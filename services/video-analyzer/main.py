"""Video Analyzer service entry point.

Consumes ingestion jobs from ``ingestion.queue``, downloads the raw
video from MinIO, uploads it to the Gemini File API, generates a
timestamped narration transcript, persists segments to PostgreSQL,
and publishes the next stage message to ``transcript.queue``.

A lightweight FastAPI health-check server runs in a background thread
so Kubernetes liveness probes work independently of queue consumption.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import suppress
from typing import Any

import pika
import pika.adapters.blocking_connection
import pika.exceptions
import psycopg2  # type: ignore[import-untyped]
import psycopg2.extras  # type: ignore[import-untyped]
import redis
import structlog
import uvicorn
from fastapi import FastAPI
from minio import Minio

from analyzer.gemini import GeminiVideoAnalyzer
from config import settings

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        structlog.get_level_from_name(settings.log_level)
    ),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger("video_analyzer")

# --------------------------------------------------------------------------- #
# Queue names
# --------------------------------------------------------------------------- #

INGESTION_QUEUE = "ingestion.queue"
TRANSCRIPT_QUEUE = "transcript.queue"

# --------------------------------------------------------------------------- #
# Health-check server (runs in a background daemon thread)
# --------------------------------------------------------------------------- #

health_app = FastAPI()
_healthy = True


@health_app.get("/health")
async def health() -> dict[str, str]:
    if _healthy:
        return {"status": "ok"}
    return {"status": "degraded"}


def _run_health_server() -> None:
    uvicorn.run(
        health_app,
        host="0.0.0.0",
        port=settings.health_port,
        log_level="warning",
    )


# --------------------------------------------------------------------------- #
# Infrastructure helpers
# --------------------------------------------------------------------------- #


def _connect_rabbitmq() -> pika.BlockingConnection:
    """Connect to RabbitMQ with retry."""
    if settings.rabbitmq_url_override:
        params = pika.URLParameters(settings.rabbitmq_url_override)
        params.heartbeat = 600
        params.blocked_connection_timeout = 300
    else:
        params = pika.ConnectionParameters(
            host=settings.rabbitmq_host,
            port=settings.rabbitmq_port,
            credentials=pika.PlainCredentials(
                settings.rabbitmq_user, settings.rabbitmq_password
            ),
            heartbeat=600,
            blocked_connection_timeout=300,
        )
    for attempt in range(1, 31):
        try:
            conn = pika.BlockingConnection(params)
            logger.info("rabbitmq_connected", attempt=attempt)
            return conn
        except pika.exceptions.AMQPConnectionError:
            logger.warning("rabbitmq_not_ready", attempt=attempt)
            time.sleep(2)
    raise RuntimeError("failed to connect to RabbitMQ after 30 attempts")


def _declare_queues(
    channel: pika.adapters.blocking_connection.BlockingChannel,
) -> None:
    """Declare the queues this service interacts with (with DLQs)."""
    for queue_name in (INGESTION_QUEUE, TRANSCRIPT_QUEUE):
        dlq = f"{queue_name}.dlq"
        channel.queue_declare(queue=dlq, durable=True)
        channel.queue_declare(
            queue=queue_name,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": dlq,
                "x-message-ttl": 86_400_000,
            },
        )
        logger.info("queue_declared", queue=queue_name)


def _connect_minio() -> Minio:
    secure = settings.s3_endpoint.startswith("https")
    endpoint = settings.s3_endpoint
    if endpoint.startswith("http://"):
        endpoint = endpoint[len("http://"):]
    elif endpoint.startswith("https://"):
        endpoint = endpoint[len("https://"):]
    return Minio(
        endpoint,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=secure,
    )


def _connect_postgres() -> psycopg2.extensions.connection:
    for attempt in range(1, 31):
        try:
            conn = psycopg2.connect(
                host=settings.db_host,
                port=settings.db_port,
                user=settings.db_user,
                password=settings.db_password,
                dbname=settings.db_name,
                sslmode=settings.db_sslmode,
            )
            conn.autocommit = False
            logger.info("postgres_connected", attempt=attempt)
            return conn
        except psycopg2.OperationalError:
            logger.warning("postgres_not_ready", attempt=attempt)
            time.sleep(2)
    raise RuntimeError("failed to connect to PostgreSQL after 30 attempts")


def _connect_redis() -> redis.Redis:
    return redis.Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        decode_responses=True,
    )


# --------------------------------------------------------------------------- #
# Video download + duration probe
# --------------------------------------------------------------------------- #


def _download_video(
    minio_client: Minio,
    object_key: str,
    local_dir: str,
) -> str:
    """Download a video object from MinIO to ``local_dir`` and return its path."""
    os.makedirs(local_dir, exist_ok=True)
    suffix = pathlib.Path(object_key).suffix or ".mp4"
    fd, local_path = tempfile.mkstemp(suffix=suffix, dir=local_dir)
    os.close(fd)
    minio_client.fget_object(settings.s3_bucket, object_key, local_path)
    size_bytes = os.path.getsize(local_path)
    logger.info(
        "video_downloaded",
        object_key=object_key,
        local_path=local_path,
        size_bytes=size_bytes,
    )
    return local_path


def _probe_duration_ms(video_path: str) -> int:
    """Probe the video file's duration in ms via ``ffprobe``.

    Returns 0 when the duration cannot be determined (treated as unknown
    by downstream code and propagated as ``None`` to the prompt).
    Raises RuntimeError when ffprobe is not installed on the system.
    """
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffprobe binary not found on PATH; install ffmpeg in the container"
        ) from exc
    except subprocess.CalledProcessError as exc:
        logger.warning(
            "ffprobe_nonzero_exit",
            stderr=exc.stderr,
            returncode=exc.returncode,
        )
        return 0
    except subprocess.TimeoutExpired:
        logger.warning("ffprobe_timeout")
        return 0

    raw = completed.stdout.strip()
    if not raw or raw.lower() == "n/a":
        return 0
    try:
        seconds = float(raw)
    except ValueError:
        return 0
    if seconds <= 0:
        return 0
    return int(seconds * 1000)


# --------------------------------------------------------------------------- #
# Database helpers
# --------------------------------------------------------------------------- #


def _store_segments(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    segments: list[dict[str, Any]],
) -> None:
    """Upsert transcript segments into PostgreSQL."""
    with pg_conn.cursor() as cur:
        for seg in segments:
            words_json = json.dumps(seg.get("words", []))
            cur.execute(
                """
                INSERT INTO transcript_segments
                    (id, job_id, segment_idx, start_ms, end_ms, text,
                     words_json, confidence)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (job_id, segment_idx)
                DO UPDATE SET
                    start_ms   = EXCLUDED.start_ms,
                    end_ms     = EXCLUDED.end_ms,
                    text       = EXCLUDED.text,
                    words_json = EXCLUDED.words_json,
                    confidence = EXCLUDED.confidence
                """,
                (
                    str(uuid.uuid4()),
                    job_id,
                    seg["segment_id"],
                    seg["start_ms"],
                    seg["end_ms"],
                    seg["text"],
                    words_json,
                    seg["confidence"],
                ),
            )
    pg_conn.commit()
    logger.info("segments_stored", job_id=job_id, count=len(segments))


def _update_job_stage(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    stage: str,
    duration_ms: int,
) -> None:
    """Update the job stage and duration (only if not already set)."""
    with pg_conn.cursor() as cur:
        if duration_ms > 0:
            cur.execute(
                """
                UPDATE jobs
                SET stage = %s,
                    duration_ms = CASE
                        WHEN duration_ms IS NULL OR duration_ms = 0 THEN %s
                        ELSE duration_ms
                    END,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (stage, duration_ms, job_id),
            )
        else:
            cur.execute(
                "UPDATE jobs SET stage = %s, updated_at = NOW() WHERE id = %s",
                (stage, job_id),
            )
    pg_conn.commit()


def _get_existing_duration_ms(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
) -> int:
    """Return the current duration_ms stored for this job, or 0 if unset."""
    with pg_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT duration_ms FROM jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return 0
        value = row.get("duration_ms") or 0
        return int(value)


# --------------------------------------------------------------------------- #
# Message processing
# --------------------------------------------------------------------------- #


def _process_message(
    body: bytes,
    analyzer: GeminiVideoAnalyzer,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
    redis_client: redis.Redis,
    channel: pika.adapters.blocking_connection.BlockingChannel,
) -> None:
    """Process a single message from ``ingestion.queue``."""
    msg = json.loads(body)
    job_id: str = msg["job_id"]
    trace_id: str = msg.get("trace_id", "")
    payload: dict[str, Any] = msg.get("payload", {})

    structlog.contextvars.bind_contextvars(job_id=job_id, trace_id=trace_id)
    try:
        logger.info("processing_message", queue=INGESTION_QUEUE)

        object_key: str = payload["object_key"]
        voice_id: str = payload.get("voice_id", "default")
        style: str = payload.get("style", "formal")
        language: str = payload.get("language", "en")

        local_video_path: str | None = None
        try:
            local_video_path = _download_video(
                minio_client,
                object_key,
                settings.tmp_dir,
            )

            probed_duration_ms = _probe_duration_ms(local_video_path)
            existing_duration_ms = _get_existing_duration_ms(pg_conn, job_id)
            effective_duration_ms = (
                probed_duration_ms if probed_duration_ms > 0 else existing_duration_ms
            )
            prompt_duration_ms: int | None = (
                effective_duration_ms if effective_duration_ms > 0 else None
            )

            logger.info(
                "duration_probed",
                probed_ms=probed_duration_ms,
                existing_ms=existing_duration_ms,
                effective_ms=effective_duration_ms,
            )

            segments = asyncio.run(
                analyzer.analyze(
                    video_path=local_video_path,
                    style=style,
                    language=language,
                    duration_ms=prompt_duration_ms,
                )
            )
        finally:
            if local_video_path and os.path.exists(local_video_path):
                with suppress(OSError):
                    os.remove(local_video_path)

        _store_segments(pg_conn, job_id, segments)
        _update_job_stage(
            pg_conn,
            job_id,
            "transcribed",
            probed_duration_ms,
        )

        transcript_payload = {
            "job_id": job_id,
            "trace_id": trace_id,
            "stage_attempt_id": str(uuid.uuid4()),
            "payload": {
                "segments": segments,
                "voice_id": voice_id,
                "duration_ms": effective_duration_ms,
            },
        }
        channel.basic_publish(
            exchange="",
            routing_key=TRANSCRIPT_QUEUE,
            body=json.dumps(transcript_payload),
            properties=pika.BasicProperties(
                delivery_mode=2,
                content_type="application/json",
            ),
        )
        logger.info(
            "published_to_transcript_queue",
            segment_count=len(segments),
        )

        event = {
            "event": "stage_complete",
            "job_id": job_id,
            "stage": "transcribed",
            "progress": 0.50,
        }
        with suppress(Exception):
            redis_client.publish(f"job:{job_id}", json.dumps(event))
    finally:
        structlog.contextvars.unbind_contextvars("job_id", "trace_id")


# --------------------------------------------------------------------------- #
# Main consumer loop
# --------------------------------------------------------------------------- #


def _run_consumer() -> None:
    """Main consumer loop with reconnection support."""
    global _healthy

    analyzer = GeminiVideoAnalyzer(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        fallback_model=settings.gemini_fallback_model,
        timeout_s=settings.gemini_timeout_s,
    )
    minio_client = _connect_minio()
    pg_conn = _connect_postgres()
    redis_client = _connect_redis()

    while _healthy:
        rmq_conn: pika.BlockingConnection | None = None
        try:
            rmq_conn = _connect_rabbitmq()
            channel = rmq_conn.channel()
            channel.basic_qos(prefetch_count=1)
            _declare_queues(channel)

            logger.info("consumer_started", queue=INGESTION_QUEUE)

            for method, _properties, body in channel.consume(
                INGESTION_QUEUE, inactivity_timeout=30
            ):
                if not _healthy:
                    break
                if method is None:
                    continue

                try:
                    _process_message(
                        body,
                        analyzer,
                        minio_client,
                        pg_conn,
                        redis_client,
                        channel,
                    )
                    channel.basic_ack(delivery_tag=method.delivery_tag)
                    logger.info(
                        "message_acked",
                        delivery_tag=method.delivery_tag,
                    )
                except Exception:
                    logger.error(
                        "message_processing_failed",
                        delivery_tag=method.delivery_tag,
                        exc_info=True,
                    )
                    with suppress(Exception):
                        pg_conn.rollback()
                    channel.basic_nack(
                        delivery_tag=method.delivery_tag,
                        requeue=False,
                    )

        except pika.exceptions.AMQPConnectionError:
            logger.warning("rabbitmq_connection_lost", exc_info=True)
            time.sleep(5)
        except Exception:
            logger.error("consumer_error", exc_info=True)
            time.sleep(5)
        finally:
            if rmq_conn and not rmq_conn.is_closed:
                with suppress(Exception):
                    rmq_conn.close()

    with suppress(Exception):
        pg_conn.close()
    with suppress(Exception):
        redis_client.close()

    logger.info("consumer_stopped")


# --------------------------------------------------------------------------- #
# Signal handling & entrypoint
# --------------------------------------------------------------------------- #


def _signal_handler(signum: int, _frame: Any) -> None:
    global _healthy
    sig_name = signal.Signals(signum).name
    logger.info("shutdown_signal_received", signal=sig_name)
    _healthy = False


def main() -> None:
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    health_thread = threading.Thread(target=_run_health_server, daemon=True)
    health_thread.start()
    logger.info("health_server_started", port=settings.health_port)

    _run_consumer()


if __name__ == "__main__":
    main()
