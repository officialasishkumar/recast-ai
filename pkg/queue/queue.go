package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
)

// Queue names used across services.
const (
	IngestionQueue  = "ingestion.queue"
	TranscriptQueue = "transcript.queue"
	AudioQueue      = "audio.queue"
	DeliveryQueue   = "delivery.queue"
)

// AllQueues lists every queue that must be declared on startup.
var AllQueues = []string{
	IngestionQueue,
	TranscriptQueue,
	AudioQueue,
	DeliveryQueue,
}

// DLQ suffix.
const dlqSuffix = ".dlq"

// Connection wraps an AMQP connection and channel.
type Connection struct {
	conn    *amqp.Connection
	channel *amqp.Channel
	logger  *slog.Logger
}

// Connect establishes an AMQP connection with retry.
func Connect(url string, logger *slog.Logger) (*Connection, error) {
	var conn *amqp.Connection
	var err error

	for i := 0; i < 30; i++ {
		conn, err = amqp.Dial(url)
		if err == nil {
			break
		}
		logger.Warn("rabbitmq not ready, retrying", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to connect to rabbitmq after retries: %w", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to open channel: %w", err)
	}

	if err := ch.Qos(1, 0, false); err != nil {
		ch.Close()
		conn.Close()
		return nil, fmt.Errorf("failed to set QoS: %w", err)
	}

	return &Connection{conn: conn, channel: ch, logger: logger}, nil
}

// DeclareQueue declares a durable queue with its DLQ.
func (c *Connection) DeclareQueue(name string) error {
	// Declare the DLQ first.
	dlq := name + dlqSuffix
	_, err := c.channel.QueueDeclare(dlq, true, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("declare DLQ %s: %w", dlq, err)
	}

	// Declare the main queue with DLQ routing.
	args := amqp.Table{
		"x-dead-letter-exchange":    "",
		"x-dead-letter-routing-key": dlq,
		"x-message-ttl":             int32(86400000), // 24h
	}
	_, err = c.channel.QueueDeclare(name, true, false, false, false, args)
	if err != nil {
		return fmt.Errorf("declare queue %s: %w", name, err)
	}

	c.logger.Info("queue declared", "queue", name, "dlq", dlq)
	return nil
}

// Publish publishes a JSON message to a queue. The current trace context (if
// any) is propagated through AMQP headers so consumers can continue the span.
func (c *Connection) Publish(ctx context.Context, queueName string, msg any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	headers := amqp.Table{}
	otel.GetTextMapPropagator().Inject(ctx, amqpCarrier(headers))

	return c.channel.PublishWithContext(ctx, "", queueName, false, false, amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		ContentType:  "application/json",
		Body:         body,
		Timestamp:    time.Now(),
		Headers:      headers,
	})
}

// amqpCarrier adapts amqp.Table to OpenTelemetry's TextMapCarrier so trace
// context can be propagated across queue boundaries.
type amqpCarrier amqp.Table

func (c amqpCarrier) Get(key string) string {
	if v, ok := c[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (c amqpCarrier) Set(key, value string) { c[key] = value }

func (c amqpCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

// ExtractContext pulls trace context from a delivery's headers and returns a
// derived context. Use this in consumers to continue the producer's span.
func ExtractContext(parent context.Context, headers amqp.Table) context.Context {
	return otel.GetTextMapPropagator().Extract(parent, amqpCarrier(headers))
}

// Consume returns a channel of deliveries for the given queue.
func (c *Connection) Consume(queueName, consumerTag string) (<-chan amqp.Delivery, error) {
	return c.channel.Consume(queueName, consumerTag, false, false, false, false, nil)
}

// Close closes the channel and connection.
func (c *Connection) Close() {
	if c.channel != nil {
		c.channel.Close()
	}
	if c.conn != nil {
		c.conn.Close()
	}
}
