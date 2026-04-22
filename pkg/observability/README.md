# pkg/observability

Shared observability primitives for every Recast AI Go service: OpenTelemetry tracing, Prometheus metrics, and a JSON `log/slog` logger. The package deliberately exposes small, opinionated constructors so each service can wire up traces, metrics, and structured logging in a handful of lines.

## Usage

```go
logger := observability.NewLogger("upload-service")

shutdown, err := observability.InitTracing("upload-service", cfg.OTELEndpoint)
if err != nil { logger.Error("otel init", "err", err) }
defer shutdown(context.Background())

_, metricsHandler := observability.NewPromRegistry()
http.Handle("/metrics", metricsHandler)
```

When `OTEL_EXPORTER_OTLP_ENDPOINT` is empty, `InitTracing` returns a no-op shutdown and installs no provider, so services are safe to run without a collector attached.
