# Recast AI — Reliability at Millions of Users

**Date:** 2026-04-29
**Status:** Draft for review
**Owner:** Platform team
**Scope:** Reliability and scale hardening of the existing pipeline. Not a product redesign.

---

## 1. Goals

Make Recast AI safely runnable for a fleet that ingests on the order of **1M monthly active users**, **50k–100k concurrent jobs in flight**, and **5–10k peak inbound uploads per minute** without changing the user-facing contract.

### Service Level Objectives

| SLI | SLO |
|---|---|
| API availability (5xx rate, excluding `429`) | 99.95% rolling 28 days |
| Upload `POST /v1/uploads/:id/complete` success | 99.9% rolling 28 days |
| Job pipeline success (excluding user errors) | 99.5% rolling 28 days |
| Job P95 end-to-end latency for ≤ 5 min videos | ≤ 3 minutes |
| WebSocket connection success | 99.9% rolling 7 days |
| Pre-signed download URL availability | 99.99% rolling 28 days |
| Data durability (final MP4 + transcripts) | 11 nines (object store), zero-RPO for transcript text up to 5 min lag |

Each SLO has a 28-day error budget. Burn rate alerts fire at 2% of budget per hour and 5% per day. When budget is exhausted, all non-reliability work pauses until budget recovers.

## 2. Non-goals

- Re-architecting the AI pipeline (Gemini File API, TTS providers, FFmpeg mux remain as-is).
- Replacing RabbitMQ with Kafka in this phase. We harden RabbitMQ first; Kafka migration is a separate spec gated on observed throughput.
- Multi-region active-active. Phase 1 is single-region multi-AZ with cold-standby in a second region. Active-active is a Phase 3 follow-up.
- Pricing, billing, or product roadmap changes.

## 3. Current state assessment

The pipeline is already well partitioned: stateless workers behind RabbitMQ queues with per-queue DLQs, idempotent stage execution, circuit breakers and jittered retries around external calls, OpenTelemetry tracing end-to-end, Prometheus + Loki + Tempo + Grafana, signed multi-arch images with SBOM, and a Helm chart with HPA, PDB, NetworkPolicy, ServiceMonitor, and restricted PodSecurityStandard. That foundation is what makes scale viable; the gaps below are about removing single points of failure, hardening the data path, and protecting the system from itself when traffic spikes.

### Identified single points of failure

| Component | Current | Risk |
|---|---|---|
| PostgreSQL | Single primary, no replicas, no pooler | Loses all writes on primary failure; reads cap at one node; connection storms during HPA spikes |
| RabbitMQ | Single node, classic queues | Whole pipeline halts on broker loss; queue contents not replicated |
| Redis | Single instance for sessions, rate limit, WebSocket pub/sub | Logout flows, WebSocket fan-out, and rate limiting all collapse together |
| MinIO | Single node, single drive | One disk corruption loses every artifact; no erasure coding |
| Delivery service | `replicas: 1` in Helm values | Webhook delivery and pre-signed URL minting halt if pod crashes |
| Outbound LLM/TTS | One provider per call; gemini quota is a global ceiling | Provider regional outage = pipeline halt |
| Transactional consistency | `jobs` row update and queue publish are not atomic | Crash between DB commit and `basicPublish` orphans a job in `uploaded` forever |
| Backpressure | Workers `prefetch=N`, no admission control at API | Burst at upload service fills queue past consumer capacity; memory pressure on analyzer |

### Identified soft spots

- Pre-signed URL TTL of 1 hour assumes the user clicks promptly; webhooks include the URL but if the consumer retries past TTL the link 403s.
- `transcript_segments.words_json` can grow to multi-MB for long videos and is fetched in full by the editor. No pagination.
- `ON DELETE CASCADE` from `users` to `jobs` to `transcript_segments` is fine for correctness but a bulk admin delete locks rows for minutes.
- WebSocket fan-out goes through a single Redis Pub/Sub channel per job; a user opening many tabs can amplify writes.
- No idempotency key on `POST /v1/jobs` or `POST /v1/uploads`; a client retry on a 5xx can create duplicate jobs.
- No archival tier; finished jobs occupy hot object storage forever.

## 4. Design — Tier 1 (must ship before scaling past ~50k MAU)

These are the changes that unblock horizontal scale and remove the worst SPOFs. They are also the cheapest in implementation effort relative to risk reduction.

### 4.1 PostgreSQL: HA primary + read replica + pooler

- Move from self-hosted single Postgres to a managed Postgres offering with synchronous replication to a standby in another AZ (target: AWS RDS Multi-AZ + one async read replica, or CloudNativePG operator if we keep it in cluster).
- Insert **PgBouncer** in transaction-pooling mode in front. All Go services use `pgx` with a small per-pod pool (max 5) and let PgBouncer fan out to the primary. This removes the connection storm we get when `api-gateway` HPA scales from 2 to 10 in 30 seconds.
- Add **read replica routing** for two specific endpoints that dominate read traffic: `GET /v1/jobs` (list) and `GET /v1/jobs/:id/transcript` (read). Writes and consistent reads stay on the primary. Implement via a `ReadOnlyDB` handle plumbed through `pkg/database`.
- Backups: managed PITR with 7-day window plus daily snapshot to a different region. RPO 5 minutes, RTO 30 minutes for primary failover.

### 4.2 RabbitMQ: 3-node cluster with quorum queues

- Run a 3-node RabbitMQ cluster across AZs, behind a stable internal DNS name. Use **quorum queues** (Raft replicated) for the four pipeline queues and their DLQs. Quorum queues survive node loss without message loss and have clearer poison-message semantics than classic mirrored queues.
- Set `delivery-limit` on quorum queues so a poison message moves to the DLQ deterministically, instead of relying on consumer retry counting.
- Producers use **publisher confirms** with mandatory routing; failure to confirm raises an error to the caller (today this is best-effort).
- Consumer prefetch is sized per queue: `ingestion=2`, `transcript=4`, `audio=4`, `delivery=8`. Today it is uniform.
- A new Prometheus alert fires when any quorum queue has fewer than 2 in-sync replicas for more than 60 seconds.

### 4.3 Redis: split by purpose, run with Sentinel

- Today one Redis carries sessions, rate limits, idempotency keys, and WebSocket pub/sub. Split into two logical instances behind Sentinel:
  - `redis-state`: sessions, rate limits, idempotency keys. Persistence on (AOF every second). 3-node replica set.
  - `redis-fanout`: ephemeral WebSocket pub/sub only. Persistence off. 3-node replica set, Sentinel for failover.
- This isolates WebSocket fan-out from auth-critical state. A surge of WebSocket subscribers cannot evict a user's session.
- Long term, `redis-fanout` is a candidate to move to NATS JetStream or to Postgres `LISTEN/NOTIFY` if scale stays manageable; not in this spec.

### 4.4 MinIO → distributed mode (or managed S3)

- Production switches to managed S3-compatible object storage with cross-region replication on the `final-mp4` and `transcripts` prefixes, OR runs MinIO in **distributed mode** with at least 4 nodes and 4 drives each (erasure coded EC:2). Single-node MinIO is removed from the production Helm chart and remains only in `docker-compose.yml` for local dev.
- Object lifecycle policy:
  - `uploads/` (raw user video): delete after 7 days.
  - `segments/` (per-segment TTS audio): delete after 24 hours after job completion.
  - `final/` (delivered MP4): keep 90 days hot, then transition to infrequent-access tier; delete on user request.
  - `thumbnails/`: keep alongside `final/`.
- Server-side encryption with a per-tenant data key wrapped by KMS. Key rotation every 90 days.

### 4.5 Transactional outbox for `jobs` state changes

- The current crash window is: `UPDATE jobs SET stage = 'analyzing' ... ` commits, then process dies before publishing to `transcript.queue`. Job is stuck.
- Add a `job_events` outbox table. Every stage transition writes to `job_events` in the **same transaction** as the `jobs` update. A small **outbox relay** worker (one per service, not a separate deployment) reads unpublished `job_events` rows in commit order and publishes to RabbitMQ with publisher confirms, marking the row published on confirm.
- On worker restart, the relay replays unpublished events. Combined with consumer-side idempotency (which we already have keyed on `(job_id, stage_attempt_id)`), the pipeline becomes exactly-once at the business layer despite at-least-once delivery.
- This is the single most impactful correctness change in this spec. It is implemented before any of the HA storage changes ship to production.

### 4.6 API idempotency keys

- `POST /v1/uploads`, `POST /v1/jobs`, and `POST /v1/jobs/:id/segments/:segmentId/regenerate` accept an `Idempotency-Key` header. The key + user_id is recorded in `redis-state` with a 24-hour TTL and a hash of the response body. A repeat request with the same key returns the cached response. This is how we make client retry loops safe across our 5xx and across our own deploys.
- Existing endpoints continue to work without the header for backward compat; the SDK and web client are updated to always send one.

### 4.7 Backpressure and admission control

- API gateway gains a global token bucket (in `redis-state`) for `POST /v1/uploads` keyed on tenant tier. When `ingestion.queue` depth + analyzer in-flight exceeds a configured ceiling, the gateway returns `429` with `Retry-After` instead of accepting more work. This is what protects us during a marketing-driven traffic spike: we shed load at the edge before queue memory pressure can cascade.
- The `Retry-After` value is computed from current queue depth and historical mean stage latency (already in Prometheus).
- Inside each worker, the queue prefetch is the bound on memory; with the prefetch values from §4.2 a worker holds at most a known fixed number of payload references.

### 4.8 Provider failover for Gemini and TTS

- Gemini today has a `GEMINI_FALLBACK_MODEL` (Flash). Extend the analyzer's `gemini_client.py` so that on `429`, repeated `5xx`, or circuit-breaker-open, it routes the next call to the fallback model. Track per-model success rate; when primary recovers (success rate > 95% over 5 minutes), promote primary back. This is a per-call decision, not a global flag.
- TTS adds a provider chain: ElevenLabs → Polly → gTTS, ordered per voice (some voices only exist on one provider). On provider failure for a non-exclusive voice, automatic fallback. On voice mismatch, the segment is flagged and surfaced in the editor instead of silently swapping voices.
- Cost guardrail: a per-tenant 24-hour budget in dollars (TTS character count × provider rate). Exceeding the budget pauses TTS for that tenant and emits a `quota_exhausted` job event surfaced over WebSocket. Today there is no such ceiling.

### 4.9 Delivery service: at least 2 replicas, idempotent webhooks

- `delivery-service` Helm values change from `replicas: 1` to `replicas: 2` with a PDB requiring 1 always available.
- Webhook deliveries already retry up to 3 times with exponential backoff. Add **HMAC-SHA256 signature** of the payload using the per-webhook `secret` (already in schema), so subscribers can deduplicate retries. Today retries are silent.
- Webhook delivery records `last_delivery_at`, `last_status`, `consecutive_failures` on a new `webhook_deliveries` row per attempt. After 10 consecutive failures, the webhook auto-disables and the user is emailed. This is what stops a dead webhook from holding capacity forever.

### 4.10 Pre-signed URL TTL bumped + CDN edge

- Pre-signed URL TTL becomes 24 hours (configurable, default raised). Webhook payloads include both `download_url` and a stable `cdn_url` for the final MP4.
- A CDN sits in front of the final-MP4 prefix in object storage. The CDN serves cached MP4s by `cdn_url`; the pre-signed URL is fallback. Cache key includes the share token if present so revoked shares miss cache after `share_revoked_at`.

## 5. Design — Tier 2 (ship after Tier 1, before crossing 100k MAU)

### 5.1 Multi-AZ and cold-standby region

- All stateful components in §4 run across 3 AZs in the primary region.
- A second region (`dr-region`) holds:
  - Cross-region replicated object storage for `final/` and `transcripts/`.
  - Daily Postgres logical backup imported into a warm-but-not-active Postgres instance.
  - Helm chart deployed with `replicas: 0`.
- Failover runbook documented and **rehearsed quarterly**. RPO 1 hour, RTO 4 hours for full regional loss. This is explicit: regional failover is a deliberate human-driven operation in this phase, not automatic.

### 5.2 Capacity model and cost ceilings

A simple capacity model lives in `docs/capacity-model.md`. The inputs are MAU, average video minutes per user per month, and current per-stage processing time. Outputs are required worker replicas, expected Gemini token cost, expected TTS cost, and expected egress. The model is checked into source so capacity discussions reference the same numbers, and the Helm `maxReplicas` values come out of it instead of being guessed.

Initial check at 1M MAU, 5 min average video, 4 videos per active user per month: ~20M Gemini calls/month, ~3.3B TTS characters/month. Cost ceilings are set in the model and enforced by §4.8 per-tenant budgets and a global circuit-breaker that pages on-call when the daily Gemini spend crosses a configured threshold.

### 5.3 Job priority lanes

- Add `jobs.priority` consumers: free-tier and large-video jobs go to a `low-priority` mirror of each queue with its own (smaller) consumer pool. Paid tiers and short videos go to the standard lane.
- This protects the median experience during a free-tier spike.

### 5.4 Hot/cold transcript storage

- `transcript_segments.words_json` for finalized jobs older than 30 days is moved to object storage as a single JSON file per job; the column is set to `NULL` and an `archived_words_path` column points to the object key. The editor lazy-loads from object storage on demand.
- This drops the largest table by 80% or more at scale and keeps the primary database hot for active jobs.

### 5.5 Chaos and load testing as a continuous gate

- A weekly **gameday** in staging runs a chaos suite: kill a random Postgres replica, kill a RabbitMQ node, blackhole the Gemini endpoint for 2 minutes, fill `audio.queue` to 10x normal. Expectation: zero data loss, automatic recovery, alerts fire and clear.
- The existing k6 perf smoke graduates from a smoke to a sustained load profile (1k concurrent users for 30 min) gated on every release-candidate tag, not just on PR.

## 6. Out-of-scope improvements (parked, with rationale)

| Idea | Why parked |
|---|---|
| Migrate from RabbitMQ to Kafka or NATS JetStream | Quorum queues + outbox close the consistency gap. Migration cost is not justified until we observe sustained throughput RabbitMQ cannot serve. Revisit at 200k MAU. |
| Active-active multi-region | Adds replication-conflict surface for `jobs.stage`. Cold standby covers the durability and outage SLOs at our target scale. Revisit at 500k MAU or first regulated-tenant request. |
| GPU FFmpeg | Mux-service is not yet the bottleneck per Prometheus. Revisit only if mux P95 becomes the gating stage. |
| Move WebSocket to NATS / SSE | Redis pub/sub split (§4.3) buys us the headroom for this phase. |
| Kubernetes Operator for Recast | Premature; the Helm chart is sufficient and easier to reason about. |

## 7. Implementation phases

The order matters. Each phase ends with a go/no-go checkpoint based on staging gameday results.

**Phase A (weeks 1 to 3): correctness foundation.**
1. §4.5 transactional outbox (highest correctness leverage, prerequisite for the rest).
2. §4.6 API idempotency keys.
3. §4.9 delivery service replicas + signed webhooks + delivery log.

**Phase B (weeks 4 to 7): stateful HA.**
4. §4.1 Postgres HA + PgBouncer + read replica routing.
5. §4.2 RabbitMQ quorum cluster with publisher confirms.
6. §4.3 Redis split with Sentinel.
7. §4.4 distributed object storage + lifecycle policy + KMS.

**Phase C (weeks 8 to 10): edge and provider safety.**
8. §4.7 admission control and backpressure at API gateway.
9. §4.8 provider failover and per-tenant cost budgets.
10. §4.10 longer pre-signed URL TTL + CDN in front of `final/`.

**Phase D (weeks 11 to 14): platform hardening.**
11. §5.2 capacity model in source.
12. §5.1 cold-standby region + first failover rehearsal.
13. §5.3 priority lanes.
14. §5.4 transcript hot/cold storage.
15. §5.5 weekly chaos gameday.

Each phase ships behind a feature flag where possible and is gated on a staging gameday that exercises the new failure modes. No phase begins until the prior phase's gameday has passed.

## 8. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Outbox relay introduces duplicate publishes during deploy | Dedup is already keyed on `stage_attempt_id` consumer-side; enable in shadow mode for one week before flipping the publish path | Disable relay flag; old direct-publish path remains in code for two releases |
| Quorum queue migration loses messages | Drain classic queue first, deploy quorum queue under a new name, switch consumers, then producers; never run both | Switch producers back to classic queue name |
| PgBouncer transaction-pooling breaks session-scoped features (e.g., `LISTEN/NOTIFY`) | Audit usage now (we use neither in `pkg/database`); enforce in CI via SQL lint | Bypass pooler with a per-service "direct" DSN behind a feature flag |
| CDN caches a stale share-revoked MP4 | Cache key includes share token; revoke triggers a CDN purge by tag | Force cache bypass header for 1 hour |
| Provider failover masks a real Gemini regression | Per-model success metric is alerted independently; failover does not silence the primary's error rate | Pin to primary via env flag |
| Cost ceiling pauses a paying tenant unfairly | Budget is per tier with explicit overrides for known large tenants; manual override endpoint for support | Raise the ceiling and resume |

## 9. Open questions for review

1. Managed Postgres vendor choice: RDS Multi-AZ vs CloudNativePG operator in cluster. Affects ops model and cost; both meet the SLOs.
2. Object storage: stay on self-hosted distributed MinIO for cost predictability, or move to a managed S3-compatible provider for ops simplicity.
3. CDN choice and whether share-token signing happens at the CDN edge or stays at the API gateway.
4. Whether `redis-fanout` should preemptively move to NATS JetStream now to avoid a second migration in 12 months.
5. Are we comfortable with **regional failover as a manual operation** in this phase, or is automatic failover a hard requirement before 100k MAU?

---

*Spec authored 2026-04-29 for review. No implementation begins until reviewers sign off in a follow-up plan document.*
