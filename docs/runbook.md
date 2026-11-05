# TenderPilot runbook

## Launch checklist

### Release gate: spec 002 auth hardening (008/FR-023)

No paid plan may be activated (no `POST /api/admin/orgs/:id/plan` to `starter`/`pro`, no invoice) until every MUST row
below reads **pass**. A row passes only when its spec 002 acceptance scenarios have a QA verdict `qa:approved` in
`qa/evidence/002/US<n>/VERDICT.md` with every criterion `met`, and the implementing tasks are ticked in
`specs/002-platform-tenancy/tasks.md`. SHOULD rows are recorded but do not block.

Last checked: 2026-11-05, against `main` at `205fe71` (after 002/US2 #487 and 002/US3 #495 merged), by 008/US3
(T057, review round 1). Sources are repository files only (QA verdicts and task ticks); re-check them before each paid
activation and update this table.

| 002 requirement | Level | Spec 002 scenarios | Implementing tasks (issue) | QA verdict | Gate |
|---|---|---|---|---|---|
| FR-010 auth failure limits (10/email, 30/IP per 15 min, 429 + `Retry-After`) | MUST | US1 scenario 14 | T024–T027 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 14a–14c met | **pass** |
| FR-011 password reset (single-use 60-min link, 3/email and 20/IP per hour) | MUST | US1 scenario 15 | T028–T029 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 15a–15c met (15b by API test only) | **pass** |
| FR-018 invite email binding (403 `invite_email_mismatch`) | MUST | US2 scenario 12 | T042 (#23), QA T045 (#26) ticked | [`qa/evidence/002/US2/VERDICT.md`](../qa/evidence/002/US2/VERDICT.md) `qa:approved` (round 2), rows 12a–12b met | **pass** |
| FR-028 `bad_origin` (cookie POST with foreign `Origin` → 403; Bearer exempt) | MUST | US3 scenario 11 (also 008/US3 scenario 9) | T055 (#31), QA T057 (#33) ticked | [`qa/evidence/002/US3/VERDICT.md`](../qa/evidence/002/US3/VERDICT.md) `qa:approved` (round 2), rows 11a–11c met | **pass** |
| FR-012 session list / revoke | SHOULD | US1 scenario 16 | T030–T032 ticked | [`qa/evidence/002/US1/VERDICT.md`](../qa/evidence/002/US1/VERDICT.md) `qa:approved`, rows 16a–16c met | pass |
| FR-037 API token expiry, hint, 10-token cap | SHOULD | US5 | T074–T077 (#39–#42) open; QA T078 (#43) open | none (`qa/evidence/002/US5/` does not exist) | open (does not block) |

**Gate status: PASS for the MUST rows** — FR-010, FR-011, FR-018 and FR-028 have approved QA verdicts. FR-037
(SHOULD) is still open; record the decision to launch without it in the release PR.

How to re-check:

1. `ls qa/evidence/002/` — each story that implements a row above must have `VERDICT.md` ending in `qa:approved`
   with no `not met` row for the listed scenarios.
2. `grep -nE "T042|T055|T074|T075|T076|T077" specs/002-platform-tenancy/tasks.md` — the lines must read `- [x]`.
3. Run the API suite (`pnpm --filter @tp/api exec vitest run`); `rate-limit.test.ts`, `password-reset.test.ts`,
   `ops-limits.test.ts` and `isolation.test.ts` must pass.
4. Update the table and the "Last checked" line above in the release PR.

### Before running migration 0007 (demo data-fix, 008/FR-016)

`packages/db/migrations/0007_demo_source_datafix.sql` deletes data. Before migrating any environment that has had
demo data loaded:

1. Create a Neon branch (or snapshot) of the database and note its name in the release PR; it is the rollback path.
2. Optionally count what will go: demo-marked tenders (`raw->>'demo' = 'true'` or `content_hash = 'demo-' || bid_number`)
   and, for orgs without `onboarding_state.demo = true`, their `tender_matches`, `notifications`, `analyses`,
   `bid_workspaces` (with comments and packets) and org-uploaded `tender_documents` on those tenders.
3. Run `db:migrate`. What it does: converts those tenders to `source = 'demo'`; for non-demo orgs deletes the matches
   and alerts they produced and any analyses, workspaces (comments, packets cascade) and uploaded documents built on
   them (bids on tenders that do not exist on GeM). Demo orgs keep everything. Blobs of deleted packets/documents stay
   in R2 unreferenced.

### Abuse and isolation controls in place (008/US3)

- Demo tenders are `source = 'demo'` and visible only to orgs with `onboarding_state.demo = true` (every tender read
  path, every `/tenders/:id*` route); rows still marked `raw.demo = true` are hidden from everyone else even if stored
  as `gem`. Watchlists in demo orgs match demo tenders silently (no alerts); other orgs never match them.
- Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts` (429 `rate_limited` + `Retry-After`). Generic rules fail
  open with a `rate_limit_unavailable` warn log; `auth.*` rules fail closed with 503 `service_unavailable`.
- Body caps (413 `payload_too_large` before the body is read): JSON 1 MB, vault 20 MB, tender documents 25 MB.
- Body caps are chosen by route: the three upload routes (`POST /api/vault`, `PUT /api/vault/:id/file`,
  `POST /api/tenders/:id/documents`) get their file cap; everything else is 1 MB whatever the content type.
- Client IP (`TRUST_PROXY`):
  - Worker: `cf-connecting-ip`; `worker.ts` sets `TRUST_PROXY=cloudflare`. Do not set it anywhere else: the Node server
    refuses to start with `TRUST_PROXY=cloudflare` because a client could send that header directly.
  - Node behind exactly one reverse proxy: `TRUST_PROXY=1`; the right-most `x-forwarded-for` hop (the one the proxy
    appended) is used. Behind a chain of proxies only the last one's view is used.
  - Node without `TRUST_PROXY`: the socket address. A loopback socket counts as unknown (per-IP rules off) and
    production logs `client_ip_unknown` once — set `TRUST_PROXY=1` in that case.
  - IPv6 clients are limited per /64.
- Fixed windows: a client can burst up to twice a limit across a window boundary. A limiter call slower than 300 ms is
  treated as unavailable (fail-open, `rate_limit_unavailable` logged at most once per rule per 10 s).
