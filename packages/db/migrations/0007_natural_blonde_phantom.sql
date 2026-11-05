ALTER TABLE "api_tokens" ADD COLUMN "token_hint" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_org_user_idx" ON "api_tokens" USING btree ("org_id","user_id");