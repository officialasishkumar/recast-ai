package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
	"github.com/officialasishkumar/recast-ai/pkg/storage"
)

// maxUploadSize is the maximum allowed upload size (2 GB).
const maxUploadSize = 2 << 30

// allowedExtensions lists the video file extensions that the service accepts.
var allowedExtensions = map[string]bool{
	".mp4":  true,
	".mov":  true,
	".webm": true,
	".avi":  true,
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	baseCfg := config.LoadBase("upload-service")
	rabbitCfg := config.LoadRabbitMQ()
	storageCfg := config.LoadStorage()

	logger.Info("starting service", "service", baseCfg.ServiceName, "env", baseCfg.Environment)

	// Connect to RabbitMQ.
	qConn, err := queue.Connect(rabbitCfg.URL(), logger)
	if err != nil {
		logger.Error("failed to connect to rabbitmq", "error", err)
		os.Exit(1)
	}
	defer qConn.Close()

	if err := qConn.DeclareQueue(queue.IngestionQueue); err != nil {
		logger.Error("failed to declare queue", "error", err)
		os.Exit(1)
	}

	// Connect to MinIO/S3 storage.
	store, err := storage.New(storageCfg, logger)
	if err != nil {
		logger.Error("failed to connect to storage", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /upload", uploadHandler(logger, store, qConn))
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	port := config.Env("PORT", "8081")
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      5 * time.Minute, // large uploads need time
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	// Start server in a goroutine.
	go func() {
		logger.Info("listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server shutdown error", "error", err)
	}
	logger.Info("stopped")
}

func uploadHandler(logger *slog.Logger, store *storage.Client, qConn *queue.Connection) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		traceID := uuid.New().String()
		log := logger.With("trace_id", traceID)

		// Enforce body size limit.
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

		if err := r.ParseMultipartForm(32 << 20); err != nil {
			log.Warn("parse multipart form failed", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid multipart form or file too large"})
			return
		}
		defer r.MultipartForm.RemoveAll()

		file, header, err := r.FormFile("file")
		if err != nil {
			log.Warn("missing file field", "error", err)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file field is required"})
			return
		}
		defer file.Close()

		// Validate extension.
		ext := strings.ToLower(filepath.Ext(header.Filename))
		if !allowedExtensions[ext] {
			log.Warn("unsupported format", "filename", header.Filename, "ext", ext)
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("unsupported format %q; allowed: mp4, mov, webm, avi", ext),
			})
			return
		}

		// Validate size.
		if header.Size > maxUploadSize {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file exceeds 2 GB limit"})
			return
		}

		// Read form parameters.
		userID := r.FormValue("user_id")
		if userID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
			return
		}
		voiceID := r.FormValue("voice_id")
		style := r.FormValue("style")
		language := r.FormValue("language")
		if language == "" {
			language = "en"
		}

		jobID := uuid.New().String()
		objectKey := fmt.Sprintf("uploads/%s/%s", jobID, header.Filename)

		// Determine content type from extension.
		contentType := "video/mp4"
		switch ext {
		case ".mov":
			contentType = "video/quicktime"
		case ".webm":
			contentType = "video/webm"
		case ".avi":
			contentType = "video/x-msvideo"
		}

		log.Info("uploading file to storage", "job_id", jobID, "filename", header.Filename, "size", header.Size)

		ctx := r.Context()
		if err := store.Upload(ctx, objectKey, file, header.Size, contentType); err != nil {
			log.Error("storage upload failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store file"})
			return
		}

		// Publish ingestion message.
		msg := models.QueueMessage{
			JobID:          jobID,
			TraceID:        traceID,
			StageAttemptID: uuid.New().String(),
			Payload: models.IngestionPayload{
				UserID:       userID,
				OriginalFile: objectKey,
				VoiceID:      voiceID,
				Style:        style,
				Language:     language,
			},
		}

		if err := qConn.Publish(ctx, queue.IngestionQueue, msg); err != nil {
			log.Error("failed to publish ingestion message", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to enqueue job"})
			return
		}

		log.Info("upload complete, job enqueued", "job_id", jobID)

		writeJSON(w, http.StatusAccepted, map[string]string{
			"job_id":   jobID,
			"trace_id": traceID,
			"status":   "queued",
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

