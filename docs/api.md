# API Reference

Base URL for local development: `http://localhost:8080`. All paths are prefixed with `/v1`.

## Authentication

Every protected endpoint expects a bearer JWT in the `Authorization` header.

```http
Authorization: Bearer <access_token>
```

Access tokens are HS256 signed, expire after 15 minutes, and are minted by `POST /v1/auth/login` or `POST /v1/auth/refresh`. Refresh tokens are rotated on every use; old refresh tokens become invalid the moment a new pair is issued. Logging out invalidates the refresh token server-side.

WebSocket connections pass the same token via the `Sec-WebSocket-Protocol` header or a `?token=` query parameter.

## Errors

All error responses share a JSON envelope.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "email is required",
    "trace_id": "0f5c1e91-..."
  }
}
```

| Status | Meaning | Suggested UX |
|---|---|---|
| 400 | Malformed request or validation failure | Surface the field-level message inline. |
| 401 | Missing, expired, or invalid token | Redirect to login; attempt refresh flow. |
| 403 | Authenticated but not authorized | Hide the action; show a muted warning if navigated directly. |
| 404 | Resource does not exist or is not visible to the caller | Show a 404 page; offer a link back to the dashboard. |
| 409 | Conflict (duplicate email, stale share token) | Prompt the user with the conflicting state. |
| 413 | Payload too large | Ask the user to trim or compress the file. |
| 422 | Valid JSON, semantically invalid (for example unsupported language) | Highlight the offending field with the server message. |
| 429 | Rate limit exceeded | Back off and surface a non-blocking toast; auto-retry on idle. |
| 500 | Unhandled server error | Show a generic "something went wrong" with the `trace_id` for support. |
| 503 | Upstream dependency unavailable | Show a status banner; retry after a short delay. |

## Rate Limits

The default budget is **60 requests per minute per authenticated user**, enforced via a Redis token-bucket keyed on user ID. The limit is configurable at deploy time through the `RATE_LIMIT_PER_MINUTE` environment variable on the gateway. Exceeding the limit returns `429` with a `Retry-After` header in seconds.

## Auth

### Register

- **Method:** `POST`
- **Path:** `/v1/auth/register`
- **Auth required?** No
- **Request body:**

```json
{
  "email": "user@example.com",
  "password": "a-strong-passphrase",
  "name": "Jane Doe"
}
```

- **Response (201):**

```json
{
  "user": { "id": "uuid", "email": "user@example.com", "name": "Jane Doe", "role": "user" },
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "rt_..."
}
```

- **Example:**

```bash
curl -X POST http://localhost:8080/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"hunter2hunter2","name":"Jane"}'
```

### Login

- **Method:** `POST`
- **Path:** `/v1/auth/login`
- **Auth required?** No
- **Request body:**

```json
{ "email": "user@example.com", "password": "hunter2hunter2" }
```

- **Response (200):**

```json
{
  "user": { "id": "uuid", "email": "user@example.com", "name": "Jane", "role": "user" },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "rt_..."
}
```

### Refresh

- **Method:** `POST`
- **Path:** `/v1/auth/refresh`
- **Auth required?** No (uses refresh token)
- **Request body:** `{ "refresh_token": "rt_..." }`
- **Response (200):** a fresh `access_token` and rotated `refresh_token`.

### Logout

- **Method:** `POST`
- **Path:** `/v1/auth/logout`
- **Auth required?** Yes
- **Request body:** `{ "refresh_token": "rt_..." }`
- **Response (204):** empty body.

### Me

- **Method:** `GET`
- **Path:** `/v1/auth/me`
- **Auth required?** Yes
- **Response (200):**

```json
{ "id": "uuid", "email": "user@example.com", "name": "Jane", "role": "user", "avatar_url": null }
```

## Jobs

### Create Job

- **Method:** `POST`
- **Path:** `/v1/jobs`
- **Auth required?** Yes
- **Request body:**

```json
{
  "upload_id": "upl_...",
  "voice_id": "nova",
  "style": "formal",
  "language": "en"
}
```

- **Response (201):**

```json
{
  "id": "uuid",
  "stage": "uploaded",
  "voice_id": "nova",
  "style": "formal",
  "language": "en",
  "created_at": "2026-04-23T12:00:00Z"
}
```

- **Example:**

```bash
curl -X POST http://localhost:8080/v1/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"upload_id":"upl_01","voice_id":"nova","style":"formal","language":"en"}'
```

### List Jobs

- **Method:** `GET`
- **Path:** `/v1/jobs`
- **Auth required?** Yes
- **Query params:** `limit` (default 20, max 100), `cursor`, `stage`.
- **Response (200):**

```json
{
  "items": [ { "id": "uuid", "stage": "delivered", "original_name": "demo.mp4", "duration_ms": 183000 } ],
  "next_cursor": null
}
```

### Get Job

- **Method:** `GET`
- **Path:** `/v1/jobs/:id`
- **Auth required?** Yes
- **Response (200):** the full job record including `download_url`, `thumbnail_path`, `share_token`.

### Delete Job

- **Method:** `DELETE`
- **Path:** `/v1/jobs/:id`
- **Auth required?** Yes
- **Response (204):** empty body. Associated MinIO objects and transcript rows are purged.

### Get Transcript

- **Method:** `GET`
- **Path:** `/v1/jobs/:id/transcript`
- **Auth required?** Yes
- **Response (200):**

```json
{
  "segments": [
    {
      "segment_idx": 0,
      "start_ms": 0,
      "end_ms": 4200,
      "text": "Welcome to the product demo.",
      "words": [ { "word": "Welcome", "start_ms": 0, "end_ms": 520 } ],
      "confidence": 0.94,
      "approved": false,
      "flagged": false
    }
  ]
}
```

### Update Transcript

- **Method:** `PATCH`
- **Path:** `/v1/jobs/:id/transcript`
- **Auth required?** Yes
- **Request body:** array of segment updates keyed by `segment_idx`.

```json
{
  "segments": [ { "segment_idx": 0, "text": "Welcome to Recast AI." } ]
}
```

- **Response (200):** the updated transcript. Edited segments have their corresponding audio invalidated and will be re-synthesized by the TTS stage.

### Regenerate Segment

- **Method:** `POST`
- **Path:** `/v1/jobs/:id/segments/:segmentId/regenerate`
- **Auth required?** Yes
- **Request body:** `{}` or optional `{ "voice_id": "onyx" }`.
- **Response (202):** `{ "status": "queued" }`. The job re-enters the `transcript.queue` for that segment only.

### Share Job

- **Method:** `POST`
- **Path:** `/v1/jobs/:id/share`
- **Auth required?** Yes
- **Response (201):**

```json
{ "share_token": "s_1a2b3c...", "url": "https://app.recast.ai/share/s_1a2b3c..." }
```

### Revoke Share

- **Method:** `DELETE`
- **Path:** `/v1/jobs/:id/share`
- **Auth required?** Yes
- **Response (204):** empty body. The stored token is cleared.

### Export

- **Method:** `GET`
- **Path:** `/v1/jobs/:id/export`
- **Auth required?** Yes
- **Query params:** `format` (`mp4`, `srt`, `vtt`, `json`; default `mp4`).
- **Response (200):** `{ "download_url": "https://...", "expires_at": "..." }`.

## Uploads

### Create Chunked Upload

- **Method:** `POST`
- **Path:** `/v1/uploads`
- **Auth required?** Yes
- **Request body:**

```json
{ "filename": "demo.mp4", "size_bytes": 41234567, "mime_type": "video/mp4" }
```

- **Response (201):** `{ "upload_id": "upl_...", "chunk_size": 5242880 }`.

### Upload Chunk

- **Method:** `PUT`
- **Path:** `/v1/uploads/:id/parts/:n`
- **Auth required?** Yes
- **Request body:** raw bytes for part `n` (multipart/form-data binary).
- **Response (200):** `{ "etag": "...", "part_number": 1 }`.

### Complete Upload

- **Method:** `POST`
- **Path:** `/v1/uploads/:id/complete`
- **Auth required?** Yes
- **Request body:** `{ "parts": [ { "part_number": 1, "etag": "..." } ] }`.
- **Response (200):** `{ "upload_id": "upl_...", "object_key": "raw/...", "duration_ms": 183000 }`.

### Upload Status

- **Method:** `GET`
- **Path:** `/v1/uploads/:id`
- **Auth required?** Yes
- **Response (200):** `{ "upload_id": "upl_...", "received_parts": 6, "expected_parts": 8 }`.

### Delete Upload

- **Method:** `DELETE`
- **Path:** `/v1/uploads/:id`
- **Auth required?** Yes
- **Response (204):** empty body. Abandoned parts are removed from MinIO.

## Voices

### List Voices

- **Method:** `GET`
- **Path:** `/v1/voices`
- **Auth required?** Yes
- **Response (200):**

```json
{
  "items": [
    { "id": "nova", "name": "Nova", "gender": "female", "accent": "american", "provider": "elevenlabs", "sample_url": "..." }
  ]
}
```

### Preview Voice

- **Method:** `POST`
- **Path:** `/v1/voices/:id/preview`
- **Auth required?** Yes
- **Request body:** `{ "text": "A short sample sentence." }`.
- **Response (200):** `{ "audio_url": "https://...", "expires_at": "..." }`.

## Public

### Get Public Share

- **Method:** `GET`
- **Path:** `/v1/public/shares/:token`
- **Auth required?** No
- **Response (200):**

```json
{
  "job": { "id": "uuid", "original_name": "demo.mp4", "duration_ms": 183000, "thumbnail_url": "..." },
  "transcript": { "segments": [ { "segment_idx": 0, "text": "Welcome...", "start_ms": 0, "end_ms": 4200 } ] },
  "download_url": "https://..."
}
```

## WebSocket

### Job Progress Stream

- **Path:** `/v1/ws/jobs/:id`
- **Auth required?** Yes (bearer token via subprotocol or `?token=` query param)
- **Server -> client frames:**

```json
{ "event": "stage_complete", "stage": "video_analysis", "progress": 0.33, "eta_seconds": 42 }
```

- **Terminal events:** `job_complete` carries `download_url`; `job_failed` carries `error_message`.

## Health

- `GET /healthz` on the gateway returns `{ "status": "ok" }`.
- `GET /readyz` returns `200` once Postgres, Redis, and RabbitMQ connections are established.
- `GET /metrics` exposes Prometheus text format.
