DROP INDEX IF EXISTS idx_segments_low_quality;

ALTER TABLE transcript_segments
    DROP COLUMN IF EXISTS rewrite_history,
    DROP COLUMN IF EXISTS quality_diagnosis,
    DROP COLUMN IF EXISTS quality_score,
    DROP COLUMN IF EXISTS iteration_count;
