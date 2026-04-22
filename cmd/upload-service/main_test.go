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
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/officialasishkumar/recast-ai/pkg/auth"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
)

// ---- test doubles ----

type fakeStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	failGet string
}

func newFakeStore() *fakeStore {
	return &fakeStore{objects: map[string][]byte{}}
}

func (f *fakeStore) Upload(_ context.Context, key string, r io.Reader, size int64, _ string) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if size >= 0 && int64(len(b)) != size {
		return fmt.Errorf("size mismatch: expected %d got %d", size, len(b))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = append([]byte(nil), b...)
	return nil
}

func (f *fakeStore) Download(_ context.Context, key string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if key == f.failGet {
		return nil, errors.New("simulated download failure")
	}
	b, ok := f.objects[key]
	if !ok {
		return nil, fmt.Errorf("not found: %s", key)
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (f *fakeStore) Delete(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, key)
	return nil
}

type fakePublisher struct {
	mu       sync.Mutex
	messages []capturedMessage
}

type capturedMessage struct {
	Queue string
	Msg   any
}

func (p *fakePublisher) Publish(_ context.Context, q string, msg any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages = append(p.messages, capturedMessage{Queue: q, Msg: msg})
	return nil
}

func (p *fakePublisher) last() capturedMessage {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.messages[len(p.messages)-1]
}

// ---- helpers ----

func newTestServer(t *testing.T, probe probeFn) (*server, *fakeStore, *fakePublisher, config.Auth) {
	t.Helper()
	store := newFakeStore()
	pub := &fakePublisher{}
	authCfg := config.Auth{
		JWTSecret:     "test-secret",
		JWTExpiry:     15 * time.Minute,
		RefreshExpiry: time.Hour,
	}
	s := &server{
		logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		store:     store,
		publisher: pub,
		tracker:   &memoryTracker{data: map[string]map[int]int64{}},
		probe:     probe,
		authCfg:   authCfg,
	}
	return s, store, pub, authCfg
}

func newRouter(s *server, authCfg config.Auth) http.Handler {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	r.Group(func(pr chi.Router) {
		pr.Use(jwtMiddleware(authCfg))
		pr.Post("/v1/upload/chunk", s.handleChunk)
		pr.Post("/v1/upload/complete", s.handleComplete)
		pr.Get("/v1/upload/{id}/status", s.handleStatus)
		pr.Delete("/v1/upload/{id}", s.handleDelete)
	})
	return r
}

func mustToken(t *testing.T, authCfg config.Auth, userID string) string {
	t.Helper()
	tok, err := auth.GenerateToken(authCfg.JWTSecret, userID, "u@example.com", "user", authCfg.JWTExpiry)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	return tok
}

func uploadChunk(t *testing.T, h http.Handler, token, uploadID string, idx int, body []byte) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		fmt.Sprintf("/v1/upload/chunk?upload_id=%s&chunk_idx=%d", uploadID, idx),
		bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Result()
}

// ---- tests ----

func TestHealthPublic(t *testing.T) {
	s, _, _, authCfg := newTestServer(t, nil)
	h := newRouter(s, authCfg)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", w.Code)
	}
}

func TestAuthRequired(t *testing.T) {
	s, _, _, authCfg := newTestServer(t, nil)
	h := newRouter(s, authCfg)
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/chunk?upload_id=abc&chunk_idx=0", bytes.NewReader([]byte("x")))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 got %d", w.Code)
	}
}

func TestChunkUploadAndStatus(t *testing.T) {
	s, _, _, authCfg := newTestServer(t, nil)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "user-1")
	uploadID := "upload-abc"

	resp := uploadChunk(t, h, token, uploadID, 0, []byte("hello"))
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("chunk 0: expected 200 got %d body=%s", resp.StatusCode, string(b))
	}
	resp = uploadChunk(t, h, token, uploadID, 1, []byte("world"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("chunk 1: expected 200 got %d", resp.StatusCode)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/upload/"+uploadID+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status expected 200 got %d", w.Code)
	}
	var st statusResponse
	if err := json.NewDecoder(w.Body).Decode(&st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if st.Chunks != 2 {
		t.Fatalf("expected 2 chunks got %d", st.Chunks)
	}
	if st.Size != 10 {
		t.Fatalf("expected size 10 got %d", st.Size)
	}
}

func TestCompleteRejectsNonVideo(t *testing.T) {
	// probe fails as if ffprobe couldn't parse the file.
	probe := func(_ context.Context, _ string) (*probeResult, error) {
		return nil, errors.New("not a video")
	}
	s, _, pub, authCfg := newTestServer(t, probe)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "user-1")
	uploadID := "not-a-video"

	if r := uploadChunk(t, h, token, uploadID, 0, []byte("PK\x03\x04garbage")); r.StatusCode != 200 {
		t.Fatalf("chunk upload failed: %d", r.StatusCode)
	}

	body, _ := json.Marshal(completeRequest{
		Filename: "malicious.mp4",
		VoiceID:  "v1",
		Style:    "neutral",
		Language: "en",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/complete?upload_id="+uploadID, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "not a valid video") {
		t.Fatalf("unexpected error body: %s", w.Body.String())
	}
	if len(pub.messages) != 0 {
		t.Fatalf("publisher must not be called on invalid video; got %d messages", len(pub.messages))
	}
}

func TestCompleteRejectsNoVideoStream(t *testing.T) {
	probe := func(_ context.Context, _ string) (*probeResult, error) {
		return &probeResult{HasVideo: false, DurationMs: 5000}, nil
	}
	s, _, pub, authCfg := newTestServer(t, probe)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "user-1")
	uploadID := "audio-only"

	uploadChunk(t, h, token, uploadID, 0, []byte("data"))

	body, _ := json.Marshal(completeRequest{Filename: "clip.mp4"})
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/complete?upload_id="+uploadID, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d", w.Code)
	}
	if len(pub.messages) != 0 {
		t.Fatalf("publisher must not be invoked")
	}
}

func TestCompleteRejectsDurationTooLong(t *testing.T) {
	probe := func(_ context.Context, _ string) (*probeResult, error) {
		return &probeResult{HasVideo: true, DurationMs: maxDurationMs + 1}, nil
	}
	s, _, pub, authCfg := newTestServer(t, probe)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "user-1")

	uploadChunk(t, h, token, "too-long", 0, []byte("x"))
	body, _ := json.Marshal(completeRequest{Filename: "x.mp4"})
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/complete?upload_id=too-long", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d", w.Code)
	}
	if len(pub.messages) != 0 {
		t.Fatalf("publisher must not be invoked")
	}
}

func TestCompletePublishesIngestionMessage(t *testing.T) {
	probe := func(_ context.Context, _ string) (*probeResult, error) {
		return &probeResult{HasVideo: true, DurationMs: 30 * 1000}, nil
	}
	s, store, pub, authCfg := newTestServer(t, probe)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "user-42")
	uploadID := "happy-path"

	uploadChunk(t, h, token, uploadID, 0, []byte("hello-"))
	uploadChunk(t, h, token, uploadID, 1, []byte("world"))

	body, _ := json.Marshal(completeRequest{
		Filename: "clip.mp4",
		VoiceID:  "voice-9",
		Style:    "documentary",
		Language: "fr",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/complete?upload_id="+uploadID, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 got %d body=%s", w.Code, w.Body.String())
	}

	var comp completeResponse
	if err := json.NewDecoder(w.Body).Decode(&comp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	expectedKey := "uploads/" + uploadID + "/final.mp4"
	if comp.ObjectKey != expectedKey {
		t.Fatalf("expected object_key %q got %q", expectedKey, comp.ObjectKey)
	}
	if comp.JobID == "" {
		t.Fatalf("job_id must be set")
	}
	if _, ok := store.objects[expectedKey]; !ok {
		t.Fatalf("expected final object persisted to storage")
	}
	// partial chunks should be cleaned up.
	if _, ok := store.objects[chunkKey(uploadID, 0)]; ok {
		t.Fatalf("expected chunk 0 to be deleted post-complete")
	}

	if len(pub.messages) != 1 {
		t.Fatalf("expected exactly 1 queue message got %d", len(pub.messages))
	}
	last := pub.last()
	if last.Queue != queue.IngestionQueue {
		t.Fatalf("expected %s got %s", queue.IngestionQueue, last.Queue)
	}
	qm, ok := last.Msg.(models.QueueMessage)
	if !ok {
		t.Fatalf("expected QueueMessage got %T", last.Msg)
	}
	if qm.JobID == "" || qm.TraceID == "" || qm.StageAttemptID == "" {
		t.Fatalf("envelope fields must be set: %+v", qm)
	}
	payload, ok := qm.Payload.(models.IngestionPayload)
	if !ok {
		t.Fatalf("expected IngestionPayload got %T", qm.Payload)
	}
	if payload.UserID != "user-42" {
		t.Fatalf("expected user id from jwt, got %q", payload.UserID)
	}
	if payload.OriginalFile != expectedKey {
		t.Fatalf("expected original_file %q got %q", expectedKey, payload.OriginalFile)
	}
	if payload.VoiceID != "voice-9" || payload.Style != "documentary" || payload.Language != "fr" {
		t.Fatalf("payload fields mismatch: %+v", payload)
	}
}

func TestCompleteUnsupportedExtension(t *testing.T) {
	s, _, pub, authCfg := newTestServer(t, func(_ context.Context, _ string) (*probeResult, error) {
		return &probeResult{HasVideo: true, DurationMs: 100}, nil
	})
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "u")
	uploadChunk(t, h, token, "bad-ext", 0, []byte("x"))
	body, _ := json.Marshal(completeRequest{Filename: "ransomware.exe"})
	req := httptest.NewRequest(http.MethodPost, "/v1/upload/complete?upload_id=bad-ext", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d", w.Code)
	}
	if len(pub.messages) != 0 {
		t.Fatalf("publisher must not be invoked for unsupported extension")
	}
}

func TestDeletePurgesChunks(t *testing.T) {
	s, store, _, authCfg := newTestServer(t, nil)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "u")
	id := "purge-me"
	uploadChunk(t, h, token, id, 0, []byte("a"))
	uploadChunk(t, h, token, id, 1, []byte("b"))

	req := httptest.NewRequest(http.MethodDelete, "/v1/upload/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", w.Code)
	}
	if _, ok := store.objects[chunkKey(id, 0)]; ok {
		t.Fatalf("chunk 0 should be deleted")
	}
	n, _ := s.tracker.ChunkCount(context.Background(), id)
	if n != 0 {
		t.Fatalf("tracker should be empty, got %d", n)
	}
}

func TestChunkRejectsOversizedTotal(t *testing.T) {
	s, _, _, authCfg := newTestServer(t, nil)
	// Pre-fill the tracker so the next chunk pushes over 2 GB.
	_ = s.tracker.RecordChunk(context.Background(), "big", 0, maxTotalUploadSize)
	h := newRouter(s, authCfg)
	token := mustToken(t, authCfg, "u")
	resp := uploadChunk(t, h, token, "big", 1, []byte("one-more-byte"))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 got %d", resp.StatusCode)
	}
}

func TestIsSafeID(t *testing.T) {
	ok := []string{"abc", "a-b_c", "ABC123"}
	bad := []string{"", "../etc/passwd", "a/b", "x y", strings.Repeat("a", 129)}
	for _, s := range ok {
		if !isSafeID(s) {
			t.Errorf("expected safe: %q", s)
		}
	}
	for _, s := range bad {
		if isSafeID(s) {
			t.Errorf("expected unsafe: %q", s)
		}
	}
}

// ensure the writeError helper writes clean JSON and status (regression).
func TestWriteError(t *testing.T) {
	w := httptest.NewRecorder()
	writeError(w, http.StatusTeapot, "boom")
	if w.Code != http.StatusTeapot {
		t.Fatalf("bad code: %d", w.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] != "boom" {
		t.Fatalf("bad body: %v", body)
	}
}

// sanity check: make sure test env does not need real ffprobe/minio/redis.
func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
