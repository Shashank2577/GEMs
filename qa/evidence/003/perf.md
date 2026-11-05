# 003 performance check (T078) — NFR-003, SC-005

Script: `scripts/perf/identify.ts`. Run on 2026-11-05 against a private local database `tp_perf` (created by hand, dropped
afterwards).

```
createdb tp_perf   # psql -h localhost -p 5433 -U postgres -c "create database tp_perf owner tp"
PERF_DATABASE_URL=postgres://tp:tp@localhost:5433/tp_perf \
  pnpm --filter @tp/api exec tsx ../../scripts/perf/identify.ts
```

## Setup

- 50,000 tenders (10,000 `open`, the rest closed/awarded/cancelled; production is nearer 6 % open, so this is heavier),
  each with a ~2 KB `raw` blob, 60 categories, 40 ministries, 8 states; `analyze` run after seeding.
- One org, one watchlist, 500 `tender_matches` (the 500 newest open tenders; 50 of them seen).
- All migrations applied (including the partial indexes of 008/FR-027 and 0019).
- Requests go through the real Hono app in-process (`app.request`), real SQL, session cookie auth. Fixed clock
  2026-11-05T04:30Z. 3 warm-up calls then 30 timed calls per case; p95 = the 29th of 30 sorted samples.

## Results

| Case | Result rows | p50 ms | p95 ms | Budget p95 |
|---|---:|---:|---:|---:|
| GET /tenders (default, open, page 1) | 10,000 | 18.1 | 23.5 | 400 |
| GET /tenders?status=all | 50,000 | 62.8 | 91.2 | 400 |
| GET /tenders?state=Maharashtra | 1,250 | 16.0 | 20.4 | 400 |
| GET /tenders?q=laptop | 1,428 | 46.2 | 68.4 | 400 |
| GET /tenders?q=laptop supply | 1,428 | 44.4 | 56.5 | 400 |
| GET /tenders?matched=1 | 500 | 15.1 | 21.7 | 400 |
| GET /tenders?matched=1&unseen=1 | 450 | 7.7 | 10.7 | 400 |
| GET /tenders?ministry&category&minValue&sort=-value | 83 | 9.9 | 13.0 | 400 |
| GET /tenders?closingWithinDays=7&sort=endAt | 2,330 | 8.8 | 9.4 | 400 |
| GET /tenders?state&q&maxValue&page=3 | 107 | 28.5 | 35.7 | 400 |
| GET /tenders?status=closed&page=100 | 13,334 | 61.1 | 81.3 | 400 |
| POST /watchlists/preview (laptop + Maharashtra) | 178 | 13.2 | 20.5 | 800 |
| POST /watchlists/preview (7 keywords, no state limit) | 10,000 | 239.9 | 279.6 | 800 |
| POST /watchlists/preview (2 categories + 2 ministries) | 333 | 41.8 | 56.0 | 800 |

Worst `GET /tenders` p95 91.2 ms against the 400 ms budget (NFR-003) and the 1 s budget for a filter change at p95
(SC-005, which also includes the browser round trip and render). Worst preview p95 279.6 ms against 800 ms (NFR-003).
All responses were 200 and the totals match the seeded data (counts are asserted by eye above, not by the script).
Related: `apps/api/test/perf/watchlists-preview.perf.test.ts` (`PERF=1`) covers the all-50,000-match preview worst case.

## Caveats

- Local PostgreSQL 16.15 on the same machine (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, shared VM, no other load), not
  Neon. The budgets are stated for Neon: every query there pays a network round trip to the database and compute may
  be a smaller instance after auto-suspend, so absolute numbers on Neon will be higher. The headroom here (4x on the
  feed, ~3x on preview) is the evidence that the query plans and indexes are right, not a measurement of Neon.
- In-process requests: no TLS, no Cloudflare Worker cold start, no Hyperdrive/pooler hop, no client network.
- Preview broad case matches 10,000 candidates (all open tenders matching a keyword); the matcher runs in the API
  process, so its time scales with the CPU of the Worker or Node host.
- Synthetic data (uniform distributions, 30 runs per case); real GeM text and skew will differ. Single user, no
  concurrent load (see `scripts/load/feed.sh` for that).
- No secrets are used: the connection string is the local throwaway `tp:tp` role from `scripts/local-pg.sh`.
