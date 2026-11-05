CREATE TABLE IF NOT EXISTS "gem_result_hints" (
	"gem_bid_id" text PRIMARY KEY NOT NULL,
	"hint" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
