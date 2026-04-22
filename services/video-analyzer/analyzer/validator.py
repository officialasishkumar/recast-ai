"""Validator and JSON schema for Gemini transcript output.

The same ``TRANSCRIPT_SCHEMA`` is passed to Gemini as ``response_schema``
(so the model-side constrained decoding enforces shape) and used here
for belt-and-braces validation of the returned JSON.

Word-level timings are synthesized locally as a proportional fallback:
Gemini is not asked to produce word timings from visual-only video
analysis, since those timings are unreliable. The TTS layer refines
them with real synthesis-derived alignments.
"""

from __future__ import annotations

import re
from typing import Any

import jsonschema
import structlog

logger = structlog.get_logger(__name__)

# Overrun tolerance on the video's probed duration, in milliseconds.
# Gemini sometimes rounds past the last frame; we forgive up to 250 ms.
_DURATION_TOLERANCE_MS = 250

# Max length of any single segment's text, in characters.
_MAX_TEXT_LEN = 2000

# Defense-in-depth sanitizers: strip HTML / script tags from model text.
_HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>", re.DOTALL)
_SCRIPT_BLOCK_RE = re.compile(
    r"<script[\s>].*?</script>",
    re.DOTALL | re.IGNORECASE,
)


# --------------------------------------------------------------------------- #
# JSON Schema
# --------------------------------------------------------------------------- #

TRANSCRIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["segments"],
    "properties": {
        "segments": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": [
                    "segment_id",
                    "start_ms",
                    "end_ms",
                    "text",
                    "confidence",
                ],
                "properties": {
                    "segment_id": {"type": "integer", "minimum": 1},
                    "start_ms": {"type": "integer", "minimum": 0},
                    "end_ms": {"type": "integer", "minimum": 0},
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": _MAX_TEXT_LEN,
                    },
                    "confidence": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                },
            },
        },
    },
}


class TranscriptValidationError(ValueError):
    """Raised when transcript JSON fails validation."""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _sanitize_text(text: str) -> str:
    """Strip any HTML / script tags from generated narration text."""
    cleaned = _SCRIPT_BLOCK_RE.sub("", text)
    cleaned = _HTML_TAG_RE.sub("", cleaned)
    return cleaned.strip()


def _synthesize_words(
    text: str,
    start_ms: int,
    end_ms: int,
) -> list[dict[str, Any]]:
    """Build proportional word timings weighted by character length.

    This is a deliberate fallback so downstream TTS has something to
    align with. Real per-word timings come from the TTS provider's
    alignment metadata (ElevenLabs character alignment, etc.).
    """
    words = [w for w in text.split() if w]
    if not words:
        return []

    span = max(1, end_ms - start_ms)
    weights = [max(1, len(w)) for w in words]
    total_weight = sum(weights)

    cursor = start_ms
    result: list[dict[str, Any]] = []
    for idx, (word, weight) in enumerate(zip(words, weights)):
        if idx == len(words) - 1:
            w_end = end_ms
        else:
            w_end = cursor + int(span * weight / total_weight)
            if w_end <= cursor:
                w_end = cursor + 1
            if w_end > end_ms:
                w_end = end_ms
        result.append({
            "word": word,
            "start_ms": cursor,
            "end_ms": w_end,
        })
        cursor = w_end
    return result


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def validate_transcript(
    data: Any,
    duration_ms: int | None = None,
) -> list[dict[str, Any]]:
    """Validate and normalize a transcript response.

    Parameters
    ----------
    data:
        Parsed JSON returned by Gemini. Expected shape::

            {"segments": [{"segment_id": 1, "start_ms": 0, ...}, ...]}

    duration_ms:
        Probed video duration in milliseconds, or ``None`` when unknown.
        Used to verify that segment end times do not exceed the video
        length (with ``_DURATION_TOLERANCE_MS`` slack). When ``None``,
        the end-time check is skipped.

    Returns
    -------
    list[dict]
        Validated, sanitized, chronologically ordered segments, each
        carrying a synthesized ``words`` list.

    Raises
    ------
    TranscriptValidationError
        When the payload fails schema or semantic validation.
    """
    # --- Shape ---
    if not isinstance(data, dict):
        raise TranscriptValidationError(
            f"transcript payload must be an object, got {type(data).__name__}"
        )

    try:
        jsonschema.validate(instance=data, schema=TRANSCRIPT_SCHEMA)
    except jsonschema.ValidationError as exc:
        raise TranscriptValidationError(
            f"transcript failed schema validation: {exc.message}"
        ) from exc

    raw_segments: list[dict[str, Any]] = list(data["segments"])
    if not raw_segments:
        raise TranscriptValidationError("transcript must contain at least one segment")

    # --- Semantic checks ---
    cleaned: list[dict[str, Any]] = []
    prev_end_ms: int = -1
    upper_bound: int | None = (
        duration_ms + _DURATION_TOLERANCE_MS
        if duration_ms is not None and duration_ms > 0
        else None
    )

    for idx, seg in enumerate(raw_segments):
        label = f"segment[{idx}]"

        segment_id = seg["segment_id"]
        start_ms = seg["start_ms"]
        end_ms = seg["end_ms"]
        text = seg["text"]
        confidence = float(seg["confidence"])

        if not isinstance(segment_id, int) or segment_id < 1:
            raise TranscriptValidationError(
                f"{label}.segment_id must be a positive integer"
            )

        if not isinstance(start_ms, int) or start_ms < 0:
            raise TranscriptValidationError(
                f"{label}.start_ms must be a non-negative integer"
            )
        if not isinstance(end_ms, int) or end_ms < 0:
            raise TranscriptValidationError(
                f"{label}.end_ms must be a non-negative integer"
            )
        if start_ms >= end_ms:
            raise TranscriptValidationError(
                f"{label}.start_ms ({start_ms}) must be strictly less than end_ms ({end_ms})"
            )
        if upper_bound is not None and end_ms > upper_bound:
            raise TranscriptValidationError(
                f"{label}.end_ms ({end_ms}) exceeds video duration "
                f"({duration_ms} ms + {_DURATION_TOLERANCE_MS} ms tolerance)"
            )

        if start_ms < prev_end_ms:
            raise TranscriptValidationError(
                f"{label}.start_ms ({start_ms}) precedes previous segment end "
                f"({prev_end_ms}); segments must be chronologically ordered"
            )

        sanitized = _sanitize_text(text)
        if not sanitized:
            raise TranscriptValidationError(
                f"{label}.text is empty after sanitization"
            )
        if len(sanitized) > _MAX_TEXT_LEN:
            raise TranscriptValidationError(
                f"{label}.text exceeds {_MAX_TEXT_LEN} characters"
            )

        cleaned.append({
            "segment_id": segment_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": sanitized,
            "confidence": confidence,
            "words": _synthesize_words(sanitized, start_ms, end_ms),
        })
        prev_end_ms = end_ms

    logger.info("transcript_validated", segment_count=len(cleaned))
    return cleaned
