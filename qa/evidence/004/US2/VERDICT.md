## QA verdict — APPROVED

**Work item:** #168 · **PR:** #501 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mJEssFE1nnr8kMX8Ue

Run with no LLM key configured (rules-only). Test file: `e2e/004-analyse/US2-extraction.e2e.ts` (one test per criterion; analyses driven through the real API, Requirements tab asserted in the real UI).

**Playwright** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **46 passed, 0 failed** (desktop 32 = smoke 1 + US1 18 + US2 13; mobile 14 = smoke 1 + US1 5 + US2 8).
**API tests** (`TEST_DATABASE_URL=… pnpm --filter @tp/api exec vitest run`): 383 passed, 1 skipped, 0 failed (20 files). **Core tests** (`pnpm --filter @tp/core exec vitest run`): 353 passed, 0 failed (20 files).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Rules-only analysis of go-it-services.pdf returns 201, method `rules`, 32 requirements: turnover_min 5000000 p1, experience 3 p1, mse/startup exemption true, estimated_value 4800000, emd 96000, epbg 3%/14 months, mii true p2, delivery 30 days p3, similar_work ₹19,20,000 p4 conf 0.85, ISO 9001 p4, non_blacklisting p4, 4 document items, bid_published_at p1, consignee_state Delhi p3 | met | `01-rules-only-analysis-desktop.png`, `01-rules-only-analysis-mobile.png`; test 1 asserts every value/page and that all 32 are method RULE |
| 2 | Requirements tab header "32 requirements extracted · 32 by rules"; groups Eligibility criteria (6) / EMD, ePBG & exemptions (7) / Documents required from seller (4) / Bid details (15) with counts; mandatory dots, Rule badges, confidence bars | met | `02-requirements-header-desktop.png`, `02-requirements-header-mobile.png` (32 visible Rule badges and 32 confidence bars asserted, no AI badge) |
| 3 | Clicking "p. 4" chip opens …/download?inline=1#page=4; chip aria-label "Open go-it-services.pdf at page 4" | met | `03-page-chip-desktop.png`; href asserted to end `/documents/<id>/download?inline=1#page=4`, target `_blank`, click issues the inline download request, response 200 `application/pdf` with inline disposition. Headless Chromium has no PDF viewer so the opened tab's URL cannot be read; the fragment is verified on the href |
| 4 | Filter "emd" narrows rows; "zzz" shows "Nothing matches" | met | `04-filter-emd-desktop.png`, `04-filter-zzz-desktop.png`, `04-filter-emd-mobile.png`, `04-filter-zzz-mobile.png` |
| 5 | Bilingual/wrapped labels parse bid_end 2026-11-28T15:00:00+05:30 | met | `05-bid-end-parsed-desktop.png`; go-it-services gives 2026-11-28T15:00:00+05:30; Hindi-first real-ra-bid (interleaved wrapped labels) 2026-11-18T11:00 and real-goods-bid 2026-11-14T13:00; no Devanagari in quotes |
| 6 | Uploaded corrigendum supersedes bid_end; multi-valued items from both docs kept | met | `06-corrigendum-supersedes-desktop.png`; bid_end 2026-11-28 becomes 2026-12-12T18:00:00+05:30 (single row), 4 bid documents + 1 corrigendum document = 5, emd untouched |
| 7 | Missing EMD/estimated value come from listing with "GeM BidPlus listing data", "Listing" source, 70% | met | `07-listing-fallback-desktop.png`, `07-listing-fallback-mobile.png` |
| 8 | review-hardware-oem.pdf yields turnover 15000000, oem_turnover 2000000000, past_performance 20%, oem_auth 0.95, BIS, BoQ compliance document | met | `08-hardware-oem-desktop.png` |
| 9 | No documents and no GeM link gives 422 no_documents; UI toast "Add the bid document first" with Upload PDF action, switches to Documents tab | met | `09-no-documents-toast-desktop.png`, `09-no-documents-toast-mobile.png` |
| 10 | GeM link and no docs auto-fetches then 201 | met | `10-auto-fetch-documents-desktop.png`, `10-auto-fetch-requirements-desktop.png`; one `gem` bid document appears, analysis done, method rules |
| 11 | "MSE/Startup Relaxation … Yes \| Complete / No \| Complete" gives mse_exemption true / startup_exemption false | met | `11-mse-startup-relaxation-desktop.png` (real-service-bid.pdf) |
| 12 | contract_period "2 years" (24 months) and bid_published_at from "Dated:" | met | `12-contract-period-published-desktop.png`, `12-contract-period-published-mobile.png` (UI shows "2 years (24 months)", published 1 Nov 2026) |
| 13 | Mismatched document bid number: summary "Check documents: …" and Requirements warning callout | met | `13-check-documents-callout-desktop.png`, `13-check-documents-callout-mobile.png`; a matching document gives no prefix and no callout |

Developer evidence retained: `dev-desktop-analysis-summary-check-documents.png`, `dev-desktop-requirements-new-keys-and-callout.png`, `dev-mobile-analysis-summary-check-documents.png`, `dev-mobile-requirements-new-keys-and-callout.png`. One .webm per test sits beside the screenshots.

### Findings

1. **observation** — Documents fetched from GeM are stored shared (org_id null) per tender, so once any org auto-fetches a GeM tender's document, every later org's analysis of that tender also includes it (observed: 34 instead of 32 requirements when go-it-services was uploaded to an already-fetched tender). This is the documented design (`apps/api/src/services/analyse.ts` fetchGemDocuments); tests use tenders without a GeM link, or a fresh GeM tender for criterion 10, to stay deterministic.
2. **observation** — Criterion 3 cannot be exercised end to end in headless Chromium (no inline PDF viewer); verified at href + network level.

### Not checked

- Real GeM BidPlus documents (only generated fixtures in the GeM layout; the real-* corpus is synthesised, as the PR states).
- LLM-assisted extraction (no key configured; out of scope for this story).

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.

---
_Generated by [Claude Code](https://claude.ai/code)_
