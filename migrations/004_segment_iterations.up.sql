-- Quality-iteration metadata for transcript segments.
--
-- The TTS service runs an FFmpeg-based quality gate on every synthesized
-- segment. Failed segments are sent back to Gemini (text-only) for a
-- rewrite, then re-synthesized and re-scored. Up to MAX_ITERATIONS
-- attempts are made; the best-scoring attempt wins.
--
-- These columns capture what happened so support and analytics can ask
-- "which segments needed rewrites, why, and did the loop converge?"
-- without spelunking through logs.

ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS iteration_count       INT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quality_score         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS quality_diagnosis     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS rewrite_history       JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Used by the editor UI to surface segments that needed manual review
-- because the loop never converged below the failure threshold.
CREATE INDEX IF NOT EXISTS idx_segments_low_quality
    ON transcript_segments (job_id)
    WHERE quality_score IS NOT NULL AND quality_score < 0.7;
