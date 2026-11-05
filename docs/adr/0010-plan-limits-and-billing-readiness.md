# ADR-0010: Plan limits, trial expiry and billing readiness without a payment provider yet

**Status**: Accepted (implemented by spec 008 US5, PR #540 — see "As implemented" below; the numbers in Decision 1 were placeholders)
**Date**: 2026-11-05
**Priority**: MUST (plan limits, trial expiry, 402 contract, usage endpoint) · SHOULD (subscriptions table) · LATER (payments)

## As implemented (008 US5)

The decision stands; the details below supersede the sketch in Decision 1–5 where they differ.

- **Limits (FR-034)** — `PLAN_LIMITS` in `packages/core/src/contracts/plans.ts`, `null` = no plan limit (not `Infinity`):

  | Plan | seats | watchlists | analyses / month | AI analyses / month | vault | packets / month | WhatsApp |
  |---|---|---|---|---|---|---|---|
  | `trial` (14 days) | 10 | — | 10 | 10 | 1 GB | 10 | yes |
  | `starter` | 3 | 5 | 100 | 50 | 2 GB | 30 | no (not yet enforced — follow-up issue) |
  | `pro` | 10 | — | 500 | 250 | 10 GB | 200 | yes |
  | `enterprise` | — | — | — | — | — | — | yes |

  "—" = no plan limit; watchlists are still capped at 50 per org by 003/FR-027 (`WATCHLIST_LIMIT`, shared with the
  web meter). Monthly counters use the IST calendar month. Seats = members + pending, unexpired invitations.
- **402 contract (FR-040)** — `plan_limit_reached` `{limit, used, max, plan, resetsAt?}` and `plan_expired`
  `{plan:'trial', trialEndsAt}`; the expired check is one global middleware (`middleware/plan.ts#requireActivePlan`)
  with an explicit allow-list (`allowedWhenExpired`, FR-038), not a flag on `requireRole`.
- **Quota integrity** — analyses and watchlists are checked and inserted under the org row lock
  (`SELECT … FOR NO KEY UPDATE`); seats, vault and packets are check-then-insert (a race can overshoot by the
  concurrent requests — accepted, not a cost risk). The AI slot is reserved in the analysis' quota transaction as a
  0-token `llm_usage` row (`reserved = true`, inserted after the analysis with `analysis_id` set) and counted on
  `llm_usage.analysis_ref` (no FK), so deleting analyses never returns AI quota; the reservation is released by id
  only when no call was metered, decided in-process after in-flight calls settle. Only rows the demo seeder wrote
  (`analyses.seeded`) are outside the quota, and `DELETE /api/demo` deletes only those. Packets are counted on the
  FK-free `packet_ledger` (written with each packet, removed only when its build fails), so deleting a packet with its
  demo workspace does not return packet quota.
- **Subscriptions (FR-042)** — append-only `subscriptions (org_id, plan, status, started_at, ends_at, note, created_by)`
  written by `POST /api/admin/orgs/:id/plan` (Bearer `ADMIN_TOKEN`, ≥ 32 characters, else the endpoint stays 404).
- **Usage (FR-039)** — `GET /api/org/usage` → `{plan, trialEndsAt, period, usage, limits}`; Settings → Plan & usage.

## Context

`organizations.plan` exists (`trial | starter | pro | enterprise`, default `trial`) and is returned in `Me`, but
nothing reads it. Specs 005 and 007 explicitly leave quotas and enforcement to "billing, if introduced". The landing
page promises a 14-day Pro trial. Without enforcement there is no reason to pay, no way to end a trial, and no cap
on the cost drivers (LLM, storage, seats).

Indian SMB billing will most likely be Razorpay (subscriptions + GST invoices); integrating it is a feature of its
own. What the platform needs *now* is the data model and the enforcement seam so that flipping `plan` has effect.

## Decision

1. **Plan catalogue in core (MUST)** — `packages/core/src/contracts/plans.ts`:
   ```ts
   export const PLAN_LIMITS = {
     trial:      { seats: 3,  watchlists: 3,  analysesPerMonth: 10,  llmAnalysesPerMonth: 10,  vaultBytes: 200 * MB, packetsPerMonth: 10 },
     starter:    { seats: 3,  watchlists: 5,  analysesPerMonth: 50,  llmAnalysesPerMonth: 50,  vaultBytes: 1 * GB,   packetsPerMonth: 50 },
     pro:        { seats: 10, watchlists: 25, analysesPerMonth: 300, llmAnalysesPerMonth: 300, vaultBytes: 10 * GB,  packetsPerMonth: 300 },
     enterprise: { seats: Infinity, watchlists: Infinity, analysesPerMonth: Infinity, llmAnalysesPerMonth: Infinity, vaultBytes: Infinity, packetsPerMonth: Infinity },
   } as const;
   ```
   (numbers are placeholders for the product owner; the shape is the decision). Shared with the web app for UI hints.
2. **Trial expiry (MUST)** — `organizations.trial_ends_at timestamptz` (set to `created_at + 14 days` on signup;
   backfilled in the migration). `middleware/auth.ts#authenticate` sets `c.var.org.locked = plan === 'trial' && trial_ends_at < now`;
   a `requireActivePlan` middleware (applied by all `requireRole` paths with `min >= 'analyst'`, i.e. every write)
   returns 402 `plan_expired`. Reads keep working so data is never held hostage.
3. **Enforcement helper (MUST)** — `apps/api/src/lib/plan.ts#assertWithinPlan(deps, org, 'watchlists' | 'seats' | 'analyses' | 'vaultBytes' | 'packets')`
   computes the usage with one query each (`count(*)` on `watchlists where active`, `memberships + pending invitations`,
   `analyses this month`, `sum(size_bytes) vault_documents`, `packets this month`) and throws 402
   `plan_limit_reached` `{ limit, used, resource, upgradeUrl }`. Call sites: `routes/watchlists.ts` (create/resume),
   `routes/org.ts` (invite), `services/analyse.ts`, `routes/vault.ts` (upload/replace), `services/packet.ts`.
   Supporting indexes: `analyses (org_id, created_at)`, `packets (org_id, created_at)`.
4. **Usage endpoint (MUST)** — `GET /org/usage` → `{ plan, trialEndsAt, limits, used, llm: { inputTokens, outputTokens } }`
   (reads `llm_usage` from ADR-0008). Settings → Organization shows it with upgrade CTAs; 402s in the UI open the same panel.
5. **Subscriptions table (SHOULD)** — `subscriptions (id, org_id unique, provider 'manual'|'razorpay', provider_customer_id,
   provider_subscription_id, plan, status 'trialing'|'active'|'past_due'|'cancelled', current_period_end, created_at, updated_at)`.
   Until payments exist, an internal script/endpoint (`POST /admin/orgs/:id/plan`, protected by an `ADMIN_TOKEN`
   secret) flips `organizations.plan` and writes a `manual` subscription row — enough to onboard the first paying
   customers by invoice.
6. **Payments (LATER)** — Razorpay Subscriptions + webhook → update `subscriptions`, mirror `plan` to
   `organizations`. Not before the first 5 paying orgs.

## Consequences

- Every cost driver has a ceiling tied to revenue; trials end on their own; sales can upgrade orgs today with a script.
- A 402 error code enters the API contract (`contracts/api.md`, web error handling, `HttpError` helper
  `paymentRequired()`).
- The limits table is product policy living in code; changing numbers is a one-line PR, not a migration.
- The enterprise tier bypasses checks via `Infinity` — simple, and auditable in `/org/usage`.

## Acceptance

- API tests per resource: at the limit → 402 with `details.resource`; enterprise never 402s; expired trial → writes
  402 `plan_expired`, reads 200.
- Signup sets `trial_ends_at = now + 14 d`; `/auth/me` and `/org/usage` expose it.
- Admin plan flip updates `plan`, writes a `subscriptions` row, and is logged in `activity_log` (`org.plan_changed`).
