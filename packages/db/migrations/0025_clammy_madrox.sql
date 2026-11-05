CREATE TABLE IF NOT EXISTS "tender_results" (
	"tender_id" uuid PRIMARY KEY NOT NULL,
	"evaluation_status" text DEFAULT 'not_evaluated' NOT NULL,
	"bidders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "ingestion_runs_one_running_uq";--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "kind" text DEFAULT 'listing' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tender_results" ADD CONSTRAINT "tender_results_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_runs_one_running_uq" ON "ingestion_runs" USING btree ("kind") WHERE status = 'running';