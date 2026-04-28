"""FFmpeg-based audio quality scorer for TTS segments.

The scorer is deterministic and uses no AI: every signal it produces
comes from FFmpeg filters that ship with the binary already on the
worker. That keeps the inner loop cheap and the diagnosis explainable
when we feed it back to Gemini for a rewrite.

Three signals contribute to the combined score:

* ``duration_fit`` — how well the synthesized audio fits the scene
  budget after the allowed atempo range ``[0.75, 1.5]`` is applied. A
  segment that overflows even at 1.5x is flagged as "too verbose for
  the scene"; a segment that underflows below 0.75x is flagged as "too
  terse" so Gemini can expand it.
* ``silence_ratio`` — the fraction of the segment that is silent
  according to ``silencedetect``. Excessive mid-segment silence
  usually means the TTS engine inserted an awkward pause or a
  punctuation glitch.
* ``loudness`` — the integrated LUFS reported by FFmpeg's ``loudnorm``
  filter. Outside ``[-30, -10]`` LUFS we flag the segment so the
  rewrite can tweak punctuation that drove the synthesizer too quiet
  or too loud.

The combined score is a weighted geometric mean of the three signals.
A geometric mean is preferred over an arithmetic mean here because we
want any single low subscore to depress the overall score; a long
segment with great loudness should still fail.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

# Atempo bounds reused from speed_control to keep the gate consistent
# with what the muxer can actually apply.
MIN_ATEMPO = 0.75
MAX_ATEMPO = 1.5

# Pass threshold for the combined score: below this, the segment goes
# back to Gemini for a rewrite. Tuned empirically; surface as env var
# if it needs to vary by deployment.
DEFAULT_PASS_THRESHOLD = 0.7

# silencedetect parameters. -30 dB and 0.4 s catch perceptible mid-segment
# pauses without being so sensitive that natural sentence breaks trip them.
_SILENCE_DB = "-30dB"
_SILENCE_MIN_S = 0.4


@dataclass
class QualityScore:
    """Result of scoring one synthesized segment."""

    combined: float
    duration_fit: float
    silence: float
    loudness: float
    duration_overflow_ms: int  # > 0 when audio is too long for the scene
    duration_underflow_ms: int  # > 0 when audio is too short for the scene
    silence_ratio: float
    lufs: float
    issues: list[str] = field(default_factory=list)

    def passes(self, threshold: float = DEFAULT_PASS_THRESHOLD) -> bool:
        return self.combined >= threshold

    def to_diagnosis(self) -> dict[str, Any]:
        """Compact, JSON-friendly summary that we hand to Gemini.

        Only the fields the rewriter needs are exported; raw subscores
        are kept for our own dashboards but the LLM is given a
        plain-English ``issues`` list and the duration delta in ms.
        """
        return {
            "duration_overflow_ms": self.duration_overflow_ms,
            "duration_underflow_ms": self.duration_underflow_ms,
            "silence_ratio": round(self.silence_ratio, 3),
            "lufs": round(self.lufs, 1) if math.isfinite(self.lufs) else None,
            "issues": list(self.issues),
            "combined_score": round(self.combined, 3),
        }


def score_segment(
    audio_bytes: bytes,
    audio_duration_ms: int,
    target_duration_ms: int,
    mime_type: str = "audio/mpeg",
) -> QualityScore:
    """Score one synthesized segment.

    The function never raises on FFmpeg edge cases: a measurement that
    cannot be taken (silent audio, decoder error) defaults to a neutral
    subscore so a working signal never gets dragged down by a missing
    one.
    """
    duration_fit, overflow_ms, underflow_ms = _score_duration_fit(
        audio_duration_ms, target_duration_ms
    )

    silence_ratio = _measure_silence_ratio(audio_bytes, mime_type, audio_duration_ms)
    silence_score = _silence_to_score(silence_ratio)

    lufs = _measure_lufs(audio_bytes, mime_type)
    loudness_score = _lufs_to_score(lufs)

    issues = _diagnose(
        overflow_ms=overflow_ms,
        underflow_ms=underflow_ms,
        silence_ratio=silence_ratio,
        lufs=lufs,
    )

    # Weighted geometric mean. Duration is the most consequential signal
    # because a segment that does not fit cannot be rendered at all; the
    # other two are quality nudges.
    weights = (0.6, 0.25, 0.15)
    parts = (max(duration_fit, 1e-3), max(silence_score, 1e-3), max(loudness_score, 1e-3))
    combined = math.exp(sum(w * math.log(p) for w, p in zip(weights, parts)))

    score = QualityScore(
        combined=combined,
        duration_fit=duration_fit,
        silence=silence_score,
        loudness=loudness_score,
        duration_overflow_ms=overflow_ms,
        duration_underflow_ms=underflow_ms,
        silence_ratio=silence_ratio,
        lufs=lufs,
        issues=issues,
    )
    logger.debug(
        "quality_scored",
        combined=round(combined, 3),
        duration_fit=round(duration_fit, 3),
        silence=round(silence_score, 3),
        loudness=round(loudness_score, 3),
        overflow_ms=overflow_ms,
        underflow_ms=underflow_ms,
    )
    return score


# --------------------------------------------------------------------------- #
# Duration
# --------------------------------------------------------------------------- #


def _score_duration_fit(audio_ms: int, target_ms: int) -> tuple[float, int, int]:
    """Return ``(score, overflow_ms, underflow_ms)``.

    Inside the atempo bounds the score is 1.0; outside it falls off
    linearly with the millisecond delta beyond the achievable extreme.
    """
    if target_ms <= 0 or audio_ms <= 0:
        return 1.0, 0, 0

    min_audio_ms = MIN_ATEMPO * target_ms  # if audio is shorter than this, ratio < 0.75
    max_audio_ms = MAX_ATEMPO * target_ms  # if audio is longer than this, ratio > 1.5

    if min_audio_ms <= audio_ms <= max_audio_ms:
        return 1.0, 0, 0

    if audio_ms > max_audio_ms:
        overflow = int(audio_ms - max_audio_ms)
        # Linear penalty: every 1000 ms of overflow costs ~0.1.
        score = max(0.0, 1.0 - overflow / 10_000.0)
        return score, overflow, 0

    underflow = int(min_audio_ms - audio_ms)
    score = max(0.0, 1.0 - underflow / 10_000.0)
    return score, 0, underflow


# --------------------------------------------------------------------------- #
# Silence
# --------------------------------------------------------------------------- #


_SILENCE_LINE = re.compile(
    r"silence_(?P<kind>start|end):\s*(?P<value>-?\d+(?:\.\d+)?)"
)


def _measure_silence_ratio(audio_bytes: bytes, mime_type: str, audio_duration_ms: int) -> float:
    """Return the fraction of the segment that is silent.

    The ratio is computed by summing intervals reported by FFmpeg's
    ``silencedetect`` filter. The filter writes its findings to stderr
    as ``silence_start: T`` / ``silence_end: T`` pairs.
    """
    if audio_duration_ms <= 0 or not audio_bytes:
        return 0.0

    suffix = _suffix_for(mime_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            tmp.name,
            "-af",
            f"silencedetect=n={_SILENCE_DB}:d={_SILENCE_MIN_S}",
            "-f",
            "null",
            "-",
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=20, check=False
            )
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            logger.warning("silencedetect_failed", error=str(exc))
            return 0.0

    starts: list[float] = []
    ends: list[float] = []
    for line in proc.stderr.splitlines():
        match = _SILENCE_LINE.search(line)
        if not match:
            continue
        try:
            value = float(match.group("value"))
        except ValueError:
            continue
        if match.group("kind") == "start":
            starts.append(max(0.0, value))
        else:
            ends.append(max(0.0, value))

    audio_seconds = audio_duration_ms / 1000.0
    silence_seconds = 0.0
    for i, start in enumerate(starts):
        end = ends[i] if i < len(ends) else audio_seconds
        silence_seconds += max(0.0, min(end, audio_seconds) - start)

    if audio_seconds <= 0:
        return 0.0
    ratio = silence_seconds / audio_seconds
    return max(0.0, min(1.0, ratio))


def _silence_to_score(ratio: float) -> float:
    """Up to 15% silence is fine; above that the score drops linearly."""
    if ratio <= 0.15:
        return 1.0
    if ratio >= 0.5:
        return 0.0
    return 1.0 - (ratio - 0.15) / 0.35


# --------------------------------------------------------------------------- #
# Loudness
# --------------------------------------------------------------------------- #


def _measure_lufs(audio_bytes: bytes, mime_type: str) -> float:
    """Return the integrated LUFS as measured by FFmpeg ``loudnorm``.

    ``-inf`` is returned when the audio is silent or unmeasurable. The
    caller treats ``-inf`` as a neutral signal so a missing measurement
    does not poison the combined score.
    """
    if not audio_bytes:
        return float("-inf")

    suffix = _suffix_for(mime_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            tmp.name,
            "-af",
            "loudnorm=I=-16:LRA=11:TP=-1:print_format=json",
            "-f",
            "null",
            "-",
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=20, check=False
            )
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            logger.warning("loudnorm_failed", error=str(exc))
            return float("-inf")

    payload = _extract_loudnorm_json(proc.stderr)
    if payload is None:
        return float("-inf")
    try:
        return float(payload.get("input_i", float("-inf")))
    except (TypeError, ValueError):
        return float("-inf")


def _extract_loudnorm_json(stderr: str) -> dict[str, Any] | None:
    """Parse the JSON block FFmpeg's loudnorm filter prints to stderr."""
    start = stderr.rfind("{")
    end = stderr.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    blob = stderr[start : end + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


def _lufs_to_score(lufs: float) -> float:
    """Score peaks at -16 LUFS (broadcast target) and falls off either side."""
    if not math.isfinite(lufs):
        return 1.0  # neutral; no measurement available
    target = -16.0
    delta = abs(lufs - target)
    if delta <= 4:
        return 1.0
    if delta >= 14:
        return 0.0
    return 1.0 - (delta - 4) / 10.0


# --------------------------------------------------------------------------- #
# Diagnosis
# --------------------------------------------------------------------------- #


def _diagnose(
    overflow_ms: int,
    underflow_ms: int,
    silence_ratio: float,
    lufs: float,
) -> list[str]:
    issues: list[str] = []
    if overflow_ms > 0:
        issues.append("too_long_for_scene")
    if underflow_ms > 0:
        issues.append("too_short_for_scene")
    if silence_ratio > 0.25:
        issues.append("excessive_silence")
    if math.isfinite(lufs) and lufs > -8:
        issues.append("too_loud")
    if math.isfinite(lufs) and lufs < -30:
        issues.append("too_quiet")
    return issues


def _suffix_for(mime_type: str) -> str:
    if "wav" in mime_type:
        return ".wav"
    if "ogg" in mime_type:
        return ".ogg"
    if "flac" in mime_type:
        return ".flac"
    return ".mp3"
