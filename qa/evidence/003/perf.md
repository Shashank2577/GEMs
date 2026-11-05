# 003 performance check (T078) — NFR-003, SC-005

Script: `scripts/perf/identify.ts`. Re-run on 2026-11-05 against a private local database `tp_perf` (created by hand, dropped
afterwards).

```
createdb tp_perf   # psql -h localhost -p 5433 -U postgres -c "create database tp_perf owner tp"
PERF_DATABASE_URL=postgres://tp:tp@localhost:5433/tp_perf \
  pnpm --filter @tp/api exec tsx ../../scripts/perf/identify.ts
```

## Setup

- 50,000 tenders (10,000 `open` = 20 %, the rest closed/awarded/cancelled; the open share is a deliberately high synthetic choice so the default open-only feed is a heavy case, not a production figure),
  each with a ~2 KB `raw` blob, 60 categories, 40 ministries, 8 states; `analyze` run after seeding.
- One org, one watchlist, 500 `tender_matches` (the 500 newest open tenders; 50 of them seen).
- All migrations applied (including the partial indexes of 008/FR-027 and 0019).
- Requests go through the real Hono app in-process (`app.request`), real SQL, session cookie auth. Fixed clock
  2026-11-05T04:30Z. Per case: 3 untimed warm-up calls (the first also primes the connection pool and plan cache), 1 untimed call to read the total, then 30 timed calls; p95 = the 29th of 30 sorted samples.

## Results

| Case | Result rows | p50 ms | p95 ms | Budget p95 |
|---|---:|---:|---:|---:|
| GET /tenders (default, open, page 1) | 10,000 | 16.0 | 24.0 | 400 |
| GET /tenders?status=all | 50,000 | 55.5 | 66.3 | 400 |
| GET /tenders?state=Maharashtra | 1,250 | 13.8 | 16.3 | 400 |
| GET /tenders?q=laptop | 1,428 | 42.2 | 70.8 | 400 |
| GET /tenders?q=laptop supply | 1,428 | 44.5 | 63.8 | 400 |
| GET /tenders?matched=1 | 500 | 14.3 | 16.4 | 400 |
| GET /tenders?matched=1&unseen=1 | 450 | 8.7 | 17.5 | 400 |
| GET /tenders?ministry&category&minValue&sort=-value | 83 | 8.6 | 10.9 | 400 |
| GET /tenders?closingWithinDays=7&sort=endAt | 2,330 | 9.1 | 12.3 | 400 |
| GET /tenders?state&q&maxValue&page=3 | 107 | 28.7 | 41.9 | 400 |
| GET /tenders?status=closed&page=100 | 13,334 | 56.2 | 83.9 | 400 |
| POST /watchlists/preview (laptop + Maharashtra) | 178 | 12.0 | 15.7 | 800 |
| POST /watchlists/preview (7 keywords, no state limit) | 10,000 | 218.7 | 275.1 | 800 |
| POST /watchlists/preview (2 categories + 2 ministries) | 333 | 35.5 | 51.7 | 800 |

Worst `GET /tenders` p95 83.9 ms against the 400 ms budget (NFR-003) and the 1 s budget for a filter change at p95
(SC-005, which also includes the browser round trip and render). Worst preview p95 275.1 ms against 800 ms (NFR-003).
All responses were 200 and the totals match the seeded data (the script compares every total with the expected value for the default seed and exits 1 on a mismatch or a missed budget).
Related: `apps/api/test/perf/watchlists-preview.perf.test.ts` (`PERF=1`) covers the all-50,000-match preview worst case.

## Caveats

- Local PostgreSQL 16.15 on the same machine (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, shared VM, no other load), not
  Neon. The budgets are stated for Neon: every query there pays a network round trip to the database and compute may
  be a smaller instance after auto-suspend, so absolute numbers on Neon will be higher. The headroom here (~4.8x on the
  feed, ~2.9x on preview) is the evidence that the query plans and indexes are right, not a measurement of Neon.
- In-process requests: no TLS, no Cloudflare Worker cold start, no Hyperdrive/pooler hop, no client network.
- Preview broad case matches 10,000 candidates (all open tenders matching a keyword); the matcher runs in the API
  process, so its time scales with the CPU of the Worker or Node host.
- Synthetic data (uniform distributions, 30 runs per case); real GeM text and skew will differ. Single user, no
  concurrent load (see `scripts/load/feed.sh` for that).
- No secrets are used: the connection string is the local throwaway `tp:tp` role from `scripts/local-pg.sh`.
