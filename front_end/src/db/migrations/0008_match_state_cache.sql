ALTER TABLE "match_state" ADD COLUMN "cached_score" real;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "cached_tier" text;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "cached_win_probability" real;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "cached_incumbent_state" text;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "match_data" jsonb;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "match_scores_pending_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_match_state_user_cached_score" ON "match_state" USING btree ("user_id","cached_score");