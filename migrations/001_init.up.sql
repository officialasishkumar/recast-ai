-- Users table
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255),
    name            VARCHAR(255) NOT NULL DEFAULT '',
    role            VARCHAR(20)  NOT NULL DEFAULT 'free',
    oauth_provider  VARCHAR(50),
    oauth_id        VARCHAR(255),
    avatar_url      TEXT,
    minutes_used    INT NOT NULL DEFAULT 0,
    minutes_quota   INT NOT NULL DEFAULT 30,
    stripe_customer_id VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_oauth ON users(oauth_provider, oauth_id);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage           VARCHAR(30)  NOT NULL DEFAULT 'uploaded',
    original_file   TEXT NOT NULL,
    original_name   VARCHAR(512) NOT NULL DEFAULT '',
    duration_ms     BIGINT NOT NULL DEFAULT 0,
    voice_id        VARCHAR(100) NOT NULL DEFAULT 'default',
    style           VARCHAR(20)  NOT NULL DEFAULT 'formal',
    language        VARCHAR(10)  NOT NULL DEFAULT 'en',
    priority        INT NOT NULL DEFAULT 0,
    frames_path     TEXT,
    audio_path      TEXT,
    output_file     TEXT,
    download_url    TEXT,
    error_message   TEXT,
    trace_id        VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_stage ON jobs(stage);
CREATE INDEX idx_jobs_trace_id ON jobs(trace_id);

-- Transcript segments
CREATE TABLE IF NOT EXISTS transcript_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    segment_idx     INT NOT NULL,
    start_ms        BIGINT NOT NULL,
    end_ms          BIGINT NOT NULL,
    text            TEXT NOT NULL,
    words_json      JSONB NOT NULL DEFAULT '[]',
    confidence      DOUBLE PRECISION NOT NULL DEFAULT 0,
    audio_path      TEXT NOT NULL DEFAULT '',
    approved        BOOLEAN NOT NULL DEFAULT FALSE,
    flagged         BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(job_id, segment_idx)
);

CREATE INDEX idx_segments_job_id ON transcript_segments(job_id);

-- Voices
CREATE TABLE IF NOT EXISTS voices (
    id          VARCHAR(100) PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    gender      VARCHAR(20)  NOT NULL,
    accent      VARCHAR(50)  NOT NULL DEFAULT 'neutral',
    provider    VARCHAR(50)  NOT NULL,
    pro_only    BOOLEAN NOT NULL DEFAULT FALSE,
    sample_url  TEXT NOT NULL DEFAULT ''
);

-- Seed standard voices
INSERT INTO voices (id, name, gender, accent, provider, pro_only) VALUES
    ('alloy',    'Alloy',    'neutral', 'american', 'elevenlabs', false),
    ('echo',     'Echo',     'male',    'american', 'elevenlabs', false),
    ('fable',    'Fable',    'female',  'british',  'elevenlabs', false),
    ('onyx',     'Onyx',     'male',    'american', 'elevenlabs', false),
    ('nova',     'Nova',     'female',  'american', 'elevenlabs', false),
    ('shimmer',  'Shimmer',  'female',  'american', 'elevenlabs', false),
    ('river',    'River',    'neutral', 'american', 'elevenlabs', false),
    ('sage',     'Sage',     'male',    'british',  'elevenlabs', false),
    ('aria',     'Aria',     'female',  'american', 'elevenlabs', true),
    ('james',    'James',    'male',    'british',  'elevenlabs', true),
    ('luna',     'Luna',     'female',  'australian','elevenlabs', true),
    ('atlas',    'Atlas',    'male',    'american', 'elevenlabs', true),
    ('coral',    'Coral',    'female',  'american', 'polly',      true),
    ('kai',      'Kai',      'male',    'american', 'polly',      true),
    ('zara',     'Zara',     'female',  'british',  'polly',      true),
    ('felix',    'Felix',    'male',    'australian','polly',      true)
ON CONFLICT DO NOTHING;

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    secret      VARCHAR(255) NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_user_id ON webhooks(user_id);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
