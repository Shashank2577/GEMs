CREATE TABLE IF NOT EXISTS "gem_result_hints" (
	"gem_bid_id" text PRIMARY KEY NOT NULL,
	"hint" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_workspaces_org_stage_idx" ON "bid_workspaces" USING btree ("org_id","stage");