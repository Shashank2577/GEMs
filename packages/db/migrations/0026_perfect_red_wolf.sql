ALTER TABLE "tender_results" ALTER COLUMN "checked_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tender_results" ALTER COLUMN "checked_at" DROP NOT NULL;