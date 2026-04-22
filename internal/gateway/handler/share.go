package handler

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/officialasishkumar/recast-ai/pkg/models"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// sharePresignExpiry is how long presigned output URLs remain valid when
// returned from the public share endpoint.
const sharePresignExpiry = 1 * time.Hour

// ---------- response types ----------

type createShareResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
}

// publicJob is the trimmed job projection returned on the public share
// endpoint. It intentionally omits internal identifiers (user_id, trace_id).
type publicJob struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Duration  int64  `json:"duration"`
	Status    string `json:"status"`
	OutputURL string `json:"output_url,omitempty"`
}

type publicShareResponse struct {
	Job        publicJob                  `json:"job"`
	Transcript []models.TranscriptSegment `json:"transcript"`
}

// ---------- handlers ----------

// CreateShare generates a share token for a job so it can be viewed publicly
// without authentication.
//
//	POST /v1/jobs/{id}/share
func (d *Deps) CreateShare(w http.ResponseWriter, r *http.Request) {
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

	var owner string
	err := d.DB.GetContext(r.Context(), &owner,
		`SELECT user_id FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("create share: query job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if owner != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	token, err := generateShareToken()
	if err != nil {
		d.Logger.Error("create share: generate token", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if _, err := d.DB.ExecContext(r.Context(),
		`UPDATE jobs SET share_token = $1, updated_at = NOW() WHERE id = $2`,
		token, jobID); err != nil {
		d.Logger.Error("create share: update job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	d.Logger.Info("share created", "job_id", jobID, "user_id", claims.UserID)
	writeJSON(w, http.StatusOK, createShareResponse{
		Token: token,
		URL:   "/share/" + token,
	})
}

// DeleteShare clears the share token on a job, revoking public access.
//
//	DELETE /v1/jobs/{id}/share
func (d *Deps) DeleteShare(w http.ResponseWriter, r *http.Request) {
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

	var owner string
	err := d.DB.GetContext(r.Context(), &owner,
		`SELECT user_id FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("delete share: query job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if owner != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	if _, err := d.DB.ExecContext(r.Context(),
		`UPDATE jobs SET share_token = NULL, updated_at = NOW() WHERE id = $1`,
		jobID); err != nil {
		d.Logger.Error("delete share: update job", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	d.Logger.Info("share revoked", "job_id", jobID, "user_id", claims.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// PublicShare returns a shared job's public metadata and transcript without
// authentication. Jobs without a share_token are treated as not found.
//
//	GET /v1/public/shares/{token}
func (d *Deps) PublicShare(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeErr(w, http.StatusBadRequest, "share token is required")
		return
	}

	var row struct {
		ID           string         `db:"id"`
		OriginalName string         `db:"original_name"`
		DurationMs   int64          `db:"duration_ms"`
		Stage        string         `db:"stage"`
		OutputFile   sql.NullString `db:"output_file"`
		ShareToken   sql.NullString `db:"share_token"`
	}
	err := d.DB.GetContext(r.Context(), &row,
		`SELECT id, original_name, duration_ms, stage, output_file, share_token
		 FROM jobs WHERE share_token = $1`, token)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "share not found")
			return
		}
		d.Logger.Error("public share: query job", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if !row.ShareToken.Valid || row.ShareToken.String == "" {
		writeErr(w, http.StatusNotFound, "share not found")
		return
	}

	var segments []models.TranscriptSegment
	err = d.DB.SelectContext(r.Context(), &segments,
		`SELECT id, job_id, segment_idx, start_ms, end_ms, text, words_json, confidence, audio_path, approved, flagged
		 FROM transcript_segments WHERE job_id = $1 ORDER BY segment_idx`, row.ID)
	if err != nil {
		d.Logger.Error("public share: query segments", "error", err, "job_id", row.ID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if segments == nil {
		segments = []models.TranscriptSegment{}
	}

	outputURL := ""
	if row.OutputFile.Valid && row.OutputFile.String != "" && row.Stage == models.StageCompleted {
		if url, err := d.Store.PresignedGetURL(r.Context(), row.OutputFile.String, sharePresignExpiry); err == nil {
			outputURL = url
		} else {
			d.Logger.Warn("public share: presign output", "error", err, "job_id", row.ID)
		}
	}

	writeJSON(w, http.StatusOK, publicShareResponse{
		Job: publicJob{
			ID:        row.ID,
			Name:      row.OriginalName,
			Duration:  row.DurationMs,
			Status:    row.Stage,
			OutputURL: outputURL,
		},
		Transcript: segments,
	})
}

// ---------- helpers ----------

// generateShareToken returns 32 bytes of randomness encoded in URL-safe base64
// (no padding). The output is 43 characters, well within the share_token
// column's 64-char cap.
func generateShareToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
