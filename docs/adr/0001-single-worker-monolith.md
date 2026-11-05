# ADR-0001: One Cloudflare Worker serves API, SPA and cron (and must run on Workers Paid)

**Status**: Accepted (existing) — with a MUST amendment on limits
**Date**: 2026-11-05
**Priority of amendment**: MUST-before-paying-customers

## Context

`wrangler.toml` deploys a single Worker `tenderpilot`: `/api/*` → Hono app (`apps/api/src/worker.ts`), everything
else → static assets (`apps/web/dist`, SPA fallback), `*/30 * * * *` cron → `runScheduledJobs`. The same
`createApp(deps)` runs on Node (`apps/api/src/node.ts`) for dev/CI/E2E. There is no separate ingestion worker,
no Queue, no Durable Object.

The heavy work runs inside ordinary `fetch` invocations: PDF text extraction with `unpdf` (pdf.js) on upload /
GeM fetch (`services/analyse.ts`), sequential LLM calls per document, and packet merging with `pdf-lib`
(`services/packet.ts`, `packages/core/src/packet/build.ts`). Cloudflare limits that apply: 10 ms CPU per
invocation on Free; 30 s default on Paid, raisable to 300 s with `[limits] cpu_ms`; 128 MB memory; 1,000
subrequests; 15 min wall clock for cron handlers.

## Decision

Keep the single-Worker monolith. It is the simplest topology that satisfies Constitution VII and VIII, the code is
already runtime-agnostic through `AppDeps`, and nothing at 100s of orgs requires a split.

Amend the deployment contract:

1. The production Worker runs on **Workers Paid**; this is a hard prerequisite, documented in `wrangler.toml` and
   the deploy runbook.
2. Add to `wrangler.toml`:
   ```toml
   [limits]
   cpu_ms = 120000   # analyse (pdf.js) and packet (pdf-lib) are CPU-bound; default 30 s is too tight for scans
   ```
3. Bound the work a single invocation can do (details in ADR-0007): max pages per PDF extracted, LLM character
   budget per analysis, packet input bytes.

## Consequences

- Positive: one deploy, one log stream, one set of secrets; local parity stays exact.
- Negative: a CPU/memory overrun surfaces as a Cloudflare 1102/1103 error, not as an application error — the caps in
  ADR-0007 exist to keep that from happening on normal inputs.
- Trigger to revisit (see ADR-0007): p95 analysis latency > 60 s, or a batch "analyse all new matches" feature.

## Acceptance

- `wrangler.toml` contains `[limits] cpu_ms = 120000`; deploy runbook states the Paid-plan requirement.
- A 150-page text PDF analyses successfully in production; a 400-page PDF is rejected with 413/422 and a clear message
  (ADR-0007), not a 1102.
