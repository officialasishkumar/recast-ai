"""TTS Service entry point.

Consumes transcript payloads from ``transcript.queue``, synthesizes
speech for each segment using ElevenLabs (or a silent placeholder in
dev mode), adjusts playback speed to match target segment durations,
concatenates all segment audio into a final file, uploads results to
MinIO, and publishes the next stage message to ``audio.queue``.

A lightweight FastAPI health-check server runs in a background thread.
"""

from __future__ import annotations

import io
import json
import os
import signal
import tempfile
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
from tts.speed import adjust_speed, concatenate_audio, get_audio_duration
from tts.synthesizer import TTSSynthesizer

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

logger = structlog.get_logger("tts_service")

# --------------------------------------------------------------------------- #
# Queue names
# --------------------------------------------------------------------------- #

TRANSCRIPT_QUEUE = "transcript.queue"
AUDIO_QUEUE = "audio.queue"

# --------------------------------------------------------------------------- #
# Health-check server
# --------------------------------------------------------------------------- #

health_app = FastAPI()
_healthy = True


@health_app.get("/health")
async def health() -> dict[str, str]:
    if _healthy:
        return {"status": "ok"}
    return {"status": "degraded"}


def _run_health_server() -> None:
    uvicorn.run(health_app, host="0.0.0.0", port=8081, log_level="warning")


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
    """Declare the queues this service uses (with DLQs)."""
    for queue_name in (TRANSCRIPT_QUEUE, AUDIO_QUEUE):
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
# MinIO upload helpers
# --------------------------------------------------------------------------- #


def _upload_to_minio(
    minio_client: Minio,
    object_name: str,
    data: bytes,
    content_type: str = "audio/wav",
) -> None:
    """Upload bytes to MinIO."""
    minio_client.put_object(
        settings.s3_bucket,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    logger.debug("minio_uploaded", object_name=object_name, size=len(data))


def _upload_file_to_minio(
    minio_client: Minio,
    object_name: str,
    file_path: str,
    content_type: str = "audio/wav",
) -> None:
    """Upload a local file to MinIO."""
    minio_client.fput_object(
        settings.s3_bucket,
        object_name,
        file_path,
        content_type=content_type,
    )
    logger.debug("minio_file_uploaded", object_name=object_name)


# --------------------------------------------------------------------------- #
# Database helpers
# --------------------------------------------------------------------------- #


def _update_segment_audio(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    segment_idx: int,
    audio_path: str,
    flagged: bool,
) -> None:
    """Update the audio_path and flagged status of a segment."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            UPDATE transcript_segments
            SET audio_path = %s, flagged = %s
            WHERE job_id = %s AND segment_idx = %s
            """,
            (audio_path, flagged, job_id, segment_idx),
        )
    pg_conn.commit()


def _update_job_synthesized(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    audio_path: str,
) -> None:
    """Update the job to synthesized stage."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            UPDATE jobs
            SET stage = 'synthesized', audio_path = %s, updated_at = NOW()
            WHERE id = %s
            """,
            (audio_path, job_id),
        )
    pg_conn.commit()


def _get_job_original_file(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
) -> str:
    """Fetch the original_file path for the job."""
    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT original_file, duration_ms FROM jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"job {job_id} not found in database")
        return row[0]


# --------------------------------------------------------------------------- #
# Segment processing
# --------------------------------------------------------------------------- #


def _process_segment(
    idx: int,
    segment: dict[str, Any],
    job_id: str,
    voice_id: str,
    synthesizer: TTSSynthesizer,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
    tmp_dir: str,
) -> str:
    """Synthesize, speed-adjust, and upload a single segment.

    Returns the local path of the final (speed-adjusted) WAV file.
    """
    text: str = segment.get("text", "")
    segment_id: int = segment.get("segment_id", idx + 1)
    start_ms: int = segment.get("start_ms", 0)
    end_ms: int = segment.get("end_ms", 0)
    target_duration_ms = end_ms - start_ms

    logger.info(
        "processing_segment",
        segment_id=segment_id,
        target_ms=target_duration_ms,
    )

    # 2a. Synthesize speech
    audio_bytes = synthesizer.synthesize(text, voice_id)

    # Write raw TTS audio to a temp file
    raw_path = os.path.join(tmp_dir, f"raw_{idx}.wav")
    with open(raw_path, "wb") as f:
        f.write(audio_bytes)

    # 2b. Measure synthesized duration
    actual_duration_ms = get_audio_duration(raw_path)

    # 2c. Calculate speed ratio
    flagged = False
    final_path = raw_path

    if target_duration_ms > 0 and actual_duration_ms > 0:
        ratio = actual_duration_ms / target_duration_ms

        # 2d. Flag if ratio outside [0.75, 1.5]
        if ratio < 0.75 or ratio > 1.5:
            flagged = True
            logger.warning(
                "segment_flagged_for_review",
                segment_id=segment_id,
                ratio=ratio,
                actual_ms=actual_duration_ms,
                target_ms=target_duration_ms,
            )

        # 2e. Adjust speed if ratio != 1.0
        if abs(ratio - 1.0) > 0.01:
            adjusted_path = os.path.join(tmp_dir, f"adjusted_{idx}.wav")
            adjust_speed(raw_path, adjusted_path, ratio)
            final_path = adjusted_path
            logger.info(
                "speed_adjusted",
                segment_id=segment_id,
                ratio=round(ratio, 4),
            )
    else:
        logger.warning(
            "skip_speed_adjust",
            segment_id=segment_id,
            target_ms=target_duration_ms,
            actual_ms=actual_duration_ms,
        )

    # 2f. Upload segment audio to MinIO
    segment_object = f"tts/{job_id}/segment_{idx}.wav"
    _upload_file_to_minio(minio_client, segment_object, final_path)

    # 2g. Update segment audio_path in DB
    _update_segment_audio(pg_conn, job_id, segment_id, segment_object, flagged)

    return final_path


# --------------------------------------------------------------------------- #
# Message processing
# --------------------------------------------------------------------------- #


def _process_message(
    body: bytes,
    synthesizer: TTSSynthesizer,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
    redis_client: redis.Redis,
    channel: pika.adapters.blocking_connection.BlockingChannel,
) -> None:
    """Process a single message from transcript.queue."""
    msg = json.loads(body)
    job_id: str = msg["job_id"]
    trace_id: str = msg.get("trace_id", "")
    payload: dict = msg.get("payload", {})

    structlog.contextvars.bind_contextvars(job_id=job_id, trace_id=trace_id)
    logger.info("processing_message", queue=TRANSCRIPT_QUEUE)

    # 1. Parse payload
    segments: list[dict] = payload.get("segments", [])
    voice_id: str = payload.get("voice_id", "default")

    if not segments:
        raise ValueError(f"no segments in transcript payload for job {job_id}")

    # Get job metadata
    original_file = _get_job_original_file(pg_conn, job_id)

    # Process all segments in a temp directory
    with tempfile.TemporaryDirectory(prefix=f"tts_{job_id}_") as tmp_dir:
        segment_paths: list[str] = []

        for idx, segment in enumerate(segments):
            path = _process_segment(
                idx=idx,
                segment=segment,
                job_id=job_id,
                voice_id=voice_id,
                synthesizer=synthesizer,
                minio_client=minio_client,
                pg_conn=pg_conn,
                tmp_dir=tmp_dir,
            )
            segment_paths.append(path)

        # 3. Concatenate all segment audio files
        final_path = os.path.join(tmp_dir, "synthesized.wav")
        concatenate_audio(segment_paths, final_path)

        # 4. Upload final audio to MinIO
        final_object = f"audio/{job_id}/synthesized.wav"
        _upload_file_to_minio(minio_client, final_object, final_path)

        # Get final audio duration
        final_duration_ms = get_audio_duration(final_path)

    # 5. Update job in DB
    _update_job_synthesized(pg_conn, job_id, final_object)

    # 6. Publish AudioPayload to audio.queue
    audio_payload = {
        "job_id": job_id,
        "trace_id": trace_id,
        "stage_attempt_id": str(uuid.uuid4()),
        "payload": {
            "audio_file": final_object,
            "original_file": original_file,
            "duration_ms": int(final_duration_ms),
        },
    }
    channel.basic_publish(
        exchange="",
        routing_key=AUDIO_QUEUE,
        body=json.dumps(audio_payload),
        properties=pika.BasicProperties(
            delivery_mode=2,
            content_type="application/json",
        ),
    )
    logger.info(
        "published_to_audio_queue",
        segment_count=len(segments),
        duration_ms=int(final_duration_ms),
    )

    # 7. Publish job event to Redis pub/sub
    event = {
        "event": "stage_complete",
        "job_id": job_id,
        "stage": "synthesized",
        "progress": 0.60,
    }
    redis_client.publish(f"job:{job_id}", json.dumps(event))

    structlog.contextvars.unbind_contextvars("job_id", "trace_id")


# --------------------------------------------------------------------------- #
# Main consumer loop
# --------------------------------------------------------------------------- #


def _run_consumer() -> None:
    """Main consumer loop with reconnection support."""
    global _healthy

    synthesizer = TTSSynthesizer(
        provider=settings.tts_provider,
        api_key=settings.elevenlabs_api_key,
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

            logger.info("consumer_started", queue=TRANSCRIPT_QUEUE)

            for method, properties, body in channel.consume(
                TRANSCRIPT_QUEUE, inactivity_timeout=30
            ):
                if not _healthy:
                    break

                if method is None:
                    continue

                try:
                    _process_message(
                        body, synthesizer, minio_client, pg_conn, redis_client, channel
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
    logger.info("health_server_started", port=8081)

    # Run the consumer on the main thread
    _run_consumer()


if __name__ == "__main__":
    main()
