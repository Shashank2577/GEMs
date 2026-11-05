# ADR-0002: Neon connection handling — pooled endpoint now, Hyperdrive with a single `pg` driver next

**Status**: Proposed (change)
**Date**: 2026-11-05
**Priority**: MUST (pooled endpoint) · SHOULD (Hyperdrive + single driver)

## Context

`packages/db/src/client.ts` has two drivers: `createNodeDb` (node-postgres Pool, max 10) for Node and
`createNeonDb` (`@neondatabase/serverless` Pool over WebSocket + `drizzle-orm/neon-serverless`) for Workers.
`apps/api/src/worker.ts#withDeps` creates a **new Pool for every request and every cron run** and closes it in
`ctx.waitUntil`. Hot routes fan out with `Promise.all` — `GET /tenders` issues five queries at once, so one request
opens several WebSocket connections, each paying a TLS + Postgres auth handshake. `DATABASE_URL` is the direct
(non-pooled) Neon endpoint, whose `max_connections` is tied to compute size (≈112 on small computes).

At 100s of orgs this means: ~100–300 ms added latency per request, connection-limit errors under bursts (e.g. the
30-minute cron plus a few users), and a second code path for transactions that only exercises in production.

Hyperdrive (Cloudflare's connection pooler for Postgres) supports Neon, works with node-postgres `pg` under
`nodejs_compat`, keeps warm connections near the Worker and lets Workers and Node share **one** driver.
Neon's pooled endpoint (PgBouncer, `-pooler` host) accepts thousands of client connections and supports the
transaction patterns used here (`db.transaction` in auth/org routes; no session-level features).

## Decision

1. **MUST**: point the production `DATABASE_URL` secret at the Neon **pooled** connection string. No code change.
2. **SHOULD**: adopt Hyperdrive and collapse to a single driver:
   - `wrangler.toml`: `[[hyperdrive]] binding = "HYPERDRIVE" id = "<id>"`, created with the pooled Neon URL and
     `caching.disabled = true` (Hyperdrive's query cache would make reads stale after writes; correctness first).
   - `packages/db/src/client.ts`: `createNodeDb(url, { max })` becomes the only factory; `createNeonDb` is removed
     together with `@neondatabase/serverless` and `drizzle-orm/neon-serverless`.
   - `apps/api/src/worker.ts`: `createNodeDb(env.HYPERDRIVE.connectionString, { max: 5 })` per request (Hyperdrive
     makes the per-request pool cheap); keep `ctx.waitUntil(close())`.
   - `specs/001-gem-tender-copilot/plan.md` Complexity Tracking: delete the "Two DB drivers" row.
3. Keep the per-request `AppDeps` construction (no module-level globals) — it is what makes tests and Node parity
   simple; the cost it had was the connection handshake, which (1)/(2) remove.

## Consequences

- Positive: p50 API latency drops by the handshake cost; connection-limit incidents disappear; one driver, one
  transaction semantics, fewer prod-only bugs.
- Negative: Hyperdrive is a Cloudflare-side dependency with its own limits (connections per config); local dev
  still uses `pg` directly (unchanged).
- Watch: with Hyperdrive, `pg` `max` per request should stay small (≤ 5); Hyperdrive, not the Worker, owns the
  origin pool size.

## Acceptance

- Production `DATABASE_URL` host contains `-pooler`; `/api/health` p50 < 150 ms from a Mumbai vantage point.
- After (2): `pnpm typecheck` passes with `@neondatabase/serverless` removed; API tests unchanged; a 50-concurrent
  `GET /api/tenders` run shows zero `too many connections` errors.
