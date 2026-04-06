#!/usr/bin/env bash
set -euo pipefail

echo "=== Recast AI — Development Setup ==="
echo ""

# Check prerequisites
for cmd in docker go node npm; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: $cmd is not installed."
        exit 1
    fi
done
echo "✓ All prerequisites found."

# Copy .env if needed
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✓ Created .env from .env.example — edit it with your API keys."
else
    echo "✓ .env already exists."
fi

# Install Go dependencies
echo "Installing Go dependencies..."
go mod download
echo "✓ Go dependencies installed."

# Install frontend dependencies
echo "Installing frontend dependencies..."
cd web && npm ci && cd ..
echo "✓ Frontend dependencies installed."

# Start infrastructure
echo "Starting infrastructure (Postgres, Redis, RabbitMQ, MinIO)..."
docker compose up -d postgres redis rabbitmq minio
echo "✓ Infrastructure started."

# Wait for services
echo "Waiting for services to be healthy..."
sleep 5

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Available commands:"
echo "  make dev          — Start infrastructure only"
echo "  make up           — Start all services (Docker)"
echo "  make build-go     — Build Go binaries locally"
echo "  make test         — Run all tests"
echo "  make logs         — Tail service logs"
echo ""
echo "Service URLs:"
echo "  Web UI:           http://localhost:3000"
echo "  API Gateway:      http://localhost:8080"
echo "  RabbitMQ Console: http://localhost:15672 (guest/guest)"
echo "  MinIO Console:    http://localhost:9001 (minioadmin/minioadmin)"
