package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"

	"github.com/officialasishkumar/recast-ai/internal/extractor"
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

	baseCfg := config.LoadBase("frame-extractor")
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
	for _, q := range []string{queue.IngestionQueue, queue.FramesQueue} {
		if err := qConn.DeclareQueue(q); err != nil {
			logger.Error("failed to declare queue", "queue", q, "error", err)
			os.Exit(1)
		}
	}

	msgs, err := qConn.Consume(queue.IngestionQueue, "frame-extractor")
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

	logger.Info("consuming from queue", "queue", queue.IngestionQueue)

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

	// Re-decode the payload field into the concrete type.
	payloadBytes, err := json.Marshal(msg.Payload)
	if err != nil {
		return fmt.Errorf("re-marshal payload: %w", err)
	}
	var payload models.IngestionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("unmarshal ingestion payload: %w", err)
	}

	log.Info("processing ingestion", "original_file", payload.OriginalFile)

	// Update job stage to frame_extracting.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, updated_at = NOW() WHERE id = $2`,
		models.StageFrameExtracting, msg.JobID,
	); err != nil {
		return fmt.Errorf("update job stage: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageFrameExtracting, 0.0, log)

	// Create temp working directory.
	tmpDir, err := os.MkdirTemp("", "frame-extractor-"+msg.JobID+"-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Download the original video.
	videoPath := filepath.Join(tmpDir, "input"+filepath.Ext(payload.OriginalFile))
	log.Info("downloading video from storage", "key", payload.OriginalFile)
	if err := store.DownloadFile(ctx, payload.OriginalFile, videoPath); err != nil {
		return fmt.Errorf("download video: %w", err)
	}

	// Get video duration.
	durationMs, err := extractor.GetDuration(videoPath)
	if err != nil {
		return fmt.Errorf("get duration: %w", err)
	}
	log.Info("video duration", "duration_ms", durationMs)

	// Extract frames.
	framesDir := filepath.Join(tmpDir, "frames")
	frameCount, err := extractor.ExtractFrames(videoPath, framesDir)
	if err != nil {
		return fmt.Errorf("extract frames: %w", err)
	}
	log.Info("frames extracted", "count", frameCount)

	publishEvent(ctx, rdb, msg.JobID, models.StageFrameExtracting, 0.5, log)

	// Extract audio.
	audioPath := filepath.Join(tmpDir, "audio", "extracted.wav")
	if err := extractor.ExtractAudio(videoPath, audioPath); err != nil {
		return fmt.Errorf("extract audio: %w", err)
	}
	log.Info("audio extracted")

	// Upload frames to MinIO.
	framesPrefix := fmt.Sprintf("frames/%s/", msg.JobID)
	entries, err := os.ReadDir(framesDir)
	if err != nil {
		return fmt.Errorf("read frames dir: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		localPath := filepath.Join(framesDir, entry.Name())
		objectKey := framesPrefix + entry.Name()
		if err := store.UploadFile(ctx, objectKey, localPath, "image/jpeg"); err != nil {
			return fmt.Errorf("upload frame %s: %w", entry.Name(), err)
		}
	}
	log.Info("frames uploaded", "prefix", framesPrefix, "count", frameCount)

	// Upload audio to MinIO.
	audioKey := fmt.Sprintf("audio/%s/extracted.wav", msg.JobID)
	if err := store.UploadFile(ctx, audioKey, audioPath, "audio/wav"); err != nil {
		return fmt.Errorf("upload audio: %w", err)
	}
	log.Info("audio uploaded", "key", audioKey)

	// Update job in database.
	if _, err := db.ExecContext(ctx,
		`UPDATE jobs SET stage = $1, duration_ms = $2, frames_path = $3, updated_at = NOW() WHERE id = $4`,
		models.StageFrameExtracted, durationMs, sql.NullString{String: framesPrefix, Valid: true}, msg.JobID,
	); err != nil {
		return fmt.Errorf("update job after extraction: %w", err)
	}

	// Publish FramesPayload to frames.queue.
	framesMsg := models.QueueMessage{
		JobID:          msg.JobID,
		TraceID:        msg.TraceID,
		StageAttemptID: uuid.New().String(),
		Payload: models.FramesPayload{
			FramesPrefix: framesPrefix,
			AudioFile:    audioKey,
			FrameCount:   frameCount,
			DurationMs:   durationMs,
		},
	}
	if err := qConn.Publish(ctx, queue.FramesQueue, framesMsg); err != nil {
		return fmt.Errorf("publish frames message: %w", err)
	}

	publishEvent(ctx, rdb, msg.JobID, models.StageFrameExtracted, 1.0, log)

	log.Info("frame extraction complete")
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

