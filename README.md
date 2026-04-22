# Recast AI

Recast AI converts any screen recording into a professionally narrated video — powered by a single Gemini 2.5 video analysis call and a word-level TTS alignment engine.

## Overview

Upload a video. Recast AI hands the whole file to Google Gemini 2.5 in a single multimodal call, receives back a fully scoped, timestamped transcript, synthesizes speech per segment with a neural TTS provider, aligns speech to the video at the word level, and mux-delivers the final narrated output. The entire pipeline is asynchronous, horizontally scalable, and fault isolated behind RabbitMQ queues.

## Architecture

```
                    ┌──────────┐
                    │  Web UI  │  Next.js 16
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   API    │  Go — Auth, Routing, WebSocket
                    │ Gateway  │
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    ┌─────▼────┐   ┌─────▼────┐   ┌────▼─────┐
    │ Upload   │   │ Jobs DB  │   │ WebSocket│
    │ Service  │   │ Postgres │   │  (Redis) │
    └─────┬────┘   └──────────┘   └──────────┘
          │
   [Ingestion Queue] ─── RabbitMQ
          │
    ┌─────▼──────────────┐
    │  Video Analyzer    │  Python + Gemini File API
    └─────┬──────────────┘
          │
    [Transcript Queue]
          │
    ┌─────▼──────────┐
    │  TTS Service   │  Python + ElevenLabs/Polly/gTTS
    └─────┬──────────┘
          │
    [Audio Queue]
          │
    ┌─────▼──────────┐
    │  Mux Service   │  Go + FFmpeg
    └─────┬──────────┘
          │
    [Delivery Queue]
          │
    ┌─────▼──────────────┐
    │ Delivery Service   │  Go — CDN upload, webhooks
    └────────────────────┘
```

Each processing stage is a stateless consumer reading from a message queue and writing results back to the next queue plus object storage. No stage calls another directly, giving the system horizontal scalability, fault isolation, and natural retry semantics.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS |
| API Gateway | Go, Chi router, JWT auth, WebSocket |
| Workers | Go (upload, mux, delivery) |
| AI Services | Python, FastAPI (video-analyzer, TTS) |
| Message Queue | RabbitMQ (with DLQ per queue) |
| Database | PostgreSQL 17 |
| Cache | Redis 7 |
| Object Storage | MinIO (S3-compatible) |
| LLM | Google Gemini 2.5 Pro / Flash |
| TTS | ElevenLabs / AWS Polly / gTTS (configurable) |
| Video Processing | FFmpeg |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Go 1.25+
- Node.js 20+
- Python 3.12+
- A Google Gemini API key

### Setup

```bash
git clone https://github.com/officialasishkumar/recast-ai.git
cd recast-ai
cp .env.example .env
# Edit .env and set GEMINI_API_KEY; optionally set ELEVENLABS_API_KEY
# or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for Polly.
make up
```

### Start All Services

```bash
make up      # Start full stack via Docker Compose
make dev     # Start infrastructure only (Postgres, RabbitMQ, MinIO, Redis)
```

### Access Points

| Service | URL |
|---|---|
| Web UI | http://localhost:3000 |
| API Gateway | http://localhost:8080 |
| RabbitMQ Management | http://localhost:15672 (guest/guest) |
| MinIO Console | http://localhost:9001 (minioadmin/minioadmin) |

## Project Structure

```
recast-ai/
├── cmd/                          # Go service entry points
│   ├── api-gateway/              # HTTP API server
│   ├── upload-service/           # Chunked upload handler
│   ├── mux-service/              # FFmpeg audio/video mux worker
│   └── delivery-service/         # Final delivery + webhooks
├── internal/                     # Go internal packages
│   ├── gateway/                  # API gateway handlers & middleware
│   ├── muxer/                    # Mux helpers
│   └── delivery/                 # Webhook delivery
├── pkg/                          # Shared Go packages
│   ├── auth/                     # JWT generation & validation
│   ├── config/                   # Environment-based configuration
│   ├── database/                 # PostgreSQL connection
│   ├── models/                   # Domain types & queue messages
│   ├── observability/            # OTLP, metrics, structured logging
│   ├── queue/                    # RabbitMQ wrapper
│   ├── resilience/               # Circuit breaker, retry, backoff
│   └── storage/                  # S3/MinIO wrapper
├── services/                     # Python services
│   ├── video-analyzer/           # Gemini File API transcript generation
│   └── tts-service/              # Text-to-speech synthesis + alignment
├── web/                          # Next.js 16 frontend
├── migrations/                   # PostgreSQL schema migrations
├── docker/                       # Dockerfiles for all services
├── scripts/                      # Development scripts
├── test/                         # e2e regression harness + sample video
├── .github/workflows/            # CI/CD (build, test, e2e, CodeQL)
├── docker-compose.yml            # Full local development stack
└── Makefile                      # Development commands
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/auth/register` | Register with email and password |
| POST | `/v1/auth/login` | Login, returns JWT and refresh token |
| POST | `/v1/auth/refresh` | Refresh JWT token |
| GET | `/v1/auth/me` | Get current user profile |

### Jobs

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/jobs` | Create a new video processing job |
| GET | `/v1/jobs` | List user's jobs |
| GET | `/v1/jobs/:id` | Get job details |
| DELETE | `/v1/jobs/:id` | Delete a job |
| GET | `/v1/jobs/:id/transcript` | Get transcript segments |
| PATCH | `/v1/jobs/:id/transcript` | Update transcript segments |
| POST | `/v1/jobs/:id/segments/:segmentId/regenerate` | Re-synthesize a single segment |
| POST | `/v1/jobs/:id/share` | Mint a public share token |
| GET | `/v1/jobs/:id/export` | Get download URL |
| WS | `/v1/ws/jobs/:id` | Real-time job progress |

### Voices

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/voices` | List available TTS voices |

### Uploads

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/uploads` | Initiate a multipart upload |
| PUT | `/v1/uploads/:id/parts/:n` | Upload a single part |
| POST | `/v1/uploads/:id/complete` | Finalize the upload |

### Public

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/public/shares/:token` | Unauthenticated share view — returns job, transcript, and output URL |

See [docs/api.md](docs/api.md) for full request and response samples.

## Development

### Available Make Commands

```bash
make help          # Show all commands
make dev           # Start infrastructure only
make up            # Start all services
make down          # Stop everything
make build-go      # Build Go binaries
make test          # Run all tests
make lint          # Lint all code
make logs          # Tail service logs
make psql          # Open PostgreSQL shell
make redis-cli     # Open Redis shell
```

### Running Services Locally

For local development, start infrastructure with `make dev`, then run individual services.

```bash
# Go services
go run ./cmd/api-gateway
go run ./cmd/upload-service
go run ./cmd/mux-service
go run ./cmd/delivery-service

# Python services
cd services/video-analyzer && python main.py
cd services/tts-service && python main.py

# Frontend
cd web && npm run dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure the keys that matter for your target TTS provider.

- `GEMINI_API_KEY` — Required for video analysis.
- `ELEVENLABS_API_KEY` — Optional. Enables ElevenLabs TTS plus native word alignment.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — Optional. Enables AWS Polly.
- `JWT_SECRET` — Must be rotated for production.
- OAuth credentials — Optional for dev.

When no TTS provider is configured, the service falls back to `gTTS` with proportional word timing.

## Message Queue Design

Four logical queues, each with a Dead Letter Queue (DLQ).

| Queue | Producer | Consumer |
|---|---|---|
| `ingestion.queue` | Upload Service | Video Analyzer |
| `transcript.queue` | Video Analyzer | TTS Service |
| `audio.queue` | TTS Service | Mux Service |
| `delivery.queue` | Mux Service | Delivery Service |

Idempotency is ensured via `stage_attempt_id` UUIDs. Duplicate messages are silently dropped.

## Security

- JWT authentication (HS256) with 15-minute expiry and rotating refresh tokens.
- LLM prompt injection defense: schema-constrained Gemini output, system-instruction hardening, and explicit instructions to ignore on-screen text.
- Rate limiting per user (token-bucket via Redis).
- All inter-service communication via private queues.
- Pre-signed URLs for object storage access (1-hour expiry).
- CORS restricted to frontend origin.
- Share tokens are 64-character opaque URL-safe strings bound to a single job.

## CI/CD

GitHub Actions pipelines.

- **CI** (`ci.yml`): Go tests, Python linting, frontend build, Docker image builds on every push and PR to `main`.
- **E2E** (`e2e.yml`): Runs the committed sample-recording regression harness against a full compose stack.
- **CodeQL** (`codeql.yml`): Static security analysis on Go, Python, and TypeScript.
- **Deploy** (`deploy.yml`): Triggered on version tags — builds and pushes images to GHCR, deploys to staging and production.

## Documentation

| Doc | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Service-by-service architecture and data model |
| [docs/api.md](docs/api.md) | Full REST API reference |
| [docs/gemini-integration.md](docs/gemini-integration.md) | Gemini File API flow, token costs, failure modes |
| [docs/contributing.md](docs/contributing.md) | Local dev setup, adding consumers, tests, conventions |
| [docs/REFACTOR_CONTRACT.md](docs/REFACTOR_CONTRACT.md) | Refactor contract shared across parallel agents |

## License

Proprietary — All rights reserved.
