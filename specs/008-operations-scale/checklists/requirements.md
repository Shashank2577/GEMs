# Cross-spec consistency analysis: Operations & Scale (008) against 002, 003, 006, 007 (and 001, 004)

**Purpose**: Confirm that no requirement is owned twice, that the three-way conflicts found while building 008 are
reconciled in one place, and list what is still open with an owner (task T115, #372, FR-023).

**Created**: 2026-11-05 | **Checked against**: `main` at `c75d2b6` plus the open PRs #475 (US1) and #492 (US2) | **Method**: read
the ownership table of `spec.md`, then grep each overlapping requirement in the sibling specs, `contracts/api.md`,
`docs/runbook.md` and the code that shipped. Every finding below was checked in the repository, not copied from a spec.

**Result**: 8 findings resolved in code and docs, 7 open (F-05 R2 packet lifecycle, F-08 numbering, F-10 003 cooldown text, F-11 trial copy in 007, F-12
referrer policy, F-13 Go/No-Go role, F-15 test-alert limiter). None of the open items blocks the shipped behaviour; F-12 must be settled before
PR #492 merges.

## Resolved

| ID | Overlap | Owner of the final rule | How it was reconciled | Where |
|---|---|---|---|---|
| F-01 | 008 FR-028 vs 003 FR-028: candidate cap for watchlist preview and back-fill | 003 | 003 prevails: no silent row cap; `candidateTenders` is bounded by open + not yet closed, a slim projection and keyset paging. 008 only adds the indexes (FR-027) | `apps/api/src/routes/watchlists.ts`, 008 spec ownership table |
| F-02 | 008 FR-032 vs 006 FR-056: packet input size | 006 (size), 008 (item count) | 006 keeps the configurable `PACKET_MAX_INPUT_BYTES` (code default 60 MB, message and `details` per 006); the Worker sets 40 MB in `wrangler.toml`; 008 adds only the 40-item cap with its own `details` | `contracts/api.md` (`packet_too_large`), `.dev.vars.example` |
| F-03 | 008 FR-030 vs 004 NFR-005: page caps | 008 | 300-page refusal (`document_too_long`) before any text is read, 150 pages read with a `pages_truncated` warning; 004's 25 MB / memory NFR is unchanged and complementary. `tender_documents.total_pages` records the real count | `contracts/api.md`, `data-model.md` |
| F-04 | 008 FR-036 vs 003 FR-027: watchlist limit | 003 (50 hard cap), 008 (plan limit) | `PLAN_LIMITS.watchlists: null` means "no plan limit" and `effectiveLimit()` still applies 50; starter's 5 is lower. Two different codes: 409 `watchlist_limit` (cap) and 402 `plan_limit_reached` (plan) | `packages/core/src/contracts/plans.ts`, `contracts/api.md` |
| F-06 | 002 FR-010 and 008 FR-017 to FR-022: rate limits owned twice | 002 (auth numbers), 008 (engine and all other rules) | One table `rate-limit-rules.ts`: the `auth.*` rules import their numbers from spec 002's `lib/rate-limit.ts`, so each limit is defined once; `engine: 'auth-attempts'` vs `'generic'` records which mechanism enforces it. Auth rules fail closed (503 `service_unavailable`), the others fail open | `apps/api/src/lib/rate-limit-rules.ts`, runbook § Abuse and isolation controls |
| F-07 | Health endpoint: 001/002 `{ok,db,version}` vs 008 FR-044 health v2 | 008 | 008 owns `GET /api/health`; 002/003 only consume sync health (`/ingestion/runs`). The contract now documents v2 (`ingestion`, `alerts`, `reasons`, 200/503) | `contracts/api.md` (Platform) |
| F-09 | Isolation sweep: 002 T052 and 008 T048 / FR-016 | 002 (resource sweep), 008 (contract-driven sweep) | Two files with distinct jobs: `isolation.test.ts` (002, one of each org-scoped resource) and `isolation-contract.test.ts` (008, every route of `contracts/api.md`, demo tenders). The runbook release gate names both | `apps/api/test/`, runbook § Release gate |
| F-14 | 007 `PLANS` display config vs 008 `PLAN_LIMITS`: plans file | 007 (display) and 008 (limits), same file | Both live in `packages/core/src/contracts/plans.ts` with separate exports; the Settings and landing pages read limits from `PLAN_LIMITS`, never a second copy | `packages/core/src/contracts/plans.ts` |

## Open

| ID | Overlap | Proposed owner | What is wrong | Action |
|---|---|---|---|---|
| F-05 | 008 FR-071 vs 006 packet R2 key: lifecycle rule on `org/*/packets/` | 008 (#552) | 006 pins the key `org/<orgId>/packets/<packetId>/…`, which sits next to vault files under `org/`, so one `org/` lifecycle rule would also expire customer vault files. No rule is configured; DB-driven housekeeping is the only packet expiry. The runbook states it and the options (a) top-level `packets/` prefix, (b) one rule per org | Decide #552: (a) top-level `packets/` prefix then a lifecycle rule, or (b) one rule per org; until then DB-driven housekeeping is the only packet expiry (US7 verdict: partial) |
| F-08 | ARCH numbering: spec 008's ownership table vs `docs/architecture.md` § 7 | 008 (spec text) | The ownership table calls ARCH-12 "password reset" and ARCH-13 "isolation sweep" and cites ARCH-19 to ARCH-26; `docs/architecture.md` § 7 defines ARCH-12 as the isolation sweep, ARCH-13 as matching efficiency and ends at ARCH-18 (no ADR defines ARCH-19 to ARCH-26). The runbook launch checklist follows `architecture.md` | Renumber the ownership table (ARCH-11 rate limits, ARCH-12 isolation; password reset, `bad_origin` and invite binding are 002 requirements, not an ARCH id) and either define ARCH-19 to ARCH-26 in § 7 or drop the references. Docs-only |
| F-10 | 003 FR-013 and scenario 11 still say "2-minute cooldown"; 008 FR-026 made it 10 minutes, cluster-wide | 003 (text), 008 (behaviour, shipped in US4) | The behaviour is 10 minutes (`MANUAL_SYNC_COOLDOWN_MIN`, default 10); spec 003 carries no supersession note, so a reader of 003 alone gets the wrong number | Add "(superseded by 008 FR-026: 10 minutes)" to 003 FR-013, scenario 11 and its task (003 `tasks.md` line 87, T021 "within 2 min"). Docs-only |
| F-11 | Trial copy: 007 scenario "You are starting a 14-day free trial of Pro" vs 008 trial limits | 007 (text) | Code already follows 008: the sign-up note names the enforced trial caps (10 analyses, 1 GB vault) instead of promising Pro (`landing.test.tsx`, 008 review S6). The 007 spec scenario still quotes the old sentence | Update 007's scenario 11 to the delivered sentence. Docs-only |
| F-12 | `Referrer-Policy`: 002 FR-050 shipped `no-referrer`; 008 FR-013 and PR #492 set `strict-origin-when-cross-origin` | 008/US2 (#492) with 002 | `no-referrer` is deliberate (`packages/core/src/security/headers.ts`): invite and reset links carry secrets in the path (`/invite/<token>`, `/reset-password/<token>`). PR #492 replaces the value in the API headers, `apps/web/public/_headers` and `scripts/smoke.sh`. `strict-origin-when-cross-origin` sends only the origin cross-site, so Google Fonts would not see the token, but it sends the full URL, token included, on same-origin requests (the API, its logs and Sentry breadcrumbs) and it silently reverses a shipped 002 decision | | Decide in #492 before merge: keep `no-referrer` (preferred; change FR-013 and the smoke script) or document why the weaker policy is acceptable. Blocking for #492 |
| F-13 | Go / No-Go role: 001 and 004 say the Bid Manager decides; 006 FR-004 and 007 FR-072 let an Analyst `PATCH /workspaces/:id {stage:'go'}` | 006 and 007 (architect decision), tracked in #527 item 5 | The UI hides "Go" and "Drop" from analysts but the API accepts them (200). Precedence is unresolved; 008 adds no role rule | Decide: bid_manager+ for `go`, `no_go` (`dropped`) at the API (then amend 006 FR-004 and 007 FR-072, with a test), or accept analyst+ and reword 001/004. Tracked in #527 |
| F-15 | `POST /me/notifications/test` rate limit (`TEST_ALERT_LIMIT`, 1/min per user, spec 002 limiter in `lib/rate-limit.ts#hit`) vs 008 F-06 "each limit defined once" | 008 (#559) | The route is the one limit outside `rate-limit-rules.ts`, and its 429 reports `details.rule: "auth.fail.email"` because `rateLimited()` defaults `rule` (`lib/rate-limit.ts:102`) | Fix in #559: pass a rule name, or move the limit into the table. Documented as an exception in `contracts/api.md` |

## Checked and clean (no duplicate ownership)

- Notification retries: 003 owns `notifications.attempts` and back-off (003 FR-047); 008 owns only the pending-notifications index (FR-029) and the Resend batch call (FR-074). No overlap in code.
- Session, cookie and CSRF: 002 owns the cookie flags and `bad_origin` (FR-028); 008 adds headers (FR-013) and the release gate (FR-023) and defines nothing about sessions. The only conflict is F-12.
- `POST /ingestion/run` error codes: 003 owns `ingestion_running` (409) and introduced `sync_cooldown` (429, 003 FR-013 and T021); 008 FR-026 owns only its duration (10 minutes) and cluster-wide scope, and the single-running index (see F-10). Both are in `contracts/api.md`.
- Demo data: 007 owns the seeder and `DELETE /demo`; 008 owns visibility (FR-016) and the quota exemption (`analyses.seeded`, FR-036). `plan_expired` allows `DELETE /demo` (FR-038).
- Contracts and data model: every 008 addition is folded into `specs/001-gem-tender-copilot/contracts/api.md` and `data-model.md` (T008); secrets list in 001 `plan.md` (T009).

## Re-run

`/cairn-analyze` is a read-only skill that needs the whole feature folder; the above was produced by the same checks done by
hand because the sibling specs are large. To refresh: grep `ARCH-`, `cooldown`, `Referrer-Policy`, `PLAN_LIMITS`,
`rate-limit-rules` and `isolation` across `specs/`, `docs/` and `apps/api/src`, update the tables, and change the date above.
