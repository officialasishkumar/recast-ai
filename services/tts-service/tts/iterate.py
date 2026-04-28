"""Iterative synthesis loop: synthesize → score → rewrite → repeat.

The whole-video Gemini analysis runs once per job. Per-segment quality
problems (audio that overflows the scene budget, excessive silence,
loudness outside broadcast band) are fixed by a much cheaper text-only
loop here:

1. Synthesize the segment with the configured TTS provider.
2. Score the audio against the scene budget using FFmpeg.
3. If the score passes, return.
4. Otherwise, call the video-analyzer's /rewrite endpoint with the
   structured failure diagnosis to get a new segment text from Gemini.
5. Re-synthesize the new text. Re-score.
6. Stop when the score passes or after ``max_iterations`` attempts.
   The best-scoring attempt is always returned, even if no attempt
   crosses the threshold (the editor UI surfaces low scores so a human
   can intervene).

The loop is intentionally conservative about cost: rewrites only fire
when the synthesizer actually produced poor audio, and re-synthesis is
scoped to a single segment, not the whole transcript.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

from tts.quality import QualityScore, score_segment
from tts.synthesizer import SynthesisResult, TTSProvider

logger = structlog.get_logger(__name__)


@dataclass
class IterationResult:
    """Final state returned to the segment processor."""

    synthesis: SynthesisResult
    final_text: str
    score: QualityScore
    iterations: int
    rewrite_history: list[dict[str, Any]]


def synthesize_with_iteration(
    *,
    provider: TTSProvider,
    segment: dict[str, Any],
    voice_id: str,
    language: str,
    style: str,
    target_duration_ms: int,
    max_iterations: int,
    pass_threshold: float,
    rewriter_url: str,
    rewrite_timeout_s: int,
    enabled: bool,
) -> IterationResult:
    """Run the iterative synthesis loop for a single segment.

    When ``enabled`` is False or ``max_iterations <= 1`` the loop
    degenerates to a single synthesis with a score, which keeps the
    function safe to wire in unconditionally.
    """
    text: str = str(segment.get("text", "")).strip()
    scene_start_ms = int(segment.get("start_ms", 0))
    scene_end_ms = int(segment.get("end_ms", 0))

    history: list[dict[str, Any]] = []
    best: IterationResult | None = None
    attempts = max(1, max_iterations) if enabled else 1

    for attempt in range(1, attempts + 1):
        synth = provider.synthesize(text, voice_id, language)
        score = score_segment(
            audio_bytes=synth.audio_bytes,
            audio_duration_ms=synth.duration_ms,
            target_duration_ms=target_duration_ms or synth.duration_ms,
            mime_type=synth.mime_type,
        )

        record = {
            "attempt": attempt,
            "text": text,
            "synthesized_ms": synth.duration_ms,
            "score": round(score.combined, 3),
            "diagnosis": score.to_diagnosis(),
        }
        history.append(record)

        candidate = IterationResult(
            synthesis=synth,
            final_text=text,
            score=score,
            iterations=attempt,
            rewrite_history=[],  # filled in once the loop finishes
        )
        if best is None or candidate.score.combined > best.score.combined:
            best = candidate

        logger.info(
            "iteration_attempt",
            attempt=attempt,
            combined=round(score.combined, 3),
            duration_fit=round(score.duration_fit, 3),
            issues=score.issues,
        )

        if score.passes(pass_threshold):
            logger.info("iteration_passed", attempt=attempt, combined=round(score.combined, 3))
            best.rewrite_history = list(history)
            return best

        if attempt >= attempts:
            break

        rewritten = _request_rewrite(
            url=rewriter_url,
            timeout_s=rewrite_timeout_s,
            original_text=text,
            scene_start_ms=scene_start_ms,
            scene_end_ms=scene_end_ms,
            style=style,
            language=language,
            diagnosis=score.to_diagnosis(),
        )
        if rewritten is None or rewritten == text:
            logger.info("iteration_rewriter_unchanged", attempt=attempt)
            break
        text = rewritten

    assert best is not None  # invariant: at least one attempt always runs
    best.rewrite_history = list(history)
    logger.info(
        "iteration_finalized",
        iterations=best.iterations,
        attempts=len(history),
        final_score=round(best.score.combined, 3),
        passed=best.score.passes(pass_threshold),
    )
    return best


def _request_rewrite(
    *,
    url: str,
    timeout_s: int,
    original_text: str,
    scene_start_ms: int,
    scene_end_ms: int,
    style: str,
    language: str,
    diagnosis: dict[str, Any],
) -> str | None:
    """POST /rewrite to the video-analyzer; return the new text or None.

    A None return is treated by the caller as "no progress possible";
    the loop stops and the best previous attempt is kept. We never
    raise from this function: a flaky rewriter call is a quality
    miss, not a pipeline failure.
    """
    if not url:
        return None
    endpoint = url.rstrip("/") + "/rewrite"
    payload = {
        "original_text": original_text,
        "scene_start_ms": scene_start_ms,
        "scene_end_ms": scene_end_ms,
        "style": style,
        "language": language,
        "diagnosis": diagnosis,
    }
    started = time.monotonic()
    try:
        response = httpx.post(endpoint, json=payload, timeout=timeout_s)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning(
            "rewriter_http_failed",
            url=endpoint,
            error=str(exc),
            elapsed_s=round(time.monotonic() - started, 2),
        )
        return None

    try:
        body = response.json()
    except ValueError:
        logger.warning("rewriter_bad_json", url=endpoint)
        return None

    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    if not body.get("changed", False):
        return None
    return text.strip()
