# ADR-0010: Plan limits, trial expiry and billing readiness without a payment provider yet

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (plan limits, trial expiry, 402 contract, usage endpoint) · SHOULD (subscriptions table) · LATER (payments)

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
