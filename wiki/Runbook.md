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
