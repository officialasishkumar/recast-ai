package handler

import (
	"database/sql"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// RegenerateSegment triggers re-synthesis of a single transcript segment.
// It clears the segment's approved/flagged flags and publishes a transcript
// message carrying only that segment so TTS regenerates just this one.
//
//	POST /v1/jobs/{id}/segments/{segmentId}/regenerate
func (d *Deps) RegenerateSegment(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	jobID := chi.URLParam(r, "id")
	segmentID := chi.URLParam(r, "segmentId")
	if jobID == "" || segmentID == "" {
		writeErr(w, http.StatusBadRequest, "job id and segment id are required")
		return
	}

	// Verify ownership and fetch the fields we need for the queue message.
	var job models.Job
	err := d.DB.GetContext(r.Context(), &job,
		`SELECT id, user_id, voice_id, trace_id FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("regenerate segment: query job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if job.UserID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	// Reset the segment's review flags; this also signals downstream that it
	// is awaiting re-synthesis.
	res, err := d.DB.ExecContext(r.Context(),
		`UPDATE transcript_segments SET approved = false, flagged = false
		 WHERE id = $1 AND job_id = $2`,
		segmentID, jobID)
	if err != nil {
		d.Logger.Error("regenerate segment: update segment", "error", err, "segment_id", segmentID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		writeErr(w, http.StatusNotFound, "segment not found")
		return
	}

	// Fetch the full segment row for the re-synthesis payload.
	var segment models.TranscriptSegment
	err = d.DB.GetContext(r.Context(), &segment,
		`SELECT id, job_id, segment_idx, start_ms, end_ms, text, words_json, confidence, audio_path, approved, flagged
		 FROM transcript_segments WHERE id = $1 AND job_id = $2`,
		segmentID, jobID)
	if err != nil {
		d.Logger.Error("regenerate segment: fetch segment", "error", err, "segment_id", segmentID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	msg := models.QueueMessage{
		JobID:   jobID,
		TraceID: job.TraceID,
		Payload: models.TranscriptPayload{
			Segments: []models.TranscriptSegment{segment},
			VoiceID:  job.VoiceID,
		},
	}
	if err := d.Queue.Publish(r.Context(), queue.TranscriptQueue, msg); err != nil {
		d.Logger.Error("regenerate segment: publish", "error", err, "job_id", jobID, "segment_id", segmentID)
		writeErr(w, http.StatusInternalServerError, "failed to enqueue re-synthesis")
		return
	}

	d.Logger.Info("segment regeneration queued", "job_id", jobID, "segment_id", segmentID)
	w.WriteHeader(http.StatusAccepted)
}
