package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/officialasishkumar/recast-ai/pkg/auth"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/database"
	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
	"github.com/officialasishkumar/recast-ai/pkg/storage"
)

const (
	// maxTotalUploadSize is the maximum total size permitted across all chunks (2 GB).
	maxTotalUploadSize int64 = 2 << 30
	// maxChunkSize is the maximum size of a single chunk (32 MB).
	maxChunkSize int64 = 32 << 20
	// maxDurationMs is the maximum allowed video duration in milliseconds (2 hours).
	maxDurationMs int64 = 2 * 60 * 60 * 1000
)

// allowedExtensions lists the video file extensions accepted by validation.
var allowedExtensions = map[string]string{
	".mp4":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".avi":  "video/x-msvideo",
	".mkv":  "video/x-matroska",
}

// publisher is the minimal interface this service uses to emit queue messages.
// It is satisfied by *queue.Connection and by mocks in tests.
type publisher interface {
	Publish(ctx context.Context, queueName string, msg any) error
}

// objectStore abstracts MinIO operations so tests can substitute a fake.
type objectStore interface {
	Upload(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error
	Download(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
}

// chunkTracker records how many chunks have been received for a given upload.
// Backed by Redis in production; an in-memory impl is used when Redis is
// unavailable (e.g. tests).
type chunkTracker interface {
	RecordChunk(ctx context.Context, uploadID string, chunkIdx int, size int64) error
	ChunkCount(ctx context.Context, uploadID string) (int, error)
	TotalSize(ctx context.Context, uploadID string) (int64, error)
	ListChunks(ctx context.Context, uploadID string) ([]int, error)
	Purge(ctx context.Context, uploadID string) error
}

// probeFn allows injecting a fake ffprobe during tests.
type probeFn func(ctx context.Context, localPath string) (*probeResult, error)

// server bundles handler dependencies.
type server struct {
	logger    *slog.Logger
	store     objectStore
	publisher publisher
	tracker   chunkTracker
	probe     probeFn
	authCfg   config.Auth
}

type probeResult struct {
	DurationMs int64
	HasVideo   bool
}

type completeRequest struct {
	Filename string `json:"filename"`
	VoiceID  string `json:"voice_id"`
	Style    string `json:"style"`
	Language string `json:"language"`
}

type completeResponse struct {
	JobID      string `json:"job_id"`
	TraceID    string `json:"trace_id"`
	ObjectKey  string `json:"object_key"`
	DurationMs int64  `json:"duration_ms"`
	Status     string `json:"status"`
}

type statusResponse struct {
	UploadID string `json:"upload_id"`
	Chunks   int    `json:"chunks_received"`
	Size     int64  `json:"bytes_received"`
	Indices  []int  `json:"chunk_indices"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	baseCfg := config.LoadBase("upload-service")
	rabbitCfg := config.LoadRabbitMQ()
	storageCfg := config.LoadStorage()
	redisCfg := config.LoadRedis()
	dbCfg := config.LoadDatabase()
	authCfg := config.LoadAuth()

	logger.Info("starting service", "service", baseCfg.ServiceName, "env", baseCfg.Environment)

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

	store, err := storage.New(storageCfg, logger)
	if err != nil {
		logger.Error("failed to connect to storage", "error", err)
		os.Exit(1)
	}

	if _, err := database.Connect(dbCfg, logger); err != nil {
		logger.Warn("postgres not available; continuing without db", "error", err)
	}

	tracker := newTracker(logger, redisCfg)

	srv := &server{
		logger:    logger,
		store:     store,
		publisher: qConn,
		tracker:   tracker,
		probe:     runFFProbe,
		authCfg:   authCfg,
	}

	r := chi.NewRouter()
	r.Use(chimw.Recoverer)
	r.Use(chimw.RequestID)
	r.Use(requestLogger(logger))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "upload-service"})
	})

	r.Group(func(pr chi.Router) {
		pr.Use(jwtMiddleware(authCfg))
		pr.Post("/v1/upload/chunk", srv.handleChunk)
		pr.Post("/v1/upload/complete", srv.handleComplete)
		pr.Get("/v1/upload/{id}/status", srv.handleStatus)
		pr.Delete("/v1/upload/{id}", srv.handleDelete)
	})

	port := config.Env("PORT", "8081")
	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		logger.Info("listening", "port", port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		logger.Error("server shutdown error", "error", err)
	}
	logger.Info("stopped")
}

// handleChunk accepts a single chunk of a larger upload and persists it under
// uploads/<upload_id>/chunk_<idx>.
func (s *server) handleChunk(w http.ResponseWriter, r *http.Request) {
	log := s.requestLogger(r)

	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		uploadID = strings.TrimSpace(r.Header.Get("X-Upload-ID"))
	}
	if uploadID == "" {
		uploadID = uuid.New().String()
	}
	if !isSafeID(uploadID) {
		writeError(w, http.StatusBadRequest, "invalid upload_id")
		return
	}

	idxStr := r.URL.Query().Get("chunk_idx")
	if idxStr == "" {
		idxStr = r.Header.Get("X-Chunk-Index")
	}
	chunkIdx, err := strconv.Atoi(idxStr)
	if err != nil || chunkIdx < 0 {
		writeError(w, http.StatusBadRequest, "chunk_idx must be a non-negative integer")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxChunkSize)
	defer r.Body.Close()

	buf, err := io.ReadAll(r.Body)
	if err != nil {
		log.Warn("read chunk failed", "error", err)
		writeError(w, http.StatusRequestEntityTooLarge, "chunk exceeds per-chunk limit or read failed")
		return
	}
	if len(buf) == 0 {
		writeError(w, http.StatusBadRequest, "empty chunk")
		return
	}

	existing, err := s.tracker.TotalSize(r.Context(), uploadID)
	if err != nil {
		log.Error("tracker total size failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	if existing+int64(len(buf)) > maxTotalUploadSize {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds 2 GB total limit")
		return
	}

	key := chunkKey(uploadID, chunkIdx)
	if err := s.store.Upload(r.Context(), key, bytes.NewReader(buf), int64(len(buf)), "application/octet-stream"); err != nil {
		log.Error("chunk upload failed", "error", err, "key", key)
		writeError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}

	if err := s.tracker.RecordChunk(r.Context(), uploadID, chunkIdx, int64(len(buf))); err != nil {
		log.Error("failed to record chunk", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to update upload state")
		return
	}

	log.Info("chunk stored", "upload_id", uploadID, "chunk_idx", chunkIdx, "size", len(buf))
	writeJSON(w, http.StatusOK, map[string]any{
		"upload_id": uploadID,
		"chunk_idx": chunkIdx,
		"received":  len(buf),
	})
}

// handleComplete concatenates chunks into uploads/<id>/final.<ext>, validates
// via ffprobe, and publishes the ingestion message.
func (s *server) handleComplete(w http.ResponseWriter, r *http.Request) {
	log := s.requestLogger(r)

	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		uploadID = strings.TrimSpace(r.Header.Get("X-Upload-ID"))
	}
	if !isSafeID(uploadID) {
		writeError(w, http.StatusBadRequest, "invalid or missing upload_id")
		return
	}

	var req completeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}

	claims := claimsFromRequest(r)
	if claims == nil || claims.UserID == "" {
		writeError(w, http.StatusUnauthorized, "missing user claims")
		return
	}

	ext := strings.ToLower(filepath.Ext(req.Filename))
	contentType, ok := allowedExtensions[ext]
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unsupported extension %q", ext))
		return
	}

	indices, err := s.tracker.ListChunks(r.Context(), uploadID)
	if err != nil {
		log.Error("list chunks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	if len(indices) == 0 {
		writeError(w, http.StatusBadRequest, "no chunks recorded for upload")
		return
	}

	totalSize, err := s.tracker.TotalSize(r.Context(), uploadID)
	if err != nil {
		log.Error("total size failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	if totalSize > maxTotalUploadSize {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds 2 GB total limit")
		return
	}

	tmpFile, err := os.CreateTemp("", "upload-*"+ext)
	if err != nil {
		log.Error("temp file failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to allocate temp file")
		return
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	if err := s.concatChunks(r.Context(), uploadID, indices, tmpFile); err != nil {
		tmpFile.Close()
		log.Error("concat chunks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to assemble upload")
		return
	}
	if err := tmpFile.Close(); err != nil {
		log.Error("close temp file failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to finalize temp file")
		return
	}

	probe, err := s.probe(r.Context(), tmpPath)
	if err != nil {
		log.Warn("ffprobe failed", "error", err)
		writeError(w, http.StatusBadRequest, "file is not a valid video")
		return
	}
	if !probe.HasVideo {
		writeError(w, http.StatusBadRequest, "file contains no video stream")
		return
	}
	if probe.DurationMs > maxDurationMs {
		writeError(w, http.StatusBadRequest, "video duration exceeds 2 hour limit")
		return
	}

	finalKey := path.Join("uploads", uploadID, "final"+ext)
	f, err := os.Open(tmpPath)
	if err != nil {
		log.Error("reopen temp file failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read assembled file")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		log.Error("stat temp file failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to stat assembled file")
		return
	}
	if err := s.store.Upload(r.Context(), finalKey, f, info.Size(), contentType); err != nil {
		log.Error("final upload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to store final file")
		return
	}

	// Best-effort cleanup of partial chunks. Keep going on failure.
	for _, idx := range indices {
		if err := s.store.Delete(r.Context(), chunkKey(uploadID, idx)); err != nil {
			log.Warn("failed to delete chunk", "error", err, "idx", idx)
		}
	}
	if err := s.tracker.Purge(r.Context(), uploadID); err != nil {
		log.Warn("failed to purge tracker state", "error", err)
	}

	jobID := uuid.New().String()
	traceID := reqTraceID(r)

	msg := models.QueueMessage{
		JobID:          jobID,
		TraceID:        traceID,
		StageAttemptID: uuid.New().String(),
		Payload: models.IngestionPayload{
			UserID:       claims.UserID,
			OriginalFile: finalKey,
			VoiceID:      req.VoiceID,
			Style:        req.Style,
			Language:     defaultLanguage(req.Language),
		},
	}

	if err := s.publisher.Publish(r.Context(), queue.IngestionQueue, msg); err != nil {
		log.Error("publish ingestion failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to enqueue job")
		return
	}

	log.Info("upload completed",
		"upload_id", uploadID,
		"job_id", jobID,
		"object_key", finalKey,
		"duration_ms", probe.DurationMs,
	)

	writeJSON(w, http.StatusAccepted, completeResponse{
		JobID:      jobID,
		TraceID:    traceID,
		ObjectKey:  finalKey,
		DurationMs: probe.DurationMs,
		Status:     "queued",
	})
}

// handleStatus returns the number of chunks received so far.
func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	uploadID := chi.URLParam(r, "id")
	if !isSafeID(uploadID) {
		writeError(w, http.StatusBadRequest, "invalid upload id")
		return
	}
	indices, err := s.tracker.ListChunks(r.Context(), uploadID)
	if err != nil {
		s.logger.Error("list chunks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	size, err := s.tracker.TotalSize(r.Context(), uploadID)
	if err != nil {
		s.logger.Error("total size failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{
		UploadID: uploadID,
		Chunks:   len(indices),
		Size:     size,
		Indices:  indices,
	})
}

// handleDelete purges partial chunks and their tracker state.
func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	uploadID := chi.URLParam(r, "id")
	if !isSafeID(uploadID) {
		writeError(w, http.StatusBadRequest, "invalid upload id")
		return
	}
	indices, err := s.tracker.ListChunks(r.Context(), uploadID)
	if err != nil {
		s.logger.Error("list chunks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read upload state")
		return
	}
	for _, idx := range indices {
		if err := s.store.Delete(r.Context(), chunkKey(uploadID, idx)); err != nil {
			s.logger.Warn("chunk delete failed", "error", err, "idx", idx)
		}
	}
	if err := s.tracker.Purge(r.Context(), uploadID); err != nil {
		s.logger.Warn("tracker purge failed", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"upload_id": uploadID,
		"purged":    len(indices),
	})
}

// concatChunks streams chunks in ascending index order into dst.
func (s *server) concatChunks(ctx context.Context, uploadID string, indices []int, dst io.Writer) error {
	sorted := append([]int(nil), indices...)
	sortInts(sorted)
	for _, idx := range sorted {
		rc, err := s.store.Download(ctx, chunkKey(uploadID, idx))
		if err != nil {
			return fmt.Errorf("download chunk %d: %w", idx, err)
		}
		if _, err := io.Copy(dst, rc); err != nil {
			rc.Close()
			return fmt.Errorf("copy chunk %d: %w", idx, err)
		}
		if err := rc.Close(); err != nil {
			return fmt.Errorf("close chunk %d: %w", idx, err)
		}
	}
	return nil
}

// ---- helpers ----

func chunkKey(uploadID string, idx int) string {
	return fmt.Sprintf("uploads/%s/chunk_%d", uploadID, idx)
}

func isSafeID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func defaultLanguage(lang string) string {
	if strings.TrimSpace(lang) == "" {
		return "en"
	}
	return lang
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func sortInts(a []int) {
	// insertion sort; chunk counts are small in the server's hot path.
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func (s *server) requestLogger(r *http.Request) *slog.Logger {
	return s.logger.With("trace_id", reqTraceID(r), "path", r.URL.Path)
}

func reqTraceID(r *http.Request) string {
	if id := r.Header.Get("X-Request-ID"); id != "" {
		return id
	}
	if id, ok := r.Context().Value(chimw.RequestIDKey).(string); ok && id != "" {
		return id
	}
	return uuid.New().String()
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			next.ServeHTTP(w, r)
			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"remote", r.RemoteAddr,
				"elapsed_ms", time.Since(start).Milliseconds(),
			)
		})
	}
}

// ---- auth middleware ----

type ctxKey int

const claimsKey ctxKey = 1

func jwtMiddleware(cfg config.Auth) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hdr := r.Header.Get("Authorization")
			if hdr == "" {
				writeError(w, http.StatusUnauthorized, "missing authorization header")
				return
			}
			parts := strings.SplitN(hdr, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
				writeError(w, http.StatusUnauthorized, "invalid authorization format")
				return
			}
			claims, err := auth.ValidateToken(cfg.JWTSecret, parts[1])
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func claimsFromRequest(r *http.Request) *auth.Claims {
	c, _ := r.Context().Value(claimsKey).(*auth.Claims)
	return c
}

// ---- ffprobe ----

// ffprobeOutput mirrors the subset of `ffprobe -print_format json` we care about.
type ffprobeOutput struct {
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
	Streams []struct {
		CodecType string `json:"codec_type"`
	} `json:"streams"`
}

// runFFProbe invokes ffprobe on localPath and returns duration + video-stream status.
func runFFProbe(ctx context.Context, localPath string) (*probeResult, error) {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		localPath,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe: %w (stderr=%s)", err, strings.TrimSpace(stderr.String()))
	}
	var out ffprobeOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		return nil, fmt.Errorf("parse ffprobe json: %w", err)
	}
	res := &probeResult{}
	for _, st := range out.Streams {
		if strings.EqualFold(st.CodecType, "video") {
			res.HasVideo = true
			break
		}
	}
	if out.Format.Duration != "" {
		if sec, err := strconv.ParseFloat(out.Format.Duration, 64); err == nil {
			res.DurationMs = int64(sec * 1000)
		}
	}
	return res, nil
}

// ---- chunk tracker implementations ----

// redisTracker stores chunk indices and their sizes in a Redis hash per upload.
type redisTracker struct {
	rdb    *redis.Client
	logger *slog.Logger
	ttl    time.Duration
}

// memoryTracker keeps upload state in process memory (fallback for tests or
// when Redis isn't configured).
type memoryTracker struct {
	mu   sync.Mutex
	data map[string]map[int]int64
}

func newTracker(logger *slog.Logger, cfg config.Redis) chunkTracker {
	rdb := redis.NewClient(&redis.Options{
		Addr:      cfg.Addr(),
		Password:  cfg.Password,
		DB:        cfg.DB,
		TLSConfig: cfg.TLSConfig(),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Warn("redis unavailable; using in-memory chunk tracker", "error", err)
		_ = rdb.Close()
		return &memoryTracker{data: make(map[string]map[int]int64)}
	}
	logger.Info("redis connected for chunk tracking", "addr", cfg.Addr())
	return &redisTracker{rdb: rdb, logger: logger, ttl: 24 * time.Hour}
}

func (t *redisTracker) key(uploadID string) string { return "upload:" + uploadID + ":chunks" }

func (t *redisTracker) RecordChunk(ctx context.Context, uploadID string, chunkIdx int, size int64) error {
	k := t.key(uploadID)
	if err := t.rdb.HSet(ctx, k, strconv.Itoa(chunkIdx), size).Err(); err != nil {
		return fmt.Errorf("hset: %w", err)
	}
	if err := t.rdb.Expire(ctx, k, t.ttl).Err(); err != nil {
		return fmt.Errorf("expire: %w", err)
	}
	return nil
}

func (t *redisTracker) ChunkCount(ctx context.Context, uploadID string) (int, error) {
	n, err := t.rdb.HLen(ctx, t.key(uploadID)).Result()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (t *redisTracker) TotalSize(ctx context.Context, uploadID string) (int64, error) {
	vals, err := t.rdb.HVals(ctx, t.key(uploadID)).Result()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, v := range vals {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse chunk size: %w", err)
		}
		total += n
	}
	return total, nil
}

func (t *redisTracker) ListChunks(ctx context.Context, uploadID string) ([]int, error) {
	keys, err := t.rdb.HKeys(ctx, t.key(uploadID)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]int, 0, len(keys))
	for _, k := range keys {
		n, err := strconv.Atoi(k)
		if err != nil {
			return nil, fmt.Errorf("parse chunk idx: %w", err)
		}
		out = append(out, n)
	}
	return out, nil
}

func (t *redisTracker) Purge(ctx context.Context, uploadID string) error {
	return t.rdb.Del(ctx, t.key(uploadID)).Err()
}

func (t *memoryTracker) RecordChunk(_ context.Context, uploadID string, chunkIdx int, size int64) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	m, ok := t.data[uploadID]
	if !ok {
		m = make(map[int]int64)
		t.data[uploadID] = m
	}
	m[chunkIdx] = size
	return nil
}

func (t *memoryTracker) ChunkCount(_ context.Context, uploadID string) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.data[uploadID]), nil
}

func (t *memoryTracker) TotalSize(_ context.Context, uploadID string) (int64, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var total int64
	for _, v := range t.data[uploadID] {
		total += v
	}
	return total, nil
}

func (t *memoryTracker) ListChunks(_ context.Context, uploadID string) ([]int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	m := t.data[uploadID]
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out, nil
}

func (t *memoryTracker) Purge(_ context.Context, uploadID string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.data, uploadID)
	return nil
}

