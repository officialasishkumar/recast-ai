"""Shared type definitions for the TTS service.

Kept dependency-free so :mod:`tts.alignment` and test utilities can import
word-alignment types without pulling in HTTP/audio libraries.
"""

from __future__ import annotations

from typing import TypedDict


class WordAlignment(TypedDict):
    """Per-word alignment relative to the synthesized audio (local ms)."""

    word: str
    start_ms: int
    end_ms: int
