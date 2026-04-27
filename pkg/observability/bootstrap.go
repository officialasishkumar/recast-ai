package observability

import (
	"context"
	"log/slog"
	"os"
)

// Bootstrap groups the observability primitives every Go service needs:
// a tracer provider shutdown function, a Prometheus metric set, and a
// metrics HTTP server. Callers should call Shutdown during graceful shutdown.
type Bootstrap struct {
	Metrics       *Metrics
	MetricsServer *MetricsServer
	tracerShut    func(context.Context) error
}

// Setup wires tracing and metrics with sensible defaults. It reads the OTLP
// endpoint from OTEL_EXPORTER_OTLP_ENDPOINT and the metrics port from
// METRICS_PORT (falling back to defaultMetricsPort when unset). The metrics
// server is started before the function returns.
func Setup(serviceName, defaultMetricsPort string, logger *slog.Logger) (*Bootstrap, error) {
	endpoint := stripScheme(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	shutdown, err := InitTracing(serviceName, endpoint)
	if err != nil {
		return nil, err
	}

	_, metrics, handler := NewPromRegistry()

	port := os.Getenv("METRICS_PORT")
	if port == "" {
		port = defaultMetricsPort
	}
	srv := NewMetricsServer(port, handler, logger)
	srv.Start()

	logger.Info("observability ready",
		"service", serviceName,
		"otel_endpoint", endpoint,
		"metrics_port", port,
	)

	return &Bootstrap{
		Metrics:       metrics,
		MetricsServer: srv,
		tracerShut:    shutdown,
	}, nil
}

// Shutdown stops the metrics server and flushes the tracer provider.
func (b *Bootstrap) Shutdown(ctx context.Context) {
	if b == nil {
		return
	}
	if b.MetricsServer != nil {
		_ = b.MetricsServer.Shutdown(ctx)
	}
	if b.tracerShut != nil {
		_ = b.tracerShut(ctx)
	}
}

// stripScheme removes a leading http:// or https:// from an OTLP endpoint
// because the OTLP gRPC client expects a host:port address.
func stripScheme(endpoint string) string {
	for _, scheme := range []string{"http://", "https://"} {
		if len(endpoint) >= len(scheme) && endpoint[:len(scheme)] == scheme {
			return endpoint[len(scheme):]
		}
	}
	return endpoint
}
