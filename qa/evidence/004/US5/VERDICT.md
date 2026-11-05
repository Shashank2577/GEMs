## QA verdict - APPROVED

**Work item:** #171 - **PR:** #535 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq

Test file: `e2e/004-analyse/US5-checklist.e2e.ts` (one test per criterion, @mobile variants where layout matters). Tenders are SQL-inserted (no GeM link, the PDF's bid number); the demo company comes from `POST /api/demo/seed`; the non-MSE company is a fresh org with no Udyam.

**Playwright** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **106 passed, 0 failed** (desktop 72 = smoke 1 + US1 18 + US2 13 + a11y 2 + US3 16 + US4 14 + US5 8; mobile 34 = smoke 1 + US1 5 + US2 8 + US3 8 + US4 6 + US5 6).
**API tests**: 644 passed, 1 failed, 2 skipped (35 files). The one failure is `apps/api/test/foundation.test.ts` "logs onboarding.completed once with durationSec" (007 US3, clock timing; same failure seen in the US4 review). **Core tests**: 449 passed, 0 failed (23 files).
Unit/API tests backing the e2e: `packages/core/test/analyse/checklist.test.ts` ("ids are stable across runs", "docType other (atc_/doc_/undertaking_/oem_turnover/unrecognised cert) is n/a", "cert_* items match by title/tags like the Certificates factor (ISO 9001 vs 27001)", "threshold: 30 days is expiring, 31 is ready", "a no-expiry doc makes the item ready").

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo + go-it-services.pdf: badge 13, "13 to submit · 4 we generate for you. Start a bid to auto-match them with your vault.", the 13 items in order | met | API: 13 mandatory, 4 generated. UI: badge 13, exact sentence, row labels equal the documented list in order (the 4 generated are the last four, shown with the Generated badge rather than a "(Generated)" label suffix). `01-demo-checklist-13-items-desktop.png` / `-mobile.png` |
| 2 | Each item: reason of at most 2 lines and a Generated / vault-type / "Action on GeM" badge | met (minor deviation) | All 13 reasons render in at most 2 lines; turnover reason is exactly "Minimum average turnover of ₹50 L required (bid document, page 1)"; the 4 generated rows carry Generated with the tooltip "TenderPilot fills this annexure from your company profile — review and sign it." Deviations: the vault-type badge reads "GST" / "ISO" / "Other" (not "GST certificate"); "Action on GeM" does not occur among the 13 demo items, it appears on the optional EMD item (criterion 3). `02-reasons-and-badges-tooltip-desktop.png` |
| 3 | Non-MSE + nogo-experience.pdf: optional "EMD of ₹50,000 — pay online or submit bank guarantee on GeM" under "Optional & informational (1)"; "Certificates requested in the ATC" listed | met | Toggle collapsed (aria-expanded false), EMD hidden; expanded: aria-expanded true, EMD row with "Action on GeM" + "Optional"; "Certificates requested in the ATC" mandatory row (id atc_certificates). `03a-...`, `03b-optional-expanded-emd-desktop.png`, `03c-...` |
| 4 | With a workspace, description ends "Map them to your vault in the bid workspace." | met | Before: "Start a bid to auto-match them with your vault."; after `POST /api/tenders/:id/workspace`: "13 to submit · 4 we generate for you. Map them to your vault in the bid workspace." and "Start a bid" gone. `04a-before-start-bid-desktop.png`, `04b-after-start-bid-desktop.png` |
| 5 | Re-analysis after ATC with CMMI Level 3 adds "CMMI Level 3 certificate", existing ids unchanged | met | API: ids before (13) all kept; the only new id is `cert_cmmi_level_3`; `gst`, `udyam`, `cert_iso_9001` unchanged; row visible on the page after re-analysis. `05a-before-atc-desktop.png`, `05b-after-atc-cmmi-row-desktop.png` |
| 6 | Empty checklist: "No documents identified" / "Re-analyse after uploading the ATC or corrigendum." | met | An analysis with the checklist emptied in SQL (the case is not reachable through the rules, which always add GST and PAN) shows both texts. `06-empty-checklist-desktop.png` |
| 7 | (gap) Chips "In vault" / "Expires in 10 days" (ISO 9001) / "Missing" without a workspace; other-typed items no chip; ISO 27001 not satisfied by ISO 9001; hidden with a workspace | met (minor deviation) | Demo: GST/PAN/balance sheet/CRAC/Udyam "In vault", ISO 9001 "Expires in 10 days", the Additional Doc ("Other") and Generated rows no chip. "Missing" does not occur for the demo company (its vault covers every typed item), so it is shown in 7b: a bid asking ISO 9001 + ISO 27001 gives ISO 9001 "Expires in 10 days" and ISO 27001 "Missing". With a workspace no chip is rendered. `07a-readiness-chips-desktop.png`, `07b-chips-hidden-with-workspace-desktop.png`, `07c-iso-27001-missing-iso-9001-expiring-desktop.png` |

Videos (one per test): this folder, `N-*-desktop.webm` / `-mobile.webm`.

### Findings

1. **minor** - The vault-type badge uses the short document-type label ("GST", "ISO", "CA certificate"), not the example "GST certificate" in the criterion.
2. **minor** - "Action on GeM" never appears on a mandatory demo item; it only shows on rows without a vault type (the optional EMD payment).
3. **observation** - The demo CA turnover certificate also shows "Expires in 25 days" (a second warning chip); not in the criterion, consistent with the validity rule.
4. **observation** - Criterion 6 is proven by emptying the checklist in SQL; no unit test covers the empty state.
5. **observation (not US5)** - `apps/api/test/foundation.test.ts` "logs onboarding.completed once with durationSec" fails (007 US3).

### Not checked

- "Vault status unavailable" hint when the vault request fails; sticky positioning at 1280 px; LLM-added `other` items (rules-only run).

### Bug issues filed

- none

### Verdict

`qa:approved` - all 7 criteria met (2 and 7 with minor deviations); T070 ticked.

---
_Generated by [Claude Code](https://claude.ai/code)_
