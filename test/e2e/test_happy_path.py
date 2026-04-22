"""Happy-path: upload -> analyze -> transcribe -> synthesize -> mux -> complete.

This is the keystone regression test. It runs against a live stack and
validates the pipeline end-to-end. When ``FAKE_GEMINI=1`` is set the test
is deterministic; otherwise it talks to a real Gemini API key configured in
the video-analyzer service.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

logger = logging.getLogger(__name__)

pytestmark = pytest.mark.slow


def _ffprobe_streams(path: Path) -> dict:
    """Run ffprobe in JSON mode and return the parsed output.

    Skips the test when ffprobe is unavailable on the runner so CI gives
    clear signal instead of a cryptic subprocess failure.
    """

    if shutil.which("ffprobe") is None:
        pytest.skip("ffprobe not available; cannot verify output streams")

    proc = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, (
        f"ffprobe exited {proc.returncode}: stderr={proc.stderr.strip()!r}"
    )
    return json.loads(proc.stdout)


def test_full_pipeline_produces_playable_output(
    client: httpx.Client,
    upload_job,
    wait_for_job,
    download_output,
) -> None:
    job_id = upload_job()
    assert job_id, "upload_job returned empty id"

    job = wait_for_job(job_id)

    assert job["stage"] == "completed", (
        f"job did not complete successfully. stage={job.get('stage')!r}, "
        f"error={job.get('error_message')!r}, body={job!r}"
    )

    output_url = job.get("download_url") or job.get("output_url") or job.get("output_file")
    assert output_url, f"completed job has no output_url. job={job!r}"

    output_path = download_output(output_url)
    logger.info("downloaded output %s (%d bytes)", output_path, output_path.stat().st_size)

    streams = _ffprobe_streams(output_path)
    codec_types = [s.get("codec_type") for s in streams.get("streams", [])]
    assert "video" in codec_types, f"output has no video stream. streams={streams!r}"
    assert "audio" in codec_types, f"output has no audio stream. streams={streams!r}"


def test_transcript_endpoint_returns_non_empty_segments(
    client: httpx.Client,
    upload_job,
    wait_for_job,
) -> None:
    job_id = upload_job()
    job = wait_for_job(job_id)
    assert job["stage"] == "completed", (
        f"job did not complete. job={job!r}"
    )

    resp = client.get(f"/v1/jobs/{job_id}/transcript", timeout=30.0)
    assert resp.status_code == 200, f"transcript fetch failed: {resp.status_code} {resp.text}"
    body = resp.json()

    segments = body.get("segments") or []
    assert len(segments) >= 1, f"expected >=1 segment, got {segments!r}"

    for idx, seg in enumerate(segments):
        assert seg.get("text"), f"segment {idx} has empty text: {seg!r}"
        assert seg.get("end_ms", 0) >= seg.get("start_ms", 0), (
            f"segment {idx} has inverted bounds: {seg!r}"
        )
        # Word-level timings are populated by the TTS layer. Allow them to be
        # absent on segments that only arrived via fake-Gemini but require at
        # least one word when they are present.
        words = seg.get("words") or []
        if words:
            assert all(w.get("word") for w in words), (
                f"segment {idx} has a word with empty text: {words!r}"
            )
