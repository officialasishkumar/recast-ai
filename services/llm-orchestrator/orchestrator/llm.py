"""LLM client wrapper for calling Claude or Gemini with multimodal input.

Handles base64 image encoding, prompt assembly, response parsing,
schema validation with one retry, and concurrency limiting.

Supports two providers:
- ``anthropic`` (default): Uses the Anthropic Python SDK (Claude).
- ``gemini``: Uses the Google GenAI SDK (Gemini).
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from typing import Protocol

import structlog

from orchestrator.prompt import build_system_prompt, build_user_prompt
from orchestrator.validator import validate_transcript

logger = structlog.get_logger(__name__)

# Maximum concurrent LLM calls across the process.
_SEMAPHORE = asyncio.Semaphore(5)

# Regex to strip markdown fencing that models sometimes emit despite
# being told not to.
_JSON_FENCE_RE = re.compile(
    r"```(?:json)?\s*\n?(.*?)\n?\s*```",
    re.DOTALL,
)


def _extract_json(text: str) -> str:
    """Extract JSON from a response that may contain markdown fences."""
    m = _JSON_FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    # Try to find the outermost JSON array directly
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text.strip()


def _parse_response(raw: str) -> list[dict]:
    """Parse the raw LLM text response into a list of dicts."""
    cleaned = _extract_json(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.error("json_parse_failed", raw_length=len(raw), error=str(exc))
        return []

    if not isinstance(data, list):
        logger.error("unexpected_json_type", got=type(data).__name__)
        return []

    return data


# --------------------------------------------------------------------------- #
# Provider protocol
# --------------------------------------------------------------------------- #


class LLMProvider(Protocol):
    """Interface that both Anthropic and Gemini clients implement."""

    async def call(
        self,
        system_prompt: str,
        frames: list[bytes],
        user_text: str,
    ) -> str: ...


# --------------------------------------------------------------------------- #
# Anthropic (Claude) provider
# --------------------------------------------------------------------------- #


class _AnthropicProvider:
    def __init__(self, api_key: str, model: str) -> None:
        import anthropic

        self._client = anthropic.Anthropic(api_key=api_key)
        self._model = model or "claude-sonnet-4-20250514"

    async def call(
        self,
        system_prompt: str,
        frames: list[bytes],
        user_text: str,
    ) -> str:
        content: list[dict] = []
        for frame_data in frames:
            b64 = base64.standard_b64encode(frame_data).decode("ascii")
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64,
                },
            })
        content.append({"type": "text", "text": user_text})

        loop = asyncio.get_running_loop()

        def _sync_call() -> str:
            response = self._client.messages.create(
                model=self._model,
                max_tokens=8192,
                system=system_prompt,
                messages=[{"role": "user", "content": content}],
            )
            for block in response.content:
                if block.type == "text":
                    return block.text
            return ""

        return await loop.run_in_executor(None, _sync_call)


# --------------------------------------------------------------------------- #
# Gemini provider
# --------------------------------------------------------------------------- #


class _GeminiProvider:
    def __init__(self, api_key: str, model: str) -> None:
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model = model or "gemini-2.0-flash"

    async def call(
        self,
        system_prompt: str,
        frames: list[bytes],
        user_text: str,
    ) -> str:
        from google.genai import types

        parts: list[types.Part] = []
        for frame_data in frames:
            b64 = base64.standard_b64encode(frame_data).decode("ascii")
            parts.append(types.Part.from_bytes(
                data=base64.standard_b64decode(b64),
                mime_type="image/jpeg",
            ))
        parts.append(types.Part.from_text(text=user_text))

        loop = asyncio.get_running_loop()

        def _sync_call() -> str:
            response = self._client.models.generate_content(
                model=self._model,
                contents=parts,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=8192,
                ),
            )
            return response.text or ""

        return await loop.run_in_executor(None, _sync_call)


# --------------------------------------------------------------------------- #
# OpenAI (GPT) provider
# --------------------------------------------------------------------------- #


class _OpenAIProvider:
    def __init__(self, api_key: str, model: str) -> None:
        import openai

        self._client = openai.OpenAI(api_key=api_key)
        self._model = model or "gpt-4o"

    async def call(
        self,
        system_prompt: str,
        frames: list[bytes],
        user_text: str,
    ) -> str:
        content: list[dict] = []
        for frame_data in frames:
            b64 = base64.standard_b64encode(frame_data).decode("ascii")
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{b64}",
                },
            })
        content.append({"type": "text", "text": user_text})

        loop = asyncio.get_running_loop()

        def _sync_call() -> str:
            response = self._client.chat.completions.create(
                model=self._model,
                max_tokens=8192,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": content},
                ],
            )
            return response.choices[0].message.content or ""

        return await loop.run_in_executor(None, _sync_call)


# --------------------------------------------------------------------------- #
# Unified LLMClient
# --------------------------------------------------------------------------- #


class LLMClient:
    """Unified LLM client that delegates to Anthropic or Gemini."""

    def __init__(self, provider: str, api_key: str, model: str) -> None:
        if provider == "gemini":
            self._provider: LLMProvider = _GeminiProvider(api_key, model)
        elif provider == "openai":
            self._provider = _OpenAIProvider(api_key, model)
        else:
            self._provider = _AnthropicProvider(api_key, model)
        logger.info("llm_provider_initialized", provider=provider, model=model)

    async def generate_transcript(
        self,
        frames: list[bytes],
        audio_text: str | None,
        style: str,
        language: str,
        duration_ms: int,
    ) -> list[dict]:
        """Generate a timestamped narration transcript.

        Parameters
        ----------
        frames:
            JPEG image bytes for each sampled video frame.
        audio_text:
            Raw ASR text extracted from the video, or ``None``.
        style:
            ``"formal"`` or ``"casual"``.
        language:
            ISO 639-1 language code.
        duration_ms:
            Total video duration in milliseconds.

        Returns
        -------
        list[dict]
            Validated list of transcript segment dicts.
        """
        async with _SEMAPHORE:
            return await self._generate_with_retry(
                frames, audio_text, style, language, duration_ms
            )

    async def _generate_with_retry(
        self,
        frames: list[bytes],
        audio_text: str | None,
        style: str,
        language: str,
        duration_ms: int,
    ) -> list[dict]:
        system_prompt = build_system_prompt(style, language, duration_ms)

        frame_descriptions = [
            f"Frame {i + 1} of {len(frames)}" for i in range(len(frames))
        ]
        user_text = build_user_prompt(frame_descriptions, audio_text)

        # First attempt
        raw = await self._provider.call(system_prompt, frames, user_text)
        segments = _parse_response(raw)
        is_valid, cleaned, errors = validate_transcript(segments, duration_ms)

        if is_valid:
            logger.info(
                "transcript_validated",
                segment_count=len(cleaned),
                attempt=1,
            )
            return cleaned

        # Retry with feedback
        logger.warning(
            "transcript_validation_failed",
            errors=errors[:10],
            attempt=1,
        )

        fallback_system = (
            system_prompt
            + "\n\n=== IMPORTANT: RETRY ===\n"
            "Your previous response had validation errors:\n"
            + "\n".join(f"- {e}" for e in errors[:10])
            + "\n\nPlease fix these issues and respond with ONLY valid JSON."
        )

        raw = await self._provider.call(fallback_system, frames, user_text)
        segments = _parse_response(raw)
        is_valid, cleaned, errors = validate_transcript(segments, duration_ms)

        if is_valid:
            logger.info(
                "transcript_validated",
                segment_count=len(cleaned),
                attempt=2,
            )
            return cleaned

        logger.error("transcript_validation_failed_final", errors=errors[:20])
        raise ValueError(
            f"LLM response failed validation after retry: {'; '.join(errors[:5])}"
        )
