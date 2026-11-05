# Cairn review record: 004 Analyse (T099)

Compiled 2026-11-05 from the PR reviews and comments on GitHub (reviews listed with `pull_request_read`/the REST API). Epic #166. Reviewer: `cairn-reviewer` (Claude, no Codex). US1 to US6 were merged with **no blocking finding open**. Review links point at the review or comment on the PR; the PR's own inline review comments are on the "Files changed" tab.

"B" = blocking, "S"/"SF" = should-fix, "N" = nit or non-blocking observation, as labelled by the reviewer.

| Story | PR | Squash SHA | Rounds | Blocking found | Final verdict |
|---|---|---|---|---|---|
| US1 | [#478](https://github.com/Shashank2577/GEMs/pull/478) | `34aea2b031af63ed34f9acabda97bab8ad679479` | 1 | 0 | APPROVE |
| US2 | [#501](https://github.com/Shashank2577/GEMs/pull/501) | `66ea31b4ac327ec8137dd45b7a5a869521fa495f` | 2 | 0 (2 should-fix) | APPROVE |
| US3 | [#517](https://github.com/Shashank2577/GEMs/pull/517) | `9cf167dbb8fc95600b372e3377b2a91ffcf9fbfc` | 2 | 2 | APPROVE |
| US4 | [#528](https://github.com/Shashank2577/GEMs/pull/528) | `c10a2fb4e9afc6eb3d47738cab16e464c2d9ea74` | 2 | 2 | APPROVE |
| US5 | [#535](https://github.com/Shashank2577/GEMs/pull/535) | `85d9a7768d5bf35efab9c0e14f392a27b92728e7` | 2 | 1 | APPROVE |
| US6 | [#542](https://github.com/Shashank2577/GEMs/pull/542) | `7524ed773b82c2f5cd6b3c41898196599dae3697` | 2 | 1 | APPROVE |
| US7 | [#560](https://github.com/Shashank2577/GEMs/pull/560) | not merged yet (branch `story/GEM-174-ai-ocr`) | 3 | 1 (B1; round 2 N1 to N6 reopened cost control, not labelled B) | APPROVE |

Totals: 7 PRs, 14 review rounds (11 + 3), 7 blocking findings (6 + US7 B1; all resolved in the same PR before merge). US7 round 2 also asked for changes on N1 to N6, cost-control gaps the reviewer did not label B; if counted, the blocking total would be higher. QA rejected US7 once (round 1 of 3). Each PR also has a developer-evidence comment and a QA verdict comment (all `qa:approved`; see `SUMMARY.md`).

Note on Codex: the automatic Codex review on #478 failed ("usage limit reached", [comment](https://github.com/Shashank2577/GEMs/pull/478#issuecomment-6648274776)). Per `CONVENTIONS.md` Codex is not used for this area; it produced no findings.

## US1, PR #478 (T004, T005, T009, T010, T017 to T024)

- Round 1, APPROVE, no blocking: [first posted as a PR comment](https://github.com/Shashank2577/GEMs/pull/478#issuecomment-6648327816); [re-posted as a review on the final head `93c7d7c`](https://github.com/Shashank2577/GEMs/pull/478#pullrequestreview-5779540877) (the playbook "Proof on GitHub" rule).
- Findings (10): S1 GeM body read had no time limit, fixed in `db2eaa3`; S2 changes made while an analysis is `running` are missed by `markStale`, deferred to T074 (#240) and fixed in US6; nits 4, 5, 6, 7, 8 fixed in `db2eaa3`; nit 3 (`markStale` marks all done analyses) and nit 9 (NOTICE links licences) accepted; nit 10 (upload route buffers the body before the size check, ADR-0014) left as a follow-up and later closed by the 008 body-limit middleware (see `apps/api/src/middleware/body-limit.ts`).

## US2, PR #501 (T032 to T037)

- [Round 1, APPROVE](https://github.com/Shashank2577/GEMs/pull/501#pullrequestreview-5779730495): S1 `parseIndianAmount` "first amount wins" turned "3 Years 50 Lakh" into 3 (the turnover blocker would become ₹3); S2 a corrigendum or ATC "Dated:" overwrote `bid_published_at`; nits 3 to 8 (contract-period confidence, delivery row split, consignee state, corpus threshold and unexpected keys, duplicated `CHECK_PREFIX_RE`, `mismatchedDocuments` timestamp).
- [Round 2, APPROVE](https://github.com/Shashank2577/GEMs/pull/501#pullrequestreview-5779892145): all eight resolved in `189b36e`, each with a unit test. The corpus nit produced follow-up T035a (real anonymised PDFs, SC-001), still open.

## US3, PR #517 (T047 to T053)

- [Round 1, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/517#pullrequestreview-5780256890).
  - B1: a run outliving the 2-minute timeout overwrote its replacement, giving two concurrent analyses (FR-028).
  - B2: an override made during a re-analysis was lost (FR-029).
  - S1 to S7: 150-page truncation was only logged; the feed read the latest row of any status; a first run that timed out showed "in progress" forever; an a11y spec excluded removed aria-labels; the failed-attempt warning lacked `role="status"`; raw exception text reached viewers; missing tests.
- [Round 2, APPROVE](https://github.com/Shashank2577/GEMs/pull/517#pullrequestreview-5780424609): B1 fixed with `status='running'`-guarded writes, a 90 s LLM budget and a 409 `analysis_superseded` for the late finisher; B2 fixed by re-reading overrides under the advisory lock; S1 to S7 and nits fixed (migration 0012 `total_pages`, ADR-0007 amendment).
- New in round 2 (should-fix, addressed in the same PR, no third round recorded): SF1 the override response lacked `lastAttempt`/`documents` and the web cache write dropped them; SF2 a 409 on a replaced analysis left the override dialog on the stale id (now `analysis_replaced`). Nits left: raw `error` text still returned by the API, a first run finishing after 2 minutes stays hidden until refetch.

## US4, PR #528 (T061 to T064)

- [Round 1, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/528#pullrequestreview-5780856483).
  - B1: Re-score could clear a staleness that needs a full re-analysis (document added or corrigendum).
  - B2: `saveWeights` marked closed tenders stale (FR-044).
  - S3 to S7: a flag lost to a concurrent weights save, a no-op save still marking stale, spec copy drift, timed-out running rows ignored, missing tests.
- [Round 2, APPROVE](https://github.com/Shashank2577/GEMs/pull/528#pullrequestreview-5780966896): B1 fixed (409 `reanalysis_required`, `markStale` keeps the stronger reason); B2 fixed (`openOnly`); S3 to S7 and nits fixed. The S3 race itself has no test (N4).
- Non-blocking left: N1 ingest's corrigendum UPDATE touched running/failed rows and could deadlock with Re-score (fixed by T074 in US6, see below); N2 preserved reason paired with the newer `staleAt`; N3 dashboard wording for `analysis.rescored`.

## US5, PR #535 (T068 to T070)

- [Round 1, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/535#pullrequestreview-5781268353).
  - B1: readiness matched vault documents by type only, so `other`-typed items and `cert_*` items showed "In vault" for unrelated documents (FR-040).
  - S2 to S5: an import cycle `checklist.ts`/`score.ts`, duplicated expiry maths, the full vault fetched when a workspace exists, test gaps.
- [Round 2, APPROVE](https://github.com/Shashank2577/GEMs/pull/535#pullrequestreview-5781378818): B1 fixed (`other` returns n/a, `cert_*` reuses the scoring matcher; ISO 9001 vs 27001 tests); S2 to S5 and nits fixed (leaf module `vault-match.ts`).
- Non-blocking left: N1 `new Date()` in a `useMemo` (chips can go stale past IST midnight); N2 the Certificates factor also passes via `profile.certifications` while readiness reads only the vault (to be written into FR-040); the certificate name is recovered by stripping the item label.

## US6, PR #542 (T074 to T080)

- [Round 1, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/542#pullrequestreview-5781804653).
  - B1: the corrigendum event and `stale_at` used the ingestion run's start time, so a corrigendum landing mid-run could be cleared on completion (FR-045) or a new document never fetched (FR-046).
  - S1 to S6: a lock-order deadlock risk in Re-score, `markStale` failing after a committed write (500, duplicate retries), a re-fetch failure blocking the tender, a gap between reading inputs and inserting the running row, a forced refresh not marking stale, an O(n squared) lock plan.
- [Round 2, APPROVE](https://github.com/Shashank2577/GEMs/pull/542#pullrequestreview-5782024038): B1 fixed (one write-time stamp in one ingest transaction, slow-run tests); S1 to S6 fixed (id-ordered locks, `markStale` in the same transaction, re-fetch failures fall through, running row inserted in the reading transaction, SHA-256 dedupe under an exclusive lock, CTE). Lock review found no cycle.
- Non-blocking left (listed in `SUMMARY.md` follow-ups): N1 `keepStaleOnCompletion` compares `stale_at >= created_at` across process clocks (use `keep = analyses.stale`); N2 forced refresh hashes stored texts under the exclusive lock; N3 corrigendum re-fetch happens before the 409 `analysis_running` check; N4 timed-out running rows become `failed` with `stale=true`.

## US7, PR #560 (T085 to T095; AI enrichment, OCR, capabilities)

Reviews are posted as review-type comments (state COMMENTED) by `cairn-reviewer`; the PR is not merged yet.

- [Round 1, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/560#pullrequestreview-5784252099) (head `f2a437f`).
  - B1 (blocking): manual OCR was metered with no `analysis_ref`, so it never used the monthly AI quota; a trial org could run OCR 20 times an hour with no monthly cap (ADR-0008, 008 FR-037).
  - S1 to S9: OCR call size/timeout, orphan auto-OCR usage rows, partial OCR stored silently, auto-OCR outside `llmUse` limits, cache rules and the 008 caps raise needing sign-off, eager PDF splitting memory, `needsOcr` not exposed to the web, 008 spec drift, escalation overriding a confident rule item.
- [Round 2, REQUEST_CHANGES](https://github.com/Shashank2577/GEMs/pull/560#pullrequestreview-5784620627) (head `9c3e025`): all round-1 findings resolved; new cost-control findings N1 to N6 (OCR text stored but unpaid, budget failures not recorded, quota pre-check without lock, two manual OCR runs both paying, `?force=1` rewriting a shared GeM row, abandoned reservations) plus N7/N8 nits.
- QA rejection, round 1 of 3: [comment](https://github.com/Shashank2577/GEMs/pull/560#issuecomment-6659094724). Criteria 8 and 9 not met (partly: scanned-only analyse gave 422 against the scenario; token usage redacted in logs) and x4 a11y (aria-label did not contain the visible text), plus minor findings. Reworked in `3dc2922`.
- [Round 3, APPROVE](https://github.com/Shashank2577/GEMs/pull/560#pullrequestreview-5786197795) (head `d8cee29`): all N1 to N7 resolved; lock/handover review found no double release or leak.
- QA round 2: [APPROVED](https://github.com/Shashank2577/GEMs/pull/560#issuecomment-6660586615) (evidence commit `fa912f1`).
- Non-blocking left (round 3):
  - S1: whether a document still needs OCR is not re-checked after `claimOcr`, so a racing run can pay for OCR whose store then returns 409. Re-read the text inside the claim.
  - S2: `autoOcr` runs before `checkAnalysisQuota`, so an org at its `analysesPerMonth` limit still pays an AI slot for OCR, then gets 402.
  - S3: the `settleOrphanOcrSlot` docstring says `finish()` waits for an in-flight call, but a late call can insert a row under the old ref (over-charge, low probability).
  - Nits: auto-OCR claims every candidate up front (manual OCR of skipped documents 409s for the analysis duration); the `ScannedDocumentNotice` live region is inserted with its text and stays after OCR until the next analyse; the claim TTL uses a per-instance clock.

## Developer evidence and QA comments

| PR | Developer evidence | QA verdict |
|---|---|---|
| #478 | [comment](https://github.com/Shashank2577/GEMs/pull/478#issuecomment-6649006002) | [comment](https://github.com/Shashank2577/GEMs/pull/478#issuecomment-6649020788) |
| #501 | [comment](https://github.com/Shashank2577/GEMs/pull/501#issuecomment-6649332445) | [comment](https://github.com/Shashank2577/GEMs/pull/501#issuecomment-6649767478) |
| #517 | [comment](https://github.com/Shashank2577/GEMs/pull/517#issuecomment-6650830072) | [comment](https://github.com/Shashank2577/GEMs/pull/517#issuecomment-6651232670) |
| #528 | [comment](https://github.com/Shashank2577/GEMs/pull/528#issuecomment-6651627952) | [comment](https://github.com/Shashank2577/GEMs/pull/528#issuecomment-6652180822) |
| #535 | [comment](https://github.com/Shashank2577/GEMs/pull/535#issuecomment-6652388413) | [comment](https://github.com/Shashank2577/GEMs/pull/535#issuecomment-6652821869) |
| #542 | [comment](https://github.com/Shashank2577/GEMs/pull/542#issuecomment-6653313629) | [comment](https://github.com/Shashank2577/GEMs/pull/542#issuecomment-6654050656) |
| #560 (US7) | [comment](https://github.com/Shashank2577/GEMs/pull/560#issuecomment-6657001483) | [rejected, round 1](https://github.com/Shashank2577/GEMs/pull/560#issuecomment-6659094724); [approved, round 2](https://github.com/Shashank2577/GEMs/pull/560#issuecomment-6660586615) |
