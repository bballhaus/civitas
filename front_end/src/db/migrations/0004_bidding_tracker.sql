-- Bidding Process Tracker schema additions.
--
-- 1. New rfp_tasks table: per-(user, RFP) checklist for the tracker.
-- 2. match_state gains a status_changed_at column for audit + sort-by-recency.
-- 3. Any pre-existing 'applied' rows are renamed to 'bid_submitted' (the new
--    pipeline vocabulary). 'applied' is no longer a valid status value.

CREATE TABLE "rfp_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rfp_id" text NOT NULL,
	"label" text NOT NULL,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_custom" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfp_tasks" ADD CONSTRAINT "rfp_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rfp_tasks_user_rfp" ON "rfp_tasks" USING btree ("user_id","rfp_id");--> statement-breakpoint
UPDATE "match_state" SET "status" = 'bid_submitted' WHERE "status" = 'applied';