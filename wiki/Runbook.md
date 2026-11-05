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
Releases run only through the GitHub Actions deploy workflow (`.github/workflows/deploy.yml`, called from `ci.yml` after
`ci-gate` is green on `main`): staging migrate → deploy → smoke → approval → production migrate → deploy → smoke.
Setup, secrets, rollback, restore drill and the break-glass procedure:
[docs/runbook.md § Deploy & rollback](https://github.com/Shashank2577/GEMs/blob/main/docs/runbook.md#deploy--rollback).
