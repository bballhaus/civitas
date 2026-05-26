-- Tracks whether a row's Haiku NAICS tagging has been audited by the
-- Sonnet critique step. NULL means "not yet critiqued"; a timestamp means
-- "audited at this moment, with any corrections already applied".
--
-- Used by /api/cron/critique-rfp-tags to pick up only un-audited rows
-- (so the daily cron doesn't re-run Sonnet over the entire catalog), and
-- by analytics queries that want to gauge audit coverage.
--
-- IF NOT EXISTS keeps this safe to re-apply.

ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "naics_critiqued_at" timestamp with time zone;
