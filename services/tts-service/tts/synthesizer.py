"""TTS synthesis module.

Calls the ElevenLabs API to synthesize speech, or generates a silent WAV
placeholder in dev mode (when no API key is configured).
"""

from __future__ import annotations

import struct

import httpx
import structlog

logger = structlog.get_logger(__name__)

# ElevenLabs text-to-speech endpoint (v1).
_ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech"


def _generate_silent_wav(duration_ms: float) -> bytes:
    """Generate a silent WAV file of the given duration.

    Used in dev mode so the pipeline can run end-to-end without a real
    TTS API key.

    Parameters
    ----------
    duration_ms:
        Duration of silence in milliseconds.
    """
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


class TTSSynthesizer:
    """Text-to-speech synthesizer backed by ElevenLabs (or silent dev mode)."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._dev_mode = not api_key
        if self._dev_mode:
            logger.warning("tts_dev_mode_enabled")

    def synthesize(self, text: str, voice_id: str) -> bytes:
        """Synthesize speech for the given text.

        Parameters
        ----------
        text:
            The narration text to speak.
        voice_id:
            The ElevenLabs voice identifier.

        Returns
        -------
        bytes
            WAV audio data.
        """
        if self._dev_mode:
            return self._synthesize_dev(text)
        return self._synthesize_elevenlabs(text, voice_id)

    def _synthesize_dev(self, text: str) -> bytes:
        """Dev-mode: generate silence proportional to text length.

        Heuristic: ~10 ms per character yields a reasonable approximation
        of spoken duration.
        """
        duration_ms = max(len(text) * 10.0, 100.0)
        logger.debug("tts_dev_synthesize", chars=len(text), duration_ms=duration_ms)
        return _generate_silent_wav(duration_ms)

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
