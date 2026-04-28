package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// QueueDepthFunc returns the current depth of the named queue.
type QueueDepthFunc func(name string) (int, error)

// AdmissionConfig configures the upload admission controller.
type AdmissionConfig struct {
	// QueueName is the queue whose depth gates admission. Defaults to
	// "ingestion.queue".
	QueueName string
	// MaxDepth is the depth above which new uploads are rejected with 429.
	// Zero disables admission control (fail open).
	MaxDepth int
	// PollInterval is how often the controller refreshes its cached depth.
	// Defaults to 2 seconds. The HTTP request path never blocks on a
	// broker call: it reads the cached value.
	PollInterval time.Duration
	// MeanStageLatencySeconds is used to compute Retry-After hints. A
	// reasonable default for the analyzer stage is 30s.
	MeanStageLatencySeconds int
}

// AdmissionController polls queue depth in the background and exposes a
// middleware that rejects requests when depth is above the configured ceiling.
// Polling out-of-band keeps the request path unaffected by broker latency.
type AdmissionController struct {
	cfg     AdmissionConfig
	depth   atomic.Int64
	healthy atomic.Bool
	getter  QueueDepthFunc
	logger  *slog.Logger
}

// NewAdmissionController constructs and starts the background poller. Cancel
// the supplied context to stop polling.
func NewAdmissionController(ctx context.Context, cfg AdmissionConfig, getter QueueDepthFunc, logger *slog.Logger) *AdmissionController {
	if cfg.QueueName == "" {
		cfg.QueueName = "ingestion.queue"
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 2 * time.Second
	}
	if cfg.MeanStageLatencySeconds <= 0 {
		cfg.MeanStageLatencySeconds = 30
	}

	a := &AdmissionController{cfg: cfg, getter: getter, logger: logger}
	a.healthy.Store(true)
	go a.run(ctx)
	return a
}

func (a *AdmissionController) run(ctx context.Context) {
	t := time.NewTicker(a.cfg.PollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := a.getter(a.cfg.QueueName)
			if err != nil {
				a.healthy.Store(false)
				a.logger.Warn("admission: queue depth poll failed", "queue", a.cfg.QueueName, "error", err)
				continue
			}
			a.healthy.Store(true)
			a.depth.Store(int64(n))
		}
	}
}

// Middleware returns the admission middleware. It MUST be applied only to
// upload-creating endpoints; other endpoints should not be gated on ingestion
// queue depth.
func (a *AdmissionController) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if a.cfg.MaxDepth <= 0 {
				next.ServeHTTP(w, r)
				return
			}
			// Fail open if the poller has not yet succeeded; we prefer
			// accepting work over a self-inflicted outage.
			if !a.healthy.Load() {
				next.ServeHTTP(w, r)
				return
			}
			depth := int(a.depth.Load())
			if depth <= a.cfg.MaxDepth {
				next.ServeHTTP(w, r)
				return
			}

			// Compute a Retry-After hint based on how far above the
			// ceiling we are and the mean stage latency. The hint is
			// advisory; clients should still respect it to avoid
			// hammering us during a backlog.
			over := depth - a.cfg.MaxDepth
			retry := over * a.cfg.MeanStageLatencySeconds / 100
			retry = max(retry, 5)
			retry = min(retry, 300)
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			w.Header().Set("X-Queue-Depth", strconv.Itoa(depth))
			writeJSON(w, http.StatusTooManyRequests, errorBody("server is busy; please retry"))
		})
	}
}
