# Runbook

## Local
```sh
pnpm install
scripts/local-pg.sh                       # Postgres 16 on :5433 (tenderpilot, tenderpilot_test)
pnpm --filter @tp/mock-gem start          # mock GeM BidPlus on :4010
cp .dev.vars.example .env && export $(grep -v '^#' .env | xargs)
pnpm --filter @tp/web build && pnpm --filter @tp/api start   # http://localhost:8787
DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot pnpm db:seed   # demo@tenderpilot.in / Demo@12345
```

## Tests
```sh
pnpm --filter @tp/core exec vitest run                                   # unit
TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api exec vitest run
pnpm exec playwright test                                                # E2E + evidence
```

## Deploy (Cloudflare Workers + Neon + R2)
See `docs/deploy.md` (spec 008). In short: create a Neon database and run `pnpm db:migrate` against it, create the R2 bucket,
`wrangler secret put DATABASE_URL` (and optional `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`),
set `APP_URL` in `wrangler.toml`, then `pnpm deploy`.

`APP_URL` must be exactly the origin users load the app from (scheme + host + port, e.g. `https://app.tenderpilot.in`).
Signed-in writes whose browser `Origin` differs are refused with 403 `bad_origin` (002/FR-028), so a wrong or stale
`APP_URL` (custom domain, `www.` vs apex, preview URL) breaks every save. Locally, a loopback `APP_URL` (the default
`http://localhost:8787`) accepts any loopback origin, so the Vite dev server works.

### `TRUST_PROXY` (client IP for rate limits)
The auth rate limits (login, accept-invite, change password: 30 failures per IP per 15 min; forgot/reset password: 20 per IP
per hour) need the caller's IP. It is read **only** from a header set by a proxy you trust, chosen by `TRUST_PROXY`:

| Value | Header used | Use when |
|---|---|---|
| `cloudflare` | `cf-connecting-ip` | Cloudflare Workers (the Worker default; set explicitly in `wrangler.toml`) |
| `xff` (or `1`) | first hop of `x-forwarded-for` | Node server behind your own reverse proxy that overwrites that header |
| unset / `none` | none | Node server reachable directly (the Node default) |

With no trusted IP, per-IP limits are skipped (per-email limits still apply), so un-proxied clients do not share one bucket.
Never set `xff` when clients can reach the Node server directly: they could forge the header to dodge or aim the limits.
Locally (`.dev.vars.example`) leave it unset. Spec: `specs/002-platform-tenancy/plan.md` (Client IP).
