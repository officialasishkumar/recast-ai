"""Gemini File API driven video analyzer.

Wraps the synchronous ``google-genai`` SDK v1 in ``asyncio.to_thread``
so the consumer loop can operate concurrently without blocking on
network I/O. Concurrency is capped via a module-level semaphore so a
burst of incoming jobs cannot overwhelm the Gemini quota.

Resilience:
- 429 / 5xx / timeout errors trigger exponential backoff
  (2, 4, 8, 16 seconds, then fail).
- Upload + polling + generate_content each run under the configured
  request timeout.
- A single schema-level retry is performed at the application layer
  (in ``analyze``) with a stricter reminder appended to the user
  prompt.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import structlog
from google import genai
from google.genai import types

from analyzer.prompt import build_system_prompt, build_user_prompt
from analyzer.validator import (
    TRANSCRIPT_SCHEMA,
    TranscriptValidationError,
    validate_transcript,
)

logger = structlog.get_logger(__name__)

# Cap concurrent in-flight Gemini calls across the whole process.
_SEMAPHORE = asyncio.Semaphore(3)

# Retry backoff schedule (seconds). After the final entry we give up.
_BACKOFF_SCHEDULE: tuple[int, ...] = (2, 4, 8, 16)

# Gemini file-activation polling.
_POLL_INTERVAL_S: float = 2.0
_POLL_TIMEOUT_S: float = 120.0


def _mime_type_for(path: str) -> str:
    """Best-effort MIME type inference for the uploaded video file."""
    ext = Path(path).suffix.lower().lstrip(".")
    return {
        "mp4": "video/mp4",
        "m4v": "video/mp4",
        "mov": "video/quicktime",
        "webm": "video/webm",
        "mkv": "video/x-matroska",
        "avi": "video/x-msvideo",
        "mpeg": "video/mpeg",
        "mpg": "video/mpeg",
    }.get(ext, "video/mp4")


def _is_retryable(exc: BaseException) -> bool:
    """Classify whether an SDK error warrants an exponential-backoff retry."""
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return True
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and (status == 429 or 500 <= status < 600):
        return True
    message = str(exc).lower()
    if "429" in message or "rate limit" in message or "quota" in message:
        return True
    if "timeout" in message or "timed out" in message:
        return True
    if "503" in message or "502" in message or "500" in message or "504" in message:
        return True
    return False


class GeminiVideoAnalyzer:
    """Asynchronous Gemini File API video analyzer.

    The underlying ``google-genai`` SDK is synchronous; we wrap each
    call with ``asyncio.to_thread`` so multiple jobs can be in flight
    concurrently without blocking the RabbitMQ consumer.
    """

    def __init__(
        self,
        api_key: str,
        model: str,
        fallback_model: str,
        timeout_s: int,
    ) -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is required")
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._fallback_model = fallback_model
        self._timeout_s = timeout_s
        logger.info(
            "gemini_analyzer_initialized",
            model=model,
            fallback_model=fallback_model,
            timeout_s=timeout_s,
        )

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def analyze(
        self,
        video_path: str,
        style: str,
        language: str,
        duration_ms: int | None,
    ) -> list[dict[str, Any]]:
        """Upload ``video_path`` to Gemini, generate a transcript, delete the file.

        Parameters
        ----------
        video_path:
            Absolute path to the video file on local disk.
        style:
            Narration style passed through to prompt construction.
        language:
            ISO 639-1 language code (e.g. ``"en"``).
        duration_ms:
            Probed duration in milliseconds, or ``None`` when unknown.

        Returns
        -------
        list[dict]
            Validated transcript segments (with synthesized words).

        Raises
        ------
        RuntimeError
            When upload, polling, or generation exhausts retries.
        TranscriptValidationError
            When Gemini's output fails validation twice.
        """
        if not os.path.isfile(video_path):
            raise FileNotFoundError(f"video file not found: {video_path}")

        async with _SEMAPHORE:
            uploaded_name: str | None = None
            try:
                uploaded = await self._upload_with_retry(video_path)
                uploaded_name = uploaded.name
                active = await self._wait_until_active(uploaded_name)

                system_prompt = build_system_prompt(style, language, duration_ms)
                user_prompt = build_user_prompt(style, language, duration_ms)

                segments = await self._generate_with_schema_retry(
                    file_ref=active,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    duration_ms=duration_ms,
                )
                return segments
            finally:
                if uploaded_name is not None:
                    await self._delete_quiet(uploaded_name)

    # ------------------------------------------------------------------ #
    # Upload + polling
    # ------------------------------------------------------------------ #

    async def _upload_with_retry(self, video_path: str) -> Any:
        mime_type = _mime_type_for(video_path)

        def _sync_upload() -> Any:
            return self._client.files.upload(
                file=video_path,
                config={"mime_type": mime_type},
            )

        for attempt, delay in enumerate(_BACKOFF_SCHEDULE + (0,), start=1):
            try:
                uploaded = await asyncio.wait_for(
                    asyncio.to_thread(_sync_upload),
                    timeout=self._timeout_s,
                )
                logger.info(
                    "gemini_file_uploaded",
                    name=uploaded.name,
                    state=getattr(uploaded.state, "name", str(uploaded.state)),
                    attempt=attempt,
                )
                return uploaded
            except Exception as exc:
                if attempt > len(_BACKOFF_SCHEDULE) or not _is_retryable(exc):
                    logger.error(
                        "gemini_upload_failed",
                        attempt=attempt,
                        error=str(exc),
                        exc_info=True,
                    )
                    raise RuntimeError(
                        f"Gemini file upload failed after {attempt} attempt(s): {exc}"
                    ) from exc
                logger.warning(
                    "gemini_upload_retry",
                    attempt=attempt,
                    delay_s=delay,
                    error=str(exc),
                )
                await asyncio.sleep(delay)
        raise RuntimeError("Gemini file upload exhausted retry budget")

    async def _wait_until_active(self, file_name: str) -> Any:
        def _sync_get() -> Any:
            return self._client.files.get(name=file_name)

        deadline = time.monotonic() + _POLL_TIMEOUT_S
        while True:
            try:
                current = await asyncio.to_thread(_sync_get)
            except Exception as exc:
                logger.error("gemini_file_poll_failed", error=str(exc), exc_info=True)
                raise RuntimeError(f"Gemini files.get failed: {exc}") from exc

            state_name = getattr(current.state, "name", str(current.state))
            if state_name == "ACTIVE":
                logger.info("gemini_file_active", name=file_name)
                return current
            if state_name == "FAILED":
                raise RuntimeError(
                    f"Gemini file processing failed for {file_name}"
                )
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"Gemini file {file_name} did not become ACTIVE within "
                    f"{int(_POLL_TIMEOUT_S)}s (last state: {state_name})"
                )
            logger.debug(
                "gemini_file_polling",
                name=file_name,
                state=state_name,
            )
            await asyncio.sleep(_POLL_INTERVAL_S)

    # ------------------------------------------------------------------ #
    # generate_content with schema retry
    # ------------------------------------------------------------------ #

    async def _generate_with_schema_retry(
        self,
        file_ref: Any,
        system_prompt: str,
        user_prompt: str,
        duration_ms: int | None,
    ) -> list[dict[str, Any]]:
        first_error: Exception | None = None
        try:
            raw = await self._generate_with_backoff(
                file_ref=file_ref,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=self._model,
            )
            return validate_transcript(raw, duration_ms)
        except TranscriptValidationError as exc:
            first_error = exc
            logger.warning(
                "gemini_transcript_invalid_first_attempt",
                error=str(exc),
            )

        stricter_user_prompt = (
            user_prompt
            + "\n\nREMINDER: The previous response failed validation with: "
            + str(first_error)
            + ". Return ONLY a JSON object matching the schema exactly. "
            + "Every segment must have segment_id, start_ms, end_ms, text, "
            + "confidence. start_ms < end_ms. Segments must be "
            + "chronologically ordered. No markdown, no commentary."
        )

        raw = await self._generate_with_backoff(
            file_ref=file_ref,
            system_prompt=system_prompt,
            user_prompt=stricter_user_prompt,
            model=self._model,
        )
        return validate_transcript(raw, duration_ms)

    async def _generate_with_backoff(
        self,
        file_ref: Any,
        system_prompt: str,
        user_prompt: str,
        model: str,
    ) -> Any:
        config = types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            response_schema=TRANSCRIPT_SCHEMA,
            temperature=0.2,
        )

        def _sync_generate() -> Any:
            return self._client.models.generate_content(
                model=model,
                contents=[file_ref, user_prompt],
                config=config,
            )

        for attempt, delay in enumerate(_BACKOFF_SCHEDULE + (0,), start=1):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(_sync_generate),
                    timeout=self._timeout_s,
                )
                parsed = self._extract_parsed(response)
                logger.info(
                    "gemini_generate_success",
                    model=model,
                    attempt=attempt,
                )
                return parsed
            except Exception as exc:
                if attempt > len(_BACKOFF_SCHEDULE) or not _is_retryable(exc):
                    logger.error(
                        "gemini_generate_failed",
                        attempt=attempt,
                        model=model,
                        error=str(exc),
                        exc_info=True,
                    )
                    raise RuntimeError(
                        f"Gemini generate_content failed after {attempt} attempt(s): {exc}"
                    ) from exc
                logger.warning(
                    "gemini_generate_retry",
                    attempt=attempt,
                    delay_s=delay,
                    error=str(exc),
                )
                await asyncio.sleep(delay)
        raise RuntimeError("Gemini generate_content exhausted retry budget")

    @staticmethod
    def _extract_parsed(response: Any) -> Any:
        """Extract the parsed JSON object from a GenerateContentResponse."""
        parsed = getattr(response, "parsed", None)
        if parsed is not None:
            return parsed
        text = getattr(response, "text", None) or ""
        if not text:
            raise RuntimeError("Gemini response had no parsed payload or text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Gemini response text was not valid JSON: {exc}"
            ) from exc

    # ------------------------------------------------------------------ #
    # Cleanup
    # ------------------------------------------------------------------ #

    async def _delete_quiet(self, file_name: str) -> None:
        def _sync_delete() -> None:
            self._client.files.delete(name=file_name)

        try:
            await asyncio.to_thread(_sync_delete)
            logger.info("gemini_file_deleted", name=file_name)
        except Exception as exc:
            logger.warning(
                "gemini_file_delete_failed",
                name=file_name,
                error=str(exc),
            )
