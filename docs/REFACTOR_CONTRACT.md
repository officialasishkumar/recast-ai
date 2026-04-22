# Recast AI Refactor — Shared Contract

This document is the single source of truth for the April 2026 architecture overhaul. All parallel agents must read this document first and only modify files inside their assigned ownership list.

## Top-Level Goals

1. **Video-first pipeline.** Replace per-frame extraction with full-video upload to Google Gemini File API. Eliminate the `frame-extractor` service and `frames.queue`.
2. **Premium dashboard UI.** Enlarged typography, generous whitespace, design inspired by Linear / Vercel / Stripe / Framer. Remove the pricing page and every tier/quota concept.
3. **Scalability & reliability.** Circuit breaker + structured tracing + per-job idempotency + backpressure. E2E regression harness with a committed sample recording.

## Non-Goals

- Do not migrate away from Go + Python + RabbitMQ + MinIO + Postgres + Redis + Next.js 16 / React 19.
- Do not rewrite the TTS provider layer. Keep ElevenLabs + Polly + gTTS support.
- Do not change the Docker Compose networking model (keep service-name DNS).

## New Pipeline

```
User upload (multipart)
  ─► upload-service  (validates, stores raw video in MinIO)
  ─► ingestion.queue
       payload: { job_id, trace_id, stage_attempt_id, payload: { object_key, user_id, voice_id, style, language } }

  ─► video-analyzer-service (Python, NEW)
       1. Downloads video from MinIO
       2. Uploads to Gemini File API (client.files.upload(file=..., config={mime_type: ...}))
       3. Polls until file.state == "ACTIVE"
       4. Calls models.generate_content with responseSchema (segment-level JSON)
       5. Deletes the uploaded Files API resource on success
  ─► transcript.queue
       payload: { segments: [...], voice_id, duration_ms }

  ─► tts-service (updated)
       1. Synthesizes per segment (ElevenLabs/Polly/gTTS)
       2. Computes word-level timings from TTS output (or proportional fallback)
       3. Runs FFmpeg atempo to fit scene bounds (0.75×-1.5×)
  ─► audio.queue

  ─► mux-service (unchanged)
  ─► delivery.queue

  ─► delivery-service (unchanged)
```

`frames.queue` **is deleted.** Do not emit to it, do not consume from it, and remove every DLQ binding.

## Gemini Integration Spec

**Model:** `gemini-2.5-pro` (default) with fallback to `gemini-2.5-flash` for long videos.

**Upload flow (Python SDK `google-genai`):**

```python
from google import genai
from google.genai import types
import time

client = genai.Client(api_key=GEMINI_API_KEY)

uploaded = client.files.upload(
    file=local_video_path,
    config={"mime_type": "video/mp4"},
)

# Poll until ACTIVE
while uploaded.state.name == "PROCESSING":
    time.sleep(2)
    uploaded = client.files.get(name=uploaded.name)

if uploaded.state.name != "ACTIVE":
    raise RuntimeError(f"Gemini upload failed: {uploaded.state.name}")

response = client.models.generate_content(
    model="gemini-2.5-pro",
    contents=[
        uploaded,
        build_user_prompt(style, language, duration_ms),
    ],
    config=types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=TRANSCRIPT_SCHEMA,
        temperature=0.2,
    ),
)

segments = response.parsed

client.files.delete(name=uploaded.name)  # cleanup on success
```

**Transcript JSON schema the model must return:**

```json
{
  "type": "object",
  "properties": {
    "segments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["segment_id", "start_ms", "end_ms", "text", "confidence"],
        "properties": {
          "segment_id":  { "type": "integer", "minimum": 1 },
          "start_ms":    { "type": "integer", "minimum": 0 },
          "end_ms":      { "type": "integer", "minimum": 0 },
          "text":        { "type": "string", "minLength": 1 },
          "confidence":  { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    }
  },
  "required": ["segments"]
}
```

Word-level timings are **not** requested from Gemini (they are unreliable with visual-only transcription). Word-level timings come from the TTS layer:

- **ElevenLabs:** use `alignment` response field (char-level → word-level aggregation).
- **gTTS / Polly / any provider without native word timings:** compute proportional timings weighted by character count within the synthesized segment duration.

## File Ownership Matrix

| Agent | Paths owned | Writes allowed only here |
|---|---|---|
| `A-video-analyzer`   | `services/video-analyzer/**`                                                                        |   |
| `A-legacy-python`    | `services/llm-orchestrator/**`                                                                      |   |
| `A-tts`              | `services/tts-service/**`                                                                           |   |
| `A-frame-remove`     | `cmd/frame-extractor/**`, `internal/extractor/**`, `docker/frame-extractor.Dockerfile`              |   |
| `A-upload`           | `cmd/upload-service/**`                                                                             |   |
| `A-gateway`          | `cmd/api-gateway/**`, `internal/gateway/**`                                                         |   |
| `A-shared-go`        | `pkg/auth/**`, `pkg/config/**`, `pkg/database/**`, `pkg/models/**`, `pkg/queue/**`, `pkg/storage/**`, `pkg/observability/**` (new), `pkg/resilience/**` (new) |   |
| `A-migrations`       | `migrations/**`                                                                                      |   |
| `A-fe-core`          | `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/src/components/ui/**`, `web/src/components/navbar.tsx` |   |
| `A-fe-dashboard`     | `web/src/app/dashboard/**`, `web/src/components/job-card.tsx`, `web/src/components/upload-modal.tsx` |   |
| `A-fe-jobs`          | `web/src/app/jobs/**`, `web/src/components/pipeline-progress.tsx`                                    |   |
| `A-fe-landing-auth`  | `web/src/app/page.tsx`, `web/src/app/login/**`, `web/src/app/register/**`, `web/src/app/settings/**` |   |
| `A-fe-share-api`     | `web/src/app/share/**` (new), `web/src/lib/**`                                                       |   |
| `A-infra`            | `docker-compose.yml`, `docker/**` (except frame-extractor.Dockerfile), `Makefile`, `.env.example`, `scripts/**`, `render.yaml` |   |
| `A-tests`            | `test/**` (new), `test/e2e/**`                                                                      |   |
| `A-ci`               | `.github/workflows/**`                                                                              |   |
| `A-docs`             | `README.md`, `product-spec.md`, `docs/**` (except this file, which is read-only)                    |   |

**Every agent must only write to files inside its ownership list.** Reading any file is allowed.

## Queue & DB Contract

### Queue names (final)

```
ingestion.queue       (+ ingestion.queue.dlq)
transcript.queue      (+ transcript.queue.dlq)
audio.queue           (+ audio.queue.dlq)
delivery.queue        (+ delivery.queue.dlq)
```

`frames.queue` is deleted. Any declaration in Go or Python must be removed.

### DB schema changes (`migrations/002_pricing_and_frames_cleanup.up.sql`)

```sql
ALTER TABLE users DROP COLUMN IF EXISTS minutes_used;
ALTER TABLE users DROP COLUMN IF EXISTS minutes_quota;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE voices DROP COLUMN IF EXISTS pro_only;

ALTER TABLE jobs DROP COLUMN IF EXISTS frames_path;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS thumbnail_path TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_share_token ON jobs(share_token);
```

Users `role` column stays (keeps `admin` capability) but no tier enforcement anywhere.

### API contract changes

- Drop any handler logic that references role==Pro / Free.
- Drop usage / quota endpoints.
- Remove `/v1/webhooks`, `/v1/voices/clone` if present (keep table but skip endpoints; out of scope).
- Add `POST /v1/jobs/:id/share` → returns a public URL like `/share/<token>`.
- Add `GET /v1/public/shares/:token` → unauthenticated, returns job + transcript + output URL.
- Add `POST /v1/jobs/:id/segments/:segmentId/regenerate` → triggers single-segment re-synthesis.

## Frontend Design Tokens

All surfaces use these tokens (no ad-hoc colors). Update `globals.css`:

```css
:root {
  --bg:            #0a0a0c;
  --bg-elev:       #121216;
  --bg-card:       #16161d;
  --border:        #1f1f2a;
  --border-hover:  #2a2a37;
  --text:          #f5f5f7;
  --text-muted:    #a3a3b5;
  --text-dim:      #5f5f72;
  --accent:        #a78bfa;   /* violet 400 */
  --accent-hover:  #8b5cf6;
  --warn:          #fbbf24;
  --success:       #34d399;
  --danger:        #f87171;
  --radius:        14px;
  --radius-lg:     20px;
}
```

**Typography scale:** body 17px / 1.6, small 14px / 1.5, h1 56px / 1.05, h2 32px / 1.15, h3 22px / 1.3. Use `font-feature-settings: "ss01", "cv01"` for Inter Display if loaded. Default font stack: `"Inter Display", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`. Monospace: `"JetBrains Mono", ui-monospace, monospace`.

## Commit Convention

Every commit is scoped to one agent. Commit message format:

```
<type>(<scope>): <imperative summary>

<optional body>
```

Examples: `feat(video-analyzer): introduce Gemini File API pipeline`, `refactor(frontend): remove pricing and tier UI`, `test(e2e): add regression harness with sample recording`.

No commit may mix frontend, backend, and infra scopes.

## Forbidden Changes

- Do not install new runtime dependencies without noting them in the agent's final report.
- Do not run `npm install`, `go mod tidy`, `docker build`, or any linter that mutates files.
- Do not touch files outside the agent's ownership list.
- Do not reintroduce any reference to tiers, pricing, quotas, Stripe, Pro, Free.
- Do not keep `frame-extractor` binaries, queue bindings, or DB columns.
- Do not write explanatory comments that restate the code.

## Verification Bar

Each agent's code must:

- Compile / parse (Go: be syntactically valid; Python: importable; TS: no obvious type errors).
- Handle errors explicitly (no swallowed exceptions in the new pipeline).
- Not break existing endpoints that aren't being explicitly removed.
- Leave the repo in a state where `make up` would build and run end-to-end (assuming API keys provided).

If an agent cannot complete its scope, it must leave a clear TODO comment tagged `// TODO(refactor-2026)` and report the blocker in its final message.
