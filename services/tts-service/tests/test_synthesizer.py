"""Tests for the provider-strategy synthesizer.

External APIs (ElevenLabs HTTP, AWS Polly, gTTS/pydub) are all stubbed.
"""

from __future__ import annotations

import base64
import io
import json
from typing import Any

import pytest

import tts.synthesizer as synthesizer_module
from tts.synthesizer import (
    ElevenLabsProvider,
    GttsProvider,
    PollyProvider,
    SynthesisResult,
    build_provider,
)


class _StubResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _StubHttpClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.last_call: dict[str, Any] | None = None

    def post(self, url: str, json: dict[str, Any], headers: dict[str, str]) -> _StubResponse:
        self.last_call = {"url": url, "json": json, "headers": headers}
        return _StubResponse(self._payload)


@pytest.fixture(autouse=True)
def _stub_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip pydub decoding by returning a predictable duration."""
    monkeypatch.setattr(
        synthesizer_module,
        "_measure_duration",
        lambda audio_bytes, mime_type: 1_500,
    )


def test_elevenlabs_parses_alignment() -> None:
    audio_bytes = b"fake-mp3-bytes"
    body = {
        "audio_base64": base64.b64encode(audio_bytes).decode(),
        "alignment": {
            "characters": ["H", "i", " ", "y", "o", "u"],
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        },
    }
    stub = _StubHttpClient(body)
    provider = ElevenLabsProvider(api_key="k", http_client=stub)
    result = provider.synthesize("Hi you", voice_id="voice-1", language="en")
    assert isinstance(result, SynthesisResult)
    assert result.audio_bytes == audio_bytes
    assert result.mime_type == "audio/mpeg"
    assert result.duration_ms == 1_500
    assert result.word_alignments is not None
    assert [w["word"] for w in result.word_alignments] == ["Hi", "you"]
    assert result.word_alignments[0]["start_ms"] == 0
    assert stub.last_call is not None
    assert stub.last_call["url"].endswith("/voice-1/with-timestamps")


def test_elevenlabs_requires_audio_base64() -> None:
    stub = _StubHttpClient({"alignment": {}})
    provider = ElevenLabsProvider(api_key="k", http_client=stub)
    with pytest.raises(RuntimeError, match="missing audio_base64"):
        provider.synthesize("hi", "v", "en")


def test_elevenlabs_requires_api_key() -> None:
    with pytest.raises(ValueError):
        ElevenLabsProvider(api_key="")


class _StubPollyStream:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data


class _StubPollyClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def synthesize_speech(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if kwargs.get("OutputFormat") == "json":
            marks = "\n".join(
                json.dumps(m)
                for m in [
                    {"type": "word", "time": 0, "start": 0, "end": 5, "value": "Hello"},
                    {"type": "word", "time": 400, "start": 6, "end": 11, "value": "world"},
                ]
            )
            return {"AudioStream": _StubPollyStream(marks.encode())}
        return {"AudioStream": _StubPollyStream(b"audio-mp3")}


def test_polly_merges_marks_and_audio() -> None:
    client = _StubPollyClient()
    provider = PollyProvider(client=client)
    result = provider.synthesize("Hello world", voice_id="Joanna", language="en")
    assert isinstance(result, SynthesisResult)
    assert result.audio_bytes == b"audio-mp3"
    assert result.mime_type == "audio/mpeg"
    assert result.duration_ms == 1_500
    assert result.word_alignments is not None
    assert [w["word"] for w in result.word_alignments] == ["Hello", "world"]
    assert result.word_alignments[0]["start_ms"] == 0
    assert result.word_alignments[1]["start_ms"] == 400
    assert len(client.calls) == 2
    formats = {c["OutputFormat"] for c in client.calls}
    assert formats == {"mp3", "json"}


def test_polly_no_marks_returns_none_alignment() -> None:
    class _Empty(_StubPollyClient):
        def synthesize_speech(self, **kwargs: Any) -> dict[str, Any]:
            if kwargs.get("OutputFormat") == "json":
                return {"AudioStream": _StubPollyStream(b"")}
            return {"AudioStream": _StubPollyStream(b"audio-mp3")}

    provider = PollyProvider(client=_Empty())
    result = provider.synthesize("Hi", voice_id="Joanna", language="en")
    assert result.word_alignments is None


class _StubGttsInstance:
    def __init__(self, text: str) -> None:
        self._text = text

    def write_to_fp(self, fp: io.BufferedIOBase) -> None:
        fp.write(b"fake-mp3-" + self._text.encode())


def _stub_gtts_factory(text: str, lang: str) -> _StubGttsInstance:  # noqa: ARG001
    return _StubGttsInstance(text)


def test_gtts_returns_no_alignment() -> None:
    provider = GttsProvider(gtts_factory=_stub_gtts_factory)
    result = provider.synthesize("hello", voice_id="ignored", language="en")
    assert isinstance(result, SynthesisResult)
    assert result.audio_bytes.startswith(b"fake-mp3-")
    assert result.word_alignments is None
    assert result.duration_ms == 1_500


def test_build_provider_falls_back_to_gtts_when_keys_missing() -> None:
    provider = build_provider("elevenlabs", elevenlabs_api_key="")
    assert isinstance(provider, GttsProvider)

    provider = build_provider(
        "polly", aws_access_key_id="", aws_secret_access_key=""
    )
    assert isinstance(provider, GttsProvider)

    provider = build_provider("unknown")
    assert isinstance(provider, GttsProvider)


def test_build_provider_selects_elevenlabs_when_configured() -> None:
    provider = build_provider("elevenlabs", elevenlabs_api_key="k")
    assert isinstance(provider, ElevenLabsProvider)
