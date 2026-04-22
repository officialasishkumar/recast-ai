-- 002_cleanup_pricing_and_frames.up.sql
-- Removes tier/quota/Stripe columns, removes frames_path from jobs,
-- adds share_token and thumbnail_path to jobs, drops pro_only from voices.
-- Every statement is guarded so reruns are safe.

ALTER TABLE users DROP COLUMN IF EXISTS minutes_used;
ALTER TABLE users DROP COLUMN IF EXISTS minutes_quota;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE voices DROP COLUMN IF EXISTS pro_only;

ALTER TABLE jobs DROP COLUMN IF EXISTS frames_path;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS thumbnail_path TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_share_token ON jobs(share_token);

-- Normalize any legacy role values to the new single 'user' role.
-- 'admin' is preserved.
UPDATE users SET role = 'user' WHERE role IN ('free', 'pro');

-- Voice seed rows already exist from 001; dropping pro_only above is sufficient.
-- Re-assert the canonical set idempotently in case voices were never seeded.
INSERT INTO voices (id, name, gender, accent, provider) VALUES
    ('alloy',    'Alloy',    'neutral',    'american',   'elevenlabs'),
    ('echo',     'Echo',     'male',       'american',   'elevenlabs'),
    ('fable',    'Fable',    'female',     'british',    'elevenlabs'),
    ('onyx',     'Onyx',     'male',       'american',   'elevenlabs'),
    ('nova',     'Nova',     'female',     'american',   'elevenlabs'),
    ('shimmer',  'Shimmer',  'female',     'american',   'elevenlabs'),
    ('river',    'River',    'neutral',    'american',   'elevenlabs'),
    ('sage',     'Sage',     'male',       'british',    'elevenlabs'),
    ('aria',     'Aria',     'female',     'american',   'elevenlabs'),
    ('james',    'James',    'male',       'british',    'elevenlabs'),
    ('luna',     'Luna',     'female',     'australian', 'elevenlabs'),
    ('atlas',    'Atlas',    'male',       'american',   'elevenlabs'),
    ('coral',    'Coral',    'female',     'american',   'polly'),
    ('kai',      'Kai',      'male',       'american',   'polly'),
    ('zara',     'Zara',     'female',     'british',    'polly'),
    ('felix',    'Felix',    'male',       'australian', 'polly')
ON CONFLICT (id) DO NOTHING;
