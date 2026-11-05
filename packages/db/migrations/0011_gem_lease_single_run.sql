-- 008/US4: cluster-wide GeM lease (FR-024) and a single running ingestion (FR-025); analysis warnings (FR-031).
CREATE TABLE IF NOT EXISTS "gem_throttle" (
	"id" text PRIMARY KEY NOT NULL,
	"next_slot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "gem_throttle" ("id", "next_slot_at") VALUES ('gem', now()) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Reap duplicates first so the unique index can build: keep the newest running run, fail the others.
UPDATE "ingestion_runs" SET "status" = 'failed', "error" = 'Superseded (duplicate running run reaped by migration)', "finished_at" = now()
WHERE "status" = 'running' AND "id" NOT IN (
	SELECT "id" FROM "ingestion_runs" WHERE "status" = 'running' ORDER BY "started_at" DESC LIMIT 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_one_running_uq" ON "ingestion_runs" USING btree ((true)) WHERE status = 'running';
