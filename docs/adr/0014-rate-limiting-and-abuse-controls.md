# ADR-0014: Rate limiting and abuse controls — one Postgres-backed limiter behind an `AppDeps` interface

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST

## Context

There is no rate limiting anywhere. Expensive or externally-visible endpoints reachable by any member:

| Endpoint | Cost | Abuse |
|---|---|---|
| `POST /auth/login`, `/auth/signup`, `/auth/accept-invite`, `/me/password` | PBKDF2 100k iterations CPU | credential stuffing, CPU bill |
| `POST /watchlists/preview` | up to 5,000-row scan + JS matching | per-keystroke calls |
| `POST /vault`, `PUT /vault/:id/file`, `POST /tenders/:id/documents` | 20–25 MB bodies, PDF parsing, R2 writes | storage/CPU bill |
| `POST /tenders/:id/fetch-documents`, `POST /ingestion/run` | GeM requests | politeness violation (ADR-0003) |
| `POST /tenders/:id/analyse`, `POST /workspaces/:id/packets` | LLM + CPU | spend (quotas in ADR-0008/0010) |
| `POST /demo/seed` | large writes | repeated seeding |

Workers have no shared in-memory state; Cloudflare's WAF rate-limiting rules need a custom domain (coming, ADR-0013)
and cannot key on org/user; the Workers rate-limit binding is still beta/"unsafe". Spec 002 FR-010 already decided
on a Postgres-backed counter for auth. Reuse it everywhere.

## Decision

1. **Interface** — `deps.rateLimiter: RateLimiter` with `hit(key: string, rule: { limit: number; windowMs: number }): Promise<{ allowed: boolean; retryAfterMs: number }>`.
   Implementation `apps/api/src/lib/rate-limit.ts` over table
   `rate_limits (key text primary key, window_start timestamptz, count int)`: a single
   `INSERT … ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start < now - $window THEN 1 ELSE count + 1 END, window_start = CASE … END RETURNING count, window_start`.
   One round trip, fixed window (good enough), safe under concurrency. Housekeeping (ADR-0012) deletes rows older
   than a day. Node/tests use the same implementation (parity), with an in-memory variant for unit tests.
2. **Middleware** — `rateLimit(name, rule, keyFn)` in `middleware/rate-limit.ts` returns 429 `rate_limited` with
   `Retry-After`. Default keys: `ip` from `cf-connecting-ip` (Workers) / `x-forwarded-for` (Node), `user`, `org`,
   and `email` for auth forms.
3. **Rules** (constants in `apps/api/src/lib/rate-limit.ts`, adjustable without code elsewhere):

   | Route | Key | Rule |
   |---|---|---|
   | login / accept-invite / password change failures | email | 10 / 15 min (spec 002 FR-010) |
   | same | ip | 30 / 15 min |
   | signup, forgot-password | ip | 5 / hour; forgot also 3 / email / hour |
   | watchlists/preview | user | 30 / min |
   | uploads (vault, tender docs) | org | 60 / hour |
   | fetch-documents | org | 20 / hour (plus the global GeM lease, ADR-0003) |
   | ingestion/run | global | cooldown (ADR-0003) |
   | analyse, packets | org | 30 / hour (quota is monthly, this is burst control) |
   | demo/seed | org | 3 / day |
   | any `/api/*` | ip | 600 / min (coarse safety net) |

4. **Body size** — `middleware/request.ts` rejects `content-length` above the route's declared max before parsing
   (`routes/vault.ts` already does this for vault; generalise), so the Worker never buffers more than it will accept.
5. **WAF (SHOULD, once on a custom domain)** — a zone-level rate-limiting rule on `/api/auth/*` at 100 req/min/IP as
   a cheap outer layer; no application change.

## Consequences

- Every abuse vector has a ceiling with a single mechanism that works identically on Workers and Node.
- One extra indexed upsert on rate-limited routes (not on ordinary reads) — microseconds on Postgres.
- Fixed windows allow a 2× burst at the boundary; acceptable for these limits.
- The limiter table is tiny and self-cleaning.

## Acceptance

- API tests: each rule table row has a test that the (limit + 1)-th call returns 429 with `Retry-After` and that a
  different key is unaffected.
- The spec 002 auth tests (FR-010) pass using this limiter.
- A 30 MB upload to `/api/vault` is rejected with 413 before the body is read (test asserts the handler was not
  invoked via the log mailer/blob spy).
