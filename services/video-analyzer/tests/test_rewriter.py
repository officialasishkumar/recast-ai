"""Unit tests for the text-only Gemini segment rewriter.

The Gemini SDK call is stubbed; only the prompt construction and the
response parser are exercised so these tests do not require an API key.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from analyzer import rewriter as rw


def test_build_prompt_includes_overflow_and_constraints() -> None:
    prompt = rw._build_rewrite_prompt(
        original_text="A very long narration that overflows.",
        scene_start_ms=0,
        scene_end_ms=4_000,
        diagnosis={
            "duration_overflow_ms": 1_500,
            "duration_underflow_ms": 0,
            "issues": ["too_long_for_scene"],
        },
        style="formal",
        language="en",
    )
    assert "Scene budget: 4000 ms" in prompt
    assert "1500 ms too long" in prompt
    assert "Style: formal." in prompt


def test_build_prompt_handles_underflow_and_silence() -> None:
    prompt = rw._build_rewrite_prompt(
        original_text="Short text.",
        scene_start_ms=1_000,
        scene_end_ms=5_000,
        diagnosis={
            "duration_overflow_ms": 0,
            "duration_underflow_ms": 800,
            "issues": ["too_short_for_scene", "excessive_silence"],
        },
        style="casual",
        language="en",
    )
    assert "800 ms too short" in prompt
    assert "long mid-segment pauses" in prompt


def test_parse_rewrite_extracts_text_field() -> None:
    response = MagicMock()
    response.text = '{"text": "new narration", "rationale": "trimmed"}'
    assert rw._parse_rewrite(response) == "new narration"


def test_parse_rewrite_returns_empty_on_missing_text() -> None:
    response = MagicMock()
    response.text = '{"rationale": "no text field"}'
    assert rw._parse_rewrite(response) == ""


def test_parse_rewrite_handles_non_json_text() -> None:
    response = MagicMock()
    response.text = "not json at all"
    assert rw._parse_rewrite(response) == ""


def test_parse_rewrite_recovers_from_extra_prose() -> None:
    response = MagicMock()
    response.text = 'Sure, here is the JSON: {"text": "fixed"} thanks!'
    assert rw._parse_rewrite(response) == "fixed"


@pytest.mark.asyncio
async def test_rewrite_falls_back_on_sdk_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """The rewriter never raises; on SDK failure it returns the original text."""

    inst = rw.GeminiSegmentRewriter.__new__(rw.GeminiSegmentRewriter)
    inst._client = MagicMock()
    inst._model = "gemini-2.5-flash"
    inst._timeout_s = 1

    def boom() -> Any:
        raise RuntimeError("API outage")

    inst._client.models.generate_content.side_effect = boom

    new_text = await inst.rewrite(
        original_text="kept on failure",
        scene_start_ms=0,
        scene_end_ms=2_000,
        diagnosis={"duration_overflow_ms": 500, "issues": ["too_long_for_scene"]},
        style="formal",
        language="en",
    )
    assert new_text == "kept on failure"
