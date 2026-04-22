"""Word-to-segment alignment helpers.

:func:`align_words_to_segment` produces a list of word records with
absolute video timestamps. When the TTS provider returned per-word
timings we rescale them against the final synthesized duration and shift
by ``segment.start_ms``. Otherwise we compute a deterministic proportional
alignment weighted by ``len(word) + 1`` so that spaces account for
whitespace delay between tokens.
"""

from __future__ import annotations

from typing import Any

from tts.types import WordAlignment


def align_words_to_segment(
    segment: dict[str, Any],
    provider_alignment: list[WordAlignment] | None,
    final_duration_ms: int,
) -> list[dict[str, int | str]]:
    """Return absolute-time word alignments for ``segment``."""
    if final_duration_ms < 0:
        raise ValueError(f"final_duration_ms must be >= 0, got {final_duration_ms}")

    start_ms = int(segment.get("start_ms", 0))
    text = str(segment.get("text", "")).strip()

    if provider_alignment:
        return _rescale_provider_alignment(
            provider_alignment,
            final_duration_ms=final_duration_ms,
            offset_ms=start_ms,
        )

    if not text:
        return []

    return _proportional_alignment(
        text=text,
        duration_ms=final_duration_ms,
        offset_ms=start_ms,
    )


def _rescale_provider_alignment(
    alignments: list[WordAlignment],
    *,
    final_duration_ms: int,
    offset_ms: int,
) -> list[dict[str, int | str]]:
    if not alignments:
        return []
    synthesized_span = max(int(alignments[-1]["end_ms"]), 1)
    multiplier = final_duration_ms / synthesized_span if final_duration_ms > 0 else 1.0

    out: list[dict[str, int | str]] = []
    prev_end_local = 0
    for word in alignments:
        start_local = int(round(max(int(word["start_ms"]), prev_end_local) * multiplier))
        end_local = int(round(max(int(word["end_ms"]), prev_end_local) * multiplier))
        if end_local < start_local:
            end_local = start_local
        if final_duration_ms > 0:
            start_local = min(start_local, final_duration_ms)
            end_local = min(end_local, final_duration_ms)
        out.append(
            {
                "word": str(word["word"]),
                "start_ms": start_local + offset_ms,
                "end_ms": end_local + offset_ms,
            }
        )
        prev_end_local = max(int(word["end_ms"]), prev_end_local)
    return _enforce_monotonic_dicts(out)


def _proportional_alignment(
    *,
    text: str,
    duration_ms: int,
    offset_ms: int,
) -> list[dict[str, int | str]]:
    tokens = [t for t in text.split() if t]
    if not tokens or duration_ms <= 0:
        return [
            {"word": tok, "start_ms": offset_ms, "end_ms": offset_ms}
            for tok in tokens
        ]

    weights = [len(tok) + 1 for tok in tokens]
    total_weight = sum(weights)

    out: list[dict[str, int | str]] = []
    cursor_ms = 0.0
    for tok, weight in zip(tokens, weights):
        share_ms = duration_ms * (weight / total_weight)
        start_local = int(round(cursor_ms))
        cursor_ms += share_ms
        end_local = int(round(cursor_ms))
        if end_local <= start_local:
            end_local = start_local + 1
        if end_local > duration_ms:
            end_local = duration_ms
        if start_local > duration_ms:
            start_local = duration_ms
        out.append(
            {
                "word": tok,
                "start_ms": offset_ms + start_local,
                "end_ms": offset_ms + end_local,
            }
        )
    return _enforce_monotonic_dicts(out)


def _enforce_monotonic_dicts(
    words: list[dict[str, int | str]],
) -> list[dict[str, int | str]]:
    prev_end = 0
    out: list[dict[str, int | str]] = []
    for w in words:
        start = max(int(w["start_ms"]), prev_end)
        end = max(int(w["end_ms"]), start)
        out.append({"word": str(w["word"]), "start_ms": start, "end_ms": end})
        prev_end = end
    return out
