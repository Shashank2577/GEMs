# ADR-0003: Shared global ingestion, one cron, and a cluster-wide GeM throttle

**Status**: Accepted (shared global ingestion, single cron) · Proposed (throttle lease, cooldown, atomic lock, matcher efficiency)
**Date**: 2026-11-05
**Priority**: MUST (throttle lease, manual-sync cooldown, atomic lock) · SHOULD (matcher efficiency)

## Context

Ingestion is already **global**: `tenders` has no `org_id`, `runIngestion` (`apps/api/src/services/ingest.ts`) runs
once per cron for every org, and `matchAndNotify` fans out changed tenders to all active watchlists. This is the
right shape — GeM traffic does not grow with customers (Constitution II).

Three gaps remain:

1. **Throttle scope**. `GemClient` (`packages/core/src/gem/client.ts`) serialises and spaces requests ≥ 1 s *per
   instance*. `fetchGemDocuments` creates a new client per HTTP request, and on Workers each request is an isolated
   isolate. Ten analysts in ten orgs clicking "Fetch from GeM" at once produce ten concurrent GeM requests. The
   ≤ 1 req/s promise in NFR-002 only holds for the cron.
2. **Manual sync**. `POST /ingestion/run` (bid_manager+, any org) runs the global job inline with up to 20 pages,
   guarded only by the single-flight check. 100 orgs × "Sync now" = 100 full GeM crawls per hour.
3. **Lock atomicity**. The single-flight guard is select-then-insert on `ingestion_runs.status = 'running'`; two
   overlapping triggers (cron + manual, or a retried cron) can both pass.
4. **Matcher cost**. `matchTender` rebuilds `keywordRegex` for every (tender, keyword) pair; matches are inserted
   one row at a time; `candidateTenders` (`routes/watchlists.ts`) selects full rows including `raw` jsonb for up to
   5,000 tenders into Worker memory.

## Decision

Keep shared global ingestion and the single 30-minute cron. Add:

**A. Cluster-wide GeM throttle lease (MUST)** — Postgres is the only shared state, so use it:

- New table `gem_throttle (key text primary key, next_allowed_at timestamptz not null)` seeded with one row `'gem'`.
- `packages/db` migration + `apps/api/src/lib/gem-lease.ts`:
  `acquireGemSlot(db, minIntervalMs)` runs
  `UPDATE gem_throttle SET next_allowed_at = GREATEST(now(), next_allowed_at) + interval '1 s' WHERE key='gem' RETURNING next_allowed_at`
  and sleeps until the returned instant minus one interval. One round trip, serialisable across isolates.
- `GemClient` gets an optional `beforeRequest?: () => Promise<void>` hook (constructor option) called from
  `request()` before each HTTP call; `services/ingest.ts` and `services/analyse.ts#fetchGemDocuments` pass the lease.
  Node and tests keep the in-process throttle (hook undefined).
- Alternative considered: a Durable Object `GemGate`. Correct and idiomatic on Cloudflare, but adds a binding, a
  class and a Node shim for one shared counter; the DB lease is ~25 lines and already parity-tested.

**B. Manual-sync cooldown (MUST)** — in `routes/ingestion.ts`: if the latest `success|partial` run finished less
than `GEM_MANUAL_COOLDOWN_MIN` (default 10) minutes ago, return 200 with that run and `cooldown: true` instead of
crawling; the UI shows "Synced N minutes ago". Cron runs are unaffected.

**C. Atomic single-flight (MUST)** — partial unique index
`CREATE UNIQUE INDEX ingestion_runs_running_uq ON ingestion_runs ((1)) WHERE status = 'running'`; `runIngestion`
inserts first and maps the unique-violation to `IngestionBusyError`. Reaping of dead runs stays as is.

**D. Scheduled handler (SHOULD)** — `worker.ts#scheduled` awaits `withDeps(...)` instead of only `waitUntil`-ing
it, so cron failures show in the Cloudflare dashboard. Add `GEM_MAX_PAGES` adaptive stop: end paging when an entire
page contained only already-known, unchanged bid numbers.

**E. Matcher efficiency (SHOULD)** — `packages/core/src/match/matcher.ts`: export `compileCriteria(criteria)`
returning pre-built regexes, and `matchTender(t, compiled)`; `matchAndNotify` compiles each watchlist once per run
and inserts matches in batches of 500 with `onConflictDoNothing().returning()`. `candidateTenders` selects explicit
columns (never `raw`).

## Consequences

- GeM sees at most one request per second from the whole deployment regardless of concurrency, which is what
  Constitution II promises and what keeps the product alive (a GeM block is fatal).
- Manual sync becomes "refresh if stale"; users lose nothing because the cron is already 30 minutes.
- The lease adds one small write per GeM request (≤ 1/s by construction) — negligible.
- Matching stays linear in watchlists × changed tenders; with pre-compiled criteria the cron comfortably handles
  ~10k active watchlists per run before a sharding discussion is needed.

## Acceptance

- Load test: 20 concurrent `POST /tenders/:id/fetch-documents` against `tools/mock-gem` → mock-gem request log shows
  inter-arrival ≥ 1 s (mock gains a timestamped request log).
- Two overlapping `runIngestion` calls in an API test → exactly one `ingestion_runs` row in `running`, the other
  receives `IngestionBusyError`.
- Manual sync within 10 min of a success returns the previous run with `cooldown: true` and makes zero GeM requests.
- Unit test: `compileCriteria` + `matchTender` produce identical results to today's matcher on the existing fixtures;
  ingest benchmark with 1,000 watchlists × 500 tenders completes < 5 s in Node.
