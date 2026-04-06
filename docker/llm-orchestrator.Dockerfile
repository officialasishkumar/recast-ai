FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/llm-orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/llm-orchestrator/ .

EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -f http://localhost:8082/health || exit 1
CMD ["python", "main.py"]
