ALTER TABLE "analyses" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tender_documents" ADD COLUMN "text_source" text DEFAULT 'pdf' NOT NULL;