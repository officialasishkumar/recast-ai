"""Tests for ``analyzer.validator``.

Run with::

    pytest services/video-analyzer/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make ``analyzer`` importable when pytest is invoked from the repo root.
_SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

from analyzer.validator import (  # noqa: E402
    TRANSCRIPT_SCHEMA,
    TranscriptValidationError,
    validate_transcript,
)


def _good_payload() -> dict:
    return {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 2000,
                "text": "Hello world.",
                "confidence": 0.92,
            },
            {
                "segment_id": 2,
                "start_ms": 2000,
                "end_ms": 5000,
                "text": "This is a second segment with multiple words.",
                "confidence": 0.87,
            },
        ]
    }


def test_schema_has_segments_key() -> None:
    assert TRANSCRIPT_SCHEMA["required"] == ["segments"]
    assert "segments" in TRANSCRIPT_SCHEMA["properties"]


def test_happy_path_returns_validated_segments() -> None:
    result = validate_transcript(_good_payload(), duration_ms=5000)
    assert len(result) == 2
    first, second = result
    assert first["segment_id"] == 1
    assert first["start_ms"] == 0
    assert first["end_ms"] == 2000
    assert first["text"] == "Hello world."
    assert 0 <= first["confidence"] <= 1
    assert second["start_ms"] == 2000


def test_words_are_synthesized_and_cover_segment_span() -> None:
    result = validate_transcript(_good_payload(), duration_ms=5000)
    words = result[0]["words"]
    assert len(words) == 2
    assert words[0]["start_ms"] == 0
    assert words[-1]["end_ms"] == 2000
    for idx in range(len(words) - 1):
        assert words[idx]["end_ms"] <= words[idx + 1]["start_ms"]


def test_non_dict_payload_is_rejected() -> None:
    with pytest.raises(TranscriptValidationError):
        validate_transcript([{"segment_id": 1}], duration_ms=1000)


def test_missing_required_field_fails_schema() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 1000,
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_empty_segments_list_is_rejected() -> None:
    with pytest.raises(TranscriptValidationError):
        validate_transcript({"segments": []}, duration_ms=1000)


def test_negative_start_ms_is_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": -10,
                "end_ms": 1000,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_start_ms_greater_than_end_ms_is_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 2000,
                "end_ms": 1000,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=5000)


def test_equal_start_and_end_ms_is_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 1000,
                "end_ms": 1000,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=5000)


def test_end_ms_exceeding_duration_plus_tolerance_is_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 6000,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=5000)


def test_end_ms_within_tolerance_is_accepted() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 5100,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    result = validate_transcript(payload, duration_ms=5000)
    assert result[0]["end_ms"] == 5100


def test_overlapping_segments_are_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 3000,
                "text": "first",
                "confidence": 0.9,
            },
            {
                "segment_id": 2,
                "start_ms": 2500,
                "end_ms": 4000,
                "text": "overlap",
                "confidence": 0.9,
            },
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=5000)


def test_out_of_order_segments_are_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 2,
                "start_ms": 3000,
                "end_ms": 4000,
                "text": "second",
                "confidence": 0.9,
            },
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 2000,
                "text": "first",
                "confidence": 0.9,
            },
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=5000)


def test_empty_text_after_sanitization_is_rejected() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 1000,
                "text": "<script>alert(1)</script>",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_html_tags_are_stripped_from_text() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 1000,
                "text": "Hello <b>world</b>.",
                "confidence": 0.5,
            }
        ]
    }
    result = validate_transcript(payload, duration_ms=1000)
    assert result[0]["text"] == "Hello world."


def test_confidence_out_of_range_fails_schema() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 1000,
                "text": "hi",
                "confidence": 1.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_unknown_duration_skips_upper_bound_check() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 999_999,
                "text": "long",
                "confidence": 0.5,
            }
        ]
    }
    result = validate_transcript(payload, duration_ms=None)
    assert result[0]["end_ms"] == 999_999


def test_zero_duration_is_treated_as_unknown() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 10_000,
                "text": "content",
                "confidence": 0.5,
            }
        ]
    }
    result = validate_transcript(payload, duration_ms=0)
    assert result[0]["end_ms"] == 10_000


def test_text_too_long_fails_schema() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 0,
                "end_ms": 1000,
                "text": "x" * 2001,
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_segment_id_must_be_positive() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 0,
                "start_ms": 0,
                "end_ms": 1000,
                "text": "hi",
                "confidence": 0.5,
            }
        ]
    }
    with pytest.raises(TranscriptValidationError):
        validate_transcript(payload, duration_ms=1000)


def test_single_word_synthesis_keeps_boundaries() -> None:
    payload = {
        "segments": [
            {
                "segment_id": 1,
                "start_ms": 100,
                "end_ms": 900,
                "text": "solo",
                "confidence": 0.5,
            }
        ]
    }
    result = validate_transcript(payload, duration_ms=5000)
    words = result[0]["words"]
    assert len(words) == 1
    assert words[0]["start_ms"] == 100
    assert words[0]["end_ms"] == 900
