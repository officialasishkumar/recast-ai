package observability

import (
	"log/slog"
	"os"
)

// NewLogger returns a JSON-encoded slog.Logger at LevelInfo with a persistent
// "service" attribute set to serviceName. Every Recast AI Go service should
// use this to produce uniform structured logs.
func NewLogger(serviceName string) *slog.Logger {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	return slog.New(handler).With(slog.String("service", serviceName))
}
