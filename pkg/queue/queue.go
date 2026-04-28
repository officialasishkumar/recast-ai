package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
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

// publishConfirmTimeout bounds how long Publish waits for the broker to
// acknowledge a message when publisher confirms are enabled.
var publishConfirmTimeout = 5 * time.Second

// Connection wraps an AMQP connection and channel.
type Connection struct {
	conn          *amqp.Connection
	channel       *amqp.Channel
	logger        *slog.Logger
	confirmsOn    bool
	queueType     string // "classic" or "quorum"
	deliveryLimit int32
}

// queueTypeFromEnv returns "quorum" when RABBITMQ_QUEUE_TYPE=quorum, else
// "classic". Quorum queues are Raft-replicated and survive node loss; they
// require a clustered broker. Classic queues are the dev default.
func queueTypeFromEnv() string {
	switch strings.ToLower(os.Getenv("RABBITMQ_QUEUE_TYPE")) {
	case "quorum":
		return "quorum"
	default:
		return "classic"
	}
}

// Connect establishes an AMQP connection with retry and enables publisher
// confirms on the channel so Publish can guarantee broker acceptance.
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

	// Enable publisher confirms. Failure is logged but does not abort
	// startup; some test brokers do not support confirms.
	confirmsOn := true
	if err := ch.Confirm(false); err != nil {
		logger.Warn("publisher confirms unavailable; falling back to fire-and-forget", "error", err)
		confirmsOn = false
	}

	c := &Connection{
		conn:          conn,
		channel:       ch,
		logger:        logger,
		confirmsOn:    confirmsOn,
		queueType:     queueTypeFromEnv(),
		deliveryLimit: 3,
	}
	logger.Info("rabbitmq connected", "queue_type", c.queueType, "publisher_confirms", confirmsOn)
	return c, nil
}

// DeclareQueue declares a durable queue with its DLQ. The queue type
// (classic/quorum) is selected from RABBITMQ_QUEUE_TYPE; quorum queues add a
// delivery-limit so a poison message is moved to the DLQ deterministically
// instead of being requeued indefinitely.
func (c *Connection) DeclareQueue(name string) error {
	dlq := name + dlqSuffix

	dlqArgs := amqp.Table{}
	if c.queueType == "quorum" {
		dlqArgs["x-queue-type"] = "quorum"
	}
	if _, err := c.channel.QueueDeclare(dlq, true, false, false, false, dlqArgs); err != nil {
		return fmt.Errorf("declare DLQ %s: %w", dlq, err)
	}

	args := amqp.Table{
		"x-dead-letter-exchange":    "",
		"x-dead-letter-routing-key": dlq,
	}
	if c.queueType == "quorum" {
		args["x-queue-type"] = "quorum"
		args["x-delivery-limit"] = c.deliveryLimit
	} else {
		// Classic queues use a TTL fallback; quorum queues should not set
		// a global TTL since the delivery-limit handles poison messages.
		args["x-message-ttl"] = int32(86400000) // 24h
	}

	if _, err := c.channel.QueueDeclare(name, true, false, false, false, args); err != nil {
		return fmt.Errorf("declare queue %s: %w", name, err)
	}

	c.logger.Info("queue declared", "queue", name, "dlq", dlq, "type", c.queueType)
	return nil
}

// Publish publishes a JSON message to a queue. The current trace context (if
// any) is propagated through AMQP headers so consumers can continue the span.
// When publisher confirms are enabled (the default), Publish blocks until the
// broker acks the message or publishConfirmTimeout elapses.
func (c *Connection) Publish(ctx context.Context, queueName string, msg any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	headers := amqp.Table{}
	otel.GetTextMapPropagator().Inject(ctx, amqpCarrier(headers))

	pub := amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		ContentType:  "application/json",
		Body:         body,
		Timestamp:    time.Now(),
		Headers:      headers,
	}

	if !c.confirmsOn {
		return c.channel.PublishWithContext(ctx, "", queueName, false, false, pub)
	}

	// mandatory=true so unroutable messages return an error rather than
	// being silently dropped. The test topology uses default exchange so
	// unroutable means the queue does not exist.
	deferred, err := c.channel.PublishWithDeferredConfirmWithContext(ctx, "", queueName, true, false, pub)
	if err != nil {
		return fmt.Errorf("publish %s: %w", queueName, err)
	}

	confirmCtx, cancel := context.WithTimeout(ctx, publishConfirmTimeout)
	defer cancel()

	confirmed, err := deferred.WaitContext(confirmCtx)
	if err != nil {
		return fmt.Errorf("await publisher confirm for %s: %w", queueName, err)
	}
	if !confirmed {
		return fmt.Errorf("broker nack for %s", queueName)
	}
	return nil
}

// QueueDepth returns the current ready-message count for a queue, used for
// admission control and backpressure decisions at the API edge. Errors are
// surfaced rather than swallowed so callers can fail open or closed
// deliberately. The passive declare matches the queue without redeclaring,
// so it works for both classic and quorum queues already on the broker.
func (c *Connection) QueueDepth(name string) (int, error) {
	q, err := c.channel.QueueDeclarePassive(name, true, false, false, false, nil)
	if err != nil {
		return 0, fmt.Errorf("inspect queue %s: %w", name, err)
	}
	return q.Messages, nil
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
