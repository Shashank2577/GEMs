ALTER TABLE "api_tokens" ADD COLUMN "token_hint" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;