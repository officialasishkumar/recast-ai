"""FFmpeg ``atempo``-based speed adjustment to fit audio into scene bounds.

:func:`fit_to_segment` clamps the effective ratio to ``[0.75, 1.5]``. When
the required ratio is outside those bounds the audio is returned
unchanged and ``speed_flagged`` is set to ``True``; the caller records the
flag against the segment so reviewers can regenerate it.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass

import structlog

logger = structlog.get_logger(__name__)

MIN_RATIO = 0.75
MAX_RATIO = 1.5


@dataclass
class FitResult:
    """Output of :func:`fit_to_segment`."""

    audio_bytes: bytes
    final_duration_ms: int
    applied_ratio: float
    speed_flagged: bool
    mime_type: str


def fit_to_segment(
    audio_bytes: bytes,
    current_ms: int,
    target_ms: int,
    mime_type: str,
) -> FitResult:
    """Fit ``audio_bytes`` of length ``current_ms`` into ``target_ms``.

    The applied ratio is ``current_ms / target_ms``. If the ratio is
    outside ``[0.75, 1.5]``, the original audio is returned and
    ``speed_flagged`` is set to ``True``.
    """
    if current_ms <= 0:
        logger.warning("fit_skip_current_zero")
        return FitResult(
            audio_bytes=audio_bytes,
            final_duration_ms=current_ms,
            applied_ratio=1.0,
            speed_flagged=True,
            mime_type=mime_type,
        )
    if target_ms <= 0:
        logger.warning("fit_skip_target_zero")
        return FitResult(
            audio_bytes=audio_bytes,
            final_duration_ms=current_ms,
            applied_ratio=1.0,
            speed_flagged=True,
            mime_type=mime_type,
        )

    ratio = current_ms / target_ms

    if ratio < MIN_RATIO or ratio > MAX_RATIO:
        logger.warning(
            "fit_ratio_out_of_bounds",
            ratio=round(ratio, 4),
            current_ms=current_ms,
            target_ms=target_ms,
        )
        return FitResult(
            audio_bytes=audio_bytes,
            final_duration_ms=current_ms,
            applied_ratio=1.0,
            speed_flagged=True,
            mime_type=mime_type,
        )

    if abs(ratio - 1.0) < 0.01:
        return FitResult(
            audio_bytes=audio_bytes,
            final_duration_ms=current_ms,
            applied_ratio=1.0,
            speed_flagged=False,
            mime_type=mime_type,
        )

    adjusted_bytes = _apply_atempo(audio_bytes, ratio, mime_type)
    logger.info(
        "fit_applied",
        ratio=round(ratio, 4),
        current_ms=current_ms,
        target_ms=target_ms,
    )
    return FitResult(
        audio_bytes=adjusted_bytes,
        final_duration_ms=target_ms,
        applied_ratio=ratio,
        speed_flagged=False,
        mime_type=mime_type,
    )


def _apply_atempo(audio_bytes: bytes, ratio: float, mime_type: str) -> bytes:
    """Run ffmpeg ``atempo`` and return the transformed audio bytes."""
    if ratio <= 0:
        raise ValueError(f"ratio must be positive, got {ratio}")
    filters = _build_atempo_chain(ratio)
    filter_str = ",".join(filters)
    ext = _ext_for_mime(mime_type)

    with tempfile.TemporaryDirectory(prefix="tts_fit_") as tmp_dir:
        in_path = os.path.join(tmp_dir, f"in{ext}")
        out_path = os.path.join(tmp_dir, f"out{ext}")
        with open(in_path, "wb") as f:
            f.write(audio_bytes)

        cmd = [
            "ffmpeg",
            "-y",
            "-i", in_path,
            "-filter:a", filter_str,
            "-vn",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg atempo failed: {result.stderr.strip()}"
            )
        with open(out_path, "rb") as f:
            return f.read()


def _build_atempo_chain(ratio: float) -> list[str]:
    """Build a chain of atempo stages (each in [0.5, 2.0]) for ``ratio``."""
    if abs(ratio - 1.0) < 0.001:
        return ["atempo=1.0"]

    filters: list[str] = []
    remaining = ratio

    if remaining > 2.0:
        while remaining > 2.0:
            filters.append("atempo=2.0")
            remaining /= 2.0
        filters.append(f"atempo={remaining:.6f}")
    elif remaining < 0.5:
        while remaining < 0.5:
            filters.append("atempo=0.5")
            remaining /= 0.5
        filters.append(f"atempo={remaining:.6f}")
    else:
        filters.append(f"atempo={remaining:.6f}")
    return filters


def _ext_for_mime(mime_type: str) -> str:
    return {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
    }.get(mime_type.lower(), ".bin")
