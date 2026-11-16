-- 0006 — FMS: status-option jumps.
-- A step's status option can end a branch early, like the sheets' "Close": choosing it skips the
-- following steps up to a target step, e.g. {"Close": 5} on STEP-1 → STEP-2..4 skipped, STEP-5 next.
ALTER TABLE fms_steps ADD COLUMN jumps TEXT NOT NULL DEFAULT '{}';
