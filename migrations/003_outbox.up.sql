-- Transactional outbox.
--
-- Stage transitions and queue publishes must be atomic. Without this table,
-- a crash between `UPDATE jobs SET stage = ...` committing and the AMQP
-- basicPublish that follows leaves a job stuck. Producers now write to
-- job_events in the same transaction as the jobs row update; an outbox relay
-- worker reads unpublished rows in commit order, publishes to RabbitMQ with
-- publisher confirms, and marks the row published only after a broker ack.
--
-- Combined with the existing consumer-side idempotency keyed on
-- (job_id, stage_attempt_id), this gives effectively-once business semantics
-- on top of at-least-once AMQP delivery.

CREATE TABLE IF NOT EXISTS job_events (
    id              BIGSERIAL PRIMARY KEY,
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    stage_attempt_id UUID NOT NULL,
    queue_name      VARCHAR(64) NOT NULL,
    payload         JSONB NOT NULL,
    trace_id        VARCHAR(64) NOT NULL DEFAULT '',
    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ,
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT
);

-- The relay polls for unpublished rows in commit order. The partial index
-- keeps that scan tight even when the table grows.
CREATE INDEX IF NOT EXISTS idx_job_events_unpublished
    ON job_events (id)
    WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_events_job_id
    ON job_events (job_id);
