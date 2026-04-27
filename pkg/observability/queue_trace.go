package observability

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// AMQPHeaderCarrier adapts amqp.Table to OpenTelemetry's propagation.TextMapCarrier
// so trace context can travel across queue boundaries. The implementation is
// intentionally string-typed to avoid a hard dependency on the AMQP package
// from this generic helper.
type AMQPHeaderCarrier map[string]any

// Get returns the value associated with the given key.
func (c AMQPHeaderCarrier) Get(key string) string {
	if v, ok := c[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// Set stores the given value under the given key.
func (c AMQPHeaderCarrier) Set(key, value string) {
	c[key] = value
}

// Keys lists every key currently in the carrier.
func (c AMQPHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

var _ propagation.TextMapCarrier = AMQPHeaderCarrier(nil)

// StartProducerSpan starts a producer span and injects trace context into the
// supplied carrier. Callers must End() the returned span when publish is done.
func StartProducerSpan(ctx context.Context, tracerName, queue string, carrier propagation.TextMapCarrier) (context.Context, trace.Span) {
	tracer := otel.Tracer(tracerName)
	ctx, span := tracer.Start(ctx, "publish "+queue,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", queue),
			attribute.String("messaging.operation", "publish"),
		),
	)
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return ctx, span
}

// StartConsumerSpan extracts trace context from the carrier and starts a
// consumer span. Callers must End() the returned span when processing is done.
func StartConsumerSpan(ctx context.Context, tracerName, queue string, carrier propagation.TextMapCarrier) (context.Context, trace.Span) {
	ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)
	tracer := otel.Tracer(tracerName)
	return tracer.Start(ctx, "consume "+queue,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", queue),
			attribute.String("messaging.operation", "process"),
		),
	)
}
