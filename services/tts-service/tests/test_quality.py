"""Unit tests for the FFmpeg-based quality scorer.

Only the pure-Python scoring math is exercised here; the FFmpeg
subprocess paths are bypassed via monkeypatching so the tests run
without the binary being installed in CI.
"""

from __future__ import annotations

from typing import Any

import pytest

from tts import quality


@pytest.fixture(autouse=True)
def _stub_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the FFmpeg helpers deterministic without invoking the binary."""
    monkeypatch.setattr(quality, "_measure_silence_ratio", lambda *_a, **_k: 0.05)
    monkeypatch.setattr(quality, "_measure_lufs", lambda *_a, **_k: -16.0)


def test_score_segment_passes_when_audio_fits_scene_budget() -> None:
    score = quality.score_segment(
        audio_bytes=b"x",
        audio_duration_ms=4_200,
        target_duration_ms=4_200,
    )
    assert score.passes()
    assert score.duration_overflow_ms == 0
    assert score.duration_underflow_ms == 0


def test_score_segment_flags_overflow_beyond_max_atempo() -> None:
    # 4200 ms target * 1.5 max-atempo = 6300 ms ceiling.
    # 8000 ms synthesized leaves 1700 ms of overflow even at full speedup.
    score = quality.score_segment(
        audio_bytes=b"x",
        audio_duration_ms=8_000,
        target_duration_ms=4_200,
    )
    assert score.duration_overflow_ms == pytest.approx(1_700, abs=1)
    assert "too_long_for_scene" in score.issues
    assert score.duration_fit < 1.0


def test_score_segment_flags_underflow_below_min_atempo() -> None:
    # 4200 ms target * 0.75 = 3150 ms floor; 1000 ms is too terse.
    score = quality.score_segment(
        audio_bytes=b"x",
        audio_duration_ms=1_000,
        target_duration_ms=4_200,
    )
    assert score.duration_underflow_ms == pytest.approx(2_150, abs=1)
    assert "too_short_for_scene" in score.issues


def test_diagnosis_payload_is_jsonable() -> None:
    score = quality.score_segment(
        audio_bytes=b"x",
        audio_duration_ms=4_200,
        target_duration_ms=4_200,
    )
    diag: dict[str, Any] = score.to_diagnosis()
    # The rewriter contract requires these keys be present.
    for key in ("duration_overflow_ms", "duration_underflow_ms", "issues", "combined_score"):
        assert key in diag


def test_silence_score_falls_off_above_threshold() -> None:
    assert quality._silence_to_score(0.0) == 1.0
    assert quality._silence_to_score(0.1) == 1.0
    assert 0.0 < quality._silence_to_score(0.3) < 1.0
    assert quality._silence_to_score(0.6) == 0.0


def test_lufs_score_peaks_at_broadcast_target() -> None:
    assert quality._lufs_to_score(-16.0) == 1.0
    assert quality._lufs_to_score(-18.0) == 1.0
    # Outside the comfortable band the score degrades.
    assert quality._lufs_to_score(-32.0) < 1.0
    assert quality._lufs_to_score(-2.0) < 1.0
