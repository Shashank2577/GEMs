# ADR-0006: Notifications as a Postgres outbox dispatched by the cron (no external queue)

**Status**: Accepted (existing) · Proposed (pending-index, batch sends, retention)
**Date**: 2026-11-05
**Priority**: MUST (partial index on pending rows) · SHOULD (bounded retries, Resend batch) · see ADR-0012 for retention

## Context

`notifications` is the outbox (`services/ingest.ts#matchAndNotify`, `services/reminders.ts` write; `services/alerts.ts`
reads). Rows are deduped by `(user_id, channel, dedupe_key)`, in-app rows are `sent` immediately, email/WhatsApp rows
are `pending` until `dispatchNotifications` sends ≤ 500 per run, one provider call each, and marks
`sent | skipped | failed(+error)`. Daily digests are one row per (user, org, channel, IST day).

Observations at scale:

- The dispatcher's selector is `status = 'pending' AND channel IN ('email','whatsapp') ORDER BY created_at` — there is
  **no index on `status`**. `notifications` grows by matches × members × channels (easily 10^6 rows in a year); every
  30 minutes the cron scans the whole table.
- `failed` rows are never retried and never expire; a transient Resend outage drops those alerts permanently.
- One HTTP call per email: 500 rows ≈ 500 subrequests out of the 1,000-per-invocation budget, plus GeM pages.

## Decision

Keep the outbox pattern (simple, idempotent, observable in SQL, no Queue to operate). Changes:

1. **MUST**: partial index
   `CREATE INDEX notifications_pending_idx ON notifications (created_at) WHERE status = 'pending' AND channel IN ('email','whatsapp')`
   (Drizzle: `index(...).on(t.createdAt).where(sql\`...\`)`).
2. **SHOULD**: bounded retry — add `attempts int not null default 0`; dispatcher selects `pending OR (failed AND attempts < 3 AND updated < now - 30 min)`,
   increments `attempts`, and only the third failure is final. Dedupe keys already make re-sends idempotent.
3. **SHOULD**: send instant emails through Resend's batch endpoint (`POST /emails/batch`, up to 100 per call) in
   `adapters/mailer.ts#sendMany`; falls back to per-row sends on Node/log mailer. Cuts subrequests ~50×.
4. Retention of `sent`/`skipped`/`read` rows is in ADR-0012.

## Consequences

- The cron's dispatch step stays O(pending) instead of O(table).
- Transient provider errors self-heal; permanent ones still surface per row in the UI (delivery status chips).
- Batch sending changes error granularity (one failure in a batch marks that row only — Resend returns per-item
  results); tests cover the mapping.

## Acceptance

- `EXPLAIN` of the dispatcher query on a 1M-row table uses `notifications_pending_idx`.
- API test: mailer throws once → row is `failed` with `attempts=1`, next dispatch after 30 min sends it (`sent`).
- 120 pending emails dispatch in 2 provider calls (log mailer records batch sizes).
