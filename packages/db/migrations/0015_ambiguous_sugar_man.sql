-- Dedupe any pre-existing duplicate overrides (keep the most recently updated row per (org_id, key)) so the unique index can be built.
DELETE FROM "annexure_templates" a USING "annexure_templates" b
  WHERE a."org_id" IS NOT NULL AND a."org_id" = b."org_id" AND a."key" = b."key"
    AND (a."updated_at", a."id") < (b."updated_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annexure_templates_org_key_uq" ON "annexure_templates" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_ws_idx" ON "comments" USING btree ("workspace_id");