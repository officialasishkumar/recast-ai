"""Tests for the word-to-segment alignment helpers."""

from __future__ import annotations

from tts.alignment import align_words_to_segment
from tts.types import WordAlignment


def test_proportional_alignment_distributes_duration() -> None:
    segment = {"segment_id": 1, "start_ms": 10_000, "end_ms": 13_000, "text": "hello world"}
    words = align_words_to_segment(segment, provider_alignment=None, final_duration_ms=3_000)
    assert len(words) == 2
    assert words[0]["word"] == "hello"
    assert words[1]["word"] == "world"
    assert words[0]["start_ms"] == 10_000
    assert words[-1]["end_ms"] == 13_000
    for w in words:
        assert w["end_ms"] >= w["start_ms"]


def test_proportional_alignment_weighted_by_length() -> None:
    segment = {"segment_id": 1, "start_ms": 0, "end_ms": 1_200, "text": "a longword"}
    words = align_words_to_segment(segment, provider_alignment=None, final_duration_ms=1_200)
    assert len(words) == 2
    short = int(words[0]["end_ms"]) - int(words[0]["start_ms"])
    long = int(words[1]["end_ms"]) - int(words[1]["start_ms"])
    assert long > short


def test_provider_alignment_rescales_and_offsets() -> None:
    provider_alignment: list[WordAlignment] = [
        WordAlignment(word="Hello", start_ms=0, end_ms=500),
        WordAlignment(word="world", start_ms=500, end_ms=1_000),
    ]
    segment = {"segment_id": 1, "start_ms": 5_000, "end_ms": 7_000, "text": "Hello world"}
    words = align_words_to_segment(
        segment, provider_alignment=provider_alignment, final_duration_ms=2_000
    )
    assert len(words) == 2
    assert words[0]["start_ms"] == 5_000
    assert words[-1]["end_ms"] == 7_000


def test_output_is_monotonic_even_with_overlapping_input() -> None:
    provider_alignment: list[WordAlignment] = [
        WordAlignment(word="one", start_ms=0, end_ms=200),
        WordAlignment(word="two", start_ms=150, end_ms=400),
        WordAlignment(word="three", start_ms=350, end_ms=600),
    ]
    segment = {"segment_id": 1, "start_ms": 1_000, "end_ms": 1_600, "text": "one two three"}
    words = align_words_to_segment(
        segment, provider_alignment=provider_alignment, final_duration_ms=600
    )
    assert [w["word"] for w in words] == ["one", "two", "three"]
    prev_end = 0
    for w in words:
        assert int(w["start_ms"]) >= prev_end
        assert int(w["end_ms"]) >= int(w["start_ms"])
        prev_end = int(w["end_ms"])


def test_empty_text_returns_empty_list() -> None:
    segment = {"segment_id": 1, "start_ms": 0, "end_ms": 1_000, "text": ""}
    assert align_words_to_segment(segment, provider_alignment=None, final_duration_ms=1_000) == []


def test_rescale_to_shorter_final_duration() -> None:
    provider_alignment: list[WordAlignment] = [
        WordAlignment(word="hi", start_ms=0, end_ms=1_000),
    ]
    segment = {"segment_id": 1, "start_ms": 0, "end_ms": 500, "text": "hi"}
    words = align_words_to_segment(
        segment, provider_alignment=provider_alignment, final_duration_ms=500
    )
    assert len(words) == 1
    assert int(words[0]["end_ms"]) <= 500
