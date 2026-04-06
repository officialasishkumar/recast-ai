"""LLM Orchestrator service entry point.

Consumes frame extraction results from ``frames.queue``, sends video
frames to Claude for multimodal narration generation, validates the
output, persists transcript segments to PostgreSQL, and publishes
the result to ``transcript.queue``.

A lightweight FastAPI health-check server runs in a background thread so
that Kubernetes liveness probes work independently of queue consumption.
"""

from __future__ import annotations

import asyncio
import json
import signal
import threading
import time
import uuid
from contextlib import suppress
from typing import Any

import pika
import pika.exceptions
import psycopg2  # type: ignore[import-untyped]
import psycopg2.extras  # type: ignore[import-untyped]
import redis
import structlog
import uvicorn
from fastapi import FastAPI
from minio import Minio

from config import settings
from orchestrator.llm import LLMClient

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

logger = structlog.get_logger("llm_orchestrator")

# --------------------------------------------------------------------------- #
# Queue names
# --------------------------------------------------------------------------- #

FRAMES_QUEUE = "frames.queue"
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
    uvicorn.run(health_app, host="0.0.0.0", port=8080, log_level="warning")


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


def _declare_queues(channel: pika.adapters.blocking_connection.BlockingChannel) -> None:
    """Declare the queues this service interacts with (with DLQs)."""
    for queue_name in (FRAMES_QUEUE, TRANSCRIPT_QUEUE):
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
    return Minio(
        settings.s3_endpoint,
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
# MinIO download helpers
# --------------------------------------------------------------------------- #


def _download_frames(minio_client: Minio, job_id: str) -> list[bytes]:
    """Download all JPEG frames for a job from MinIO."""
    prefix = f"frames/{job_id}/"
    frames: list[bytes] = []

    objects = list(minio_client.list_objects(
        settings.s3_bucket, prefix=prefix, recursive=True
    ))
    # Sort by object name to maintain frame ordering
    objects.sort(key=lambda o: o.object_name)

    for obj in objects:
        if not obj.object_name.lower().endswith(".jpg"):
            continue
        response = minio_client.get_object(settings.s3_bucket, obj.object_name)
        try:
            data = response.read()
            frames.append(data)
        finally:
            response.close()
            response.release_conn()

    logger.info("frames_downloaded", job_id=job_id, count=len(frames))
    return frames


def _download_audio_text(
    minio_client: Minio, audio_file: str
) -> str | None:
    """Download extracted audio text from MinIO, or return None."""
    if not audio_file:
        return None
    try:
        response = minio_client.get_object(settings.s3_bucket, audio_file)
        try:
            return response.read().decode("utf-8", errors="replace")
        finally:
            response.close()
            response.release_conn()
    except Exception:
        logger.warning("audio_download_failed", audio_file=audio_file, exc_info=True)
        return None


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
            words_json = json.dumps(seg["words"])
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
) -> None:
    """Update the job stage in PostgreSQL."""
    with pg_conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET stage = %s, updated_at = NOW() WHERE id = %s",
            (stage, job_id),
        )
    pg_conn.commit()


def _get_job_metadata(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
) -> dict[str, Any]:
    """Fetch job metadata needed for prompt construction."""
    with pg_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT voice_id, style, language, duration_ms FROM jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"job {job_id} not found in database")
        return dict(row)


# --------------------------------------------------------------------------- #
# Message processing
# --------------------------------------------------------------------------- #


def _process_message(
    body: bytes,
    llm_client: LLMClient,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
    redis_client: redis.Redis,
    channel: pika.adapters.blocking_connection.BlockingChannel,
) -> None:
    """Process a single message from frames.queue."""
    msg = json.loads(body)
    job_id: str = msg["job_id"]
    trace_id: str = msg.get("trace_id", "")
    payload: dict = msg.get("payload", {})

    structlog.contextvars.bind_contextvars(job_id=job_id, trace_id=trace_id)
    logger.info("processing_message", queue=FRAMES_QUEUE)

    # 1. Parse payload
    audio_file: str = payload.get("audio_file", "")
    duration_ms: int = payload.get("duration_ms", 0)

    # 2. Download frames from MinIO
    frames = _download_frames(minio_client, job_id)
    if not frames:
        raise ValueError(f"no frames found for job {job_id}")

    # 3. Download extracted audio text if available
    audio_text = _download_audio_text(minio_client, audio_file)

    # 4. Get job metadata for prompt construction
    job_meta = _get_job_metadata(pg_conn, job_id)
    style: str = job_meta.get("style", "formal")
    language: str = job_meta.get("language", "en")
    if duration_ms == 0:
        duration_ms = int(job_meta.get("duration_ms", 0))

    # 5-7. Call Claude API with multimodal input, parse and validate
    loop = asyncio.new_event_loop()
    try:
        segments = loop.run_until_complete(
            llm_client.generate_transcript(
                frames=frames,
                audio_text=audio_text,
                style=style,
                language=language,
                duration_ms=duration_ms,
            )
        )
    finally:
        loop.close()

    # 8. Store segments in PostgreSQL
    _store_segments(pg_conn, job_id, segments)

    # 9. Update job stage
    _update_job_stage(pg_conn, job_id, "transcribed")

    # 10. Publish to transcript.queue
    voice_id: str = job_meta.get("voice_id", "default")
    transcript_payload = {
        "job_id": job_id,
        "trace_id": trace_id,
        "stage_attempt_id": str(uuid.uuid4()),
        "payload": {
            "segments": segments,
            "voice_id": voice_id,
        },
    }
    channel.basic_publish(
        exchange="",
        routing_key=TRANSCRIPT_QUEUE,
        body=json.dumps(transcript_payload),
        properties=pika.BasicProperties(
            delivery_mode=2,  # persistent
            content_type="application/json",
        ),
    )
    logger.info("published_to_transcript_queue", segment_count=len(segments))

    # 11. Publish job event to Redis pub/sub
    event = {
        "event": "stage_complete",
        "job_id": job_id,
        "stage": "transcribed",
        "progress": 0.40,
    }
    redis_client.publish(f"job:{job_id}", json.dumps(event))

    structlog.contextvars.unbind_contextvars("job_id", "trace_id")


# --------------------------------------------------------------------------- #
# Main consumer loop
# --------------------------------------------------------------------------- #


def _run_consumer() -> None:
    """Main consumer loop with reconnection support."""
    global _healthy

    # Resolve provider + API key
    provider = settings.llm_provider
    if provider == "gemini":
        api_key = settings.gemini_api_key
    elif provider == "openai":
        api_key = settings.openai_api_key
    else:
        api_key = settings.anthropic_api_key
    llm_client = LLMClient(provider=provider, api_key=api_key, model=settings.llm_model)
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

            logger.info("consumer_started", queue=FRAMES_QUEUE)

            for method, properties, body in channel.consume(
                FRAMES_QUEUE, inactivity_timeout=30
            ):
                if not _healthy:
                    break

                if method is None:
                    # Inactivity timeout -- heartbeat / check shutdown flag
                    continue

                try:
                    _process_message(
                        body, llm_client, minio_client, pg_conn, redis_client, channel
                    )
                    channel.basic_ack(delivery_tag=method.delivery_tag)
                    logger.info("message_acked", delivery_tag=method.delivery_tag)
                except Exception:
                    logger.error(
                        "message_processing_failed",
                        delivery_tag=method.delivery_tag,
                        exc_info=True,
                    )
                    channel.basic_nack(
                        delivery_tag=method.delivery_tag, requeue=False
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

    # Cleanup
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

    # Start the health-check server in a daemon thread
    health_thread = threading.Thread(target=_run_health_server, daemon=True)
    health_thread.start()
    logger.info("health_server_started", port=8080)

    # Run the consumer on the main thread
    _run_consumer()


if __name__ == "__main__":
    main()
