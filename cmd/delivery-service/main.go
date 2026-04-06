package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"

	"github.com/officialasishkumar/recast-ai/internal/delivery"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/health"
	"github.com/officialasishkumar/recast-ai/pkg/database"
	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
	"github.com/officialasishkumar/recast-ai/pkg/storage"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	health.Serve(logger)

	baseCfg := config.LoadBase("delivery-service")
	rabbitCfg := config.LoadRabbitMQ()
	storageCfg := config.LoadStorage()
	dbCfg := config.LoadDatabase()
	redisCfg := config.LoadRedis()

	logger.Info("starting service", "service", baseCfg.ServiceName, "env", baseCfg.Environment)

	// --- Connect to dependencies ---

	db, err := database.Connect(dbCfg, logger)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	qConn, err := queue.Connect(rabbitCfg.URL(), logger)
	if err != nil {
		logger.Error("failed to connect to rabbitmq", "error", err)
		os.Exit(1)
	}
	defer qConn.Close()

	store, err := storage.New(storageCfg, logger)
	if err != nil {
		logger.Error("failed to connect to storage", "error", err)
		os.Exit(1)
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:     redisCfg.Addr(),
		Password: redisCfg.Password,
		DB:       redisCfg.DB,
	})
	defer rdb.Close()

	// Declare queue.
	if err := qConn.DeclareQueue(queue.DeliveryQueue); err != nil {
		logger.Error("failed to declare queue", "error", err)
		os.Exit(1)
	}

	msgs, err := qConn.Consume(queue.DeliveryQueue, "delivery-service")
	if err != nil {
		logger.Error("failed to start consuming", "error", err)
		os.Exit(1)
	}

	// Graceful shutdown.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		logger.Info("shutdown signal received")
		cancel()
	}()

	logger.Info("consuming from queue", "queue", queue.DeliveryQueue)

	for {
		select {
		case <-ctx.Done():
			logger.Info("stopped")
			return
		case dlv, ok := <-msgs:
			if !ok {
				logger.Warn("message channel closed")
				return
			}

			if err := processMessage(ctx, logger, db, store, rdb, dlv.Body); err != nil {
				logger.Error("processing failed", "error", err)
				dlv.Nack(false, true)
				continue
			}
			dlv.Ack(false)
		}
	}
}

// presignedURLExpiry is the lifetime of download URLs generated for completed jobs.
const presignedURLExpiry = 1 * time.Hour

func processMessage(
	ctx context.Context,
	logger *slog.Logger,
	db *sqlx.DB,
	store *storage.Client,
	rdb *redis.Client,
	body []byte,
) error {
	var msg models.QueueMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return fmt.Errorf("unmarshal queue message: %w", err)
	}

	log := logger.With("job_id", msg.JobID, "trace_id", msg.TraceID)

	// Re-decode the payload into DeliveryPayload.
	payloadBytes, err := json.Marshal(msg.Payload)
	if err != nil {
		return fmt.Errorf("re-marshal payload: %w", err)
	}
	var payload models.DeliveryPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("unmarshal delivery payload: %w", err)
	}

	log.Info("processing delivery", "output_file", payload.OutputFile, "user_id", payload.UserID)

	// Update job stage to delivering.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, updated_at = NOW() WHERE id = $2`,
		models.StageDelivering, msg.JobID,
	); err != nil {
		return fmt.Errorf("update job stage: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageDelivering, 0.0, log)

	// Generate a presigned download URL.
	downloadURL, err := store.PresignedGetURL(ctx, payload.OutputFile, presignedURLExpiry)
	if err != nil {
		return fmt.Errorf("generate presigned URL: %w", err)
	}
	log.Info("presigned URL generated", "expiry", presignedURLExpiry)

	// Retrieve duration_ms for the webhook payload.
	var durationMs int64
	if err := db.GetContext(ctx, &durationMs, `SELECT duration_ms FROM jobs WHERE id = $1`, msg.JobID); err != nil {
		return fmt.Errorf("lookup job duration: %w", err)
	}

	completedAt := time.Now()
	expiresAt := completedAt.Add(presignedURLExpiry)

	// Update job: stage=completed, download_url, completed_at.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, download_url = $2, completed_at = $3, updated_at = NOW() WHERE id = $4`,
		models.StageCompleted,
		sql.NullString{String: downloadURL, Valid: true},
		sql.NullTime{Time: completedAt, Valid: true},
		msg.JobID,
	); err != nil {
		return fmt.Errorf("update job completed: %w", err)
	}

	log.Info("job marked as completed")

	// Deliver webhooks if the user has registered any.
	webhookPayload := map[string]any{
		"job_id":       msg.JobID,
		"download_url": downloadURL,
		"expires_at":   expiresAt.Format(time.RFC3339),
		"duration_ms":  durationMs,
	}

	var webhooks []models.Webhook
	if err := sqlx.SelectContext(ctx, db, &webhooks,
		`SELECT id, user_id, url, secret, active, created_at FROM webhooks WHERE user_id = $1 AND active = true`,
		payload.UserID,
	); err != nil {
		log.Warn("failed to query webhooks, skipping", "error", err)
	} else {
		for _, wh := range webhooks {
			whLog := log.With("webhook_id", wh.ID, "webhook_url", wh.URL)
			if err := delivery.SendWebhook(ctx, wh.URL, wh.Secret, webhookPayload); err != nil {
				whLog.Warn("webhook delivery failed", "error", err)
			} else {
				whLog.Info("webhook delivered")
			}
		}
	}

	// Publish final completed event to Redis pub/sub.
	publishEvent(ctx, rdb, msg.JobID, models.StageCompleted, 1.0, log)

	log.Info("delivery processing complete")
	return nil
}

// publishEvent sends a JobEvent to the Redis pub/sub channel for the given job.
func publishEvent(ctx context.Context, rdb *redis.Client, jobID, stage string, progress float64, log *slog.Logger) {
	evt := models.JobEvent{
		Event:    "stage_update",
		JobID:    jobID,
		Stage:    stage,
		Progress: progress,
	}
	data, err := json.Marshal(evt)
	if err != nil {
		log.Warn("failed to marshal job event", "error", err)
		return
	}
	channel := fmt.Sprintf("job:%s:events", jobID)
	if err := rdb.Publish(ctx, channel, string(data)).Err(); err != nil {
		log.Warn("failed to publish job event to redis", "error", err)
	}
}
