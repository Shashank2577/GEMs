## QA verdict — APPROVED

**Work item:** #115 · **PR:** #473 · **Reviewer:** qa (claude-code/sonnet) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Suite: [`e2e/005-profile-vault/US2-completeness.e2e.ts`](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/e2e/005-profile-vault/US2-completeness.e2e.ts) — 14 runs (13 desktop + 1 @mobile), **14 passed**, real clock 2026-11-05 IST, real Postgres/API/SPA.
Command: `E2E_PORT=8802 E2E_GEM_PORT=4012 pnpm exec playwright test e2e/005-profile-vault/US2 --reporter=list` (isolated DB `tenderpilot_e2e_us2`).
Videos (one .webm per test) and Playwright traces (`trace-*.zip`) are in [`qa/evidence/005/US2/`](https://github.com/Shashank2577/GEMs/tree/story/GEM-115-completeness-financials/qa/evidence/005/US2).

### Acceptance criteria

| # | Criterion (from #115 / spec US2) | Verdict | Evidence |
|---|---|---|---|
| 1a | Fresh org GET /api/profile: completeness 0, averageTurnover null | met | AC1 test; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac1-fresh-org-profile.png) |
| 1b | 17 issues ordered error→warning→info; first four errors with exact texts | met | AC1 asserts length 17, severity ordering, 4 errors, exact 4 texts |
| 2a | Legal name+GSTIN+PAN (saved via UI) -> 27% | met | AC2; [27%](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac2-27-percent.png) |
| 2b | Plus non-expired gst vault doc -> 32% (expired gst doc stays 27%) | met | AC2; [32%](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac2-32-percent.png) |
| 3a | Headings by band (<55 / 55–84 / 85–99 / 100) | met | AC3; [<55](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac3-band-lt55-red-max6-more.png) [55-84](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac3-band-55-84-amber.png) [85-99](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac3-band-85-99-green.png) [100](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac3-band-100-all-done.png) |
| 3b | Ring red/amber/green | met | AC3 asserts text-danger / text-warning / text-success on the ring (same screenshots) |
| 3c | Max 6 issues + '+N more suggestions' | met | AC3: 6 buttons + "+11 more suggestions" (17 issues) |
| 3d | All-done message at no issues | met | AC3 (100% org, issues []) "Everything bids usually ask for is in place." |
| 4a | GSTIN issue scrolls to Company identity and focuses GSTIN | met | AC4a; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac4-gstin-focused-smooth.png) |
| 4b | Scroll is instant with prefers-reduced-motion | met | AC4a spies scrollIntoView: 'smooth' by default, 'auto' when reduced; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac4-gstin-focused-reduced-motion.png) |
| 4c | Vault issue opens /vault Add a document preset 'GST registration' | met | AC4b; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac4-vault-upload-dialog-gst-preset.png) |
| 4d | Expired issue opens /vault?status=expired | met | AC4b; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac4-vault-status-expired.png) |
| 5a | Meter recomputes live before saving | met | AC5: 0% -> 8% on typing legal name with zero PUT requests; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac5-live-meter-and-red-dot.png) |
| 5b | Desktop nav shows per-section issue counts | met | AC5: identity 4 -> 3, financials 1 |
| 5c | Red dot on sections with errors | met | AC5: invalid GSTIN -> "has errors" dot on Company identity |
| 6a | Financials empty: 'Add FY 2025-26' and 'Add at least one year' | met | AC6; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac6-empty-state.png) |
| 6b | Successive clicks add 2025-26, then 'Add FY 2024-25', 'Add FY 2023-24'; used FYs not offered again | met | AC6; [picker](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac6-fy-picker-excludes-used.png) |
| 7a | 6 Cr/4.5 Cr/3 Cr -> 'Last 3 FYs (2023-24, 2024-25, 2025-26) · ₹4,50,00,000' + dashed average line | met | AC7; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac7-average-card-and-chart.png) |
| 7b | API averageTurnover {avg:45000000, years:[2025-26,2024-25,2023-24]} | met | AC7 after UI save |
| 8a | Duplicate FY -> 400 fields['financials.1.fy'] '2024-25 is listed twice' | met | AC8 |
| 8b | Bad FY '2024-26', negative, fractional turnover rejected with exact messages | met | AC8: 'Use a financial year like 2024-25', 'Turnover cannot be negative', 'Whole rupees only' |
| 8c | Negative net worth allowed | met | AC8: 200, stored -5000000; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac8-negative-net-worth-saved.png) |
| 9 | Only FY 2025-26 -> warning 'Add turnover for 2024-25, 2023-24 so the 3-year average is accurate.' (4 of 12 pts) | met | AC9: warning text; 31% = (26+4)/98; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac9-partial-financials-warning.png) |
| 10a | Demo org: 96%, 'Almost there' | met | AC10; [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac10-demo-org-96.png) |
| 10b | Three specific warnings (missing FY 2025-26, Dell OEM expired in profile, Dell expired in vault) then the D-Link info (amended scenario 10; CP PLUS/Dell linked, D-Link unlinked) | met | AC10 asserts the 4 exact items in order, severities [warning x3, info], OEM links via API |
| 11a | (gap) OEM expiring within 30 days -> info 'expires in 20 days — ask for a renewed MAF.', no score change | met | AC11 (100% stays 100%); [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/ac11-oem-info-suggestions.png) |
| 11b | (gap) OEM without linked doc -> info 'Link the <OEM> authorisation letter…', no score change | met | AC11 (same) |

### Findings

1. **observation** — Below 1024px (phone/tablet) the profile page shows only the compact score pill and section pills; the completeness card with its suggestion list is not rendered (it lives in the desktop nav / xl aside).
   - Observed: @mobile run, [screenshot](https://github.com/Shashank2577/GEMs/blob/story/GEM-115-completeness-financials/qa/evidence/005/US2/mobile-compact-meter-mobile.png) shows a "96%" pill, no suggestions.
   - Expected: the story's criteria are stated for the card without a viewport restriction; not a criterion failure, so noted only.
   - Where: `apps/web/src/features/profile/ProfilePage.tsx` (pill block `lg:hidden`, aside `hidden xl:block`).
2. **observation** — Band boundaries 54/55/84/85 are exercised only by the heading/ring logic at 0, 59, 96, 100 in e2e; exact thresholds are in the app code (`CompletenessCard.tsx`) and not boundary-tested here.
3. **observation** — `e2e/support/start-api.sh` calls `scripts/local-pg.sh`, which per worktree tries to start its own Postgres on :5433 and fails when another worktree already runs one; I passed `E2E_DATABASE_URL` to work around it.

### Not checked

- Accessibility (axe) scan: `@axe-core/playwright` is not installed (task T003); not one of the story's acceptance criteria. The DoD line "axe report" is therefore unmet and deferred to that task.
- Duplicate-FY message through the UI (the picker prevents duplicates; covered at API level only).
- Cross-browser (Chromium only); non-Owner roles; read-only profile view.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
