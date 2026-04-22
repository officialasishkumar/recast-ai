package handler

import (
	"database/sql/driver"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
)

// TestRegenerateSegment_AuthFailure confirms the handler rejects
// unauthenticated callers with 401.
func TestRegenerateSegment_AuthFailure(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	r := chi.NewRouter()
	r.Post("/v1/jobs/{id}/segments/{segmentId}/regenerate", deps.RegenerateSegment)

	req := httptest.NewRequest(http.MethodPost, "/v1/jobs/job-1/segments/seg-1/regenerate", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

// TestRegenerateSegment_HappyPath exercises the full handler: ownership
// lookup, segment update, segment re-read, and queue publish.
func TestRegenerateSegment_HappyPath(t *testing.T) {
	db := newFakeDB(t)
	pub := &fakePublisher{}
	deps := newDeps(db, pub)

	// 1. Ownership query.
	sharedDriver.On("SELECT id, user_id, voice_id, trace_id FROM jobs", fakeResult{
		rows: []fakeRow{{
			cols: []string{"id", "user_id", "voice_id", "trace_id"},
			vals: []driver.Value{"job-1", "user-1", "voice-1", "trace-1"},
		}},
	}, false)
	// 2. UPDATE transcript_segments.
	sharedDriver.On("UPDATE transcript_segments", fakeResult{
		exec: struct {
			lastInsertID int64
			rowsAffected int64
		}{0, 1},
	}, false)
	// 3. Re-read segment.
	sharedDriver.On("FROM transcript_segments WHERE id", fakeResult{
		rows: []fakeRow{{
			cols: []string{
				"id", "job_id", "segment_idx", "start_ms", "end_ms",
				"text", "words_json", "confidence", "audio_path",
				"approved", "flagged",
			},
			vals: []driver.Value{
				"seg-1", "job-1", int64(0), int64(0), int64(1000),
				"hello world", "[]", float64(0.9), "",
				false, false,
			},
		}},
	}, false)

	r := chi.NewRouter()
	r.Post("/v1/jobs/{id}/segments/{segmentId}/regenerate", deps.RegenerateSegment)

	req := httptest.NewRequest(http.MethodPost, "/v1/jobs/job-1/segments/seg-1/regenerate", nil)
	req = req.WithContext(ctxWithClaims("user-1", "user"))
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (body: %s)", rr.Code, rr.Body.String())
	}

	if len(pub.published) != 1 {
		t.Fatalf("expected 1 message published, got %d", len(pub.published))
	}
	msg := pub.published[0]
	if msg.Queue != queue.TranscriptQueue {
		t.Fatalf("expected publish to %q, got %q", queue.TranscriptQueue, msg.Queue)
	}
	env, ok := msg.Message.(models.QueueMessage)
	if !ok {
		t.Fatalf("expected QueueMessage, got %T", msg.Message)
	}
	payload, ok := env.Payload.(models.TranscriptPayload)
	if !ok {
		t.Fatalf("expected TranscriptPayload, got %T", env.Payload)
	}
	if len(payload.Segments) != 1 || payload.Segments[0].ID != "seg-1" {
		t.Fatalf("expected single segment payload for seg-1, got %+v", payload.Segments)
	}
}
