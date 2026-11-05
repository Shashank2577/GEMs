# 006 Apply & Packet Assist — QA summary (T098 / SC-006)

All seven user stories plus the cross-cutting HARDEN story are QA-approved. Epic: #173.

| Story | Story issue | PR | Squash SHA | QA verdict | Evidence |
|---|---|---|---|---|---|
| US1 Workspace stages | #176 | #471 | d919033 | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US1/VERDICT.md) |
| US2 Mapping and readiness | #179 | #483 | 7839493 | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US2/VERDICT.md) |
| US3 Overrides and comments | #181 | #503 | d7444ba | approved (rejected once for axe contrast, fixed) | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US3/VERDICT.md) |
| US4 Annexures | #184 | #488 | 3e3370d | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US4/VERDICT.md) |
| US5 Packet | #186 | #498 | 703301b | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US5/VERDICT.md) |
| US6 Assisted submission | #188 | #520 | 53aa5e4 | approved (rejected once: axe, DSC outline, copy; fixed) | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US6/VERDICT.md) |
| US7 Submission outcome | #191 | #529 | 3ffd799 | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/US7/VERDICT.md) |
| HARDEN (T002/T004/T010/T096/T097/T098) | none (epic #173) | #536 | pending merge (head d5cb2b2 plus the QA evidence commit) | approved | [VERDICT](https://github.com/Shashank2577/GEMs/blob/story/GEM-173-hardening/qa/evidence/006/HARDEN/VERDICT.md) |

Latest full regression (HARDEN QA): `pnpm exec playwright test e2e/006-apply-packet-assist` → 132 passed, 0 failed.

## Cairn review verdicts
- Per-story cairn reviews were posted as GitHub PR reviews on each PR above.
- HARDEN #536: round 1 (at dc35034) requested changes for one blocker, migration number collision with main; resolved in d5cb2b2 (renumbered to 0020, dedupe DELETE kept). No later review round is recorded on the PR at the time of this QA pass.

## T098 spec-to-code traceability (FR-001..FR-092, NFR, SC)
All seven stories are implemented and tested. Gaps:
- SC-004: mapping test corpus is partial.
- SC-003: the Ready-guard API test matrix is partial.
- NFR-008 (determinism) traceability: partial.
- NFR-003 (packet build memory vs 60 MB cap): open, #500.
- Added in the HARDEN PR: NFR-001/SC-007 perf test, FR-044 and FR-067 assertions.

## Constitution I checklist: PASS
No price, CAPTCHA, OTP, DSC, e-Sign or final-submit automation in apps/extension or apps/api; manifest permissions are storage and activeTab; content script limited to *.gem.gov.in.

## Open follow-ups
- #494 Annexures: phone breakpoint 768 vs spec 640; palette aria-label/visible text mismatch
- #500 NFR-003 packet build memory vs the 60 MB input cap
- #537 needs-human: ratify or replace the unlicensed GEM-SCRAPER port exception
- #538 Narrow read-only API tokens to the routes the extension needs
- Observation from HARDEN QA: shared workspace header buttons fail axe label-content-name-mismatch on a full-page scan

## Perf and model policy
- Perf NFR-001: p95 87 ms against the 600 ms budget.
- Every story was reviewed by cairn on Opus. Opus development escalations: US6 T078/T079.

## Other notes for the human
- Pre-existing failing 007 test `PATCH /org onboarding state ... durationSec` fails on main; not caused by 006.
- A stray 627-byte file `/m` outside the repo was created by an agent; please delete it.
