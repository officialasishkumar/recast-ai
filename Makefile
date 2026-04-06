.PHONY: help dev up down build test lint migrate clean

SHELL := /bin/bash

# --- Help ---

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Development ---

dev: ## Start infrastructure only (for local development)
	docker compose up -d postgres redis rabbitmq minio

up: ## Start all services
	docker compose up -d --build

down: ## Stop all services
	docker compose down

logs: ## Tail logs for all services
	docker compose logs -f

# --- Build ---

build-go: ## Build all Go binaries
	@echo "Building Go services..."
	go build -o bin/api-gateway ./cmd/api-gateway
	go build -o bin/upload-service ./cmd/upload-service
	go build -o bin/frame-extractor ./cmd/frame-extractor
	go build -o bin/mux-service ./cmd/mux-service
	go build -o bin/delivery-service ./cmd/delivery-service
	@echo "Done."

build-web: ## Build the Next.js frontend
	cd web && npm ci && npm run build

build: build-go build-web ## Build everything

# --- Testing ---

test-go: ## Run Go tests
	go test -race -coverprofile=coverage.txt -covermode=atomic ./...

test-python: ## Run Python tests
	cd services/llm-orchestrator && python -m pytest tests/ -v
	cd services/tts-service && python -m pytest tests/ -v

test: test-go test-python ## Run all tests

# --- Linting ---

lint-go: ## Lint Go code
	golangci-lint run ./...

lint-web: ## Lint frontend
	cd web && npm run lint

lint: lint-go lint-web ## Lint everything

# --- Database ---

migrate: ## Run database migrations (requires running postgres)
	@echo "Running migrations..."
	docker compose exec -T postgres psql -U recast -d recast -f /docker-entrypoint-initdb.d/001_init.sql
	@echo "Migrations complete."

migrate-down: ## Rollback database migrations
	docker compose exec -T postgres psql -U recast -d recast -f /dev/stdin < migrations/001_init.down.sql

# --- Utilities ---

clean: ## Remove build artifacts
	rm -rf bin/ web/.next web/node_modules coverage.txt

psql: ## Open a psql shell
	docker compose exec postgres psql -U recast -d recast

redis-cli: ## Open a redis-cli shell
	docker compose exec redis redis-cli

rabbitmq: ## Open RabbitMQ management UI (http://localhost:15672)
	@echo "RabbitMQ management: http://localhost:15672 (guest/guest)"

minio: ## Open MinIO console (http://localhost:9001)
	@echo "MinIO console: http://localhost:9001 (minioadmin/minioadmin)"
