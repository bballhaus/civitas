CREATE TABLE "agency_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agency_canonical" text NOT NULL,
	"agency_display" text NOT NULL,
	"role" text NOT NULL,
	"contract_count" integer DEFAULT 1 NOT NULL,
	"last_contract_at" date,
	"strength" smallint DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agency_relationships_user_agency_role" UNIQUE("user_id","agency_canonical","role")
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"value" text NOT NULL,
	"canonical_id" text,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_capabilities_user_value" UNIQUE("user_id","value")
);
--> statement-breakpoint
CREATE TABLE "certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"canonical_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_certifications_user_canonical" UNIQUE("user_id","canonical_id")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contract_id" uuid,
	"field_path" text NOT NULL,
	"value" text NOT NULL,
	"snippet" text,
	"confidence" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"contract_status" text,
	"s3_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"title" text,
	"issuing_agency" text,
	"contract_value_usd" bigint,
	"duration_text" text,
	"role" text,
	"award_date" date,
	"start_date" date,
	"end_date" date,
	"raw_extraction" jsonb,
	"extracted_by_model" text,
	"extracted_at" timestamp with time zone,
	"extracted_text" text,
	"text_truncated" boolean DEFAULT false NOT NULL,
	"pii_redacted_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rfp_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"license_class" text NOT NULL,
	"license_number" text,
	"expires_on" date,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rfp_id" text NOT NULL,
	"status" text,
	"match_score" real,
	"match_tier" text,
	"win_probability" real,
	"incumbent_state" text,
	"feedback_rating" text,
	"feedback_reason" text,
	"feedback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_match_state_user_rfp" UNIQUE("user_id","rfp_id")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"company_name" text,
	"year_founded" integer,
	"employee_band" text,
	"website" text,
	"scope_min_usd" bigint,
	"scope_max_usd" bigint,
	"duration_pref" text,
	"complexity_pref" text,
	"prime_vs_sub" text,
	"gov_experience" text,
	"vendor_fingerprint" text,
	"vendor_resolved_at" timestamp with time zone,
	"completeness_score" real DEFAULT 0,
	"onboarded_at" timestamp with time zone,
	"embedding_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_bidders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfp_id" text NOT NULL,
	"vendor_fingerprint" text,
	"vendor_name" text NOT NULL,
	"role" text NOT NULL,
	"bid_amount_cents" bigint,
	"responsive" boolean,
	"classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"agency" text,
	"location" text,
	"deadline" timestamp with time zone,
	"estimated_value_usd" bigint,
	"capabilities" text[],
	"naics_codes" text[],
	"certifications_required" text[],
	"licenses_required" text[],
	"set_aside_lockout" text[],
	"deliverables" text[],
	"requires_past_gov_exp" boolean,
	"incumbent_vendor" text,
	"incumbent_contract_end" date,
	"prospective_bidder_count" integer,
	"bid_count" integer,
	"bid_amounts_cents" bigint[],
	"winning_bid_cents" bigint,
	"winning_vendor_fingerprint" text,
	"embedding" vector(1024),
	"raw" jsonb,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"value" text NOT NULL,
	"canonical_id" text,
	"weight" text DEFAULT 'primary' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_specialties_user_value" UNIQUE("user_id","value")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text,
	"city" text,
	"certifications" text[],
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"bid_count" integer DEFAULT 0,
	"win_count" integer DEFAULT 0,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"is_hard" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_work_areas_user_kind_name" UNIQUE("user_id","kind","name")
);
--> statement-breakpoint
ALTER TABLE "agency_relationships" ADD CONSTRAINT "agency_relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_state" ADD CONSTRAINT "match_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_bidders" ADD CONSTRAINT "rfp_bidders_rfp_id_rfp_cache_id_fk" FOREIGN KEY ("rfp_id") REFERENCES "public"."rfp_cache"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_areas" ADD CONSTRAINT "work_areas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agency_relationships_user" ON "agency_relationships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_capabilities_user" ON "capabilities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_capabilities_embedding" ON "capabilities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_certifications_user_kind" ON "certifications" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_claims_user_status" ON "claims" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_claims_contract" ON "claims" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "idx_contracts_user" ON "contracts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_generated_user_rfp" ON "generated_documents" USING btree ("user_id","rfp_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_user" ON "licenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_match_state_user_status" ON "match_state" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_profiles_vendor_fingerprint" ON "profiles" USING btree ("vendor_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_rfp_bidders_rfp" ON "rfp_bidders" USING btree ("rfp_id");--> statement-breakpoint
CREATE INDEX "idx_rfp_bidders_fingerprint" ON "rfp_bidders" USING btree ("vendor_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_rfp_cache_embedding" ON "rfp_cache" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_rfp_cache_deadline" ON "rfp_cache" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "idx_rfp_cache_agency" ON "rfp_cache" USING btree ("agency");--> statement-breakpoint
CREATE INDEX "idx_rfp_cache_source" ON "rfp_cache" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_rfp_cache_winning_vendor" ON "rfp_cache" USING btree ("winning_vendor_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_specialties_user" ON "specialties" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_specialties_embedding" ON "specialties" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_work_areas_user" ON "work_areas" USING btree ("user_id");