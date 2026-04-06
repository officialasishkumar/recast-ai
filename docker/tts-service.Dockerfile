FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/tts-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/tts-service/ .

EXPOSE 8083
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -f http://localhost:8083/health || exit 1
CMD ["python", "main.py"]
