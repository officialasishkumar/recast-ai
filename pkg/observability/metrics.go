package observability

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
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
	// HTTPRequests counts inbound HTTP requests by method, route, and status.
	HTTPRequests *prometheus.CounterVec
	// HTTPDuration records inbound HTTP request latency by route.
	HTTPDuration *prometheus.HistogramVec
	// QueuePublished counts messages published to a queue.
	QueuePublished *prometheus.CounterVec
	// QueueConsumed counts messages successfully processed from a queue.
	QueueConsumed *prometheus.CounterVec
	// QueueFailed counts messages that failed processing and were retried or
	// dead-lettered.
	QueueFailed *prometheus.CounterVec
	// QueueProcessSeconds records consumer processing latency by queue.
	QueueProcessSeconds *prometheus.HistogramVec
}

// NewPromRegistry builds a fresh Prometheus registry, registers the standard
// Recast AI metrics on it, and returns the registry, the metric set, and an
// HTTP handler suitable for mounting under /metrics.
func NewPromRegistry() (*prometheus.Registry, *Metrics, http.Handler) {
	reg := prometheus.NewRegistry()
	m := newMetrics()
	reg.MustRegister(
		m.JobsSubmitted,
		m.JobsCompleted,
		m.JobsFailed,
		m.StageDuration,
		m.HTTPRequests,
		m.HTTPDuration,
		m.QueuePublished,
		m.QueueConsumed,
		m.QueueFailed,
		m.QueueProcessSeconds,
	)
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	handler := promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg})
	return reg, m, handler
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
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of inbound HTTP requests.",
		}, []string{"service", "method", "route", "status"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "Inbound HTTP request latency in seconds.",
			Buckets: prometheus.DefBuckets,
		}, []string{"service", "method", "route"}),
		QueuePublished: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "queue_messages_published_total",
			Help: "Total number of messages published to a queue.",
		}, []string{"queue"}),
		QueueConsumed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "queue_messages_consumed_total",
			Help: "Total number of messages successfully processed from a queue.",
		}, []string{"queue"}),
		QueueFailed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "queue_messages_failed_total",
			Help: "Total number of messages that failed processing.",
		}, []string{"queue", "reason"}),
		QueueProcessSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "queue_message_process_seconds",
			Help:    "Consumer processing latency for queue messages.",
			Buckets: prometheus.ExponentialBuckets(0.05, 2, 12),
		}, []string{"queue"}),
	}
}
