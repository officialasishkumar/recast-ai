# video-analyzer

Python 3.12 service that replaces the per-frame Claude pipeline with a
single Gemini File API call per job. It consumes ingestion jobs,
uploads the video to Gemini, asks for a timestamped narration
transcript, persists the segments, and hands off to the TTS stage.

## Pipeline

```
ingestion.queue
  -> video-analyzer
       1. download video from MinIO
       2. probe duration with ffprobe
       3. upload to Gemini File API, poll until ACTIVE
       4. generate_content with response_schema (JSON)
       5. validate + synthesize word-level fallback timings
       6. persist transcript_segments, update jobs.stage / duration_ms
       7. delete the uploaded Gemini file
-> transcript.queue
```

A FastAPI health endpoint is exposed on `:8080/health` by default.

## Required environment variables

| Variable | Description | Default |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio / Vertex AI key | required |
| `GEMINI_MODEL` | Primary model | `gemini-2.5-pro` |
| `GEMINI_FALLBACK_MODEL` | Fallback model for long videos | `gemini-2.5-flash` |
| `GEMINI_TIMEOUT_S` | Per-request timeout, seconds | `600` |
| `RABBITMQ_HOST` / `RABBITMQ_PORT` | RabbitMQ connection | `localhost` / `5672` |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD` | RabbitMQ credentials | `guest` / `guest` |
| `RABBITMQ_URL_OVERRIDE` | Full AMQP URL | empty |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | MinIO | `localhost:9000` / `minioadmin` / `minioadmin` / `recastai` |
| `REDIS_HOST` / `REDIS_PORT` | Redis | `localhost` / `6379` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SSLMODE` | PostgreSQL | `localhost` / `5432` / `recast` / `recast` / `recastai` / `disable` |
| `TMP_DIR` | Scratch dir for downloaded videos (prefer tmpfs) | `/tmp/video-analyzer` |
| `HEALTH_PORT` | Port for the FastAPI health server | `8080` |
| `LOG_LEVEL` | structlog level | `INFO` |

## Run locally

```bash
cd services/video-analyzer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=...
python main.py
```

`ffprobe` (from ffmpeg) must be on `PATH` at runtime; the service
fails hard with `RuntimeError` if it is missing.

## Tests

```bash
pip install pytest
pytest services/video-analyzer/tests
```

The included tests cover validator edge cases: schema failure,
overlapping segments, negative timestamps, empty text, out-of-order
segments, and word-timing synthesis.

## Message contracts

Consumes `ingestion.queue`:

```json
{
  "job_id": "uuid",
  "trace_id": "uuid",
  "stage_attempt_id": "uuid",
  "payload": {
    "object_key": "videos/<user>/<job>/raw.mp4",
    "user_id": "uuid",
    "voice_id": "alloy",
    "style": "formal",
    "language": "en"
  }
}
```

Produces `transcript.queue`:

```json
{
  "job_id": "uuid",
  "trace_id": "uuid",
  "stage_attempt_id": "uuid",
  "payload": {
    "segments": [{"segment_id": 1, "start_ms": 0, "end_ms": 4000, "text": "...", "confidence": 0.92, "words": [...]}],
    "voice_id": "alloy",
    "duration_ms": 32000
  }
}
```

Also publishes a Redis pub/sub event on `job:<id>`:

```json
{"event": "stage_complete", "stage": "transcribed", "progress": 0.50}
```
