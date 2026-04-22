"""Public share-link regression.

Creates a share token on a completed job, then hits the public endpoint
without auth and validates the returned payload exposes the job plus
transcript while redacting internal identifiers (user_id, trace_id).
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = [pytest.mark.slow, pytest.mark.share]


def test_share_exposes_public_view(
    client: httpx.Client,
    anon_client: httpx.Client,
    upload_job,
    wait_for_job,
) -> None:
    job_id = upload_job()
    job = wait_for_job(job_id)
    assert job["stage"] == "completed", f"job did not complete. job={job!r}"

    create = client.post(f"/v1/jobs/{job_id}/share", timeout=15.0)
    assert create.status_code == 200, (
        f"share create failed: {create.status_code} {create.text}"
    )
    body = create.json()
    token = body.get("token")
    share_url = body.get("url")
    assert token, f"share create response missing token: {body!r}"
    assert share_url and share_url.endswith(token), (
        f"expected url to end with token, got {share_url!r}"
    )

    # Hit the public endpoint *without* auth.
    public = anon_client.get(f"/v1/public/shares/{token}")
    assert public.status_code == 200, (
        f"public share fetch failed: {public.status_code} {public.text}"
    )

    payload = public.json()
    pub_job = payload.get("job") or {}
    transcript = payload.get("transcript") or []

    assert pub_job.get("id") == job_id, f"expected job id {job_id}, got {pub_job!r}"
    assert pub_job.get("status") == "completed", f"unexpected status: {pub_job!r}"
    # Public payload must NOT leak internal fields.
    assert "user_id" not in pub_job, f"public payload leaked user_id: {pub_job!r}"
    assert "trace_id" not in pub_job, f"public payload leaked trace_id: {pub_job!r}"

    assert len(transcript) >= 1, "public share returned empty transcript"
    for idx, seg in enumerate(transcript):
        assert seg.get("text"), f"public segment {idx} has empty text: {seg!r}"


def test_share_revocation_makes_token_404(
    client: httpx.Client,
    anon_client: httpx.Client,
    upload_job,
    wait_for_job,
) -> None:
    job_id = upload_job()
    job = wait_for_job(job_id)
    assert job["stage"] == "completed", f"job did not complete. job={job!r}"

    token = client.post(f"/v1/jobs/{job_id}/share", timeout=15.0).json()["token"]
    assert anon_client.get(f"/v1/public/shares/{token}").status_code == 200

    revoke = client.delete(f"/v1/jobs/{job_id}/share", timeout=15.0)
    assert revoke.status_code in (200, 204), (
        f"share revoke failed: {revoke.status_code} {revoke.text}"
    )
    # After revocation the old token must not resolve.
    gone = anon_client.get(f"/v1/public/shares/{token}")
    assert gone.status_code == 404, (
        f"expected 404 after revoke, got {gone.status_code}: {gone.text}"
    )
