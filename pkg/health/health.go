package health

import (
	"log/slog"
	"net/http"

	"github.com/officialasishkumar/recast-ai/pkg/config"
)

// Serve starts a minimal HTTP server with a /health endpoint.
// Used by queue workers so they can run as web services on platforms
// like Render that require an HTTP port binding.
func Serve(logger *slog.Logger) {
	port := config.Env("PORT", "8080")
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	})
	go func() {
		logger.Info("health server listening", "port", port)
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			logger.Error("health server error", "error", err)
		}
	}()
}
