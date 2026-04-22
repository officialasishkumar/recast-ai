"""TTS synthesis module using a provider-strategy pattern.

Every provider implements :class:`TTSProvider` and returns a
:class:`SynthesisResult` containing the raw audio bytes, the decoded
duration, an optional list of word-level alignments, and the MIME type of
the audio payload.

Supported providers:

* ``elevenlabs`` -- calls the ``/with-timestamps`` endpoint to obtain
  character-level alignments, then aggregates them into word alignments.
* ``polly`` -- calls AWS Polly twice (audio + ``SpeechMarkTypes=['word']``)
  and merges the two outputs.
* ``gtts`` -- no native word timings; the caller falls back to the
  proportional alignment algorithm.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from typing import Any, Protocol, cast

import httpx
import structlog

from tts.types import WordAlignment

logger = structlog.get_logger(__name__)


_ELEVENLABS_BASE = "https://api.elevenlabs.io"
_DEFAULT_LANGUAGE = "en"

__all__ = [
    "ElevenLabsProvider",
    "GttsProvider",
    "PollyProvider",
    "SynthesisResult",
    "TTSProvider",
    "WordAlignment",
    "build_provider",
]


@dataclass
class SynthesisResult:
    """Result of a single TTS synthesis call."""

    audio_bytes: bytes
    duration_ms: int
    word_alignments: list[WordAlignment] | None
    mime_type: str


class TTSProvider(Protocol):
    """Strategy contract for TTS providers."""

    def synthesize(
        self, text: str, voice_id: str, language: str
    ) -> SynthesisResult:  # pragma: no cover - protocol
        ...


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def _measure_duration(audio_bytes: bytes, mime_type: str) -> int:
    """Decode ``audio_bytes`` with pydub and return the duration in ms."""
    from pydub import AudioSegment  # deferred to keep module import cheap

    fmt = _mime_to_format(mime_type)
    try:
        segment = AudioSegment.from_file(io.BytesIO(audio_bytes), format=fmt)
    except (OSError, ValueError, IndexError) as exc:
        raise RuntimeError(
            f"failed to decode audio ({mime_type}) with pydub: {exc}"
        ) from exc
    return int(len(segment))


def _mime_to_format(mime_type: str) -> str:
    """Map an audio MIME type to a pydub/ffmpeg format code."""
    mapping = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
    }
    return mapping.get(mime_type.lower(), mime_type.split("/")[-1])


def _aggregate_characters_to_words(
    characters: list[str],
    start_times: list[float],
    end_times: list[float],
) -> list[WordAlignment]:
    """Fold a sequence of per-character timings into word alignments.

    Whitespace characters close the current word; punctuation stays attached
    to the preceding token. Entries with zero-length timings are discarded
    if they are whitespace-only.
    """
    if not (len(characters) == len(start_times) == len(end_times)):
        raise ValueError(
            "characters/start_times/end_times length mismatch: "
            f"{len(characters)}/{len(start_times)}/{len(end_times)}"
        )

    words: list[WordAlignment] = []
    current_chars: list[str] = []
    current_start: float | None = None
    current_end: float = 0.0

    def _flush() -> None:
        nonlocal current_chars, current_start, current_end
        if current_chars and current_start is not None:
            token = "".join(current_chars).strip()
            if token:
                words.append(
                    WordAlignment(
                        word=token,
                        start_ms=int(round(current_start * 1000)),
                        end_ms=int(round(current_end * 1000)),
                    )
                )
        current_chars = []
        current_start = None
        current_end = 0.0

    for char, start, end in zip(characters, start_times, end_times):
        if char.isspace():
            _flush()
            continue
        if current_start is None:
            current_start = float(start)
        current_chars.append(char)
        current_end = float(end)

    _flush()
    return _enforce_monotonic(words)


def _enforce_monotonic(words: list[WordAlignment]) -> list[WordAlignment]:
    """Ensure start/end sequences are monotonic and non-overlapping."""
    prev_end = 0
    normalised: list[WordAlignment] = []
    for w in words:
        start = max(int(w["start_ms"]), prev_end)
        end = max(int(w["end_ms"]), start)
        normalised.append(WordAlignment(word=w["word"], start_ms=start, end_ms=end))
        prev_end = end
    return normalised


# --------------------------------------------------------------------------- #
# ElevenLabs
# --------------------------------------------------------------------------- #


class ElevenLabsProvider:
    """ElevenLabs provider using the ``/with-timestamps`` endpoint."""

    def __init__(
        self,
        api_key: str,
        model_id: str = "eleven_multilingual_v2",
        timeout_seconds: float = 60.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("ElevenLabsProvider requires a non-empty api_key")
        self._api_key = api_key
        self._model_id = model_id
        self._timeout = timeout_seconds
        self._http_client = http_client

    def synthesize(
        self, text: str, voice_id: str, language: str = _DEFAULT_LANGUAGE
    ) -> SynthesisResult:
        url = f"{_ELEVENLABS_BASE}/v1/text-to-speech/{voice_id}/with-timestamps"
        headers = {
            "xi-api-key": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        payload: dict[str, Any] = {
            "text": text,
            "model_id": self._model_id,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }
        if language and language != _DEFAULT_LANGUAGE:
            payload["language_code"] = language

        body = self._post(url, payload, headers)
        audio_base64 = body.get("audio_base64")
        if not audio_base64:
            raise RuntimeError("ElevenLabs response missing audio_base64")
        import base64

        audio_bytes = base64.b64decode(audio_base64)
        alignment = body.get("alignment") or body.get("normalized_alignment") or {}
        word_alignments = self._parse_alignment(alignment)
        mime_type = "audio/mpeg"
        duration_ms = _measure_duration(audio_bytes, mime_type)

        logger.info(
            "elevenlabs_synthesized",
            voice_id=voice_id,
            text_length=len(text),
            audio_bytes=len(audio_bytes),
            duration_ms=duration_ms,
            words=len(word_alignments) if word_alignments else 0,
        )
        return SynthesisResult(
            audio_bytes=audio_bytes,
            duration_ms=duration_ms,
            word_alignments=word_alignments,
            mime_type=mime_type,
        )

    def _post(
        self, url: str, payload: dict[str, Any], headers: dict[str, str]
    ) -> dict[str, Any]:
        if self._http_client is not None:
            response = self._http_client.post(url, json=payload, headers=headers)
        else:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return cast(dict[str, Any], response.json())

    @staticmethod
    def _parse_alignment(alignment: dict[str, Any]) -> list[WordAlignment] | None:
        characters = alignment.get("characters")
        starts = alignment.get("character_start_times_seconds")
        ends = alignment.get("character_end_times_seconds")
        if not (isinstance(characters, list) and isinstance(starts, list) and isinstance(ends, list)):
            return None
        if not characters:
            return None
        return _aggregate_characters_to_words(characters, starts, ends)


# --------------------------------------------------------------------------- #
# AWS Polly
# --------------------------------------------------------------------------- #


class PollyProvider:
    """AWS Polly provider.

    Calls ``synthesize_speech`` twice: once to retrieve MP3 bytes and once
    with ``OutputFormat='json', SpeechMarkTypes=['word']`` to obtain
    per-word timestamps.
    """

    def __init__(
        self,
        client: Any,
        engine: str = "neural",
        output_format: str = "mp3",
    ) -> None:
        if client is None:
            raise ValueError("PollyProvider requires a boto3 polly client")
        self._client = client
        self._engine = engine
        self._output_format = output_format

    def synthesize(
        self, text: str, voice_id: str, language: str = _DEFAULT_LANGUAGE
    ) -> SynthesisResult:
        audio_bytes = self._synthesize_audio(text, voice_id, language)
        mime_type = "audio/mpeg" if self._output_format == "mp3" else "audio/ogg"
        duration_ms = _measure_duration(audio_bytes, mime_type)
        marks = self._synthesize_marks(text, voice_id, language)
        word_alignments = self._marks_to_alignment(marks)
        logger.info(
            "polly_synthesized",
            voice_id=voice_id,
            text_length=len(text),
            audio_bytes=len(audio_bytes),
            duration_ms=duration_ms,
            words=len(word_alignments) if word_alignments else 0,
        )
        return SynthesisResult(
            audio_bytes=audio_bytes,
            duration_ms=duration_ms,
            word_alignments=word_alignments,
            mime_type=mime_type,
        )

    def _synthesize_audio(self, text: str, voice_id: str, language: str) -> bytes:
        response = self._client.synthesize_speech(
            Text=text,
            VoiceId=voice_id,
            OutputFormat=self._output_format,
            Engine=self._engine,
            LanguageCode=self._polly_language(language),
        )
        stream = response.get("AudioStream")
        if stream is None:
            raise RuntimeError("Polly synthesize_speech returned no AudioStream")
        return stream.read() if hasattr(stream, "read") else bytes(stream)

    def _synthesize_marks(
        self, text: str, voice_id: str, language: str
    ) -> list[dict[str, Any]]:
        response = self._client.synthesize_speech(
            Text=text,
            VoiceId=voice_id,
            OutputFormat="json",
            Engine=self._engine,
            SpeechMarkTypes=["word"],
            LanguageCode=self._polly_language(language),
        )
        stream = response.get("AudioStream")
        if stream is None:
            return []
        raw = stream.read() if hasattr(stream, "read") else bytes(stream)
        text_payload = raw.decode("utf-8", errors="ignore").strip()
        if not text_payload:
            return []
        marks: list[dict[str, Any]] = []
        for line in text_payload.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                mark = json.loads(line)
            except json.JSONDecodeError:
                continue
            if mark.get("type") == "word":
                marks.append(mark)
        return marks

    @staticmethod
    def _polly_language(language: str) -> str:
        if not language:
            return "en-US"
        if "-" in language:
            return language
        return {
            "en": "en-US",
            "es": "es-ES",
            "fr": "fr-FR",
            "de": "de-DE",
            "it": "it-IT",
            "pt": "pt-BR",
            "hi": "hi-IN",
            "ja": "ja-JP",
        }.get(language.lower(), "en-US")

    @staticmethod
    def _marks_to_alignment(
        marks: list[dict[str, Any]],
    ) -> list[WordAlignment] | None:
        if not marks:
            return None
        words: list[WordAlignment] = []
        ordered = sorted(marks, key=lambda m: int(m.get("time", 0)))
        for idx, mark in enumerate(ordered):
            value = str(mark.get("value", "")).strip()
            if not value:
                continue
            start_ms = int(mark.get("time", 0))
            if idx + 1 < len(ordered):
                end_ms = int(ordered[idx + 1].get("time", start_ms))
            else:
                end_ms = start_ms + max(1, len(value) * 70)
            if end_ms < start_ms:
                end_ms = start_ms
            words.append(WordAlignment(word=value, start_ms=start_ms, end_ms=end_ms))
        if not words:
            return None
        return _enforce_monotonic(words)


# --------------------------------------------------------------------------- #
# gTTS
# --------------------------------------------------------------------------- #


class GttsProvider:
    """Google Text-to-Speech (no native timings)."""

    def __init__(self, gtts_factory: Any | None = None) -> None:
        self._gtts_factory = gtts_factory

    def synthesize(
        self, text: str, voice_id: str, language: str = _DEFAULT_LANGUAGE
    ) -> SynthesisResult:
        factory = self._gtts_factory
        if factory is None:
            from gtts import gTTS

            factory = gTTS
        lang = (language or _DEFAULT_LANGUAGE).split("-")[0] or _DEFAULT_LANGUAGE
        tts = factory(text=text, lang=lang)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        audio_bytes = buf.getvalue()
        mime_type = "audio/mpeg"
        duration_ms = _measure_duration(audio_bytes, mime_type)
        logger.info(
            "gtts_synthesized",
            voice_id=voice_id,
            text_length=len(text),
            audio_bytes=len(audio_bytes),
            duration_ms=duration_ms,
        )
        return SynthesisResult(
            audio_bytes=audio_bytes,
            duration_ms=duration_ms,
            word_alignments=None,
            mime_type=mime_type,
        )


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #


def build_provider(
    provider: str,
    *,
    elevenlabs_api_key: str = "",
    elevenlabs_model_id: str = "eleven_multilingual_v2",
    aws_access_key_id: str = "",
    aws_secret_access_key: str = "",
    aws_region: str = "us-east-1",
    polly_engine: str = "neural",
) -> TTSProvider:
    """Construct a provider from configuration values."""
    name = provider.lower()
    if name == "elevenlabs":
        if not elevenlabs_api_key:
            logger.warning("elevenlabs_missing_key_falling_back_to_gtts")
            return GttsProvider()
        return ElevenLabsProvider(
            api_key=elevenlabs_api_key, model_id=elevenlabs_model_id
        )
    if name == "polly":
        if not (aws_access_key_id and aws_secret_access_key):
            logger.warning("polly_missing_creds_falling_back_to_gtts")
            return GttsProvider()
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover - defensive
            raise RuntimeError("boto3 is required for Polly provider") from exc
        client = boto3.client(
            "polly",
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=aws_region,
        )
        return PollyProvider(client=client, engine=polly_engine)
    return GttsProvider()
