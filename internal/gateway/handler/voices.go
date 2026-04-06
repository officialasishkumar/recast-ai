package handler

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/officialasishkumar/recast-ai/pkg/models"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// ---------- response types ----------

type listVoicesResponse struct {
	Voices []models.Voice `json:"voices"`
}

type exportResponse struct {
	URL       string `json:"url"`
	ExpiresIn int    `json:"expires_in_seconds"`
}

// ---------- handlers ----------

// ListVoices returns all available voices. Voices marked pro_only are excluded
// for free-tier users unless they have the "pro" or "admin" role.
//
//	GET /v1/voices
func (d *Deps) ListVoices(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())

	// Determine whether to include pro-only voices.
	includePro := false
	if claims != nil && (claims.Role == models.RolePro || claims.Role == models.RoleAdmin) {
		includePro = true
	}

	var voices []models.Voice
	var err error
	if includePro {
		err = d.DB.SelectContext(r.Context(), &voices,
			`SELECT id, name, gender, accent, provider, pro_only, sample_url
			 FROM voices ORDER BY name`)
	} else {
		err = d.DB.SelectContext(r.Context(), &voices,
			`SELECT id, name, gender, accent, provider, pro_only, sample_url
			 FROM voices WHERE pro_only = false ORDER BY name`)
	}
	if err != nil {
		d.Logger.Error("list voices: query", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if voices == nil {
		voices = []models.Voice{}
	}

	writeJSON(w, http.StatusOK, listVoicesResponse{Voices: voices})
}

// ExportJob generates a presigned download URL for a completed job's output
// file. The URL is valid for 1 hour.
//
//	GET /v1/jobs/{id}/export
func (d *Deps) ExportJob(w http.ResponseWriter, r *http.Request) {
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
		`SELECT id, user_id, stage, output_file FROM jobs WHERE id = $1`, jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "job not found")
			return
		}
		d.Logger.Error("export job: query", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if job.UserID != claims.UserID && claims.Role != models.RoleAdmin {
		writeErr(w, http.StatusNotFound, "job not found")
		return
	}

	if job.Stage != models.StageCompleted {
		writeErr(w, http.StatusConflict, "job is not yet completed")
		return
	}

	if !job.OutputFile.Valid || job.OutputFile.String == "" {
		writeErr(w, http.StatusConflict, "output file is not available")
		return
	}

	expiry := 1 * time.Hour
	url, err := d.Store.PresignedGetURL(r.Context(), job.OutputFile.String, expiry)
	if err != nil {
		d.Logger.Error("export job: presign", "error", err, "job_id", jobID)
		writeErr(w, http.StatusInternalServerError, "failed to generate download URL")
		return
	}

	writeJSON(w, http.StatusOK, exportResponse{
		URL:       url,
		ExpiresIn: int(expiry.Seconds()),
	})
}
