package handler

import (
	"database/sql"
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// Maximum upload size: 2 GB.
const maxUploadSize = 2 << 30

// ---------- request / response types ----------

type createJobResponse struct {
	Job models.Job `json:"job"`
}

type listJobsResponse struct {
	Jobs []models.Job `json:"jobs"`
}

type transcriptResponse struct {
	Segments []models.TranscriptSegment `json:"segments"`
}

type updateSegmentRequest struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type updateTranscriptRequest struct {
	Segments []updateSegmentRequest `json:"segments"`
}

// ---------- handlers ----------

// CreateJob accepts a multipart upload containing a video file and job
// parameters. It stores the file in MinIO, creates a DB record, and publishes
// an ingestion message to RabbitMQ.
//
//	POST /v1/jobs
func (d *Deps) CreateJob(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "failed to parse multipart form (file may exceed 2 GB limit)")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()

	voiceID := r.FormValue("voice_id")
	style := r.FormValue("style")
	language := r.FormValue("language")

	if voiceID == "" {
		writeErr(w, http.StatusBadRequest, "voice_id is required")
		return
	}
	if language == "" {
		language = "en"
	}
	if style == "" {
		style = "conversational"
	}

	jobID := uuid.New().String()
	traceID := uuid.New().String()
	originalName := filepath.Base(header.Filename)
	objectKey := fmt.Sprintf("uploads/%s/%s", jobID, originalName)
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Upload to MinIO.
	if err := d.Store.Upload(r.Context(), objectKey, file, header.Size, contentType); err != nil {
		d.Logger.Error("create job: upload file", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "failed to upload file")
		return
	}

	// Determine priority based on role.
	priority := 0
	if claims.Role == models.RolePro || claims.Role == models.RoleAdmin {
		priority = 1
	}

	now := time.Now().UTC()
	job := models.Job{
		ID:           jobID,
		UserID:       claims.UserID,
		Stage:        models.StageUploaded,
		OriginalFile: objectKey,
		OriginalName: originalName,
		VoiceID:      voiceID,
		Style:        style,
		Language:     language,
		Priority:     priority,
		TraceID:      traceID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	_, err = d.DB.ExecContext(r.Context(),
		`INSERT INTO jobs (id, user_id, stage, original_file, original_name, duration_ms,
		                    voice_id, style, language, priority, trace_id, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		job.ID, job.UserID, job.Stage, job.OriginalFile, job.OriginalName,
		job.DurationMs, job.VoiceID, job.Style, job.Language,
		job.Priority, job.TraceID, job.CreatedAt, job.UpdatedAt)
	if err != nil {
		d.Logger.Error("create job: insert db", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "failed to create job record")
		return
	}

	// Publish to ingestion queue.
	msg := models.QueueMessage{
		JobID:   jobID,
		TraceID: traceID,
		Payload: models.IngestionPayload{
			UserID:       claims.UserID,
			OriginalFile: objectKey,
			VoiceID:      voiceID,
			Style:        style,
			Language:     language,
		},
	}
	if err := d.Queue.Publish(r.Context(), queue.IngestionQueue, msg); err != nil {
		d.Logger.Error("create job: publish message", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "failed to enqueue job")
		return
	}

	d.Logger.Info("job created", "job_id", jobID, "user_id", claims.UserID)
	writeJSON(w, http.StatusCreated, createJobResponse{Job: job})
}

// ListJobs returns all jobs belonging to the authenticated user, ordered by
// creation date descending.
//
//	GET /v1/jobs
func (d *Deps) ListJobs(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var jobs []models.Job
	err := d.DB.SelectContext(r.Context(), &jobs,
		`SELECT id, user_id, stage, original_file, original_name, duration_ms,
		        voice_id, style, language, priority, frames_path, audio_path,
		        output_file, download_url, error_message, trace_id,
		        created_at, updated_at, completed_at
		 FROM jobs WHERE user_id = $1 ORDER BY created_at DESC`, claims.UserID)
	if err != nil {
		d.Logger.Error("list jobs: query", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if jobs == nil {
		jobs = []models.Job{}
	}

	writeJSON(w, http.StatusOK, listJobsResponse{Jobs: jobs})
}

// GetJob returns a single job by ID. The user must own the job unless they are
// an admin.
//
//	GET /v1/jobs/{id}
func (d *Deps) GetJob(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		writeErr(w, http.StatusBadRequest, "job id is required")
		return
	}

	var job models.Job
	err := d.DB.GetContext(r.Context(), &job,
		`SELECT id, user_id, stage, original_file, original_name, duration_ms,
		        voice_id, style, language, priority, frames_path, audio_path,
		        output_file, download_url, error_message, trace_id,
		        created_at, updated_at, completed_at
		 FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("get job: query", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if job.UserID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	writeJSON(w, http.StatusOK, job)
}

// DeleteJob deletes a job record and its associated S3 objects.
//
//	DELETE /v1/jobs/{id}
func (d *Deps) DeleteJob(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		writeErr(w, http.StatusBadRequest, "job id is required")
		return
	}

	var job models.Job
	err := d.DB.GetContext(r.Context(), &job,
		`SELECT id, user_id, original_file, frames_path, audio_path, output_file
		 FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("delete job: query", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if job.UserID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	// Remove S3 objects (best-effort).
	ctx := r.Context()
	for _, key := range s3KeysForJob(job) {
		if key == "" {
			continue
		}
		if err := d.Store.Delete(ctx, key); err != nil {
			d.Logger.Warn("delete job: remove s3 object", "key", key, "error", err)
		}
	}

	// Delete transcript segments first (FK).
	if _, err := d.DB.ExecContext(ctx, `DELETE FROM transcript_segments WHERE job_id = $1`, jobID); err != nil {
		d.Logger.Error("delete job: remove segments", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if _, err := d.DB.ExecContext(ctx, `DELETE FROM jobs WHERE id = $1`, jobID); err != nil {
		d.Logger.Error("delete job: remove job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	d.Logger.Info("job deleted", "job_id", jobID, "user_id", claims.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// GetTranscript returns the transcript segments for a job.
//
//	GET /v1/jobs/{id}/transcript
func (d *Deps) GetTranscript(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		writeErr(w, http.StatusBadRequest, "job id is required")
		return
	}

	// Verify ownership.
	var ownerID string
	err := d.DB.GetContext(r.Context(), &ownerID,
		`SELECT user_id FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("get transcript: query job", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if ownerID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	var segments []models.TranscriptSegment
	err = d.DB.SelectContext(r.Context(), &segments,
		`SELECT id, job_id, segment_idx, start_ms, end_ms, text, words_json, confidence, audio_path, approved, flagged
		 FROM transcript_segments WHERE job_id = $1 ORDER BY segment_idx`, jobID)
	if err != nil {
		d.Logger.Error("get transcript: query segments", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if segments == nil {
		segments = []models.TranscriptSegment{}
	}

	writeJSON(w, http.StatusOK, transcriptResponse{Segments: segments})
}

// UpdateTranscript patches segment text and publishes a re-synthesis message.
//
//	PATCH /v1/jobs/{id}/transcript
func (d *Deps) UpdateTranscript(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		writeErr(w, http.StatusBadRequest, "job id is required")
		return
	}

	var req updateTranscriptRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Segments) == 0 {
		writeErr(w, http.StatusBadRequest, "at least one segment is required")
		return
	}

	// Verify ownership and fetch job metadata.
	var job models.Job
	err := d.DB.GetContext(r.Context(), &job,
		`SELECT id, user_id, voice_id, trace_id FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("update transcript: query job", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if job.UserID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	// Update each segment's text.
	tx, err := d.DB.BeginTxx(r.Context(), nil)
	if err != nil {
		d.Logger.Error("update transcript: begin tx", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	for _, seg := range req.Segments {
		if seg.ID == "" || seg.Text == "" {
			tx.Rollback() //nolint:errcheck
			writeErr(w, http.StatusBadRequest, "each segment must have id and text")
			return
		}
		res, err := tx.ExecContext(r.Context(),
			`UPDATE transcript_segments SET text = $1, approved = false
			 WHERE id = $2 AND job_id = $3`,
			seg.Text, seg.ID, jobID)
		if err != nil {
			d.Logger.Error("update transcript: update segment", "error", err, "segment_id", seg.ID)
			writeErr(w, http.StatusInternalServerError, "internal server error")
			return
		}
		rows, _ := res.RowsAffected()
		if rows == 0 {
			writeErr(w, http.StatusNotFound, fmt.Sprintf("segment %s not found in job", seg.ID))
			return
		}
	}

	if err := tx.Commit(); err != nil {
		d.Logger.Error("update transcript: commit", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	// Fetch updated segments for the re-synthesis payload.
	var segments []models.TranscriptSegment
	err = d.DB.SelectContext(r.Context(), &segments,
		`SELECT id, job_id, segment_idx, start_ms, end_ms, text, words_json, confidence, audio_path, approved, flagged
		 FROM transcript_segments WHERE job_id = $1 ORDER BY segment_idx`, jobID)
	if err != nil {
		d.Logger.Error("update transcript: fetch updated segments", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	// Update job stage.
	_, err = d.DB.ExecContext(r.Context(),
		`UPDATE jobs SET stage = $1, updated_at = $2 WHERE id = $3`,
		models.StageTranscribed, time.Now().UTC(), jobID)
	if err != nil {
		d.Logger.Error("update transcript: update job stage", "error", err)
		// Non-fatal — continue to publish.
	}

	// Publish re-synthesis message.
	msg := models.QueueMessage{
		JobID:   jobID,
		TraceID: job.TraceID,
		Payload: models.TranscriptPayload{
			Segments: segments,
			VoiceID:  job.VoiceID,
		},
	}
	if err := d.Queue.Publish(r.Context(), queue.TranscriptQueue, msg); err != nil {
		d.Logger.Error("update transcript: publish re-synthesis", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "failed to enqueue re-synthesis")
		return
	}

	d.Logger.Info("transcript updated, re-synthesis queued", "job_id", jobID)
	writeJSON(w, http.StatusOK, transcriptResponse{Segments: segments})
}

// ---------- helpers ----------

// s3KeysForJob collects all S3 keys associated with a job for cleanup.
func s3KeysForJob(j models.Job) []string {
	keys := []string{j.OriginalFile}
	if j.FramesPath.Valid {
		keys = append(keys, j.FramesPath.String)
	}
	if j.AudioPath.Valid {
		keys = append(keys, j.AudioPath.String)
	}
	if j.OutputFile.Valid {
		keys = append(keys, j.OutputFile.String)
	}
	return keys
}
