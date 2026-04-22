#!/usr/bin/env bash
set -euo pipefail

# Starts only the infrastructure services and waits for them to become healthy.
# Use this when developing application services on the host.

cd "$(dirname "$0")/.."

INFRA_SERVICES=(postgres redis rabbitmq minio)

echo "Starting infrastructure services: ${INFRA_SERVICES[*]}..."
docker compose up -d "${INFRA_SERVICES[@]}"

echo "Waiting for infrastructure to report healthy..."
DEADLINE=$((SECONDS + 120))
for svc in "${INFRA_SERVICES[@]}"; do
    while true; do
        status=$(docker compose ps --format json "$svc" 2>/dev/null | grep -o '"Health":"[^"]*"' | head -n1 | sed 's/"Health":"//;s/"$//' || true)
        if [ "$status" = "healthy" ]; then
            echo "  [ok] $svc"
            break
        fi
        if [ "$SECONDS" -ge "$DEADLINE" ]; then
            echo "  [fail] $svc not healthy within timeout"
            docker compose ps
            exit 1
        fi
        sleep 2
    done
done

echo ""
echo "Infrastructure is ready."
echo "  Postgres  -> localhost:5432  (recast/recast)"
echo "  Redis     -> localhost:6379"
echo "  RabbitMQ  -> localhost:5672  (UI: http://localhost:15672)"
echo "  MinIO     -> localhost:9000  (UI: http://localhost:9001)"
