-- Structured RFP dates extracted from attachment PDFs.
-- Each column is nullable: source document may not state the date.
-- key_dates_sources is a per-date jsonb {value, snippet} for explainability.
--
-- IF NOT EXISTS makes this safe to re-apply in environments where the
-- columns already landed via an earlier numbering of this migration.

ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "qa_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "qa_response_date" date;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "prebid_meeting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "site_visit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "award_date" date;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "contract_start" date;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "contract_end" date;--> statement-breakpoint
ALTER TABLE "rfp_cache" ADD COLUMN IF NOT EXISTS "key_dates_sources" jsonb;
