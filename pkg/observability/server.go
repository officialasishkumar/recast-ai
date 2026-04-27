package observability

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// MetricsServer runs the Prometheus exposition endpoint on a sidecar port. It
// also serves /healthz and /readyz so orchestrators can probe the service
// without going through the application port.
type MetricsServer struct {
	server *http.Server
	logger *slog.Logger
}

// NewMetricsServer wires the Prometheus handler onto /metrics and trivial
// liveness/readiness handlers onto /healthz and /readyz. addr is typically
// ":9100" or whatever METRICS_PORT resolves to.
func NewMetricsServer(addr string, handler http.Handler, logger *slog.Logger) *MetricsServer {
	mux := http.NewServeMux()
	mux.Handle("/metrics", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})

	if !strings.Contains(addr, ":") {
		addr = ":" + addr
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return &MetricsServer{server: srv, logger: logger}
}

// Start begins serving in a background goroutine. It logs the listen address
// and blocks only when the server stops.
func (m *MetricsServer) Start() {
	go func() {
		m.logger.Info("metrics server listening", "addr", m.server.Addr)
		if err := m.server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			m.logger.Error("metrics server failed", "error", err)
		}
	}()
}

// Shutdown gracefully stops the metrics server.
func (m *MetricsServer) Shutdown(ctx context.Context) error {
	return m.server.Shutdown(ctx)
}
