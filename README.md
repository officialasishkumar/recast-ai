# Recast AI

Recast AI converts any screen recording into a professionally narrated video — powered by a single Gemini 2.5 video analysis call and a word-level TTS alignment engine.

## Overview

Upload a video. Recast AI hands the whole file to Google Gemini 2.5 in a single multimodal call, receives back a fully scoped, timestamped transcript, synthesizes speech per segment with a neural TTS provider, aligns speech to the video at the word level, and mux-delivers the final narrated output. The entire pipeline is asynchronous, horizontally scalable, and fault isolated behind RabbitMQ queues.

### Highlights

- **Distributed tracing** end-to-end with OpenTelemetry — HTTP spans,
  RabbitMQ producer/consumer span linking via AMQP headers, exported
  over OTLP gRPC to Tempo and stitched to logs in Grafana.
- **Full monitoring stack** in `docker compose up`: Prometheus +
  Alertmanager + Grafana (3 provisioned dashboards) + Loki + Tempo +
  cAdvisor + node-exporter + Redis/Postgres exporters.
- **9 GitHub Actions pipelines** covering lint, test, e2e, security
  (Trivy, Gitleaks, Hadolint, govulncheck, pip-audit, npm audit,
  Semgrep, CodeQL), SBOM (SPDX + CycloneDX), perf smoke (k6), and
  signed multi-arch releases (cosign + SLSA provenance).
- **Production Helm chart** with HPA, PDB, NetworkPolicy,
  ServiceMonitor, restricted PodSecurityStandard, and topology-spread
  anti-affinity.
- **Resilient by design** — per-queue DLQs, circuit breakers, retry
  with jitter, idempotent stage execution, graceful shutdown, and
  startup connection retry across every infra dependency.

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
| Message Queue | RabbitMQ (per-queue DLQ, x-message-ttl) |
| Database | PostgreSQL 17 |
| Cache | Redis 7 (rate limit + pub/sub for WS fanout) |
| Object Storage | MinIO (S3-compatible) |
| LLM | Google Gemini 2.5 Pro / Flash |
| TTS | ElevenLabs / AWS Polly / gTTS (configurable) |
| Video Processing | FFmpeg |
| Tracing | OpenTelemetry (OTLP gRPC) → Tempo |
| Metrics | Prometheus client + Alertmanager |
| Logs | structured slog/structlog → Loki |
| Dashboards | Grafana (provisioned) |
| Resilience | Circuit breaker (gobreaker), retry with jitter |
| Container Orchestration | Helm chart with HPA, PDB, NetworkPolicy, ServiceMonitor |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Go 1.26+
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
│   └── delivery/                 # Webhook delivery
├── pkg/                          # Shared Go packages
│   ├── auth/                     # JWT generation & validation
│   ├── config/                   # Environment-based configuration
│   ├── database/                 # PostgreSQL connection
│   ├── health/                   # /healthz / /readyz helpers
│   ├── models/                   # Domain types & queue messages
│   ├── observability/            # OTLP tracing, metrics, /metrics server
│   ├── outbox/                   # Transactional outbox dispatcher
│   ├── queue/                    # RabbitMQ wrapper with trace propagation
│   ├── resilience/               # Circuit breaker, retry, backoff
│   └── storage/                  # S3/MinIO wrapper
├── services/                     # Python services
│   ├── video-analyzer/           # Gemini File API transcript generation
│   └── tts-service/              # Text-to-speech synthesis + alignment
├── web/                          # Next.js 16 frontend
├── migrations/                   # PostgreSQL schema migrations
├── docker/                       # Dockerfiles for all services
│   └── monitoring/               # Prometheus, Grafana, Loki, Tempo configs
├── deploy/                       # Production deployment artifacts
│   ├── helm/recast-ai/           # Helm chart (Deployments, HPA, PDB, ...)
│   └── k8s/                      # Raw manifests (hardened namespace)
├── scripts/                      # Development scripts
├── test/                         # e2e harness, sample video, k6 perf tests
├── .github/workflows/            # CI/CD (build, test, e2e, security, release)
├── docker-compose.yml            # Full local stack incl. monitoring
└── Makefile                      # Development commands
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/auth/register` | Register with email and password |
| POST | `/v1/auth/login` | Login, returns JWT and refresh token |
| POST | `/v1/auth/refresh` | Refresh JWT token |
| POST | `/v1/auth/google` | Sign in with a Google ID token |
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
| DELETE | `/v1/jobs/:id/share` | Revoke an existing share token |
| GET | `/v1/jobs/:id/export` | Get download URL |
| WS | `/v1/ws/jobs/:id` | Real-time job progress |

### Voices

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/voices` | List available TTS voices |

### Uploads

The `upload-service` exposes a chunked-upload API on its own port (`8081` by default), separate from the API gateway.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/upload/chunk` | Stream a single chunk; identifies the upload via `upload_id` and `chunk_idx` (query param or `X-Upload-ID` / `X-Chunk-Index` header) |
| POST | `/v1/upload/complete` | Finalize an upload once every chunk has been received |
| GET | `/v1/upload/{id}/status` | Inspect chunk receipt state |
| DELETE | `/v1/upload/{id}` | Abort and discard an in-progress upload |

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
- Container images run as a non-root user with `readOnlyRootFilesystem`,
  `allowPrivilegeEscalation: false`, all capabilities dropped, and the
  RuntimeDefault seccomp profile in production.
- NetworkPolicies enforce a default-deny baseline with explicit allow
  rules for DNS, intra-namespace data plane, and HTTPS egress only.
- Every release image is signed with [cosign](https://github.com/sigstore/cosign)
  (keyless via OIDC) and publishes SLSA provenance + SBOM attestations.

## Reliability

The pipeline is designed for partial-failure tolerance — any stage can
crash, restart, and pick up where it left off without data loss.

- **Async, queue-driven stages.** Each Recast service consumes one
  RabbitMQ queue and produces another. No service makes a synchronous
  call to another service in the pipeline.
- **Per-queue dead-letter queue.** Messages that fail after retry land
  in `<queue>.dlq` for manual inspection. A 24-hour `x-message-ttl`
  prevents poison-pill backlog growth.
- **Idempotency.** Every queue message carries a `stage_attempt_id`
  UUID that consumers persist before doing real work, so duplicate
  redeliveries are silently dropped.
- **Circuit breakers.** External integrations (Gemini, ElevenLabs,
  Polly, S3) are wrapped in a [gobreaker](https://github.com/sony/gobreaker)
  circuit breaker (`pkg/resilience`) configured per-callsite.
- **Retry with jittered exponential backoff.** `pkg/resilience.Do`
  wraps transient calls with bounded retry; tests cover the
  exhaustion and context-cancellation paths.
- **Connection retry on startup.** RabbitMQ, PostgreSQL, and Redis
  connections retry up to 30 times during cold start so services
  survive infra warm-up windows.
- **Graceful shutdown.** Every service listens for SIGINT/SIGTERM,
  stops accepting new work, waits for in-flight requests to drain
  (15-second timeout), then flushes the OTLP tracer provider.
- **Liveness & readiness.** `/healthz` (liveness) and `/readyz`
  (readiness) are served on every service's metrics sidecar port,
  giving orchestrators independent signals from the application port.
- **Horizontal scaling.** The Helm chart auto-scales workers on CPU,
  memory, and (for queue consumers) backlog depth via
  HorizontalPodAutoscaler.

## CI/CD

Nine GitHub Actions pipelines cover lint, test, security, and release.

| Workflow | When | What it does |
|---|---|---|
| **CI** (`ci.yml`) | push / PR to `main` | Go lint + race tests, Python lint + pytest, frontend lint + build, Docker image builds, critical-package coverage gate |
| **E2E** (`e2e.yml`) | PRs | Full compose stack with a deterministic Gemini stub, exercising the upload to narrate to mux to deliver flow |
| **CodeQL** (`codeql.yml`) | push / PR / weekly | Static analysis for Go, Python, and TypeScript with `security-and-quality` queries |
| **Security** (`security.yml`) | push / PR / weekly | Gitleaks, Trivy filesystem and image scans, hadolint, govulncheck, pip-audit, npm audit, Semgrep |
| **Dependency Review** (`dependency-review.yml`) | PR | Blocks PRs that introduce high-severity or AGPL-licensed dependencies |
| **SBOM** (`sbom.yml`) | push / tag | Generates SPDX + CycloneDX SBOMs with Syft and attaches them to GitHub Releases |
| **Performance Smoke** (`perf-smoke.yml`) | PR (gateway-touching) | k6 smoke test asserting `p95 < 250 ms`, `error rate < 1%` |
| **Release** (`release.yml`) | tag `v*.*.*` | Multi-arch image builds, SLSA provenance, SBOM attestations, keyless cosign signing, auto-generated release notes |
| **Deploy** (`deploy.yml`) | tag `v*` / manual | GHCR image push and staged rollout to staging and production environments |

## Observability

A complete monitoring stack is bundled in `docker/monitoring`. Local
`docker compose up` brings up:

- **Prometheus** with alert rules on `:9090`
- **Alertmanager** on `:9093`
- **Grafana** with provisioned dashboards on `:3001`
- **Loki** for log aggregation on `:3100`
- **Tempo** for trace storage on `:3200`
- **OpenTelemetry Collector** fanning OTLP traces, metrics, and logs out to Tempo, Prometheus, and Loki
- **cAdvisor**, **node-exporter**, **redis-exporter**, **postgres-exporter** for infra metrics

Every Go and Python service exposes a `/metrics` endpoint on a sidecar
port (`9100` to `9105`) and emits OTLP traces to the collector. The
RabbitMQ Prometheus plugin is enabled by default. Grafana ships with
three dashboards (`Pipeline Overview`, `RabbitMQ Queues`, `Service
Health`) and Loki is wired into trace exemplars so you can jump from a
span to its log line in one click.

## Production deployment

Production deploys go out via the Helm chart in
[`deploy/helm/recast-ai`](deploy/helm/recast-ai). The chart provides
Deployments, HPAs, PodDisruptionBudgets, ServiceMonitors,
NetworkPolicies, and an optional Ingress. See
[`deploy/README.md`](deploy/README.md) for the install commands.

## Performance targets (SLOs)

The CI perf-smoke job and the Grafana dashboards are calibrated against
these service-level objectives:

| Surface | Metric | Target |
|---|---|---|
| `/v1/*` API | request error rate | < 1% over any 10-minute window |
| `/v1/*` API | latency p95 | < 250 ms |
| `/v1/*` API | latency p99 | < 500 ms |
| Pipeline | end-to-end completion (≤ 5-minute video) | < 90 s p95 |
| Pipeline | success rate | ≥ 99% over any 1-hour window |
| Worker queues | DLQ growth | 0 messages over a rolling 15 min |

Alertmanager rules in `docker/monitoring/prometheus/rules/recast-alerts.yml`
fire when any of these are violated, and Grafana's `Pipeline Overview`
dashboard surfaces them on a single screen.

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
