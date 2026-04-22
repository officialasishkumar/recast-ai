package observability

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics groups the standard counters and histograms every Recast AI Go
// service exposes on its /metrics endpoint.
type Metrics struct {
	// JobsSubmitted counts jobs accepted for processing.
	JobsSubmitted prometheus.Counter
	// JobsCompleted counts jobs that finished successfully.
	JobsCompleted prometheus.Counter
	// JobsFailed counts jobs that terminated in a failure state.
	JobsFailed prometheus.Counter
	// StageDuration records wall-clock time spent in each pipeline stage.
	StageDuration *prometheus.HistogramVec
}

// NewPromRegistry builds a fresh Prometheus registry, registers the standard
// Recast AI metrics on it, and returns the registry together with an HTTP
// handler suitable for mounting under /metrics.
func NewPromRegistry() (*prometheus.Registry, http.Handler) {
	reg := prometheus.NewRegistry()
	m := newMetrics()
	reg.MustRegister(m.JobsSubmitted, m.JobsCompleted, m.JobsFailed, m.StageDuration)
	reg.MustRegister(prometheus.NewGoCollector())
	reg.MustRegister(prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))

	handler := promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg})
	return reg, handler
}

// NewMetrics builds the standard Recast AI metric set without registering it.
// Prefer NewPromRegistry when you also need the HTTP handler.
func NewMetrics() *Metrics {
	return newMetrics()
}

func newMetrics() *Metrics {
	return &Metrics{
		JobsSubmitted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "jobs_submitted_total",
			Help: "Total number of jobs submitted to the pipeline.",
		}),
		JobsCompleted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "jobs_completed_total",
			Help: "Total number of jobs that completed successfully.",
		}),
		JobsFailed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "jobs_failed_total",
			Help: "Total number of jobs that failed terminally.",
		}),
		StageDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "stage_duration_seconds",
			Help:    "Wall-clock seconds spent in each pipeline stage.",
			Buckets: prometheus.ExponentialBuckets(0.1, 2, 12),
		}, []string{"stage"}),
	}
}
