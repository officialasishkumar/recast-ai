"""Regression against a committed golden transcript.

This test compares the pipeline's output against a golden reference using
fuzzy text similarity and timing proximity. The thresholds are deliberately
generous because Gemini paraphrases and TTS timing drifts; the goal is to
catch significant regressions (e.g. empty transcripts, totally wrong
timings, segments out of order) rather than enforce byte-exact output.

Run in ``FAKE_GEMINI=1`` mode for deterministic comparisons.
"""

from __future__ import annotations

import difflib
import logging
from typing import Any

import httpx
import pytest

logger = logging.getLogger(__name__)

pytestmark = pytest.mark.slow

# Thresholds — tuned to survive TTS paraphrase and model drift while still
# catching real regressions. Documented here so a future tweak has to touch
# the tunable knob in one place.
MIN_TEXT_SIMILARITY = 0.55
MAX_TIMING_DRIFT_MS = 500


def _text_similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.strip().lower(), b.strip().lower()).ratio()


def _closest_segment(
    target_start_ms: int,
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], int]:
    """Return the candidate whose start_ms is closest to the target, and the
    absolute delta in milliseconds. ``candidates`` must be non-empty.
    """

    best = min(candidates, key=lambda s: abs(int(s.get("start_ms", 0)) - target_start_ms))
    delta = abs(int(best.get("start_ms", 0)) - target_start_ms)
    return best, delta


def _format_diff_table(rows: list[str]) -> str:
    return "\n".join(["", *rows, ""])


def test_transcript_matches_golden(
    client: httpx.Client,
    upload_job,
    wait_for_job,
    golden_transcript: dict[str, Any],
) -> None:
    job_id = upload_job()
    job = wait_for_job(job_id)

    assert job["stage"] == "completed", (
        f"pipeline did not finish successfully. job={job!r}"
    )

    resp = client.get(f"/v1/jobs/{job_id}/transcript", timeout=30.0)
    assert resp.status_code == 200, f"transcript fetch failed: {resp.status_code} {resp.text}"
    actual_segments = resp.json().get("segments") or []
    golden_segments = golden_transcript.get("segments") or []

    assert len(actual_segments) >= 1, "actual transcript is empty"
    assert len(golden_segments) >= 1, "golden fixture is empty; check test/fixtures/golden_transcript.json"

    diffs: list[str] = []
    failures: list[str] = []

    for golden in golden_segments:
        g_start = int(golden["start_ms"])
        g_text = str(golden["text"])
        actual, delta_ms = _closest_segment(g_start, actual_segments)
        a_start = int(actual.get("start_ms", 0))
        a_text = str(actual.get("text", ""))

        ratio = _text_similarity(g_text, a_text)
        row = (
            f"  segment {golden.get('segment_id')}: "
            f"golden=({g_start}ms, {g_text!r}) "
            f"actual=({a_start}ms, {a_text!r}) "
            f"drift={delta_ms}ms similarity={ratio:.2f}"
        )
        diffs.append(row)

        if delta_ms > MAX_TIMING_DRIFT_MS:
            failures.append(
                f"segment {golden.get('segment_id')} timing drift {delta_ms}ms exceeds "
                f"{MAX_TIMING_DRIFT_MS}ms"
            )
        if ratio < MIN_TEXT_SIMILARITY:
            failures.append(
                f"segment {golden.get('segment_id')} text similarity {ratio:.2f} below "
                f"{MIN_TEXT_SIMILARITY:.2f} (golden={g_text!r} actual={a_text!r})"
            )

    logger.info("transcript comparison%s", _format_diff_table(diffs))

    if failures:
        pytest.fail(
            "transcript regressed against golden:\n"
            + "\n".join(f"  - {f}" for f in failures)
            + _format_diff_table(diffs)
        )
