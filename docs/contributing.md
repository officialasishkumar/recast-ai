# Contributing

## Prerequisites

- Docker and Docker Compose v2.
- Go 1.25 or newer.
- Python 3.12 or newer.
- Node.js 20 or newer (npm 10+).

A Gemini API key is required to actually exercise the pipeline. TTS providers (ElevenLabs, AWS Polly) are optional; without them the stack falls back to gTTS.

## Local Setup

Clone and bootstrap:

```bash
git clone https://github.com/officialasishkumar/recast-ai.git
cd recast-ai
cp .env.example .env
```

Edit `.env` and set at minimum `GEMINI_API_KEY` and `JWT_SECRET`. Optional blocks:

- `ELEVENLABS_API_KEY` to enable ElevenLabs TTS and native alignment.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` to enable Polly.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` to enable OAuth in development.

Bring everything up:

```bash
make up       # full stack: gateway + workers + Next.js + Postgres + Rabbit + MinIO + Redis
make dev      # infra only: Postgres, Rabbit, MinIO, Redis (run workers locally with go run / python)
make down     # stop everything
make logs     # tail all service logs
make psql     # open a psql shell against the dev database
```

## Environment Variables

A non-exhaustive reference; see `.env.example` for the full list.

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | all backend services | PostgreSQL DSN. |
| `RABBITMQ_URL` | all backend services | AMQP connection string. |
| `REDIS_URL` | gateway, delivery | Redis connection string. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | all services | MinIO credentials. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | video-analyzer | Gemini auth and model override. |
| `ELEVENLABS_API_KEY` | tts-service | ElevenLabs credentials. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | tts-service | Polly credentials. |
| `JWT_SECRET` | gateway | HS256 signing key. Rotate for production. |
| `RATE_LIMIT_PER_MINUTE` | gateway | Per-user request budget. Defaults to 60. |
| `CORS_ORIGIN` | gateway | Allowed origin for the web app. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all services | OTLP collector URL. |

## Adding a New Queue Consumer

1. Pick the closest existing consumer as a template. Python consumers live under `services/<name>/` with a `main.py` that wires a `QueueConsumer`; Go consumers live under `cmd/<name>-service/` with a `main.go` that uses `pkg/queue`.
2. Declare the new queue **and** its dead-letter queue in `pkg/queue` (Go) or `services/<name>/queue.py` (Python). Both sides must agree on the queue name.
3. Implement the message handler. In Python the convention is `async def _process_message(self, message: dict) -> None`; in Go the convention is `func (c *Consumer) Handle(ctx context.Context, msg queue.Message) error`.
4. Check the incoming `stage_attempt_id` against Redis and acknowledge-drop duplicates before doing any real work.
5. Publish progress events to the Redis pub/sub channel `job:<job_id>` so the gateway can fan them out over WebSocket.
6. Register a Prometheus counter and histogram for processed messages and processing latency; expose `/metrics` on the service's health port.
7. Add the new service to `docker-compose.yml` and wire a Dockerfile under `docker/`.

## Adding a New Next.js Page

1. Create a route under `web/src/app/<segment>/page.tsx`. Follow `web/AGENTS.md` for Next 16 breaking changes, especially the rules around async dynamic APIs (`cookies()`, `headers()`, `params`) and the new caching defaults.
2. Use the design tokens declared in `web/src/app/globals.css`. Do not hard-code hex values; reference `var(--bg)`, `var(--text)`, and friends.
3. Co-locate tests under `web/src/app/<segment>/__tests__/` or as `*.test.tsx` next to the component.
4. For shared UI bits, add to `web/src/components/ui/`.

## Running Tests

```bash
go test ./...
cd web && npm test
pytest services/video-analyzer/tests services/tts-service/tests
make test-e2e
```

`make test-e2e` boots the full compose stack against the committed sample recording in `test/e2e/fixtures/` and walks the pipeline end-to-end.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary>

<optional body>
```

Allowed types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`, `ci`.
A single commit stays inside one scope. Never mix frontend, backend, and infra changes in the same commit.

## Pull Request Review

- Two LGTMs from maintainers are required to merge.
- CI must be green: the Go, Python, frontend, and Docker-build jobs all pass.
- The end-to-end regression job must pass on the sample recording.
- Include a short testing note in the PR description so reviewers know what was exercised locally.

## Coding Conventions

- **Go:** use `log/slog` with JSON output; return errors wrapped with `fmt.Errorf("context: %w", err)`; no panics outside `main` setup; run `go vet` and `gofmt` before pushing.
- **Python:** use `structlog` with the JSON renderer; type every public function with `typing`/`pydantic`; format with `ruff format` and lint with `ruff check`.
- **TypeScript:** keep `strict: true` in `tsconfig.json`; prefer explicit return types on exported functions; avoid `any`.
