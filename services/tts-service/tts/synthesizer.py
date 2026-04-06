"""TTS synthesis module.

Supports multiple providers:
- ``elevenlabs``: ElevenLabs API (requires API key).
- ``gtts``: Google Text-to-Speech (free, no API key).
- ``mock``: Silent WAV placeholder for dev/testing.
"""

from __future__ import annotations

import io
import struct
import subprocess
import tempfile

import httpx
import structlog

logger = structlog.get_logger(__name__)

# ElevenLabs text-to-speech endpoint (v1).
_ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech"


def _generate_silent_wav(duration_ms: float) -> bytes:
    """Generate a silent WAV file of the given duration."""
    sample_rate = 22050
    num_channels = 1
    bits_per_sample = 16
    num_samples = int(sample_rate * duration_ms / 1000.0)
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = num_samples * block_align

    buf = bytearray()
    # RIFF header
    buf.extend(b"RIFF")
    buf.extend(struct.pack("<I", 36 + data_size))
    buf.extend(b"WAVE")
    # fmt sub-chunk
    buf.extend(b"fmt ")
    buf.extend(struct.pack("<I", 16))  # sub-chunk size
    buf.extend(struct.pack("<H", 1))  # PCM format
    buf.extend(struct.pack("<H", num_channels))
    buf.extend(struct.pack("<I", sample_rate))
    buf.extend(struct.pack("<I", byte_rate))
    buf.extend(struct.pack("<H", block_align))
    buf.extend(struct.pack("<H", bits_per_sample))
    # data sub-chunk
    buf.extend(b"data")
    buf.extend(struct.pack("<I", data_size))
    buf.extend(b"\x00" * data_size)

    return bytes(buf)


def _mp3_to_wav(mp3_data: bytes) -> bytes:
    """Convert MP3 bytes to WAV using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=True) as mp3_f:
        mp3_f.write(mp3_data)
        mp3_f.flush()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as wav_f:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", mp3_f.name,
                    "-ar", "22050",
                    "-ac", "1",
                    wav_f.name,
                ],
                capture_output=True,
                check=True,
            )
            return wav_f.read()


class TTSSynthesizer:
    """Text-to-speech synthesizer with multiple provider support."""

    def __init__(self, provider: str, api_key: str = "") -> None:
        self._provider = provider
        self._api_key = api_key

        if provider == "mock" or (provider == "elevenlabs" and not api_key):
            self._provider = "mock"
            logger.warning("tts_mock_mode_enabled")
        else:
            logger.info("tts_provider_initialized", provider=provider)

    def synthesize(self, text: str, voice_id: str) -> bytes:
        """Synthesize speech for the given text.

        Returns WAV audio data.
        """
        if self._provider == "gtts":
            return self._synthesize_gtts(text)
        if self._provider == "elevenlabs":
            return self._synthesize_elevenlabs(text, voice_id)
        return self._synthesize_mock(text)

    def _synthesize_mock(self, text: str) -> bytes:
        """Mock mode: generate silence proportional to text length."""
        duration_ms = max(len(text) * 10.0, 100.0)
        logger.debug("tts_mock_synthesize", chars=len(text), duration_ms=duration_ms)
        return _generate_silent_wav(duration_ms)

    def _synthesize_gtts(self, text: str) -> bytes:
        """Use Google Text-to-Speech (free, no API key)."""
        from gtts import gTTS

        tts = gTTS(text=text, lang="en")
        mp3_buf = io.BytesIO()
        tts.write_to_fp(mp3_buf)
        mp3_data = mp3_buf.getvalue()

        # gTTS outputs MP3 — convert to WAV for the pipeline
        wav_data = _mp3_to_wav(mp3_data)

        logger.info(
            "tts_gtts_synthesized",
            text_length=len(text),
            audio_bytes=len(wav_data),
        )
        return wav_data

    def _synthesize_elevenlabs(self, text: str, voice_id: str) -> bytes:
        """Call the ElevenLabs API and return WAV audio bytes."""
        url = f"{_ELEVENLABS_BASE}/{voice_id}"
        headers = {
            "xi-api-key": self._api_key,
            "Content-Type": "application/json",
            "Accept": "audio/wav",
        }
        payload = {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }

        with httpx.Client(timeout=60.0) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            audio_data = response.content

        logger.info(
            "tts_synthesized",
            voice_id=voice_id,
            text_length=len(text),
            audio_bytes=len(audio_data),
        )
        return audio_data
