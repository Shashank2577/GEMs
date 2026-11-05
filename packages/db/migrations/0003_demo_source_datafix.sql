-- 008/FR-016 data fix (data only, no DDL; idempotent). Demo tenders used to be stored as source = 'gem', so they
-- showed up in every org's feed and matched other orgs' watchlists. From now on packages/db/src/demo.ts writes
-- source = 'demo'. This converts the rows seeded before that change and removes what they leaked to orgs that
-- never loaded the demo (onboarding_state.demo is not true).
--
-- 1. Demo rows are recognised by the marker the seeder always wrote (raw.demo = true) or its content hash
--    ('demo-' || bid_number). The bid number alone is not used: a real GeM bid could share it.
UPDATE "tenders" AS t SET "source" = 'demo'
WHERE t."source" = 'gem'
  AND (t."raw"->>'demo' = 'true' OR t."content_hash" = 'demo-' || t."bid_number")
  AND NOT EXISTS (SELECT 1 FROM "tenders" AS d WHERE d."source" = 'demo' AND d."bid_number" = t."bid_number");
--> statement-breakpoint
-- 2. Watchlist matches of non-demo orgs that point at demo tenders.
DELETE FROM "tender_matches" AS m
USING "tenders" AS t, "organizations" AS o
WHERE m."tender_id" = t."id" AND t."source" = 'demo'
  AND o."id" = m."org_id" AND coalesce(o."onboarding_state"->>'demo', 'false') <> 'true';
--> statement-breakpoint
-- 3. Alerts those matches produced (dedupe key `tender:<tenderId>:<orgId>`, or any alert linking to the tender).
DELETE FROM "notifications" AS n
USING "tenders" AS t, "organizations" AS o
WHERE t."source" = 'demo'
  AND o."id" = n."org_id" AND coalesce(o."onboarding_state"->>'demo', 'false') <> 'true'
  AND (n."dedupe_key" = 'tender:' || t."id"::text || ':' || n."org_id"::text OR n."link" = '/tenders/' || t."id"::text);
