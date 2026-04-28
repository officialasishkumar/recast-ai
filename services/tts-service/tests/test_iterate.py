"""Unit tests for the iterative synthesis loop.

The TTS provider, FFmpeg scorer, and the /rewrite HTTP call are all
stubbed so these tests exercise only the loop logic: stop on success,
stop on max iterations, prefer the best-scoring attempt when none pass.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from tts import iterate, quality
from tts.synthesizer import SynthesisResult


def _synth_result(duration_ms: int = 4200) -> SynthesisResult:
    return SynthesisResult(
        audio_bytes=b"audio",
        duration_ms=duration_ms,
        mime_type="audio/mpeg",
        word_alignments=None,
    )


def _passing_score() -> quality.QualityScore:
    return quality.QualityScore(
        combined=0.95,
        duration_fit=1.0,
        silence=0.95,
        loudness=0.9,
        duration_overflow_ms=0,
        duration_underflow_ms=0,
        silence_ratio=0.05,
        lufs=-16.0,
        issues=[],
    )


def _failing_score(combined: float = 0.4) -> quality.QualityScore:
    return quality.QualityScore(
        combined=combined,
        duration_fit=0.4,
        silence=0.9,
        loudness=0.9,
        duration_overflow_ms=2_000,
        duration_underflow_ms=0,
        silence_ratio=0.05,
        lufs=-16.0,
        issues=["too_long_for_scene"],
    )


@pytest.fixture
def stub_provider() -> MagicMock:
    p = MagicMock()
    p.synthesize.return_value = _synth_result()
    return p


def test_loop_returns_after_first_pass(
    monkeypatch: pytest.MonkeyPatch, stub_provider: MagicMock
) -> None:
    monkeypatch.setattr(iterate, "score_segment", lambda **_kw: _passing_score())
    rewrite_called = {"n": 0}
    monkeypatch.setattr(
        iterate,
        "_request_rewrite",
        lambda **_kw: rewrite_called.__setitem__("n", rewrite_called["n"] + 1) or "",
    )

    segment: dict[str, Any] = {"text": "hello", "start_ms": 0, "end_ms": 4_200}
    result = iterate.synthesize_with_iteration(
        provider=stub_provider,
        segment=segment,
        voice_id="v",
        language="en",
        style="formal",
        target_duration_ms=4_200,
        max_iterations=3,
        pass_threshold=0.7,
        rewriter_url="http://video-analyzer:8080",
        rewrite_timeout_s=5,
        enabled=True,
    )

    assert result.iterations == 1
    assert result.final_text == "hello"
    assert rewrite_called["n"] == 0  # never called when first attempt passes


def test_loop_stops_after_max_iterations_and_keeps_best(
    monkeypatch: pytest.MonkeyPatch, stub_provider: MagicMock
) -> None:
    scores = iter([_failing_score(0.4), _failing_score(0.55), _failing_score(0.5)])
    monkeypatch.setattr(iterate, "score_segment", lambda **_kw: next(scores))
    rewrites = iter(["rewrite v1", "rewrite v2"])
    monkeypatch.setattr(iterate, "_request_rewrite", lambda **_kw: next(rewrites))

    segment = {"text": "original", "start_ms": 0, "end_ms": 1_000}
    result = iterate.synthesize_with_iteration(
        provider=stub_provider,
        segment=segment,
        voice_id="v",
        language="en",
        style="formal",
        target_duration_ms=1_000,
        max_iterations=3,
        pass_threshold=0.7,
        rewriter_url="http://video-analyzer:8080",
        rewrite_timeout_s=5,
        enabled=True,
    )

    # Three synthesis attempts ran; the second had the best score so it wins.
    assert len(result.rewrite_history) == 3
    assert result.iterations == 2
    assert pytest.approx(result.score.combined, abs=1e-6) == 0.55


def test_loop_short_circuits_when_rewriter_returns_empty(
    monkeypatch: pytest.MonkeyPatch, stub_provider: MagicMock
) -> None:
    monkeypatch.setattr(iterate, "score_segment", lambda **_kw: _failing_score())
    monkeypatch.setattr(iterate, "_request_rewrite", lambda **_kw: None)

    segment = {"text": "x", "start_ms": 0, "end_ms": 1_000}
    result = iterate.synthesize_with_iteration(
        provider=stub_provider,
        segment=segment,
        voice_id="v",
        language="en",
        style="formal",
        target_duration_ms=1_000,
        max_iterations=3,
        pass_threshold=0.7,
        rewriter_url="http://video-analyzer:8080",
        rewrite_timeout_s=5,
        enabled=True,
    )

    # Only one attempt was made because the rewriter could not produce new text.
    assert result.iterations == 1
    assert stub_provider.synthesize.call_count == 1


def test_loop_disabled_runs_exactly_once(
    monkeypatch: pytest.MonkeyPatch, stub_provider: MagicMock
) -> None:
    monkeypatch.setattr(iterate, "score_segment", lambda **_kw: _failing_score())
    rewrite_called = {"n": 0}
    monkeypatch.setattr(
        iterate,
        "_request_rewrite",
        lambda **_kw: rewrite_called.__setitem__("n", rewrite_called["n"] + 1) or "x",
    )

    segment = {"text": "x", "start_ms": 0, "end_ms": 1_000}
    result = iterate.synthesize_with_iteration(
        provider=stub_provider,
        segment=segment,
        voice_id="v",
        language="en",
        style="formal",
        target_duration_ms=1_000,
        max_iterations=3,
        pass_threshold=0.7,
        rewriter_url="http://video-analyzer:8080",
        rewrite_timeout_s=5,
        enabled=False,
    )

    assert result.iterations == 1
    assert rewrite_called["n"] == 0
