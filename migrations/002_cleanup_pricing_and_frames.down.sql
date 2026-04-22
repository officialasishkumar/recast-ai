-- 002_cleanup_pricing_and_frames.down.sql
-- Reverses 002_cleanup_pricing_and_frames.up.sql.
-- Restores dropped columns with their original types/defaults and
-- removes columns/indexes that were added.

-- Restore users pricing/quota/Stripe columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS minutes_used INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS minutes_quota INT NOT NULL DEFAULT 30;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);

-- Restore voices.pro_only column.
ALTER TABLE voices ADD COLUMN IF NOT EXISTS pro_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Restore jobs.frames_path and drop the added columns/index.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS frames_path TEXT;

DROP INDEX IF EXISTS idx_jobs_share_token;

ALTER TABLE jobs DROP COLUMN IF EXISTS share_token;
ALTER TABLE jobs DROP COLUMN IF EXISTS thumbnail_path;

-- Best-effort role rollback: any rows normalized to 'user' become 'free'.
-- 'admin' rows are preserved.
UPDATE users SET role = 'free' WHERE role = 'user';
