# Recast AI — Product Specification

**Version:** 2.0 | **Date:** April 2026 | **Status:** Draft | **Classification:** Confidential

---

## 1. Executive Summary

Recast AI is an end-to-end cloud platform that converts any screen recording or video into a professionally narrated output — complete with AI-generated, time-synchronized voice-over — without requiring the creator to ever record their own voice.

The platform ingests a video, sends the whole file to a multimodal LLM (Google Gemini 2.5) in a single call, receives a scene-level transcript, synthesizes natural speech per segment using a neural TTS engine, derives word-level timings from the TTS output, dynamically adjusts speech rate to fit within scene boundaries, and delivers the final muxed video back to the user — all within a single secure, asynchronous pipeline.

**Core value proposition:** zero-effort, broadcast-quality narration for developers, educators, product teams, and content creators — in minutes, not hours.

### Key Differentiators

- Whole-video analysis via Gemini File API, not per-frame captioning.
- Word-level timestamp alignment derived from the TTS provider.
- Adaptive TTS speed control: speech is stretched or compressed to fit scene duration exactly.
- Fully asynchronous, queue-backed pipeline — each stage is independently scalable.
- Hardened LLM prompt injection defense at every AI boundary.

---

## 2. Problem & Opportunity

### The Problem

Screen recorders, demo tools, and video editors all share the same bottleneck: narration. Recording a clear, well-paced voice-over requires a quiet room, a decent microphone, multiple takes, and then careful sync editing. For developers shipping demos, educators making tutorials, and product managers producing walkthroughs, this is the slowest part of the workflow.

Existing workarounds fall short:

| Workaround | Why It Fails |
|---|---|
| Manual re-record | Time-consuming, requires hardware, multiple retakes, background noise. |
| Auto-captions only | Text only, no voice, poor sync, no timestamp granularity. |
| Generic TTS overlay | No timing alignment; speech runs over scene boundaries. |
| Outsource narration | Expensive, slow turnaround, no control over output. |
| Video editing software | Complex tooling, steep learning curve, not AI-native. |

### The Opportunity

Multimodal LLMs, high-quality neural TTS APIs, and scalable cloud message queues have matured to the point where a fully automated, word-level synchronized narration pipeline is technically feasible at low cost. The market is large: video content creation is growing rapidly and the developer-tooling and education verticals are underserved by existing AI video tools.

---

## 3. Product Overview

### Core User Flow

1. **Upload** — user uploads a video file (MP4, MOV, WebM).
2. **Analyze** — the whole video is sent to Gemini; the model returns a scene-level transcript.
3. **Review** — user reviews, edits, or regenerates segments of the transcript in the UI.
4. **Synthesize** — TTS engine generates voice audio per segment; speed is dynamically adjusted; word-level timings are produced alongside.
5. **Export** — final video is muxed with the new audio track and delivered for download or shared via a public link.

### Supported Input Formats

- **Video formats:** MP4 (H.264/H.265), MOV, WebM, AVI — up to 4K resolution.
- **Audio:** extracted automatically; silent videos are supported (the LLM reads screen content visually).

---

## 4. System Architecture

### Architecture Principle

Every processing stage is a stateless consumer that reads from a message queue and writes results back to a queue plus object storage. No stage calls another directly. This gives the system horizontal scalability, fault isolation, and natural retry semantics.

### Data Flow

```
Upload
  -> [ingestion.queue]
  -> Video Analyzer (Gemini File API)
  -> [transcript.queue]
  -> TTS Service
  -> [audio.queue]
  -> Mux Service
  -> [delivery.queue]
  -> Delivery Service
  -> User
```

### Services & Responsibilities

| Service | Responsibility | Stack |
|---|---|---|
| API Gateway | Auth, rate limiting, request validation, WebSocket fan-out. | Go, Chi router |
| Upload Service | Chunked upload handling, MIME validation, raw-video write to object storage. | Go |
| Video Analyzer | Uploads the whole video to Gemini File API, polls for `ACTIVE`, invokes schema-constrained `generate_content`, persists segments, deletes the remote file. | Python, `google-genai` |
| TTS Service | Calls TTS API per segment, extracts word-level timings from the provider response, applies FFmpeg `atempo` to fit the scene bound. | Python |
| Mux Service | Combines original video with synthesized audio into the final MP4, generates thumbnail. | Go + FFmpeg |
| Delivery Service | Writes final file to object storage, mints pre-signed download URL, dispatches webhooks. | Go |

### Technology Stack

| Layer | Choice |
|---|---|
| Backend APIs | Go (primary), Python (AI workers). |
| Frontend | Next.js 16 + React 19 + TypeScript + Tailwind CSS. |
| Message Queue | RabbitMQ with a DLQ per queue. |
| Object Storage | MinIO (S3-compatible) for raw uploads, segment audio, final video. |
| Database | PostgreSQL 17 (users, jobs, transcripts) + Redis 7 (session cache, job progress pub/sub). |
| LLM Provider | Google Gemini 2.5 Pro (default), Gemini 2.5 Flash (fallback for long videos). |
| TTS Provider | ElevenLabs / AWS Polly / gTTS — configurable per user. |
| Video Processing | FFmpeg. |
| Auth | JWT (HS256) with rotating refresh tokens plus optional Google / GitHub OAuth. |
| Observability | OpenTelemetry via OTLP collector, Prometheus metrics, JSON structured logs. |

---

## 5. Security Architecture

### Authentication & Authorization

- All protected API endpoints require a signed JWT (HS256). Access tokens expire in 15 minutes; refresh tokens are rotated on every use.
- OAuth social login (Google, GitHub) supported alongside email plus password.
- Role is either `user` or `admin`. Admin capability is preserved for internal operations; there is no paid tier gating anywhere in the system.
- Brute-force protection: accounts locked after repeated failed login attempts; CAPTCHA on signup.
- All sessions backed by Redis; logout invalidates the refresh token server-side immediately.

### LLM Prompt Injection Defense

> **Risk:** the LLM processes user-uploaded video content, which may contain on-screen text, audio, or visuals crafted to manipulate the model into producing harmful or off-topic output.

**Defense layers:**

1. **Output Schema.** The model is constrained by a JSON schema through `response_schema`, so text in the video cannot rewrite the contract.
2. **System Instruction Hardening.** The system prompt tells the model to treat any text appearing on screen as content to describe, not as instructions to follow.
3. **No User-Controlled System Prompt.** Users select only `style` (`formal` or `casual`) and `language`; both are validated against allow-lists.
4. **Output Scrubbing.** Segments are checked for zero-width characters and suspicious control sequences before persistence.
5. **Per-User Rate Limits.** LLM calls are rate-limited per user to prevent abuse of the AI pipeline.

### Data Security

- All data in transit: TLS 1.3 enforced; HSTS with a one-year max-age.
- All data at rest: AES-256 on object storage and PostgreSQL (encrypted disks).
- User videos stored under UUID-keyed object-storage prefixes with no guessable path. Pre-signed URLs expire in one hour.
- GDPR compliance: users can request full data export or deletion. Deletion purges all object-storage entries, DB rows, and in-flight queue messages.

### Infrastructure Security

- Services run in private networks; only the API gateway and CDN are internet-facing.
- Secrets managed via the platform secret store; no secrets in environment variables or source code at rest.
- Container images scanned for CVEs on every build; base images pinned to digests.
- Share tokens are 64-character URL-safe strings bound to a single job and are revocable.

---

## 6. Transcript & Timing Engine

### LLM Transcript Generation

The video analyzer uploads the whole video to Gemini File API, polls until the file is `ACTIVE`, and invokes `generate_content` with a schema-constrained response. The model returns an array of transcript segments.

**Transcript segment schema (Gemini response):**

```json
{
  "segment_id": 1,
  "start_ms": 0,
  "end_ms": 4200,
  "text": "Welcome to the product demo.",
  "confidence": 0.94
}
```

Word-level timings are **not** requested from Gemini. They are computed downstream by the TTS layer, which has accurate ground truth from the actual synthesized audio.

### Word-Level Timings (TTS-Sourced)

- **ElevenLabs:** the `alignment` response field carries per-character timings; the TTS service aggregates to word-level.
- **AWS Polly:** `SpeechMarks` of type `word` are requested alongside synthesis and used directly.
- **gTTS and any provider without native timings:** each word receives a slice of the segment duration proportional to its character count.

The canonical word-level timings live in `transcript_segments.words_json` and drive the interactive UI.

### Adaptive TTS Speed Control

Each transcript segment has a known duration (`end_ms - start_ms`). The TTS engine synthesizes speech at a neutral rate and measures the resulting audio duration. If the synthesized audio is longer or shorter than the target duration, FFmpeg's `atempo` filter is applied.

- **Speed adjustment bounds:** 0.75x (slow) to 1.5x (fast).
- If a segment cannot fit within those bounds, it is **flagged for human review**.
- The UI surfaces flagged segments with a warning indicator and manual override controls.

### Transcript Editor (UI)

- Side-by-side view: video player on the left, transcript editor on the right.
- Clicking a word in the transcript scrubs the video to that word's timestamp.
- Editing a segment triggers re-synthesis of only that segment via `POST /v1/jobs/:id/segments/:segmentId/regenerate`.
- Confidence score shown as color-coded badge: green > 0.85, yellow 0.6 to 0.85, red < 0.6.
- Users can split or merge segments and adjust timestamps with drag handles on the timeline.
- Keyboard shortcuts: approve, regenerate, jump to next flagged segment.

---

## 7. UI / UX Specification

### Design Principles

- **Premium aesthetic:** enlarged typography, generous whitespace, tokenized palette inspired by Linear, Vercel, Stripe, and Framer.
- **Real-time feedback:** job progress streamed via WebSocket; users see each pipeline stage complete in real time.
- **Non-blocking:** users can start multiple jobs, leave the page, and return to find results ready.
- **Accessible:** WCAG 2.1 AA compliance, full keyboard navigation, screen reader support.

### Key Screens

| Screen | Description |
|---|---|
| Dashboard | Job list with status badges and a quick-start upload button. |
| Upload & Configure | Drag-and-drop zone, voice selection, language, style (formal/casual), privacy toggle. |
| Processing View | Live pipeline progress: Upload -> Analyze -> Transcript -> Synthesize -> Mux -> Done. |
| Transcript Editor | Split-pane: video player plus word-level transcript; inline edit, regenerate, approve controls. |
| Export / Share | Download MP4, mint a public share link, revoke share, export SRT/VTT captions, export transcript JSON. |
| Settings | Profile, voice presets, webhook configuration. |
| Admin Panel | User management, job queue monitor, abuse flags (admin role only). |

### Real-Time Job Progress (WebSocket)

Once a job is submitted, the frontend opens a WebSocket connection to the job channel. The backend emits typed events as each queue consumer completes its stage:

```json
{
  "event": "stage_complete",
  "stage": "video_analysis",
  "progress": 0.33,
  "eta_seconds": 42
}
```

The UI renders a live pipeline diagram. Each stage node lights up when complete. ETA is updated in real time based on queue depth and historical processing times.

### Voice Selection

- Library of neural voices (gender, age, accent variants) across ElevenLabs and Polly.
- Voice preview: a short sample generated on demand from an arbitrary sentence.
- Per-segment voice override: assign a different voice to individual segments for dialogue.

---

## 8. API Specification

### REST Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/auth/register` | Register with email and password. |
| POST | `/v1/auth/login` | Login; returns JWT and refresh token. |
| POST | `/v1/auth/refresh` | Refresh the access token. |
| POST | `/v1/auth/logout` | Invalidate the refresh token. |
| GET | `/v1/auth/me` | Current user profile. |
| POST | `/v1/uploads` | Initiate a chunked upload. |
| PUT | `/v1/uploads/:id/parts/:n` | Upload a single part. |
| POST | `/v1/uploads/:id/complete` | Finalize the upload. |
| GET | `/v1/uploads/:id` | Upload status. |
| DELETE | `/v1/uploads/:id` | Abandon and clean up an upload. |
| POST | `/v1/jobs` | Create a job from a completed upload. |
| GET | `/v1/jobs` | List the caller's jobs. |
| GET | `/v1/jobs/:id` | Get job details. |
| DELETE | `/v1/jobs/:id` | Delete a job and all associated data. |
| GET | `/v1/jobs/:id/transcript` | Retrieve transcript segments with word-level timings. |
| PATCH | `/v1/jobs/:id/transcript` | Update transcript text; triggers re-synthesis of changed segments. |
| POST | `/v1/jobs/:id/segments/:segmentId/regenerate` | Re-synthesize a single segment. |
| POST | `/v1/jobs/:id/share` | Mint a public share token. |
| DELETE | `/v1/jobs/:id/share` | Revoke the share token. |
| GET | `/v1/jobs/:id/export` | Get a pre-signed download URL for the final MP4. |
| GET | `/v1/voices` | List available TTS voices. |
| POST | `/v1/voices/:id/preview` | Generate a short voice preview. |
| GET | `/v1/public/shares/:token` | Unauthenticated: returns job metadata, transcript, and download URL. |
| WS | `/v1/ws/jobs/:id` | Real-time job progress. |
| GET | `/healthz` | Liveness probe. |

### Webhook Payload

```json
{
  "event": "job.completed",
  "job_id": "abc123",
  "download_url": "https://cdn.recast.ai/...",
  "expires_at": "2026-05-06T12:00:00Z",
  "transcript_url": "https://cdn.recast.ai/.../transcript.json",
  "duration_ms": 183400
}
```

### Rate Limits

| Operation | Limit |
|---|---|
| API calls (default bucket) | 60 requests per minute per user (configurable via `RATE_LIMIT_PER_MINUTE`). |
| Transcript PATCH | 10 per minute per job. |

Full request and response samples live in [docs/api.md](docs/api.md).

---

## 9. Message Queue Design

### Queue Topology

Four logical queues, each with a Dead Letter Queue (DLQ) for messages that fail after three delivery attempts. A DLQ monitor alerts on-call when any DLQ depth exceeds threshold.

| Queue | Producer | Consumer |
|---|---|---|
| `ingestion.queue` | Upload Service | Video Analyzer |
| `transcript.queue` | Video Analyzer | TTS Service |
| `audio.queue` | TTS Service | Mux Service |
| `delivery.queue` | Mux Service | Delivery Service |

### Idempotency

- Every message carries a `job_id` and `stage_attempt_id` (UUID). Consumers check a Redis set before processing; duplicates are silently acknowledged and dropped.
- Object-storage writes are conditional to prevent partial overwrites on retries.
- Database writes use upsert-on-conflict semantics keyed on `(job_id, segment_idx)` or `(job_id, stage)`.

### Scalability

- Each consumer is a stateless worker that scales horizontally on queue depth.
- Gemini calls are rate-limited by provider quota; the video analyzer uses a token bucket with exponential backoff.
- FFmpeg workers can run on CPU or GPU nodes depending on fleet composition.

---

## 10. Observability & Reliability

### Metrics & Alerting

| Metric | Alert Threshold |
|---|---|
| Job P95 end-to-end latency | Alert if > 3 minutes for a 5-minute video. |
| Queue depth | Alert if any queue exceeds 500 messages for > 2 minutes. |
| DLQ depth | Alert immediately on any DLQ message. |
| LLM error rate | Alert if > 2% of Gemini calls fail in a 5-minute window. |
| TTS error rate | Alert if > 1% of TTS calls fail. |
| Auth failure rate | Alert if > 50 failed logins/minute (potential brute-force). |

### Distributed Tracing

Every job carries a `trace_id` from the moment the upload is accepted. All queue messages, service logs, and external API calls include this `trace_id`. OTLP spans are exported through the collector to any compatible backend, enabling a full waterfall view of any job's history.

### Structured Logging & Metrics

Go services use `slog` JSON output; Python services use `structlog` with a JSON renderer. Each service exposes Prometheus metrics on `/metrics`; a compose-provided scraper collects them in development.

---

## 11. Product Roadmap

### Phase 1 — Core Pipeline

- Upload -> Gemini analysis -> TTS -> mux -> delivery pipeline.
- Standard voice library, English-first.
- Web UI: upload, processing view, transcript editor, download.
- JWT auth plus Google and GitHub OAuth.
- Schema-constrained Gemini output with prompt-injection defenses.

### Phase 2 — Editing & Collaboration

- Full transcript editor with inline edit and per-segment regeneration.
- Additional languages (Spanish, French, German, Japanese, Hindi, Portuguese, Arabic, Korean, Chinese, Italian).
- Team accounts with shared job libraries.
- SRT / VTT / JSON export.
- Public share links with revocation.

### Phase 3 — Scale & Platform

- Real-time collaborative transcript editing (multi-cursor, presence).
- Chrome extension: capture screen and send directly to Recast AI.
- Zapier and Make.com integrations.
- Enterprise SSO (SAML 2.0).
- On-premise / VPC deployment option.
- Analytics dashboard: views, plays, engagement per video.
- Embeddable animated transcript player widget.

### Future Explorations

- AI lip-sync: generate a talking-head avatar that matches the synthesized audio.
- Translation mode: generate transcript in language A, synthesize voice in language B.
- Video chapter auto-detection and per-chapter regeneration.
- Plug-in SDK: let third-party tools (Notion, Loom, etc.) send videos directly.

---

## 12. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Gemini outage | High | Fallback to `gemini-2.5-flash`; queue retries absorb short outages; DLQ keeps work recoverable. |
| Prompt injection via video | High | Schema-constrained output, hardened system instruction, no user-controlled prompts. |
| TTS cost overrun | Medium | Per-user quotas enforced at the queue level before TTS calls are made; provider fallback to gTTS. |
| FFmpeg vulnerabilities | Medium | Containers run as non-root; input videos validated before processing; images pinned and scanned. |
| GDPR / data breach | High | Encryption at rest and in transit; data retention limits; right-to-erasure pipeline; DPA agreements with all sub-processors. |
| Abuse (harmful output) | Medium | Content policy filter on model output; audio scanned with a moderation model before delivery. |

---

## 13. Glossary

| Term | Definition |
|---|---|
| ASR | Automatic Speech Recognition: converting audio to text. |
| atempo | FFmpeg audio filter for time-stretching without pitch change. |
| DLQ | Dead Letter Queue: receives messages that failed processing after N retries. |
| File API | Google Gemini endpoint for uploading media and referencing it in generate-content calls. |
| Mux / Demux | Multiplexing: combining audio and video streams into a single container file. |
| OCR | Optical Character Recognition: reading text from video frames. |
| OTLP | OpenTelemetry Protocol: the wire format for traces and metrics. |
| Pre-signed URL | Short-lived signed URL granting temporary object-storage access. |
| Share Token | 64-character opaque URL-safe token granting unauthenticated read access to a single job. |
| TTS | Text-to-Speech: synthesizing human-like voice from text. |
| Word-level timestamp | The precise start and end time (in ms) of each spoken word in the rendered audio. |

---

## 14. Appendix: Database Schema Summary

The full schema lives under `migrations/`. Highlights:

- `users(id, email, password_hash, name, role, oauth_provider, oauth_id, avatar_url, created_at, updated_at)`.
- `jobs(id, user_id, stage, original_file, original_name, duration_ms, voice_id, style, language, priority, audio_path, output_file, thumbnail_path, share_token, download_url, error_message, trace_id, created_at, updated_at, completed_at)`.
- `transcript_segments(id, job_id, segment_idx, start_ms, end_ms, text, words_json, confidence, audio_path, approved, flagged)`.
- `voices(id, name, gender, accent, provider, sample_url)`.
- `webhooks(id, user_id, url, secret, active, created_at)`.
- `refresh_tokens(id, user_id, token_hash, expires_at, created_at)`.

---

## 15. Gemini Integration

Recast AI hands the entire screen recording to the Google Gemini File API as a single multimodal input and asks the model for a schema-constrained JSON transcript. Whole-video analysis beats per-frame sampling on token cost, on temporal coherence, and by preserving the native audio channel. The video analyzer uploads the raw file, polls until it reports `ACTIVE`, calls `generate_content` with a strict `response_schema`, validates the parsed segments, persists them, and deletes the remote file. Word-level timings are delegated to the TTS layer where they can be derived from actual synthesized audio. Full implementation notes, cost ranges, failure-mode handling, and prompt-injection defenses live in [docs/gemini-integration.md](docs/gemini-integration.md).

---

*Recast AI — Confidential — Internal Use Only — v2.0 — April 2026*
