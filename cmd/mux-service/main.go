package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"

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

	baseCfg := config.LoadBase("mux-service")
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
		Addr:      redisCfg.Addr(),
		Password:  redisCfg.Password,
		DB:        redisCfg.DB,
		TLSConfig: redisCfg.TLSConfig(),
	})
	defer rdb.Close()

	// Declare queues.
	for _, q := range []string{queue.AudioQueue, queue.DeliveryQueue} {
		if err := qConn.DeclareQueue(q); err != nil {
			logger.Error("failed to declare queue", "queue", q, "error", err)
			os.Exit(1)
		}
	}

	msgs, err := qConn.Consume(queue.AudioQueue, "mux-service")
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

	logger.Info("consuming from queue", "queue", queue.AudioQueue)

	for {
		select {
		case <-ctx.Done():
			logger.Info("stopped")
			return
		case delivery, ok := <-msgs:
			if !ok {
				logger.Warn("message channel closed")
				return
			}

			if err := processMessage(ctx, logger, db, qConn, store, rdb, delivery.Body); err != nil {
				logger.Error("processing failed", "error", err)
				delivery.Nack(false, true)
				continue
			}
			delivery.Ack(false)
		}
	}
}

func processMessage(
	ctx context.Context,
	logger *slog.Logger,
	db *sqlx.DB,
	qConn *queue.Connection,
	store *storage.Client,
	rdb *redis.Client,
	body []byte,
) error {
	var msg models.QueueMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return fmt.Errorf("unmarshal queue message: %w", err)
	}

	log := logger.With("job_id", msg.JobID, "trace_id", msg.TraceID)

	// Re-decode the payload into AudioPayload.
	payloadBytes, err := json.Marshal(msg.Payload)
	if err != nil {
		return fmt.Errorf("re-marshal payload: %w", err)
	}
	var payload models.AudioPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("unmarshal audio payload: %w", err)
	}

	log.Info("processing mux", "audio_file", payload.AudioFile, "original_file", payload.OriginalFile)

	// Update job stage to muxing.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, updated_at = NOW() WHERE id = $2`,
		models.StageMuxing, msg.JobID,
	); err != nil {
		return fmt.Errorf("update job stage: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageMuxing, 0.0, log)

	// Create temp working directory.
	tmpDir, err := os.MkdirTemp("", "mux-service-"+msg.JobID+"-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Download original video.
	videoPath := filepath.Join(tmpDir, "input"+filepath.Ext(payload.OriginalFile))
	log.Info("downloading video", "key", payload.OriginalFile)
	if err := store.DownloadFile(ctx, payload.OriginalFile, videoPath); err != nil {
		return fmt.Errorf("download video: %w", err)
	}

	// Download synthesised audio.
	audioPath := filepath.Join(tmpDir, "audio"+filepath.Ext(payload.AudioFile))
	log.Info("downloading audio", "key", payload.AudioFile)
	if err := store.DownloadFile(ctx, payload.AudioFile, audioPath); err != nil {
		return fmt.Errorf("download audio: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageMuxing, 0.3, log)

	// Mux video + audio with ffmpeg.
	outputPath := filepath.Join(tmpDir, "final.mp4")
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", videoPath,
		"-i", audioPath,
		"-c:v", "copy",
		"-c:a", "aac",
		"-map", "0:v:0",
		"-map", "1:a:0",
		"-y",
		outputPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg mux: %w: %s", err, string(out))
	}
	log.Info("muxing complete")

	publishEvent(ctx, rdb, msg.JobID, models.StageMuxing, 0.7, log)

	// Upload muxed file to MinIO.
	outputKey := fmt.Sprintf("output/%s/final.mp4", msg.JobID)
	if err := store.UploadFile(ctx, outputKey, outputPath, "video/mp4"); err != nil {
		return fmt.Errorf("upload output: %w", err)
	}
	log.Info("output uploaded", "key", outputKey)

	// Update job in database.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, output_file = $2, updated_at = NOW() WHERE id = $3`,
		models.StageMuxed, sql.NullString{String: outputKey, Valid: true}, msg.JobID,
	); err != nil {
		return fmt.Errorf("update job after mux: %w", err)
	}

	// Look up the user_id from the job so we can include it in the delivery payload.
	var userID string
	if err := db.GetContext(ctx, &userID, `SELECT user_id FROM jobs WHERE id = $1`, msg.JobID); err != nil {
		return fmt.Errorf("lookup job user_id: %w", err)
	}

	// Publish DeliveryPayload to delivery.queue.
	deliveryMsg := models.QueueMessage{
		JobID:          msg.JobID,
		TraceID:        msg.TraceID,
		StageAttemptID: uuid.New().String(),
		Payload: models.DeliveryPayload{
			OutputFile: outputKey,
			UserID:     userID,
		},
	}
	if err := qConn.Publish(ctx, queue.DeliveryQueue, deliveryMsg); err != nil {
		return fmt.Errorf("publish delivery message: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageMuxed, 1.0, log)

	log.Info("mux processing complete")
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
