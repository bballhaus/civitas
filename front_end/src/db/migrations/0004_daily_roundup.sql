-- Daily roundup email opt-in (notifications branch).
-- Stores per-user enablement + IANA timezone (captured from the browser at
-- opt-in) + last-sent dedupe timestamp. Hour-of-day is hard-coded at 7am
-- local in the cron handler — no column for it.
ALTER TABLE "profiles" ADD COLUMN "daily_roundup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "daily_roundup_timezone" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "daily_roundup_last_sent_at" timestamp with time zone;--> statement-breakpoint

-- First-view timestamp per (user, RFP). Set once on RFP detail load and
-- never cleared. The roundup digest filters to rows where viewed_at IS NULL.
ALTER TABLE "match_state" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_match_state_user_viewed" ON "match_state" USING btree ("user_id","viewed_at");
