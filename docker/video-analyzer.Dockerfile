FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ffmpeg build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 analyzer \
    && useradd --system --uid 1001 --gid analyzer --create-home analyzer

WORKDIR /app

COPY services/video-analyzer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/video-analyzer/ .
RUN chown -R analyzer:analyzer /app

USER analyzer

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -f http://localhost:8080/health || exit 1
CMD ["python", "main.py"]
