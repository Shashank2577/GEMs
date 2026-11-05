# QA evidence summary: 005 Profile and Vault

**Area:** 005-profile-vault (company profile, completeness, vault, expiry reminders, experience and OEM, renew and history, hardening)
**Epic:** #113 · **Umbrella:** #1 · **Date:** 2026-11-05

All stories and the HARDEN pass are `qa:approved`. Numbers are taken from the VERDICT files; `n/a` means the VERDICT does not state it. "Criteria" counts the rows of each VERDICT's acceptance-criteria table (sub-rows such as 2a/2b count separately).

## Per-story results

| Story | Issue | PR | Squash SHA | Verdict | Criteria (total / met / not met / unverifiable) | Playwright (desktop + mobile) | API / unit tests | VERDICT |
|---|---|---|---|---|---|---|---|---|
| US1 Validated profile | #114 | #472 | `0d293aab83e75e490297f99d802a90d2819baf4c` | approved | 20 / 20 / 0 / 0 | 20 passed (17 + 3) | n/a | [US1](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US1/VERDICT.md) |
| US2 Completeness and financials | #115 | #473 | `7728ae2d48205b4c20faffee8b2e0e3c3a6b8d82` | approved | 27 / 27 / 0 / 0 | 14 passed (13 + 1) | n/a | [US2](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US2/VERDICT.md) |
| US3 Vault | #116 | #477 | `3b4599742c2a49b59d94a3fc7a242e1dd1727b77` | approved (re-review after 1 rejection) | 31 / 30 / 0 / 1 (axe NFR-005 not checked in this story; covered later by HARDEN T075) | 18 passed (17 + 1), 1 skipped | n/a | [US3](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US3/VERDICT.md) |
| US4 Expiry reminders | #117 | #481 (+ #489 `ef5707798fd2a271966ecc3321ee2968f27cb0bd`, dashboard label fix) | `2a16489a32a1571e7cfa1af57f7b4598a1e5539e` | approved | 19 / 19 / 0 / 0 | 11 passed (9 + 2) | n/a | [US4](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US4/VERDICT.md) |
| US5 Experience and OEM | #118 | #484 | `36dd4efdac276df30f4e7d23041b3ceb58d9280c` | approved (re-review after 1 rejection) | 26 / 26 / 0 / 0 | 23 passed, 1 skipped of 24 runs | n/a | [US5](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US5/VERDICT.md) |
| US6 Renew and history | #119 | #486 | `9fe86e3f74020f47489034d028faa9ece3d09eaf` | approved | 20 / 20 / 0 / 0 | 18 passed (11 + 7) | n/a | [US6](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/US6/VERDICT.md) |
| HARDEN (T002, T003, T009, T074, T075, T076) | none | #504 | `4982e028179ee15301c185704f6ed09d75e64bee` | approved ([verdict comment](https://github.com/Shashank2577/GEMs/pull/504#issuecomment-6650144067)) | 7 / 7 / 0 / 0 | 110 run: 108 passed, 0 failed, 1 skipped, 1 flaky; a11y spec 6 passed | core 379; API 451 passed, 2 skipped (514 passed after the final main merge); `vault.test.ts` 96; web 165 | [HARDEN](https://github.com/Shashank2577/GEMs/blob/4982e028179ee15301c185704f6ed09d75e64bee/qa/evidence/005/HARDEN/VERDICT.md) |

## HARDEN results (PR #504)

- **Accessibility (T003, T075, NFR-005):** `@axe-core/playwright` 4.14.0 with an `a11y()` helper. All 28 `*.axe.json` reports have 0 serious/critical violations; the a11y spec passed 6 of 6 (desktop and mobile). The PR body says 30 scans; 28 report files exist.
- **Tenant isolation (T076):** the table-driven cross-org sweep in `apps/api/test/vault.test.ts` passed 14 of 14; every id-addressed vault, version and past-contract route returns 404 for another org.
- **Migration (T009):** `vault_expiry_idx` on `vault_documents(expiry_date)`. The migration was renumbered to `0011_vault_expiry_idx.sql` when main took `0009` before merge.
- **Helpers (T002) and docs (T074):** 005 E2E helpers in `e2e/support/fixtures.ts`; `contracts/api.md` and `data-model.md` updated.
- **Cross-team checks:** 006 US1 + 002 US2 passed 13 of 13; 003 US2 passed 20 of 20 on a fresh DB (its setup assumes a clean DB).
- **Cairn review of PR #504:** round 1 changes requested (B1: 003 watchlist locator broken by the `ChipInput` label; fixed), round 2 approve.

## Rework history and known flaky tests

| Story | Rework |
|---|---|
| US3 (#116, PR #477) | 1 rejection: horizontal overflow on phone `/vault` (NFR-006). Fixed in cbe30ba; re-review passes at 375 px and 412 px. |
| US5 (#118, PR #484) | 1 rejection: Delete from the actions menu also opened Edit. Fixed in 663b8c0. |
| US4 (#117) | No rejection; follow-up PR #489 fixed a dashboard label. |
| US1, US2, US6 | No rejection. |
| HARDEN (#504) | Cairn round 1 changes requested (see above); QA approved first time. |

**Known flaky tests:** US5 AC10b and AC10c; US3 AC2 flaked once in the HARDEN full run (passed 3 of 3 alone).

## Area cairn review (T077)

Opus cairn review of the whole 005 surface at `main` 4982e02: **APPROVE, no blocking findings.** Every mutating route is org-scoped and in the roles matrix; the cross-org 404 sweep covers all vault, version and past-contract routes; replace and delete are transactional (replace uses compare-and-swap on `blob_key`); reminder dedupe is safe under overlap; every FR-001..FR-068 has an implementing path, with server-side FRs covered by API/unit tests (FR-047 is the weak spot) and UI-only FRs covered by Playwright.

Non-blocking findings are tracked in **#512**:
- reminder job can overwrite a renewal's reminder reset (lost 30-day reminder);
- delete concurrent with replace can leak one blob; profile save can link a document being deleted;
- stricter `isoDateSchema` may block profile saves for legacy impossible `validTill` dates;
- CIN year bound uses the wall clock; org deletion leaves blobs; reminder scan has no lower date bound;
- FR-047 untested; `POST /vault/reminders/run` unthrottled; spec/plan/api.md drift.

Other leftovers: shell Account menu / org switcher `label-content-name-mismatch` (#505, 002/007); repeated hard-coded tone colours should become a design token.

`needs-human`: none.
