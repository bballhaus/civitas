CREATE TABLE "pending_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"verification_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_users_username_unique" UNIQUE("username"),
	CONSTRAINT "pending_users_email_unique" UNIQUE("email"),
	CONSTRAINT "pending_users_verification_token_unique" UNIQUE("verification_token")
);
--> statement-breakpoint
CREATE INDEX "idx_pending_users_token" ON "pending_users" USING btree ("verification_token");