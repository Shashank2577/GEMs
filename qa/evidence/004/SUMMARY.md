# QA evidence summary: 004 Analyse (bid documents, extraction, Go/No-Go scoring)

**Area:** 004-analyse-scoring · **Epic:** #166 · **Date:** 2026-11-05 · **Status:** US1 to US6 `qa:approved`; **US7 pending** (AI enrichment and OCR, not built yet)

Numbers come from the `VERDICT.md` files. "Criteria" counts the rows of each VERDICT's acceptance-criteria table. All links are pinned to the story's squash commit on `main`, not to a branch name.

## Per-story results

| Story | Issue | PR | Squash SHA | Verdict | Criteria (total / met / not met) | Deviations | Playwright (desktop + mobile) | Evidence | VERDICT |
|---|---|---|---|---|---|---|---|---|---|
| US1 Documents (fetch/upload) | #167 | [#478](https://github.com/Shashank2577/GEMs/pull/478) | `34aea2b031af63ed34f9acabda97bab8ad679479` | approved | 27 / 27 / 0 | none | 23 (18 desktop + 5 mobile) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/34aea2b031af63ed34f9acabda97bab8ad679479/qa/evidence/004/US1) | [US1](https://github.com/Shashank2577/GEMs/blob/34aea2b031af63ed34f9acabda97bab8ad679479/qa/evidence/004/US1/VERDICT.md) |
| US2 Extraction | #168 | [#501](https://github.com/Shashank2577/GEMs/pull/501) | `66ea31b4ac327ec8137dd45b7a5a869521fa495f` | approved | 13 / 13 / 0 | none | 21 (13 + 8) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/66ea31b4ac327ec8137dd45b7a5a869521fa495f/qa/evidence/004/US2) | [US2](https://github.com/Shashank2577/GEMs/blob/66ea31b4ac327ec8137dd45b7a5a869521fa495f/qa/evidence/004/US2/VERDICT.md) |
| US3 Scoring | #169 | [#517](https://github.com/Shashank2577/GEMs/pull/517) | `9cf167dbb8fc95600b372e3377b2a91ffcf9fbfc` | approved | 16 / 16 / 0 | criterion 6 "Go 82" holds only on a tender naming no product (finding 1) | 24 (16 + 8) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/9cf167dbb8fc95600b372e3377b2a91ffcf9fbfc/qa/evidence/004/US3) | [US3](https://github.com/Shashank2577/GEMs/blob/9cf167dbb8fc95600b372e3377b2a91ffcf9fbfc/qa/evidence/004/US3/VERDICT.md) |
| US4 Override and weights | #170 | [#528](https://github.com/Shashank2577/GEMs/pull/528) | `c10a2fb4e9afc6eb3d47738cab16e464c2d9ea74` | approved | 14 / 14 / 0 | none | 20 (14 + 6) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/c10a2fb4e9afc6eb3d47738cab16e464c2d9ea74/qa/evidence/004/US4) | [US4](https://github.com/Shashank2577/GEMs/blob/c10a2fb4e9afc6eb3d47738cab16e464c2d9ea74/qa/evidence/004/US4/VERDICT.md) |
| US5 Checklist | #171 | [#535](https://github.com/Shashank2577/GEMs/pull/535) | `85d9a7768d5bf35efab9c0e14f392a27b92728e7` | approved | 7 / 7 / 0 | criteria 2 and 7: minor wording deviations (badge uses the short type label; "Action on GeM" never on a mandatory demo item) | 14 (8 + 6) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/85d9a7768d5bf35efab9c0e14f392a27b92728e7/qa/evidence/004/US5) | [US5](https://github.com/Shashank2577/GEMs/blob/85d9a7768d5bf35efab9c0e14f392a27b92728e7/qa/evidence/004/US5/VERDICT.md) |
| US6 Stale and re-analyse | #172 | [#542](https://github.com/Shashank2577/GEMs/pull/542) | `7524ed773b82c2f5cd6b3c41898196599dae3697` | approved | 8 / 8 / 0 | criterion 2: History says "Closing date", criterion says "Bid end date" (minor); 2 extra scenarios also met | 16 (10 + 6) | [screenshots and videos](https://github.com/Shashank2577/GEMs/tree/7524ed773b82c2f5cd6b3c41898196599dae3697/qa/evidence/004/US6) | [US6](https://github.com/Shashank2577/GEMs/blob/7524ed773b82c2f5cd6b3c41898196599dae3697/qa/evidence/004/US6/VERDICT.md) |
| US7 AI enrichment and OCR | #174 | none yet | n/a | **pending** | n/a | n/a | n/a | n/a | n/a |

**Totals (US1 to US6):** 85 acceptance criteria (plus 2 extra scenarios in US6), 85 met, 0 not met, 0 unverifiable; 6 stories approved. Final cumulative Playwright run in the US6 verdict (`e2e/000-smoke e2e/004-analyse`, desktop and mobile): **122 passed, 0 failed**. No story needed a QA rejection; every PR needed 0 or 1 cairn rework round (see [REVIEWS.md](REVIEWS.md)).

**Traces:** Playwright traces were not committed; the evidence is full-page screenshots (desktop and mobile) and one video per test. **Per-scenario results are in each VERDICT's criteria table** (criterion, verdict, evidence); the links above open them.

## Other test results at the last story gate (US6, `d8d2345`)

- API: 721 passed, 1 failed, 2 skipped (38 files). The failure is `apps/api/test/foundation.test.ts` "logs onboarding.completed once with durationSec" (007 US3, clock timing, pre-existing, not in this area).
- Core: 480 passed. Typecheck clean.

## Deviations recorded in the VERDICT files

- **US3 finding 1 (minor):** criteria 6 and 16 give the same inputs but cannot both give "Go 82". 82 appears only when the tender's title and category name no product; a product-named tender gives OEM Needs review and Go 76. Spec criterion 6 was reworded in the HARDEN pass (see `specs/004-analyse-scoring/analysis-report.md`, F2).
- **US5 findings 1 and 2 (minor):** the vault-type badge shows the short type label ("GST", "ISO") rather than the example "GST certificate"; "Action on GeM" only appears on rows without a vault type (the optional EMD payment).
- **US6 finding 1 (minor):** History shows "Closing date: old -> new" where the criterion text says "Bid end date".
- **Observations (no action):** the GeM copy of a bid document is shared across orgs, so a tender already fetched by another org adds its requirements to a later analysis (US2); headless Chromium has no inline PDF viewer, so "View opens at page N" was checked at href and network level (US1, US2); US4 criterion 13 corrigendum case and US6 criterion 8 (`documentUrl` change) are proven at API level, the UI uses an uploaded document or a SQL-inserted event.
- **Not checked in any story:** real GeM BidPlus documents (generated fixtures and mock-gem only) and LLM-assisted extraction/scoring (rules-only runs, no key).

## Known follow-ups (from the cairn reviews and VERDICTs)

Non-blocking items left open at merge; none block the area. Sources: [REVIEWS.md](REVIEWS.md).

- **T035a:** SC-001 is measured on a synthesised corpus; genuine anonymised GeM PDFs are still needed. See `specs/004-analyse-scoring/corpus/README.md`. **needs-human**.
- **`keepStaleOnCompletion` clock safety (US6 N1):** `stale_at >= created_at` compares timestamps that can come from different process clocks. A running row starts `stale=false`, so `keep = analyses.stale` would be simpler and clock-safe; the test "a flag older than created_at is cleared" would be replaced.
- **Forced-refresh hashing under the lock (US6 N2):** `fetch-documents?refresh=1` hashes the stored texts while holding the exclusive tender-input lock (`analyse.ts` around line 326). Hash before locking or store a hash column.
- **Corrigendum re-fetch before the 409 check (US6 N3):** The re-fetch of the GeM document happens before `analysis_running` is checked.
- **Timed-out running rows (US6 N4):** They become `failed` with `stale=true`, a flag nobody reads.
- **Readiness chips use a stale `now` (US5 N1):** `AnalysisPanel.tsx` captures `new Date()` in a `useMemo` with no clock dependency, so chips can stay stale past IST midnight.
- **FR-040 certification note (US5 N2):** The Certificates factor also passes via `profile.certifications`, while checklist readiness reads only the vault, so a certificate can score Pass and still show "Missing". Write this into FR-040. The certificate name is also recovered by stripping the item label, which is fragile.
- **Spec criterion 6 "Go 82" wording (US3):** Reworded in the HARDEN pass. Related: the "Go 82" screenshot `06-go-82-desktop.png` only holds for a tender with no product word.
- **Upload body limit / ADR-0014 (US1 nit 10):** The upload route buffered the whole multipart body before the 25 MB check. A body-limit middleware (`bodyLimit`, 008/FR-021) now guards the route; no open action unless the cap is changed.
- **Override response and dialog (US3 nits):** The API still returns raw `error` text on a failed attempt (UI maps it through `friendlyAnalysisError`); a first run finishing after the 2-minute mark stays hidden until the next refetch.
- **Weights save race test (US4 N4):** The race between Re-score and `saveWeights` (row read FOR UPDATE) has no test; dashboard wording for `analysis.rescored` (N3) and the preserved-reason/newer-`staleAt` pairing (N2) are open nits.
- **Evidence nit:** US1 observation: a bid-number-mismatch warning toast stacks over the "uploaded" toast and partly covers its Re-analyse action.

## Open in the epic

- **US7** (#174, T085 to T094): AI enrichment, OCR, capabilities endpoint. When it lands: add its VERDICT row here, complete the pending section of `contracts/api.md § Analyse` (T095) and re-run this aggregation (T100).
- **T100** stays open because US7 is pending; **T099** stays open until the US7 PR has its cairn review.
- `needs-human`: T035a (real GeM PDFs).
