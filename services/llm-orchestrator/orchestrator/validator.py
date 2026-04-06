"""Output validation and sanitization for LLM-generated transcripts.

Ensures that every transcript segment conforms to the expected schema,
timestamps are well-ordered, and no HTML/script injection is present in
the generated text.
"""

from __future__ import annotations

import re
from typing import Any

# Pre-compiled regex for stripping HTML/script tags from generated text.
_HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>", re.DOTALL)
_SCRIPT_BLOCK_RE = re.compile(
    r"<script[\s>].*?</script>",
    re.DOTALL | re.IGNORECASE,
)


def sanitize_text(text: str) -> str:
    """Strip any HTML / script tags from generated text.

    This is a defense-in-depth measure -- the LLM should never produce
    HTML, but if it does (or if injection succeeds), we remove it before
    the text reaches TTS or the user.
    """
    cleaned = _SCRIPT_BLOCK_RE.sub("", text)
    cleaned = _HTML_TAG_RE.sub("", cleaned)
    return cleaned.strip()


def _validate_word(word: dict[str, Any], seg_start: int, seg_end: int) -> list[str]:
    """Validate a single word entry and return a list of errors (empty if valid)."""
    errors: list[str] = []

    if not isinstance(word.get("word"), str) or not word["word"].strip():
        errors.append("word.word must be a non-empty string")

    w_start = word.get("start_ms")
    w_end = word.get("end_ms")

    if not isinstance(w_start, int) or w_start < 0:
        errors.append(f"word.start_ms must be a non-negative int, got {w_start!r}")
    if not isinstance(w_end, int) or w_end < 0:
        errors.append(f"word.end_ms must be a non-negative int, got {w_end!r}")

    if isinstance(w_start, int) and isinstance(w_end, int):
        if w_start > w_end:
            errors.append(f"word.start_ms ({w_start}) > word.end_ms ({w_end})")
        if w_start < seg_start:
            errors.append(
                f"word.start_ms ({w_start}) < segment start_ms ({seg_start})"
            )
        if w_end > seg_end:
            errors.append(
                f"word.end_ms ({w_end}) > segment end_ms ({seg_end})"
            )

    return errors


def validate_transcript(
    data: list[dict[str, Any]],
    duration_ms: int,
) -> tuple[bool, list[dict[str, Any]], list[str]]:
    """Validate an LLM-generated transcript against the expected schema.

    Parameters
    ----------
    data:
        The raw list of segment dicts parsed from the LLM response.
    duration_ms:
        Total video duration in milliseconds -- used to verify that all
        timestamps fall within bounds.

    Returns
    -------
    tuple of (is_valid, cleaned_segments, errors)
        *is_valid* is ``True`` when every segment passes validation.
        *cleaned_segments* contains sanitized copies of valid segments.
        *errors* lists human-readable descriptions of any problems found.
    """
    errors: list[str] = []
    cleaned: list[dict[str, Any]] = []

    if not isinstance(data, list):
        return False, [], ["transcript must be a JSON array"]

    if len(data) == 0:
        return False, [], ["transcript must contain at least one segment"]

    prev_end_ms: int = -1

    for idx, seg in enumerate(data):
        seg_errors: list[str] = []
        label = f"segment[{idx}]"

        # --- Required fields ---
        segment_id = seg.get("segment_id")
        if not isinstance(segment_id, int) or segment_id < 1:
            seg_errors.append(f"{label}.segment_id must be a positive int")

        start_ms = seg.get("start_ms")
        end_ms = seg.get("end_ms")

        if not isinstance(start_ms, int) or start_ms < 0:
            seg_errors.append(f"{label}.start_ms must be a non-negative int")

        if not isinstance(end_ms, int) or end_ms < 0:
            seg_errors.append(f"{label}.end_ms must be a non-negative int")

        text = seg.get("text")
        if not isinstance(text, str) or not text.strip():
            seg_errors.append(f"{label}.text must be a non-empty string")

        confidence = seg.get("confidence")
        if not isinstance(confidence, (int, float)):
            seg_errors.append(f"{label}.confidence must be a number")
        elif not (0 <= confidence <= 1):
            seg_errors.append(f"{label}.confidence must be between 0 and 1, got {confidence}")

        words = seg.get("words")
        if not isinstance(words, list):
            seg_errors.append(f"{label}.words must be an array")

        # --- Timestamp ordering ---
        if isinstance(start_ms, int) and isinstance(end_ms, int):
            if start_ms > end_ms:
                seg_errors.append(
                    f"{label}.start_ms ({start_ms}) > end_ms ({end_ms})"
                )
            if end_ms > duration_ms:
                seg_errors.append(
                    f"{label}.end_ms ({end_ms}) exceeds video duration ({duration_ms})"
                )
            if start_ms <= prev_end_ms:
                seg_errors.append(
                    f"{label}.start_ms ({start_ms}) overlaps with previous "
                    f"segment end ({prev_end_ms})"
                )

        # --- Word-level validation ---
        clean_words: list[dict[str, Any]] = []
        if isinstance(words, list) and isinstance(start_ms, int) and isinstance(end_ms, int):
            prev_word_end = start_ms - 1
            for wi, w in enumerate(words):
                if not isinstance(w, dict):
                    seg_errors.append(f"{label}.words[{wi}] must be an object")
                    continue
                w_errors = _validate_word(w, start_ms, end_ms)
                if w_errors:
                    for we in w_errors:
                        seg_errors.append(f"{label}.words[{wi}]: {we}")
                else:
                    if w["start_ms"] < prev_word_end:
                        seg_errors.append(
                            f"{label}.words[{wi}].start_ms ({w['start_ms']}) "
                            f"precedes previous word end ({prev_word_end})"
                        )
                    prev_word_end = w["end_ms"]
                    clean_words.append({
                        "word": sanitize_text(w["word"]),
                        "start_ms": w["start_ms"],
                        "end_ms": w["end_ms"],
                    })

        if seg_errors:
            errors.extend(seg_errors)
            continue

        # Build cleaned segment
        if isinstance(end_ms, int):
            prev_end_ms = end_ms

        cleaned.append({
            "segment_id": segment_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": sanitize_text(str(text)),
            "words": clean_words,
            "confidence": float(confidence) if isinstance(confidence, (int, float)) else 0.0,
        })

    is_valid = len(errors) == 0
    return is_valid, cleaned, errors
