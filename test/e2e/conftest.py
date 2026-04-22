"""Shared fixtures for Recast AI end-to-end tests.

The harness talks to a live stack reachable at ``E2E_API_URL`` (default
``http://localhost:8080``). It either brings the stack up itself via
``docker compose`` or, when ``E2E_SKIP_COMPOSE=1`` is set, assumes the stack
has already been provisioned (typical for CI jobs where services run as
side-cars or Kubernetes pods).

Every test runs as a freshly-registered throw-away user so that runs are
independent and can execute in parallel.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

import httpx
import pytest
from dotenv import load_dotenv
from tenacity import Retrying, stop_after_delay, wait_fixed, retry_if_exception_type

# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "test" / "fixtures"
GENERATE_SAMPLE_SCRIPT = FIXTURES_DIR / "generate_sample.sh"
SAMPLE_MP4 = FIXTURES_DIR / "sample.mp4"
GOLDEN_TRANSCRIPT = FIXTURES_DIR / "golden_transcript.json"
FAKE_GEMINI_RESPONSE = FIXTURES_DIR / "fake_gemini_response.json"

DEFAULT_API_URL = "http://localhost:8080"
DEFAULT_VOICE_ID = "default"
DEFAULT_LANGUAGE = "en"
DEFAULT_STYLE = "conversational"

# Maximum time we are willing to wait for the full pipeline on a ~3s sample.
DEFAULT_PIPELINE_TIMEOUT_S = int(os.environ.get("E2E_PIPELINE_TIMEOUT_S", "600"))
DEFAULT_POLL_INTERVAL_S = float(os.environ.get("E2E_POLL_INTERVAL_S", "2"))
DEFAULT_HEALTH_TIMEOUT_S = int(os.environ.get("E2E_HEALTH_TIMEOUT_S", "120"))

# Stages we consider terminal.
TERMINAL_STAGES = {"completed", "failed"}
COMPLETED_STAGES = {"completed"}

logger = logging.getLogger("e2e")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _truthy(val: Optional[str]) -> bool:
    return bool(val) and val.strip().lower() in {"1", "true", "yes", "on"}


def _load_env() -> None:
    """Load .env (repo root) so local runs work without shell exports."""

    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=False)


_load_env()


# ---------------------------------------------------------------------------
# Dataclasses used by tests
# ---------------------------------------------------------------------------


@dataclass
class E2ESettings:
    api_url: str
    pipeline_timeout_s: int
    poll_interval_s: float
    fake_gemini: bool
    skip_compose: bool
    keep_stack: bool


@dataclass
class AuthedUser:
    user_id: str
    email: str
    password: str
    token: str


# ---------------------------------------------------------------------------
# Top-level session fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def settings() -> E2ESettings:
    return E2ESettings(
        api_url=os.environ.get("E2E_API_URL", DEFAULT_API_URL).rstrip("/"),
        pipeline_timeout_s=DEFAULT_PIPELINE_TIMEOUT_S,
        poll_interval_s=DEFAULT_POLL_INTERVAL_S,
        fake_gemini=_truthy(os.environ.get("FAKE_GEMINI")),
        skip_compose=_truthy(os.environ.get("E2E_SKIP_COMPOSE")),
        keep_stack=_truthy(os.environ.get("E2E_KEEP_STACK")),
    )


@pytest.fixture(scope="session", autouse=True)
def docker_stack(settings: E2ESettings) -> Iterator[None]:
    """Bring the docker compose stack up for the test session.

    Skipped when ``E2E_SKIP_COMPOSE=1`` is set or when ``docker`` is not on
    ``$PATH`` (the test run is almost certainly happening against a
    remote/staging environment).
    """

    if settings.skip_compose:
        logger.info("E2E_SKIP_COMPOSE=1 set; assuming stack is already running")
        yield
        return

    if shutil.which("docker") is None:
        pytest.skip("docker CLI not available and E2E_SKIP_COMPOSE not set")

    compose_file = REPO_ROOT / "docker-compose.yml"
    if not compose_file.exists():
        pytest.skip(f"docker-compose.yml not found at {compose_file}")

    env = os.environ.copy()
    if settings.fake_gemini:
        env.setdefault("FAKE_GEMINI", "1")

    logger.info("starting docker compose stack (this may take a while on first run)")
    subprocess.run(
        ["docker", "compose", "-f", str(compose_file), "up", "-d"],
        check=True,
        cwd=REPO_ROOT,
        env=env,
    )

    try:
        yield
    finally:
        if settings.keep_stack:
            logger.info("E2E_KEEP_STACK=1 set; leaving stack running")
            return
        logger.info("tearing down docker compose stack")
        subprocess.run(
            ["docker", "compose", "-f", str(compose_file), "down", "-v"],
            check=False,
            cwd=REPO_ROOT,
            env=env,
        )


@pytest.fixture(scope="session")
def api_ready(settings: E2ESettings, docker_stack: None) -> str:
    """Wait for the API gateway's /health endpoint to respond 2xx."""

    url = f"{settings.api_url}/health"
    deadline = time.monotonic() + DEFAULT_HEALTH_TIMEOUT_S
    last_err: Optional[Exception] = None

    while time.monotonic() < deadline:
        try:
            resp = httpx.get(url, timeout=5.0)
            if 200 <= resp.status_code < 300:
                logger.info("api gateway healthy after %.1fs", time.monotonic() - (deadline - DEFAULT_HEALTH_TIMEOUT_S))
                return settings.api_url
        except Exception as exc:  # pragma: no cover
            last_err = exc
        time.sleep(1.0)

    pytest.skip(
        f"api gateway at {url} never became healthy within {DEFAULT_HEALTH_TIMEOUT_S}s: {last_err}"
    )


@pytest.fixture(scope="session")
def sample_mp4(settings: E2ESettings) -> Path:
    """Ensure test/fixtures/sample.mp4 exists. Generated on demand.

    If ffmpeg is missing and the file is not committed, the test is skipped
    with a clear reason so CI won't fail silently.
    """

    if SAMPLE_MP4.exists() and SAMPLE_MP4.stat().st_size > 0:
        return SAMPLE_MP4

    if not GENERATE_SAMPLE_SCRIPT.exists():
        pytest.skip(f"sample generator not found at {GENERATE_SAMPLE_SCRIPT}")

    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is required to generate test/fixtures/sample.mp4 and is not on $PATH")

    logger.info("generating sample.mp4 via %s", GENERATE_SAMPLE_SCRIPT)
    subprocess.run(
        ["bash", str(GENERATE_SAMPLE_SCRIPT)],
        check=True,
        cwd=FIXTURES_DIR,
    )

    if not SAMPLE_MP4.exists():
        raise RuntimeError(f"{GENERATE_SAMPLE_SCRIPT} ran but {SAMPLE_MP4} was not created")
    return SAMPLE_MP4


@pytest.fixture(scope="session")
def golden_transcript() -> dict[str, Any]:
    if not GOLDEN_TRANSCRIPT.exists():
        pytest.skip(f"golden transcript fixture missing at {GOLDEN_TRANSCRIPT}")
    return json.loads(GOLDEN_TRANSCRIPT.read_text())


# ---------------------------------------------------------------------------
# Per-test fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def unique_email() -> str:
    return f"e2e-{uuid.uuid4().hex[:12]}@recast.test"


@pytest.fixture
def authed_user(api_ready: str, unique_email: str) -> AuthedUser:
    """Register a fresh user and return a valid JWT for them.

    We always register through /v1/auth/register and then log in again so the
    flow exercises both endpoints even though register already returns a
    token.
    """

    password = "pw-" + secrets.token_urlsafe(16)
    register_resp = httpx.post(
        f"{api_ready}/v1/auth/register",
        json={"email": unique_email, "password": password, "name": "E2E Tester"},
        timeout=15.0,
    )
    if register_resp.status_code != 201:
        raise AssertionError(
            f"register failed: {register_resp.status_code} {register_resp.text}"
        )
    user_id = register_resp.json()["user"]["id"]

    login_resp = httpx.post(
        f"{api_ready}/v1/auth/login",
        json={"email": unique_email, "password": password},
        timeout=15.0,
    )
    if login_resp.status_code != 200:
        raise AssertionError(
            f"login failed: {login_resp.status_code} {login_resp.text}"
        )
    token = login_resp.json()["token"]

    return AuthedUser(user_id=user_id, email=unique_email, password=password, token=token)


@pytest.fixture
def client(api_ready: str, authed_user: AuthedUser) -> Iterator[httpx.Client]:
    """An httpx.Client with the user's bearer token baked in.

    A long ``timeout`` covers uploads of small test videos; individual polling
    calls pass their own shorter timeouts.
    """

    with httpx.Client(
        base_url=api_ready,
        headers={"Authorization": f"Bearer {authed_user.token}"},
        timeout=httpx.Timeout(connect=10.0, read=60.0, write=120.0, pool=10.0),
    ) as c:
        yield c


@pytest.fixture
def anon_client(api_ready: str) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=api_ready, timeout=15.0) as c:
        yield c


# ---------------------------------------------------------------------------
# Utility fixtures consumed by tests
# ---------------------------------------------------------------------------


@pytest.fixture
def upload_job(client: httpx.Client, sample_mp4: Path, settings: E2ESettings):
    """Factory that uploads the sample recording and returns the job id.

    Prefers the multipart ``POST /v1/jobs`` endpoint (simple, one round-trip).
    Falls back to the chunked upload flow on 404.
    """

    def _upload(*, voice_id: str = DEFAULT_VOICE_ID,
                style: str = DEFAULT_STYLE,
                language: str = DEFAULT_LANGUAGE) -> str:
        with sample_mp4.open("rb") as f:
            files = {"file": (sample_mp4.name, f, "video/mp4")}
            data = {"voice_id": voice_id, "style": style, "language": language}
            resp = client.post("/v1/jobs", files=files, data=data, timeout=120.0)

        if resp.status_code == 404:
            return _upload_chunked(
                client,
                sample_mp4,
                voice_id=voice_id,
                style=style,
                language=language,
            )

        assert resp.status_code == 201, (
            f"expected 201 from POST /v1/jobs, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        return body["job"]["id"]

    return _upload


def _upload_chunked(
    client: httpx.Client,
    sample_mp4: Path,
    *,
    voice_id: str,
    style: str,
    language: str,
) -> str:
    """Fallback path: upload-service chunked endpoints.

    Splits the file into a single chunk (small fixture) for simplicity.
    """

    upload_id = uuid.uuid4().hex
    payload = sample_mp4.read_bytes()
    resp = client.post(
        "/v1/upload/chunk",
        params={"upload_id": upload_id, "chunk_idx": 0},
        content=payload,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert resp.status_code == 200, f"chunk upload failed: {resp.status_code} {resp.text}"

    complete = client.post(
        "/v1/upload/complete",
        params={"upload_id": upload_id},
        json={
            "filename": sample_mp4.name,
            "voice_id": voice_id,
            "style": style,
            "language": language,
        },
    )
    assert complete.status_code in (200, 202), (
        f"complete failed: {complete.status_code} {complete.text}"
    )
    return complete.json()["job_id"]


@pytest.fixture
def wait_for_job(client: httpx.Client, settings: E2ESettings):
    """Poll GET /v1/jobs/:id until stage is terminal or timeout.

    Returns the final job payload so tests can make richer assertions.
    """

    def _wait(job_id: str, *, timeout_s: Optional[int] = None) -> dict[str, Any]:
        deadline = time.monotonic() + (timeout_s or settings.pipeline_timeout_s)
        last_stage = ""
        last_body: dict[str, Any] = {}

        while time.monotonic() < deadline:
            resp = client.get(f"/v1/jobs/{job_id}", timeout=30.0)
            if resp.status_code != 200:
                logger.warning("transient GET /v1/jobs/%s -> %s", job_id, resp.status_code)
                time.sleep(settings.poll_interval_s)
                continue

            last_body = resp.json()
            stage = last_body.get("stage", "")
            if stage != last_stage:
                logger.info("job %s stage: %s", job_id, stage)
                last_stage = stage

            if stage in TERMINAL_STAGES:
                return last_body

            time.sleep(settings.poll_interval_s)

        raise TimeoutError(
            f"job {job_id} did not reach a terminal stage within "
            f"{timeout_s or settings.pipeline_timeout_s}s "
            f"(last stage={last_stage!r}, last body={last_body!r})"
        )

    return _wait


@pytest.fixture
def download_output(tmp_path: Path):
    """Download a presigned output URL to a local temp file and return the path."""

    def _download(url: str) -> Path:
        assert url, "output url is empty"
        dest = tmp_path / f"output-{uuid.uuid4().hex[:8]}.mp4"

        for attempt in Retrying(
            stop=stop_after_delay(60),
            wait=wait_fixed(2),
            retry=retry_if_exception_type((httpx.HTTPError, OSError)),
            reraise=True,
        ):
            with attempt:
                with httpx.Client(timeout=60.0, follow_redirects=True) as raw:
                    with raw.stream("GET", url) as r:
                        r.raise_for_status()
                        with dest.open("wb") as f:
                            for chunk in r.iter_bytes(64 * 1024):
                                f.write(chunk)
        assert dest.stat().st_size > 0, "downloaded output file is empty"
        return dest

    return _download
