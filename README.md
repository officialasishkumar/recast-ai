# Recast AI

AI-powered video narration platform — converts screen recordings into professionally narrated videos with word-level synchronized voice-over.

## Overview

Recast AI is an end-to-end cloud platform that ingests a video, extracts visual and audio context using a multimodal LLM, produces a word-level timestamped transcript, synthesizes natural speech using a TTS engine, dynamically adjusts speech rate to fit within scene boundaries, and delivers the final muxed video — all within a single secure, asynchronous pipeline.

## Architecture

```
                    ┌──────────┐
                    │  Web UI  │  Next.js 15
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
    ┌─────▼──────────┐
    │ Frame Extractor │  Go + FFmpeg
    └─────┬──────────┘
          │
    [Frames Queue]
          │
    ┌─────▼──────────────┐
    │  LLM Orchestrator  │  Python + Claude API
    └─────┬──────────────┘
          │
    [Transcript Queue]
          │
    ┌─────▼──────────┐
    │  TTS Service   │  Python + ElevenLabs/Polly
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

Each processing stage is a stateless consumer reading from a message queue and writing results back to the next queue + object storage. No stage calls another directly, giving the system horizontal scalability, fault isolation, and natural retry semantics.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, TypeScript, Tailwind CSS |
| API Gateway | Go, Chi router, JWT auth, WebSocket |
| Workers | Go (frame extraction, mux, delivery) |
| AI Services | Python, FastAPI (LLM orchestrator, TTS) |
| Message Queue | RabbitMQ (with DLQ per queue) |
| Database | PostgreSQL 17 |
| Cache | Redis 7 |
| Object Storage | MinIO (S3-compatible) |
| LLM | Anthropic Claude (multimodal) |
| TTS | ElevenLabs / AWS Polly (configurable) |
| Video Processing | FFmpeg |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Go 1.25+
- Node.js 20+
- Python 3.12+

### Setup

```bash
# Clone the repository
git clone https://github.com/officialasishkumar/recast-ai.git
cd recast-ai

# Run the setup script
./scripts/setup.sh

# Or manually:
cp .env.example .env       # Edit with your API keys
make up                     # Start everything
```

### Start All Services

```bash
# Start everything with Docker Compose
make up

# Or start infrastructure only (for local Go/Python development)
make dev
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
│   ├── frame-extractor/          # FFmpeg frame extraction worker
│   ├── mux-service/              # FFmpeg audio/video mux worker
│   └── delivery-service/         # Final delivery + webhooks
├── internal/                     # Go internal packages
│   ├── gateway/                  # API gateway handlers & middleware
│   │   ├── handler/              # HTTP handlers (auth, jobs, voices)
│   │   ├── middleware/           # Auth, rate limiting
│   │   └── websocket/            # Real-time job progress
│   ├── extractor/                # FFmpeg helpers
│   ├── muxer/                    # Mux helpers
│   └── delivery/                 # Webhook delivery
├── pkg/                          # Shared Go packages
│   ├── auth/                     # JWT generation & validation
│   ├── config/                   # Environment-based configuration
│   ├── database/                 # PostgreSQL connection
│   ├── models/                   # Domain types & queue messages
│   ├── queue/                    # RabbitMQ wrapper
│   └── storage/                  # S3/MinIO wrapper
├── services/                     # Python services
│   ├── llm-orchestrator/         # Multimodal LLM transcript generation
│   │   └── orchestrator/         # Prompt building, LLM client, validation
│   └── tts-service/              # Text-to-speech synthesis
│       └── tts/                  # Synthesizer, speed control
├── web/                          # Next.js 15 frontend
│   └── src/
│       ├── app/                  # Pages (dashboard, jobs, settings)
│       ├── components/           # Reusable UI components
│       └── lib/                  # API client, WebSocket, utilities
├── migrations/                   # PostgreSQL schema migrations
├── docker/                       # Dockerfiles for all services
├── scripts/                      # Development scripts
├── .github/workflows/            # CI/CD (build, test, deploy)
├── docker-compose.yml            # Full local development stack
└── Makefile                      # Development commands
```

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/auth/register` | Register with email + password |
| POST | `/v1/auth/login` | Login, returns JWT + refresh token |
| POST | `/v1/auth/refresh` | Refresh JWT token |
| GET | `/v1/auth/me` | Get current user profile |

### Jobs
| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/jobs` | Create a new video processing job |
| GET | `/v1/jobs` | List user's jobs |
| GET | `/v1/jobs/:id` | Get job details |
| DELETE | `/v1/jobs/:id` | Delete a job |
| GET | `/v1/jobs/:id/transcript` | Get word-level transcript |
| PATCH | `/v1/jobs/:id/transcript` | Update transcript segments |
| GET | `/v1/jobs/:id/export` | Get download URL |
| WS | `/v1/ws/jobs/:id` | Real-time job progress |

### Voices
| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/voices` | List available TTS voices |

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

For local development, start infrastructure with `make dev`, then run individual services:

```bash
# Go services
go run ./cmd/api-gateway
go run ./cmd/frame-extractor
go run ./cmd/mux-service
go run ./cmd/delivery-service

# Python services
cd services/llm-orchestrator && python main.py
cd services/tts-service && python main.py

# Frontend
cd web && npm run dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

- `ANTHROPIC_API_KEY` — Required for LLM transcript generation
- `ELEVENLABS_API_KEY` — Required for real TTS (set `TTS_PROVIDER=mock` for development)
- `JWT_SECRET` — Change for production
- OAuth credentials (optional for dev)
- Stripe keys (optional for dev)

## Message Queue Design

Five logical queues, each with a Dead Letter Queue (DLQ):

| Queue | Producer | Consumer |
|---|---|---|
| `ingestion.queue` | Upload Service | Frame Extractor |
| `frames.queue` | Frame Extractor | LLM Orchestrator |
| `transcript.queue` | LLM Orchestrator | TTS Service |
| `audio.queue` | TTS Service | Mux Service |
| `delivery.queue` | Mux Service | Delivery Service |

Idempotency is ensured via `stage_attempt_id` UUIDs — duplicate messages are silently dropped.

## Security

- JWT authentication (HS256) with 15-minute expiry and rotating refresh tokens
- LLM prompt injection defense: input sanitization, sandboxed prompts, output schema validation, content policy filter
- Rate limiting per user (token-bucket via Redis)
- All inter-service communication via private queues
- Pre-signed URLs for S3 access (1-hour expiry)
- CORS restricted to frontend origin

## CI/CD

GitHub Actions pipelines:

- **CI** (`ci.yml`): Runs on every push/PR to `main` — Go tests, Python linting, frontend build, Docker image builds
- **Deploy** (`deploy.yml`): Triggered on version tags — builds and pushes images to GHCR, deploys to staging/production

## License

Proprietary — All rights reserved.
