"""TTS Service entry point.

Consumes transcript payloads from ``transcript.queue``, synthesizes
speech per segment using the configured provider, rescales each clip to
match the scene duration, aggregates word-level timings, uploads the
per-segment audio to MinIO, updates the database row, and publishes the
next-stage message to ``audio.queue``.

A lightweight FastAPI health-check server runs in a background thread.
"""

from __future__ import annotations

import io
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
from tts.alignment import align_words_to_segment
from tts.speed_control import FitResult, fit_to_segment
from tts.synthesizer import SynthesisResult, TTSProvider, build_provider

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

SEGMENT_MIME = "audio/mpeg"
SEGMENT_EXT = "mp3"

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
# MinIO upload helper
# --------------------------------------------------------------------------- #


def _upload_bytes(
    minio_client: Minio,
    object_name: str,
    data: bytes,
    content_type: str,
) -> None:
    minio_client.put_object(
        settings.s3_bucket,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    logger.debug("minio_uploaded", object_name=object_name, size=len(data))


# --------------------------------------------------------------------------- #
# Database helpers
# --------------------------------------------------------------------------- #


def _update_segment_record(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    segment_idx: int,
    audio_path: str,
    flagged: bool,
    words: list[dict[str, int | str]],
) -> None:
    """Persist audio path, flag, and word-level timings for a segment."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            UPDATE transcript_segments
               SET audio_path = %s,
                   flagged    = %s,
                   words_json = %s::jsonb
             WHERE job_id = %s
               AND segment_idx = %s
            """,
            (
                audio_path,
                flagged,
                json.dumps(words),
                job_id,
                segment_idx,
            ),
        )
    pg_conn.commit()


def _mark_job_synthesized(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
) -> None:
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            UPDATE jobs
               SET stage = 'synthesized',
                   updated_at = NOW()
             WHERE id = %s
            """,
            (job_id,),
        )
    pg_conn.commit()


def _fetch_segments_by_id(
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
    segment_ids: list[int],
) -> list[dict[str, Any]]:
    if not segment_ids:
        return []
    with pg_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT segment_idx, start_ms, end_ms, text
              FROM transcript_segments
             WHERE job_id = %s
               AND segment_idx = ANY(%s::int[])
             ORDER BY segment_idx
            """,
            (job_id, segment_ids),
        )
        rows = cur.fetchall()
    return [
        {
            "segment_id": int(r["segment_idx"]),
            "start_ms": int(r["start_ms"]),
            "end_ms": int(r["end_ms"]),
            "text": str(r["text"]),
        }
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# Segment processing
# --------------------------------------------------------------------------- #


def _process_segment(
    segment: dict[str, Any],
    job_id: str,
    voice_id: str,
    language: str,
    provider: TTSProvider,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
) -> dict[str, Any]:
    """Synthesize, fit, align, persist, and return a summary dict."""
    text: str = str(segment.get("text", "")).strip()
    segment_id: int = int(segment.get("segment_id", 0))
    start_ms: int = int(segment.get("start_ms", 0))
    end_ms: int = int(segment.get("end_ms", 0))
    target_duration_ms = max(end_ms - start_ms, 0)

    logger.info(
        "processing_segment",
        segment_id=segment_id,
        target_ms=target_duration_ms,
        text_length=len(text),
    )

    result: SynthesisResult = provider.synthesize(text, voice_id, language)

    fit: FitResult = fit_to_segment(
        audio_bytes=result.audio_bytes,
        current_ms=result.duration_ms,
        target_ms=target_duration_ms or result.duration_ms,
        mime_type=result.mime_type,
    )

    words = align_words_to_segment(
        segment=segment,
        provider_alignment=result.word_alignments,
        final_duration_ms=fit.final_duration_ms,
    )

    object_name = f"audio/{job_id}/{segment_id}.{SEGMENT_EXT}"
    _upload_bytes(
        minio_client,
        object_name=object_name,
        data=fit.audio_bytes,
        content_type=SEGMENT_MIME,
    )

    _update_segment_record(
        pg_conn=pg_conn,
        job_id=job_id,
        segment_idx=segment_id,
        audio_path=object_name,
        flagged=fit.speed_flagged,
        words=words,
    )

    return {
        "segment_id": segment_id,
        "audio_path": object_name,
        "duration_ms": fit.final_duration_ms,
        "flagged": fit.speed_flagged,
        "applied_ratio": fit.applied_ratio,
        "word_count": len(words),
    }


# --------------------------------------------------------------------------- #
# Message processing
# --------------------------------------------------------------------------- #


def _process_message(
    body: bytes,
    provider: TTSProvider,
    minio_client: Minio,
    pg_conn: psycopg2.extensions.connection,
    redis_client: redis.Redis,
    channel: pika.adapters.blocking_connection.BlockingChannel,
) -> None:
    """Process one message from ``transcript.queue``."""
    msg = json.loads(body)
    job_id: str = msg["job_id"]
    trace_id: str = msg.get("trace_id", "")
    payload: dict[str, Any] = msg.get("payload", {}) or {}

    structlog.contextvars.bind_contextvars(job_id=job_id, trace_id=trace_id)
    try:
        logger.info("processing_message", queue=TRANSCRIPT_QUEUE)

        voice_id: str = str(payload.get("voice_id") or "default")
        language: str = str(payload.get("language") or "en")

        segments = _select_segments(payload, pg_conn, job_id)
        if not segments:
            raise ValueError(f"no segments to synthesize for job {job_id}")

        regen_only = _is_regeneration_request(payload)

        summaries: list[dict[str, Any]] = []
        for segment in segments:
            summary = _process_segment(
                segment=segment,
                job_id=job_id,
                voice_id=voice_id,
                language=language,
                provider=provider,
                minio_client=minio_client,
                pg_conn=pg_conn,
            )
            summaries.append(summary)

        if not regen_only:
            _mark_job_synthesized(pg_conn, job_id)

        audio_payload = {
            "job_id": job_id,
            "trace_id": trace_id,
            "stage_attempt_id": str(uuid.uuid4()),
            "payload": {
                "segments_count": len(summaries),
                "voice_id": voice_id,
                "regenerated_segment_ids": (
                    [s["segment_id"] for s in summaries] if regen_only else None
                ),
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
            segments_count=len(summaries),
            regen_only=regen_only,
        )

        if not regen_only:
            event = {
                "event": "stage_complete",
                "job_id": job_id,
                "stage": "synthesized",
                "progress": 0.80,
            }
            redis_client.publish(f"job:{job_id}", json.dumps(event))
    finally:
        structlog.contextvars.unbind_contextvars("job_id", "trace_id")


def _select_segments(
    payload: dict[str, Any],
    pg_conn: psycopg2.extensions.connection,
    job_id: str,
) -> list[dict[str, Any]]:
    """Choose the working segments for this message.

    A regeneration request sends ``segment_id`` or ``segment_ids`` and we
    hydrate the rows from Postgres. Full-job messages send ``segments``
    inline from the video-analyzer.
    """
    ids = _regeneration_ids(payload)
    if ids:
        return _fetch_segments_by_id(pg_conn, job_id, ids)

    raw_segments = payload.get("segments") or []
    out: list[dict[str, Any]] = []
    for idx, seg in enumerate(raw_segments):
        seg_dict = dict(seg)
        seg_dict.setdefault("segment_id", int(seg.get("segment_id", idx + 1)))
        out.append(seg_dict)
    return out


def _is_regeneration_request(payload: dict[str, Any]) -> bool:
    return bool(_regeneration_ids(payload))


def _regeneration_ids(payload: dict[str, Any]) -> list[int]:
    if "segment_ids" in payload and payload["segment_ids"]:
        return [int(v) for v in payload["segment_ids"]]
    if "segment_id" in payload and payload["segment_id"] is not None:
        return [int(payload["segment_id"])]
    return []


# --------------------------------------------------------------------------- #
# Main consumer loop
# --------------------------------------------------------------------------- #


def _run_consumer() -> None:
    """Main consumer loop with reconnection support."""
    global _healthy

    provider = build_provider(
        settings.tts_provider,
        elevenlabs_api_key=settings.elevenlabs_api_key,
        elevenlabs_model_id=settings.elevenlabs_model_id,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        aws_region=settings.aws_region,
        polly_engine=settings.polly_engine,
    )
    logger.info(
        "provider_initialized",
        provider=type(provider).__name__,
        configured=settings.tts_provider,
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

            for method, _properties, body in channel.consume(
                TRANSCRIPT_QUEUE, inactivity_timeout=30
            ):
                if not _healthy:
                    break
                if method is None:
                    continue

                try:
                    _process_message(
                        body,
                        provider,
                        minio_client,
                        pg_conn,
                        redis_client,
                        channel,
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
    logger.info("health_server_started", port=8081)

    _run_consumer()


if __name__ == "__main__":
    main()
