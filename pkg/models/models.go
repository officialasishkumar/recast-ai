package models

import (
	"database/sql"
	"time"
)

// User roles.
const (
	// RoleGuest identifies an anonymous or unauthenticated principal.
	RoleGuest = "guest"
	// RoleUser identifies a standard authenticated user.
	RoleUser = "user"
	// RoleAdmin identifies a privileged administrator.
	RoleAdmin = "admin"
)

// Job stages.
const (
	StageUploaded     = "uploaded"
	StageAnalyzing    = "analyzing"
	StageAnalyzed     = "analyzed"
	StageTranscribing = "transcribing"
	StageTranscribed  = "transcribed"
	StageSynthesizing = "synthesizing"
	StageSynthesized  = "synthesized"
	StageMuxing       = "muxing"
	StageMuxed        = "muxed"
	StageDelivering   = "delivering"
	StageCompleted    = "completed"
	StageFailed       = "failed"
)

// User represents a platform user.
type User struct {
	ID            string         `db:"id" json:"id"`
	Email         string         `db:"email" json:"email"`
	PasswordHash  sql.NullString `db:"password_hash" json:"-"`
	Name          string         `db:"name" json:"name"`
	Role          string         `db:"role" json:"role"`
	OAuthProvider sql.NullString `db:"oauth_provider" json:"-"`
	OAuthID       sql.NullString `db:"oauth_id" json:"-"`
	AvatarURL     sql.NullString `db:"avatar_url" json:"avatar_url,omitempty"`
	CreatedAt     time.Time      `db:"created_at" json:"created_at"`
	UpdatedAt     time.Time      `db:"updated_at" json:"updated_at"`
}

// Job represents a video processing job.
type Job struct {
	ID            string         `db:"id" json:"id"`
	UserID        string         `db:"user_id" json:"user_id"`
	Stage         string         `db:"stage" json:"stage"`
	OriginalFile  string         `db:"original_file" json:"original_file"`
	OriginalName  string         `db:"original_name" json:"original_name"`
	DurationMs    int64          `db:"duration_ms" json:"duration_ms"`
	VoiceID       string         `db:"voice_id" json:"voice_id"`
	Style         string         `db:"style" json:"style"`
	Language      string         `db:"language" json:"language"`
	Priority      int            `db:"priority" json:"priority"`
	AudioPath     sql.NullString `db:"audio_path" json:"audio_path,omitempty"`
	OutputFile    sql.NullString `db:"output_file" json:"output_file,omitempty"`
	DownloadURL   sql.NullString `db:"download_url" json:"download_url,omitempty"`
	ShareToken    sql.NullString `db:"share_token" json:"share_token,omitempty"`
	ThumbnailPath sql.NullString `db:"thumbnail_path" json:"thumbnail_path,omitempty"`
	ErrorMessage  sql.NullString `db:"error_message" json:"error_message,omitempty"`
	TraceID       string         `db:"trace_id" json:"trace_id"`
	CreatedAt     time.Time      `db:"created_at" json:"created_at"`
	UpdatedAt     time.Time      `db:"updated_at" json:"updated_at"`
	CompletedAt   sql.NullTime   `db:"completed_at" json:"completed_at,omitempty"`
}

// TranscriptSegment represents a single narration segment with word-level timestamps.
type TranscriptSegment struct {
	ID         string  `db:"id" json:"id"`
	JobID      string  `db:"job_id" json:"job_id"`
	SegmentIdx int     `db:"segment_idx" json:"segment_id"`
	StartMs    int64   `db:"start_ms" json:"start_ms"`
	EndMs      int64   `db:"end_ms" json:"end_ms"`
	Text       string  `db:"text" json:"text"`
	Words      []Word  `json:"words"`
	WordsJSON  string  `db:"words_json" json:"-"`
	Confidence float64 `db:"confidence" json:"confidence"`
	AudioPath  string  `db:"audio_path" json:"audio_path,omitempty"`
	Approved   bool    `db:"approved" json:"approved"`
	Flagged    bool    `db:"flagged" json:"flagged"`
}

// Word represents a single word with its timestamp.
type Word struct {
	Word    string `json:"word"`
	StartMs int64  `json:"start_ms"`
	EndMs   int64  `json:"end_ms"`
}

// Voice represents a TTS voice option.
type Voice struct {
	ID        string `db:"id" json:"id"`
	Name      string `db:"name" json:"name"`
	Gender    string `db:"gender" json:"gender"`
	Accent    string `db:"accent" json:"accent"`
	Provider  string `db:"provider" json:"provider"`
	SampleURL string `db:"sample_url" json:"sample_url"`
}

// Webhook represents a user-registered webhook endpoint.
type Webhook struct {
	ID        string    `db:"id" json:"id"`
	UserID    string    `db:"user_id" json:"user_id"`
	URL       string    `db:"url" json:"url"`
	Secret    string    `db:"secret" json:"-"`
	Active    bool      `db:"active" json:"active"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

// --- Queue message types ---

// QueueMessage is the envelope for all inter-service messages.
type QueueMessage struct {
	JobID          string `json:"job_id"`
	TraceID        string `json:"trace_id"`
	StageAttemptID string `json:"stage_attempt_id"`
	Payload        any    `json:"payload,omitempty"`
}

// IngestionPayload is published after upload completes.
type IngestionPayload struct {
	UserID       string `json:"user_id"`
	OriginalFile string `json:"original_file"`
	VoiceID      string `json:"voice_id"`
	Style        string `json:"style"`
	Language     string `json:"language"`
	DurationMs   int64  `json:"duration_ms,omitempty"`
}

// TranscriptPayload is published after LLM transcript generation.
type TranscriptPayload struct {
	Segments   []TranscriptSegment `json:"segments"`
	VoiceID    string              `json:"voice_id"`
	DurationMs int64               `json:"duration_ms,omitempty"`
}

// AudioPayload is published after TTS synthesis.
type AudioPayload struct {
	AudioFile    string `json:"audio_file"`
	OriginalFile string `json:"original_file"`
	DurationMs   int64  `json:"duration_ms"`
}

// DeliveryPayload is published after muxing.
type DeliveryPayload struct {
	OutputFile string `json:"output_file"`
	UserID     string `json:"user_id"`
}

// JobEvent is a WebSocket event sent to the frontend.
type JobEvent struct {
	Event      string  `json:"event"`
	JobID      string  `json:"job_id"`
	Stage      string  `json:"stage"`
	Progress   float64 `json:"progress"`
	ETASeconds int     `json:"eta_seconds,omitempty"`
	Error      string  `json:"error,omitempty"`
}
