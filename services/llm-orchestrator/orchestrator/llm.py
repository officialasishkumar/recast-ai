"""LLM client wrapper for calling Claude with multimodal input.

Handles base64 image encoding, prompt assembly, response parsing,
schema validation with one retry, and concurrency limiting.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re

import anthropic
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


class LLMClient:
    """Wrapper around the Anthropic Python SDK for transcript generation."""

    def __init__(self, api_key: str, model: str) -> None:
        self._client = anthropic.Anthropic(api_key=api_key)
        self._model = model

    async def generate_transcript(
        self,
        frames: list[bytes],
        audio_text: str | None,
        style: str,
        language: str,
        duration_ms: int,
    ) -> list[dict]:
        """Generate a timestamped narration transcript.

        Sends the video frames as base64-encoded images alongside the
        extracted audio text (if any) to Claude, then validates the
        response.  On validation failure, retries once with a more
        explicit prompt.

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

        Raises
        ------
        ValueError
            If the LLM response fails validation even after retry.
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
        """Call the LLM and retry once on validation failure."""
        system_prompt = build_system_prompt(style, language, duration_ms)
        user_content = self._build_multimodal_content(frames, audio_text)

        # First attempt
        raw = await self._call_llm(system_prompt, user_content)
        segments = self._parse_response(raw)
        is_valid, cleaned, errors = validate_transcript(segments, duration_ms)

        if is_valid:
            logger.info(
                "transcript_validated",
                segment_count=len(cleaned),
                attempt=1,
            )
            return cleaned

        # Retry with a more explicit fallback prompt
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

        raw = await self._call_llm(fallback_system, user_content)
        segments = self._parse_response(raw)
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

    def _build_multimodal_content(
        self,
        frames: list[bytes],
        audio_text: str | None,
    ) -> list[dict]:
        """Build the multimodal content array for the Claude API.

        Each frame is sent as a base64-encoded image block.  The text
        prompt with frame descriptions and audio text follows.
        """
        content: list[dict] = []

        frame_descriptions: list[str] = []
        for i, frame_data in enumerate(frames):
            b64 = base64.standard_b64encode(frame_data).decode("ascii")
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64,
                },
            })
            frame_descriptions.append(f"Frame {i + 1} of {len(frames)}")

        text_prompt = build_user_prompt(frame_descriptions, audio_text)
        content.append({"type": "text", "text": text_prompt})

        return content

    async def _call_llm(
        self,
        system_prompt: str,
        user_content: list[dict],
    ) -> str:
        """Make a synchronous Anthropic API call in a thread executor.

        The Anthropic Python SDK is synchronous, so we run it in the
        default executor to avoid blocking the asyncio event loop.
        """
        loop = asyncio.get_running_loop()

        def _sync_call() -> str:
            response = self._client.messages.create(
                model=self._model,
                max_tokens=8192,
                system=system_prompt,
                messages=[{"role": "user", "content": user_content}],
            )
            # Extract text from the first text block
            for block in response.content:
                if block.type == "text":
                    return block.text
            return ""

        return await loop.run_in_executor(None, _sync_call)

    @staticmethod
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
