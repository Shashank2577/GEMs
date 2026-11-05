# ADR-0012: Data retention — a weekly housekeeping cron step, packet retention and R2 lifecycle

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: SHOULD

## Context

Nothing is ever deleted. Growth drivers and their rates at 100s of orgs:

| Data | Growth | Why it matters |
|---|---|---|
| `tenders.raw` jsonb | ~3k rows/day × 3–8 KB | Neon storage is billed per GB; `raw` is never read after normalisation |
| `notifications` | matches × members × channels | Dispatcher and inbox queries (ADR-0006) |
| `tender_events` | every change | Only the last 50 per tender are shown |
| `sessions` | every login, expired rows never purged | Table scans on token lookup are index-backed, but it is still garbage |
| `ingestion_runs` | 48/day | Sync-health shows 20 |
| `packets` + R2 objects | every build ≤ 20 MB | R2 storage cost; workspaces rebuild often |
| `activity_log` | every action | Compliance value; keep long |

Paying customers will also ask what happens to their data on cancellation.

## Decision

1. **Housekeeping step** in `apps/api/src/lib/scheduled.ts` (`services/housekeeping.ts`), run on the first cron tick
   after 02:00 IST each day (cheap guard on `ingestion_runs`/a `housekeeping_runs` row), applying this retention
   table — kept in code as `RETENTION` so it is the single source of truth:

   | Data | Rule |
   |---|---|
   | `sessions` | delete `expires_at < now - 7 d` |
   | `invitations` | delete `expires_at < now - 30 d AND accepted_at IS NULL` |
   | `notifications` | delete `status IN ('sent','skipped','read') AND created_at < now - 180 d`; `failed` after 30 d |
   | `tender_events` | delete `created_at < now - 365 d` |
   | `ingestion_runs` | delete `started_at < now - 90 d` |
   | `tenders.raw` | set `raw = NULL` where `status <> 'open' AND updated_at < now - 90 d` |
   | `tenders` (closed) | keep rows (history for win-rate, past-contract matching); revisit at 5M rows |
   | `packets` | keep the newest 5 `ready` per workspace; delete older rows **and** their R2 objects; delete `failed` after 7 d |
   | `activity_log` | keep 2 years |
   | `llm_usage` | keep 2 years (billing evidence) |

   Each rule deletes in batches of 5,000 with `LIMIT` subqueries to stay inside cron time; the step logs counts.
2. **R2 lifecycle rule** (Cloudflare dashboard / `wrangler r2 bucket lifecycle`) on prefix `org/*/packets/` to expire
   objects older than 365 days as a backstop for anything the DB-driven cleanup misses; vault objects are never
   lifecycle-expired (customer data).
3. **Org offboarding procedure** (documented in the runbook; endpoint LATER): export = zip of vault files + JSON of
   profile/analyses; delete = `DELETE FROM organizations WHERE id = $1` (cascades) followed by R2 prefix delete
   `org/<orgId>/`. Until the endpoint exists, this is a scripted ops task.
4. Privacy note for Terms: tenant data is deleted within 30 days of a confirmed deletion request; public tender data
   is retained indefinitely.

## Consequences

- Storage and hot-table sizes plateau; the dispatcher and inbox stay fast without heroic indexing.
- Users keep the five most recent packets per bid, which matches how the workspace UI presents them.
- A documented deletion path is part of what a paying customer's procurement will ask for.

## Acceptance

- API test with a fixed clock: seeded rows beyond each threshold are removed, rows inside are untouched, and the
  blob store no longer contains the pruned packets.
- `RETENTION` is referenced from `docs/runbook.md` and the Terms draft.
