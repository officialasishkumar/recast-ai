package observability

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestNewPromRegistry_RegistersStandardCollectors(t *testing.T) {
	t.Parallel()

	_, metrics, handler := NewPromRegistry()
	if metrics == nil {
		t.Fatal("expected non-nil metrics")
	}

	// Touch each labeled vector so the series is materialized in the
	// exposition output before scraping.
	metrics.JobsSubmitted.Inc()
	metrics.JobsCompleted.Inc()
	metrics.JobsFailed.Inc()
	metrics.StageDuration.WithLabelValues("ingest").Observe(0.5)
	metrics.HTTPRequests.WithLabelValues("svc", "GET", "/", "200").Inc()
	metrics.HTTPDuration.WithLabelValues("svc", "GET", "/").Observe(0.1)
	metrics.QueuePublished.WithLabelValues("ingest").Inc()
	metrics.QueueConsumed.WithLabelValues("ingest").Inc()
	metrics.QueueFailed.WithLabelValues("ingest", "boom").Inc()
	metrics.QueueProcessSeconds.WithLabelValues("ingest").Observe(0.1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from /metrics, got %d", rec.Code)
	}
	body := rec.Body.String()
	required := []string{
		"jobs_submitted_total",
		"jobs_completed_total",
		"jobs_failed_total",
		"stage_duration_seconds",
		"http_requests_total",
		"queue_messages_published_total",
		"go_goroutines",
	}
	for _, want := range required {
		if !strings.Contains(body, want) {
			t.Errorf("metric %q missing from /metrics output", want)
		}
	}
}

func TestHTTPMiddleware_RecordsRequestMetrics(t *testing.T) {
	t.Parallel()

	_, metrics, handler := NewPromRegistry()

	r := chi.NewRouter()
	r.Use(HTTPMiddleware("test-service", metrics))
	r.Get("/items/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("ok"))
	})

	req := httptest.NewRequest(http.MethodGet, "/items/42", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusTeapot {
		t.Fatalf("expected 418, got %d", rec.Code)
	}

	metricsRec := httptest.NewRecorder()
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	handler.ServeHTTP(metricsRec, metricsReq)
	body := metricsRec.Body.String()

	if !strings.Contains(body, `route="/items/{id}"`) {
		t.Errorf("expected route label /items/{id} in metrics, got body:\n%s", body)
	}
	if !strings.Contains(body, `status="418"`) {
		t.Errorf("expected status 418 in metrics output")
	}
}

func TestNewMetricsServer_ServesHealthAndMetrics(t *testing.T) {
	t.Parallel()

	_, _, handler := NewPromRegistry()
	srv := NewMetricsServer(":0", handler, discardLogger())

	mux := srv.server.Handler

	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("path %s: expected 200, got %d", path, rec.Code)
		}
	}

	_ = srv.Shutdown(context.Background())
}

func TestStripScheme(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"http://otel:4317":  "otel:4317",
		"https://otel:4317": "otel:4317",
		"otel:4317":         "otel:4317",
		"":                  "",
	}
	for in, want := range cases {
		if got := stripScheme(in); got != want {
			t.Errorf("stripScheme(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestInitTracing_NoEndpointReturnsNoopShutdown(t *testing.T) {
	t.Parallel()

	shutdown, err := InitTracing("svc", "")
	if err != nil {
		t.Fatalf("expected no error from empty endpoint, got %v", err)
	}
	if shutdown == nil {
		t.Fatal("expected shutdown func, got nil")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("expected no-op shutdown to succeed, got %v", err)
	}
}

func TestAMQPHeaderCarrier_RoundTrip(t *testing.T) {
	t.Parallel()

	c := AMQPHeaderCarrier{}
	c.Set("traceparent", "00-abcd-1234-01")
	if c.Get("traceparent") != "00-abcd-1234-01" {
		t.Errorf("Get returned wrong value: %q", c.Get("traceparent"))
	}
	if c.Get("missing") != "" {
		t.Errorf("Get(missing) should be empty")
	}
	keys := c.Keys()
	if len(keys) != 1 || keys[0] != "traceparent" {
		t.Errorf("Keys = %v, want [traceparent]", keys)
	}
}
