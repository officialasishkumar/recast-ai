"""Adaptive speed control using ffmpeg/ffprobe.

Provides utilities to measure audio duration, adjust playback speed to
match target segment durations, and concatenate WAV files.
"""

from __future__ import annotations

import json
import math
import subprocess

import structlog

logger = structlog.get_logger(__name__)


def get_audio_duration(audio_path: str) -> float:
    """Return the duration of an audio file in milliseconds.

    Uses ``ffprobe`` to read the container duration.

    Parameters
    ----------
    audio_path:
        Path to the audio file on disk.

    Raises
    ------
    RuntimeError
        If ffprobe fails or returns an unparseable result.
    """
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)

    if result.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed for {audio_path}: {result.stderr.strip()}"
        )

    try:
        info = json.loads(result.stdout)
        duration_sec = float(info["format"]["duration"])
        return duration_sec * 1000.0
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        raise RuntimeError(
            f"failed to parse ffprobe output for {audio_path}: {exc}"
        ) from exc


def adjust_speed(input_path: str, output_path: str, ratio: float) -> None:
    """Adjust audio playback speed using ffmpeg's ``atempo`` filter.

    The ``atempo`` filter only accepts values in [0.5, 100.0].  For
    ratios outside [0.5, 2.0] we chain multiple ``atempo`` filters to
    reach the desired ratio.

    Parameters
    ----------
    input_path:
        Path to the source WAV file.
    output_path:
        Path where the speed-adjusted WAV file will be written.
    ratio:
        Speed multiplier.  Values > 1.0 speed up; < 1.0 slow down.
        ``1.0`` copies the file without modification (but we still
        re-encode via ffmpeg for consistency).

    Raises
    ------
    RuntimeError
        If ffmpeg returns a non-zero exit code.
    """
    if ratio <= 0:
        raise ValueError(f"speed ratio must be positive, got {ratio}")

    # Build the atempo filter chain
    filters = _build_atempo_chain(ratio)
    filter_str = ",".join(filters)

    cmd = [
        "ffmpeg",
        "-y",
        "-i", input_path,
        "-filter:a", filter_str,
        "-vn",
        output_path,
    ]

    logger.debug("ffmpeg_adjust_speed", ratio=ratio, filter=filter_str)

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg speed adjust failed: {result.stderr.strip()}"
        )


def _build_atempo_chain(ratio: float) -> list[str]:
    """Build a chain of atempo filter values for the given speed ratio.

    Each individual atempo value must be in [0.5, 100.0].  We use the
    practical range of [0.5, 2.0] per stage and chain multiple stages
    when the ratio is outside that range.
    """
    if abs(ratio - 1.0) < 0.001:
        return ["atempo=1.0"]

    filters: list[str] = []
    remaining = ratio

    if remaining > 2.0:
        # Speed up: chain atempo=2.0 stages
        while remaining > 2.0:
            filters.append("atempo=2.0")
            remaining /= 2.0
        filters.append(f"atempo={remaining:.6f}")
    elif remaining < 0.5:
        # Slow down: chain atempo=0.5 stages
        while remaining < 0.5:
            filters.append("atempo=0.5")
            remaining /= 0.5
        filters.append(f"atempo={remaining:.6f}")
    else:
        filters.append(f"atempo={remaining:.6f}")

    return filters


def concatenate_audio(input_paths: list[str], output_path: str) -> None:
    """Concatenate multiple WAV files into a single output file.

    Uses the ffmpeg ``concat`` demuxer for gapless joining.

    Parameters
    ----------
    input_paths:
        Ordered list of WAV file paths to concatenate.
    output_path:
        Path where the concatenated WAV file will be written.

    Raises
    ------
    RuntimeError
        If ffmpeg returns a non-zero exit code.
    ValueError
        If the input list is empty.
    """
    if not input_paths:
        raise ValueError("input_paths must not be empty")

    if len(input_paths) == 1:
        # Single file -- just copy
        cmd = ["ffmpeg", "-y", "-i", input_paths[0], "-c", "copy", output_path]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg copy failed: {result.stderr.strip()}")
        return

    # Build the concat filter for multiple inputs
    filter_parts: list[str] = []
    input_args: list[str] = []
    for i, path in enumerate(input_paths):
        input_args.extend(["-i", path])
        filter_parts.append(f"[{i}:a]")

    filter_str = "".join(filter_parts) + f"concat=n={len(input_paths)}:v=0:a=1[outa]"

    cmd = [
        "ffmpeg",
        "-y",
        *input_args,
        "-filter_complex", filter_str,
        "-map", "[outa]",
        output_path,
    ]

    logger.debug("ffmpeg_concatenate", count=len(input_paths))

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {result.stderr.strip()}")
