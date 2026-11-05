-- tp:non-transactional
-- 008/FR-027, FR-029: partial indexes for the open-tender feed, latest-analysis lookups and the alert dispatcher.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, so packages/db/src/migrate.ts runs this file statement by
-- statement outside one (first-line marker). Every statement must be idempotent (IF NOT EXISTS): if one fails, the file
-- is re-run from the top. A failed CONCURRENTLY build leaves an INVALID index — drop it before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "analyses_org_tender_created_idx" ON "analyses" USING btree ("org_id","tender_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_pending_idx" ON "notifications" USING btree ("created_at") WHERE status = 'pending' AND channel IN ('email','whatsapp');--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_created_idx" ON "tenders" USING btree ("created_at" DESC NULLS FIRST) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_end_idx" ON "tenders" USING btree ("end_at") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_value_idx" ON "tenders" USING btree ("estimated_value" DESC NULLS LAST) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_state_idx" ON "tenders" USING btree ("state") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_ministry_idx" ON "tenders" USING btree ("ministry") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tenders_open_category_idx" ON "tenders" USING btree ("category") WHERE status = 'open';
