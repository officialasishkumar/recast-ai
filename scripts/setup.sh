#!/usr/bin/env bash
set -euo pipefail

# Lean one-shot setup: copies .env if missing, pulls images, brings up the stack.

cd "$(dirname "$0")/.."

echo "=== Recast AI - Setup ==="

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example - edit it to add API keys (GEMINI_API_KEY, etc)."
else
    echo ".env already exists; leaving it in place."
fi

echo "Pulling base images (this may take a while)..."
docker compose pull || true

echo "Building and starting the full stack via make up..."
make up

cat <<'EONEXT'

=== Setup complete ===

Next steps:
  make logs              Tail logs across all services
  make dev               Start only infra for local dev (app runs on host)
  make test-e2e          Run the end-to-end regression harness
  make seed-demo         Seed demo user/voices/sample job
  make down              Stop everything

Service URLs:
  Web UI         http://localhost:3000
  API Gateway    http://localhost:8080
  RabbitMQ UI    http://localhost:15672  (guest/guest)
  MinIO Console  http://localhost:9001   (minioadmin/minioadmin)
EONEXT
