# Migrations

This directory holds plain SQL migration files. The project does not use a
migration tool (e.g. `golang-migrate`, `sqlx-migrate`, `atlas`); files are
applied in numeric order with `psql` directly.

## Layout

Each migration is a pair of files:

```
NNN_<name>.up.sql     # forward migration
NNN_<name>.down.sql   # inverse migration
```

All statements are written to be idempotent (`IF EXISTS` / `IF NOT EXISTS`
/ `ON CONFLICT DO NOTHING`) so reruns are safe.

## Applying

Apply migrations in order against the target database. The `DATABASE_URL`
follows the standard `postgresql://user:pass@host:port/dbname` form.

### Fresh install

```bash
psql "$DATABASE_URL" < migrations/001_init.up.sql
psql "$DATABASE_URL" < migrations/002_cleanup_pricing_and_frames.up.sql
```

Or chained:

```bash
psql "$DATABASE_URL" < migrations/001_init.up.sql \
  && psql "$DATABASE_URL" < migrations/002_cleanup_pricing_and_frames.up.sql
```

### Upgrading an existing prod database

`001_init.up.sql` is already applied. Apply only the new migration:

```bash
psql "$DATABASE_URL" < migrations/002_cleanup_pricing_and_frames.up.sql
```

### Rolling back

Apply the matching `.down.sql` file for the migration you want to reverse,
most recent first:

```bash
psql "$DATABASE_URL" < migrations/002_cleanup_pricing_and_frames.down.sql
```

## Migration log

| File | Purpose |
| --- | --- |
| `001_init.up.sql` | Initial schema: users, jobs, transcript_segments, voices, webhooks, refresh_tokens. |
| `002_cleanup_pricing_and_frames.up.sql` | Drop tier/quota/Stripe columns, drop `pro_only` from voices, drop `frames_path` from jobs, add `share_token` (unique) and `thumbnail_path` to jobs, index `share_token`, normalize legacy `role` values (`free`/`pro` become `user`). |

## Conventions

- Every destructive change is paired with a non-destructive `down.sql` that
  restores the prior column types and defaults.
- No migration edits an older migration file. Once committed, past
  migrations are immutable.
- Seed data lives inside the migration that introduces the table it
  targets, guarded by `ON CONFLICT DO NOTHING` so reruns do not fail.
