package handler

import (
	"database/sql/driver"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// TestListJobs_AuthFailure confirms ListJobs returns 401 when no claims are
// attached to the request context.
func TestListJobs_AuthFailure(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	req := httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)
	rr := httptest.NewRecorder()

	deps.ListJobs(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}

// TestListJobs_HappyPath verifies the handler returns a jobs envelope after
// reading rows from the database.
func TestListJobs_HappyPath(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	// One job row with all selected columns present.
	now := time.Now().UTC()
	cols := []string{
		"id", "user_id", "stage", "original_file", "original_name", "duration_ms",
		"voice_id", "style", "language", "priority", "audio_path",
		"output_file", "download_url", "error_message", "trace_id",
		"created_at", "updated_at", "completed_at",
	}
	sharedDriver.On("FROM jobs WHERE user_id", fakeResult{
		rows: []fakeRow{{
			cols: cols,
			vals: []driver.Value{
				"job-1", "user-1", "uploaded", "uploads/job-1/vid.mp4", "vid.mp4", int64(0),
				"voice-1", "conversational", "en", int64(0), nil,
				nil, nil, nil, "trace-1",
				now, now, nil,
			},
		}},
	}, false)

	req := httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)
	req = req.WithContext(ctxWithClaims("user-1", "user"))
	rr := httptest.NewRecorder()

	deps.ListJobs(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"job-1"`) {
		t.Fatalf("expected job-1 in body: %s", rr.Body.String())
	}
}

// TestGetJob_OwnershipCheck confirms GetJob returns 404 when the caller is
// neither the owner nor an admin. We return 404 (not 403) to avoid leaking
// job existence.
func TestGetJob_OwnershipCheck(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	now := time.Now().UTC()
	cols := []string{
		"id", "user_id", "stage", "original_file", "original_name", "duration_ms",
		"voice_id", "style", "language", "priority", "audio_path",
		"output_file", "download_url", "error_message", "trace_id",
		"created_at", "updated_at", "completed_at",
	}
	sharedDriver.On("FROM jobs WHERE id", fakeResult{
		rows: []fakeRow{{
			cols: cols,
			vals: []driver.Value{
				"job-1", "owner-user", "uploaded", "uploads/job-1/vid.mp4", "vid.mp4", int64(0),
				"voice-1", "conversational", "en", int64(0), nil,
				nil, nil, nil, "trace-1",
				now, now, nil,
			},
		}},
	}, false)

	r := chi.NewRouter()
	r.Get("/v1/jobs/{id}", deps.GetJob)

	req := httptest.NewRequest(http.MethodGet, "/v1/jobs/job-1", nil)
	req = req.WithContext(ctxWithClaims("different-user", "user"))
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user access, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}

// TestUpdateTranscript_AuthFailure confirms 401 without claims.
func TestUpdateTranscript_AuthFailure(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	body := strings.NewReader(`{"segments":[{"id":"seg-1","text":"hello"}]}`)
	req := httptest.NewRequest(http.MethodPatch, "/v1/jobs/job-1/transcript", body)
	rr := httptest.NewRecorder()

	r := chi.NewRouter()
	r.Patch("/v1/jobs/{id}/transcript", deps.UpdateTranscript)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}

	var body2 map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body2)
	if body2["error"] == "" {
		t.Fatalf("expected JSON error body, got %s", rr.Body.String())
	}
}
