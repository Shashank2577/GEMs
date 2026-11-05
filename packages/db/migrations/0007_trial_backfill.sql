-- 008/FR-035: existing trial orgs get a trial end. Fair to early users: at least 7 more days from the migration,
-- otherwise created + 14 days. Idempotent (only rows still without an end).
UPDATE "organizations"
   SET "trial_ends_at" = greatest("created_at" + interval '14 days', now() + interval '7 days')
 WHERE "plan" = 'trial' AND "trial_ends_at" IS NULL;
