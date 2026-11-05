# TenderPilot runbook

## Launch checklist

### Release gate: spec 002 auth hardening (008/FR-023)

No paid plan may be activated (no `POST /api/admin/orgs/:id/plan` to `starter`/`pro`, no invoice) until every MUST row
below reads **pass**. A row passes only when its spec 002 acceptance scenarios have a QA verdict `qa:approved` in
`qa/evidence/002/US<n>/VERDICT.md` with every criterion `met`, and the implementing tasks are ticked in
`specs/002-platform-tenancy/tasks.md`. SHOULD rows are recorded but do not block.

Last checked: 2026-11-05, against `main` at `ef57077`, by 008/US3 (T057). Sources are repository files only
(QA verdicts and task ticks); re-check them before each paid activation and update this table.

| 002 requirement | Level | Spec 002 scenarios | Implementing tasks (issue) | QA verdict | Gate |
|---|---|---|---|---|---|
| FR-010 auth failure limits (10/email, 30/IP per 15 min, 429 + `Retry-After`) | MUST | US1 scenario 14 | T024–T027 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 14a–14c met | **pass** |
| FR-011 password reset (single-use 60-min link, 3/email and 20/IP per hour) | MUST | US1 scenario 15 | T028–T029 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 15a–15c met (15b by API test only) | **pass** |
| FR-018 invite email binding (403 `invite_email_mismatch`) | MUST | US2 scenario 12 | T042 (#23) open; QA T045 (#26) open | none (`qa/evidence/002/US2/` does not exist) | **blocked** |
| FR-028 `bad_origin` (cookie POST with foreign `Origin` → 403; Bearer exempt) | MUST | US3 scenario 11 (also 008/US3 scenario 9) | T055 (#31) open; QA T057 (#33) open | none (`qa/evidence/002/US3/` does not exist) | **blocked** |
| FR-012 session list / revoke | SHOULD | US1 scenario 16 | T030–T032 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 16a–16c met | pass |
| FR-037 API token expiry, hint, 10-token cap | SHOULD | US5 | T074–T077 (#39–#42) open; QA T078 (#43) open | none (`qa/evidence/002/US5/` does not exist) | open |

**Gate status: BLOCKED** — FR-018 and FR-028 are not implemented yet. Re-run this check when spec 002 US2 and US3
merge with `qa:approved` verdicts.

How to re-check:

1. `ls qa/evidence/002/` — each story that implements a row above must have `VERDICT.md` ending in `qa:approved`
   with no `not met` row for the listed scenarios.
2. `grep -nE "T042|T055|T074|T075|T076|T077" specs/002-platform-tenancy/tasks.md` — the lines must read `- [x]`.
3. Run the API suite (`pnpm --filter @tp/api exec vitest run`); `rate-limit.test.ts`, `password-reset.test.ts`,
   `ops-limits.test.ts` and `isolation.test.ts` must pass.
4. Update the table and the "Last checked" line above in the release PR.

### Abuse and isolation controls in place (008/US3)

- Demo tenders are `source = 'demo'` and visible only to orgs with `onboarding_state.demo = true`; data-fix migration
  `0003_demo_source_datafix.sql` converted rows seeded earlier.
- Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts` (429 `rate_limited` + `Retry-After`). Generic rules fail
  open with a `rate_limit_unavailable` warn log; `auth.*` rules fail closed with 503 `service_unavailable`.
- Body caps (413 `payload_too_large` before the body is read): JSON 1 MB, vault 20 MB, tender documents 25 MB.
- Client IP: `cf-connecting-ip` on Workers (`TRUST_PROXY=cloudflare` is set by `worker.ts`); behind another proxy on Node
  set `TRUST_PROXY=1` so the first `x-forwarded-for` hop is used.
