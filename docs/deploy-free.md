# Going Live On A $0 Budget (No Credit Card)

This guide stitches together free-tier services that do not ask for a card to
get the entire Recast AI stack running on the public internet. Everything
listed below works with just an email signup as of April 2026; we have
checked each one. Free tiers change, so re-check the provider page before
you depend on it.

There are tradeoffs. Free tiers have small storage, low rate limits, and
some platforms sleep idle services. This setup is suitable for a personal
demo, a portfolio piece, or a small private beta with friends. It is **not**
suitable for production traffic; once you have real users, the spec under
`docs/superpowers/specs/2026-04-29-reliability-at-millions-design.md`
covers the upgrade path.

---

## 1. Pick the providers

| Layer | Provider | Free terms (no card) | Notes |
|---|---|---|---|
| Frontend hosting | **Vercel** | Hobby plan; 100 GB bandwidth/mo | Native Next.js 16 deploys, deploy from GitHub on push |
| Backend services | **Render** OR **Koyeb** | Render: 750 hours/mo on free web services (sleep after 15 min idle); Koyeb: 1 service + 1 worker on the eco plan | Render is simpler; Koyeb does not sleep but has a tighter resource ceiling |
| PostgreSQL | **Supabase** | 500 MB DB, 2 GB egress/mo | Includes Postgres + auth + realtime; we only use the Postgres part |
| PostgreSQL alternative | **Neon** | 512 MB storage, branching | Faster cold starts than Supabase, no auth bundled |
| Redis | **Upstash** | 256 MB, 10k commands/day | Serverless Redis with REST and TCP |
| RabbitMQ | **CloudAMQP "Little Lemur"** | 1M messages/mo, 100 queues, 20 connections | The only credible free RabbitMQ host left |
| Object storage | **Backblaze B2** | 10 GB storage, 1 GB/day egress | S3-compatible, generous outbound, no card |
| LLM | **Google AI Studio** | Gemini 2.5 Flash free tier (15 RPM, 1500 RPD) | Use Flash, not Pro, on the free tier |
| TTS (default) | **gTTS** (in-process) | Unlimited within app | Bundled in the repo; no signup |
| TTS (premium) | **ElevenLabs** | 10 000 characters/mo | Optional; only set ELEVENLABS_API_KEY when you have one |
| Email/SMTP | **Resend** | 3000 emails/mo | Only needed when you wire transactional email |
| Domain | Free subdomain on Vercel (`*.vercel.app`) and Render (`*.onrender.com`) | Or your own domain pointed via DNS | |

A note on Fly.io, Railway, Cloudflare R2, and AWS: they all require a credit
card on signup as of this writing, even for "free" plans. They are excluded.

---

## 2. Provision the stateful pieces first

Order matters here: spin these up before the application services because
the app reads their connection strings on startup.

### Postgres on Supabase

1. Create a project at <https://supabase.com>. Pick the closest region to
   where Render or Koyeb will run.
2. Go to *Project Settings -> Database* and copy the connection string of
   the form `postgres://postgres:<password>@<host>:6543/postgres`. The
   `6543` port is the **transaction-mode pooler** (PgBouncer); use that
   one, not `5432`, so you do not exhaust the small free-tier connection
   cap.
3. Open the SQL editor and run, in order, every file under `migrations/`
   ending in `.up.sql`. Recast AI does not bundle a migration runner
   yet, so this is a one-time manual step. Drop down to a paid tier or
   `psql` if you want to script it.

### Redis on Upstash

1. Create a database at <https://upstash.com>. Eviction: `noeviction`.
   TLS: enabled.
2. Copy the **TCP endpoint**, port, and password. The `redis-cli` URL
   format will look like `rediss://default:<password>@<host>:6379`.
3. Recast AI uses Redis for sessions, rate limits, idempotency keys, and
   WebSocket fan-out. The free tier of 10k commands/day is tight; expect
   rate-limit middleware to push you to the limit if you stress test.

### RabbitMQ on CloudAMQP

1. Create a Little Lemur instance at <https://www.cloudamqp.com>.
2. From the *Details* tab, copy the AMQP URL of the form
   `amqp://<user>:<pass>@<host>/<vhost>`.
3. The four pipeline queues (`ingestion`, `transcript`, `audio`,
   `delivery`) and their DLQs will be auto-declared on first publish.

### Object storage on Backblaze B2

1. Sign up at <https://www.backblaze.com/sign-up/cloud-storage>. No card.
2. Create an *application key* with read/write access to a single bucket
   (do not use the master key).
3. Create the bucket; pick the same region your backend runs in for the
   cheapest egress. Make it **private**; we mint pre-signed URLs from
   the app.
4. The S3 endpoint format is `https://s3.<region>.backblazeb2.com`. Set
   the env vars:
   - `S3_ENDPOINT=s3.us-west-004.backblazeb2.com` (no scheme)
   - `S3_ACCESS_KEY=<keyID>`
   - `S3_SECRET_KEY=<applicationKey>`
   - `S3_BUCKET=<your-bucket-name>`

### Gemini API key

1. Create an API key at <https://aistudio.google.com/apikey>. No billing
   setup is required for the free tier.
2. Set in the backend env:
   - `GEMINI_API_KEY=<the-key>`
   - `GEMINI_MODEL=gemini-2.5-flash` (Flash, not Pro, on the free tier)
   - `GEMINI_FALLBACK_MODEL=gemini-2.5-flash` (no fallback available)

---

## 3. Deploy the backend services

Recast AI ships seven services. On the free tier we collapse them onto
Render with one *Web Service* per Dockerfile. The Helm chart under
`deploy/helm` is for Kubernetes; ignore it on Render.

### Render setup (recommended for first time)

1. Create a Render account at <https://render.com>. No card needed for
   the free plan.
2. Click *New -> Blueprint* and point it at your forked GitHub repo. The
   repo includes a `render.yaml` already.
3. Render will provision each Web Service from `docker/<service>.Dockerfile`.
4. For each service, open *Environment* and add the keys from the
   provisioning steps above. Bulk-paste from a `.env` file is supported.
5. Wait for the first build. Free Web Services sleep after 15 minutes of
   inactivity; the **first request after a sleep takes ~30 seconds** as
   the container cold-starts. The Cron Job feature can ping `/health`
   every 10 minutes to keep them warm if you want.

### Koyeb alternative (no sleep, tighter ceiling)

If the cold starts on Render are unacceptable, Koyeb (https://koyeb.com)
gives you one free always-on web service plus one worker. Pick *one*
service to host on Koyeb (api-gateway is the obvious choice) and keep
the rest on Render.

### Service-specific notes

- **upload-service**: handles multipart uploads up to 2 GB. The free
  Render plan has a 100 MB request body limit; either ship smaller
  videos or move uploads directly to B2 with a presigned `PUT`.
- **video-analyzer** and **tts-service**: Python services. Memory is
  tight on free tiers; in `services/<svc>/config.py` lower
  `_SEMAPHORE`-style concurrency caps if you see OOM kills.
- **mux-service**: needs FFmpeg. The Dockerfile already installs it.
- **delivery-service**: now defaults to 2 replicas in Helm but on Render
  one is fine; keep the PDB-driven settings irrelevant here.

### Required env vars (backend)

```
JWT_SECRET=<generate-a-random-32-byte-string>

DATABASE_URL=postgres://postgres:<pw>@<supabase-host>:6543/postgres?sslmode=require

REDIS_HOST=<upstash-host>
REDIS_PORT=6379
REDIS_PASSWORD=<upstash-password>
REDIS_TLS=true

RABBITMQ_URL=amqp://<user>:<pw>@<cloudamqp-host>/<vhost>

S3_ENDPOINT=s3.us-west-004.backblazeb2.com
S3_BUCKET=<bucket>
S3_ACCESS_KEY=<keyID>
S3_SECRET_KEY=<applicationKey>

GEMINI_API_KEY=<aistudio-key>
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_MODEL=gemini-2.5-flash

TTS_PROVIDER=gtts

# Reliability switches added in the latest commits
RABBITMQ_QUEUE_TYPE=classic       # quorum requires a clustered broker
ADMISSION_MAX_QUEUE_DEPTH=200     # tight for the free tier
QUALITY_ITERATION_ENABLED=true
QUALITY_MAX_ITERATIONS=2          # keep within Gemini RPM limits
```

---

## 4. Deploy the frontend

1. Create a Vercel account at <https://vercel.com> via GitHub login.
2. *Add New -> Project* and pick the same repo. Set the *Root Directory*
   to `web/`.
3. Vercel auto-detects Next.js 16. Set the production env vars:
   ```
   NEXT_PUBLIC_API_URL=https://<your-api-gateway>.onrender.com/v1
   NEXT_PUBLIC_WS_URL=wss://<your-api-gateway>.onrender.com/v1
   ```
4. Deploy. Future pushes to `main` trigger a new deploy automatically.

The Hobby plan caps you at 100 GB egress per month; for a demo that is
plenty.

---

## 5. Smoke test

After both stacks are up:

1. Visit the Vercel URL.
2. Register an account. Email verification is disabled by default; you
   can sign in immediately.
3. Upload a short MP4 (under 50 MB to stay inside Render's request
   limit) and watch the pipeline progress.
4. The first time, the Render free service will cold-start; expect the
   first stage to take ~30 seconds longer than later runs.
5. Open the job page and confirm the *AI-refined* badge in the header
   shows up on segments where the FFmpeg gate triggered a Gemini
   rewrite.

---

## 6. What breaks first as you scale

In rough order:

1. **Upstash 10k commands/day.** Rate limiting alone burns through this.
   Disable RateLimiter in dev or move to a paid Redis tier.
2. **Gemini free RPM cap.** Fifteen requests/minute is enough for one
   active user, not many. Pre-cache transcripts by job_id; consider
   batching.
3. **Render cold starts.** The first request after sleep is slow enough
   to time out the upload UI. Either keep-alive ping or upgrade.
4. **Backblaze 1 GB/day egress.** Each video download counts; CDN in
   front (Cloudflare free) buys you cache hits.
5. **CloudAMQP 1M msg/mo.** Each completed job costs ~10 messages
   (uploads, three pipeline queues, two delivery webhooks). 100k jobs
   per month is the soft ceiling.

If you hit any of these, the Tier 1 reliability spec is the migration
plan: managed Postgres with a pooler, Redis split, distributed object
storage, and provider failover are the same shape regardless of which
free tier you came from.
