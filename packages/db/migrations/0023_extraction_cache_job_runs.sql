CREATE TABLE IF NOT EXISTS "job_runs" (
	"job" text NOT NULL,
	"day" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	CONSTRAINT "job_runs_job_day_pk" PRIMARY KEY("job","day")
);
--> statement-breakpoint
ALTER TABLE "tender_documents" ADD COLUMN "requirements" jsonb;--> statement-breakpoint
ALTER TABLE "tender_documents" ADD COLUMN "extractor_version" text;--> statement-breakpoint
ALTER TABLE "tender_documents" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tender_documents" ADD COLUMN "extracted_method" text;