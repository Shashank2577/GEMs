# ADR-0011: Observability — health with ingestion staleness, external monitor, structured logs, error reporting

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (health + external monitor + structured logs) · SHOULD (Sentry)

## Context

Today: `adapters/logger.ts` prints `[tp] <message> {json}` to the console; `middleware/request.ts` logs one line per
request with `rid` and echoes `x-request-id`; `[observability] enabled = true` ships console output to Workers Logs
(short retention, no alerting); `/api/health` returns `{ ok, db, version }`; `runScheduledJobs` logs a step report;
`ingestion_runs` records every run with status and error.

What is missing for a paid service: nobody is paged when ingestion fails silently for hours (the product's core
promise is "you will know within 30 minutes"), there is no aggregation of 5xx errors with stack traces, and logs
cannot be queried by org for support ("alerts stopped for customer X").

## Decision

1. **Health reflects the pipeline (MUST)** — `app.ts#/health` adds
   `ingestion: { lastSuccessAt, ageMinutes, lastStatus }` from `ingestion_runs`, and `alerts: { pendingOlderThan30m }`
   from `notifications`. Status 503 when the DB is down **or** `ageMinutes > 120` (two missed cycles) **or**
   pending alerts older than 60 min exist. Response is cheap (two indexed queries) and unauthenticated as today.
2. **External monitor (MUST)** — an uptime monitor (Cloudflare Health Checks, Better Stack, or UptimeRobot — any)
   polls `https://<domain>/api/health` every 5 minutes from an Indian region and pages the on-call email/WhatsApp on
   two consecutive failures. Configured outside the repo; documented in `docs/runbook.md` (new, owned by spec 008).
3. **Structured logs (MUST)** — `adapters/logger.ts` emits one JSON object per line
   `{ t, level, msg, rid?, orgId?, userId?, ...meta }`; `middleware/request.ts` attaches `orgId`/`userId` after auth
   (a child logger stored on the context). Workers Logs can then filter by `orgId`. No PII beyond ids; never log
   tokens, emails or document text.
4. **Error reporting (SHOULD)** — `deps.errors: ErrorReporter` (`capture(err, ctx)`), implemented with
   `@sentry/cloudflare` in `worker.ts` (`withSentry(env => ({ dsn: env.SENTRY_DSN }), handler)`) and `@sentry/node`
   in `node.ts`, no-op when `SENTRY_DSN` is absent (Constitution VII). `middleware/error.ts` and `runScheduledJobs`
   call `capture` for 5xx and step failures with `rid`, route, orgId. Sentry's free tier is sufficient.
5. **Request metrics (LATER)** — if needed, Workers Analytics Engine for per-org request counts; not required for
   the first customers because `activity_log` + `llm_usage` already answer "what did org X do".

## Consequences

- Silent ingestion failure becomes a page within ~1 hour; most incidents will be caught before customers notice.
- Logs become greppable by org and request id; support can answer tickets without DB access.
- Sentry adds a dependency and a secret; the no-op default keeps dev/E2E unchanged.

## Acceptance

- API test: with the latest success 3 h old, `/api/health` → 503 with `ingestion.ageMinutes ≥ 180`.
- Runbook lists the monitor URL, alert routing and the three first steps for "ingestion stale", "alerts pending",
  "DB unreachable".
- A thrown error in a route in production appears in Sentry with `rid` matching the `x-request-id` the user saw.
