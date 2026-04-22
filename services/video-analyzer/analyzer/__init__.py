"""Video analyzer package.

Gemini File API based video-to-transcript pipeline. Exposes
``GeminiVideoAnalyzer`` and the transcript schema / validator used
both for Gemini's ``response_schema`` and local validation.
"""

from __future__ import annotations

from analyzer.gemini import GeminiVideoAnalyzer
from analyzer.prompt import build_system_prompt, build_user_prompt
from analyzer.validator import (
    TRANSCRIPT_SCHEMA,
    TranscriptValidationError,
    validate_transcript,
)

__all__ = [
    "GeminiVideoAnalyzer",
    "TRANSCRIPT_SCHEMA",
    "TranscriptValidationError",
    "build_system_prompt",
    "build_user_prompt",
    "validate_transcript",
]
