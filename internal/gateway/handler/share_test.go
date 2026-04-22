package handler

import (
	"database/sql/driver"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestGenerateShareToken is a pure-logic check: tokens should be URL-safe,
// 43 chars (32 bytes base64 raw url), and unique per call.
func TestGenerateShareToken(t *testing.T) {
	a, err := generateShareToken()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(a) != 43 {
		t.Fatalf("expected length 43, got %d (%q)", len(a), a)
	}
	for _, c := range a {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			t.Fatalf("non url-safe character %q in token %q", c, a)
		}
	}
	b, err := generateShareToken()
	if err != nil {
		t.Fatalf("generate 2: %v", err)
	}
	if a == b {
		t.Fatalf("expected unique tokens, got same: %q", a)
	}
}

// TestCreateShare_AuthFailure confirms anonymous callers cannot create a
// share.
func TestCreateShare_AuthFailure(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	r := chi.NewRouter()
	r.Post("/v1/jobs/{id}/share", deps.CreateShare)

	req := httptest.NewRequest(http.MethodPost, "/v1/jobs/job-1/share", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}

// TestCreateShare_HappyPath verifies an owner can create a share and receive
// a token + URL.
func TestCreateShare_HappyPath(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	// Ownership lookup: returns user-1 as owner of job-1.
	sharedDriver.On("SELECT user_id FROM jobs WHERE id", fakeResult{
		rows: []fakeRow{{
			cols: []string{"user_id"},
			vals: []driver.Value{"user-1"},
		}},
	}, false)
	// UPDATE setting share_token.
	sharedDriver.On("UPDATE jobs SET share_token", fakeResult{
		exec: struct {
			lastInsertID int64
			rowsAffected int64
		}{0, 1},
	}, false)

	r := chi.NewRouter()
	r.Post("/v1/jobs/{id}/share", deps.CreateShare)

	req := httptest.NewRequest(http.MethodPost, "/v1/jobs/job-1/share", nil)
	req = req.WithContext(ctxWithClaims("user-1", "user"))
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rr.Code, rr.Body.String())
	}

	var resp createShareResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token == "" || !strings.HasPrefix(resp.URL, "/share/") {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

// TestPublicShare_NotFound confirms 404 when the share token does not match
// any job.
func TestPublicShare_NotFound(t *testing.T) {
	db := newFakeDB(t)
	deps := newDeps(db, &fakePublisher{})

	// Query returns no rows.
	sharedDriver.On("WHERE share_token", fakeResult{rows: nil}, false)

	r := chi.NewRouter()
	r.Get("/v1/public/shares/{token}", deps.PublicShare)

	req := httptest.NewRequest(http.MethodGet, "/v1/public/shares/unknown-token", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown token, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}
