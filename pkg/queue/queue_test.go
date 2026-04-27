package queue

import (
	"context"
	"testing"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func TestAllQueuesContainsExpectedNames(t *testing.T) {
	t.Parallel()
	want := map[string]struct{}{
		IngestionQueue:  {},
		TranscriptQueue: {},
		AudioQueue:      {},
		DeliveryQueue:   {},
	}
	if len(AllQueues) != len(want) {
		t.Fatalf("AllQueues has %d entries, want %d", len(AllQueues), len(want))
	}
	for _, q := range AllQueues {
		if _, ok := want[q]; !ok {
			t.Errorf("unexpected queue in AllQueues: %q", q)
		}
	}
}

func TestAMQPCarrier_RoundTrip(t *testing.T) {
	t.Parallel()
	headers := amqp.Table{}
	c := amqpCarrier(headers)
	c.Set("traceparent", "00-abcd-ef01-01")
	if got := c.Get("traceparent"); got != "00-abcd-ef01-01" {
		t.Errorf("Get returned %q, want round-tripped value", got)
	}
	if got := c.Get("missing"); got != "" {
		t.Errorf("Get(missing) returned %q, want empty", got)
	}
	if c.Get("non-string") != "" {
		t.Errorf("non-string value should produce empty string")
	}
	keys := c.Keys()
	if len(keys) != 1 || keys[0] != "traceparent" {
		t.Errorf("unexpected keys: %v", keys)
	}
}

func TestExtractContext_PropagatesActiveTrace(t *testing.T) {
	t.Parallel()

	// Configure a real tracer provider so a span produces a non-empty span
	// context. Use a no-op exporter — we only care about propagation.
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	ctx, span := tp.Tracer("queue-test").Start(context.Background(), "produce")
	defer span.End()

	headers := amqp.Table{}
	otel.GetTextMapPropagator().Inject(ctx, amqpCarrier(headers))

	if _, ok := headers["traceparent"]; !ok {
		t.Fatalf("expected traceparent header to be injected, got %#v", headers)
	}

	consumed := ExtractContext(context.Background(), headers)
	got := trace.SpanContextFromContext(consumed)
	if !got.IsValid() {
		t.Errorf("expected propagated span context to be valid")
	}
	if got.TraceID() != span.SpanContext().TraceID() {
		t.Errorf("trace IDs differ: got %s, want %s", got.TraceID(), span.SpanContext().TraceID())
	}
}
