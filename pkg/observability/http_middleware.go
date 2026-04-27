package observability

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// statusRecorder captures the response status code for metrics reporting.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// HTTPMiddleware emits Prometheus HTTP metrics and an OpenTelemetry server
// span for every request. service is the logical service name used as a
// metric label.
func HTTPMiddleware(service string, m *Metrics) func(http.Handler) http.Handler {
	tracer := otel.Tracer("recast-ai/" + service)
	prop := otel.GetTextMapPropagator()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

			ctx, span := tracer.Start(ctx, r.Method+" "+r.URL.Path,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(
					attribute.String("http.method", r.Method),
					attribute.String("http.target", r.URL.Path),
					attribute.String("http.scheme", schemeFromRequest(r)),
					attribute.String("net.host.name", r.Host),
					attribute.String("user_agent.original", r.UserAgent()),
				),
			)
			defer span.End()

			recorder := &statusRecorder{ResponseWriter: w, status: 0}
			next.ServeHTTP(recorder, r.WithContext(ctx))

			// Prefer the Chi route pattern if available so high-cardinality
			// path parameters do not explode the label set.
			route := r.URL.Path
			if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
				route = rc.RoutePattern()
			}

			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			elapsed := time.Since(start).Seconds()

			span.SetAttributes(
				attribute.String("http.route", route),
				attribute.Int("http.status_code", status),
				attribute.Int("http.response.body.size", recorder.bytes),
			)

			if m != nil {
				m.HTTPRequests.WithLabelValues(service, r.Method, route, strconv.Itoa(status)).Inc()
				m.HTTPDuration.WithLabelValues(service, r.Method, route).Observe(elapsed)
			}
		})
	}
}

func schemeFromRequest(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}
	return "http"
}
