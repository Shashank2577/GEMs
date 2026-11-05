## QA verdict — APPROVED

**Work item:** #114 · **PR:** #472 · **Reviewer:** qa (claude-code/sonnet) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Spec: `e2e/005-profile-vault/US1-profile.e2e.ts` (helpers in `e2e/005-profile-vault/support.ts`). Run: `E2E_PORT=8801 E2E_GEM_PORT=4013 E2E_DB_NAME=tenderpilot_e2e_us1 pnpm exec playwright test e2e/005-profile-vault/US1` → **20 passed** (17 desktop 1440px, 3 mobile Pixel 7 `@mobile`). Traces: `https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/traces/`; one .webm per test alongside the screenshots.

### Acceptance criteria

| # | Criterion (from #114) | Verdict | Evidence |
|---|---|---|---|
| 1 | Fresh org /profile: header 'Company profile', 'Not saved yet', disabled 'Save profile', 7 sections in order, meter 0% 'Let’s complete your profile' | met | [desktop](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac01-fresh-profile-desktop.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac01-fresh-profile-mobile.png) (mobile shows compact 0% pill; heading card is desktop-only by design) |
| 2a | GSTIN 27aapfu0939f1zv upper-cased, hint '✓ Valid · Maharashtra · PAN AAPFU0939F' | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac02-gstin-valid-before-fill-desktop.png) |
| 2b | 'Fill from GSTIN' fills only empty PAN/State; PAN hint '✓ Firm / LLP' | met | [after fill](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac02-after-fill-desktop.png), [existing PAN kept](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac02-autofill-keeps-existing-pan-desktop.png) |
| 3 | Invalid GSTIN: check-char, state code '00', length message quoting valid example 27AAPCS1234K1Z2 | met | [check char](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac03-check-char-desktop.png), [state](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac03-state-code-desktop.png), [length](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac03-length-desktop.png) |
| 4 | Inline errors PAN 4th char, Udyam, CIN, PIN 0, mobile 12345, email 'bids@' (exact texts) | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac04-inline-errors-desktop.png) |
| 5 | GSTIN/PAN mismatch blocks save client-side: toast, focus GSTIN, message; no PUT sent | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac05-mismatch-blocks-save-desktop.png) (test counts PUT requests = 0, asserts GSTIN focused) |
| 6 | PUT invalid gstin/pan/pincode → 400 validation_error with details.fields each; nothing stored | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac06-nothing-stored-desktop.png); response body printed in run log, GET shows nulls and updatedAt null |
| 7 | PUT only pan conflicting with stored GSTIN → 400 fields.pan 'Your GSTIN is registered to PAN AAPFU0939F' | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac07-pan-vs-stored-gstin-desktop.png) |
| 8 | Partial upsert normalises (27AAPFU0939F1ZV, +919812345678, UDYAM-MH-26-0123456), omitted fields kept, activity profile.updated with meta.fields | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac08-partial-upsert-desktop.png); GET /api/activity shows 2 rows with expected field lists |
| 9a | MII Class-I 30% → 'Class-I needs at least 50% local content' | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac09-class1-30-desktop.png) |
| 9b | Class-II 55% → 'Class-II means 20% to under 50% local content' | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac09-class2-55-desktop.png) |
| 9c | Non-local hides the field | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac09-nonlocal-hides-desktop.png) |
| 10 | MSE switch shows Udyam/category/owner category; Medium warning; off clears fields | met | [on](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac10-mse-on-small-desktop.png), [medium](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac10-medium-warning-desktop.png), [off](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac10-off-clears-desktop.png) |
| 11a | Unsaved bar 'Unsaved changes' + '· N to fix'; Discard restores | met | [desktop](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac11-unsaved-bar-with-errors-desktop.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac11-unsaved-bar-with-errors-mobile.png) |
| 11b | Save toast 'Profile saved' '<n>% complete · next: …', header 'Saved just now', bar disappears | met | [desktop](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac11-saved-toast-desktop.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac11-saved-toast-mobile.png) |
| 12a | beforeunload prompt on tab close | met | Chromium raised a `beforeunload` dialog via `page.close({runBeforeUnload:true})`; [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac12a-beforeunload-dismissed-page-stays-desktop.png) |
| 12b | (gap) In-app navigation shows 'Discard unsaved changes?' Stay / Discard and leave | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac12b-discard-dialog-desktop.png); Stay keeps /profile and value, Discard and leave navigates |
| 13a | Viewer sees view-only banner, disabled inputs, no save/autofill/add | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac13-viewer-readonly-desktop.png); viewer created through POST /api/org/invitations + /api/auth/accept-invite; zero enabled inputs, no Save/Fill/bar/Add contract |
| 13b | Viewer PUT /api/profile → 403 'You need to be at least an Analyst to do that' | met | same test (code forbidden + exact message) |
| 14 | (gap) Stale save with expectedUpdatedAt → 409 conflict 'Someone else saved the profile at <time IST>. Reload to see their changes.' with Reload | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/ac14-conflict-banner-desktop.png); second analyst context saves first; UI banner + Reload button; direct API 409 + code conflict; B's change not stored; Reload adopts A's value |

Additional (T022): spec Independent Test passes ([shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/independent-persisted-desktop.png)); `@mobile` layout test passes at 375-class Pixel 7 viewport: pill section nav visible, save bar sits above the bottom tab bar, no horizontal scroll ([mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-114-validated-profile/qa/evidence/005/US1/layout-mobile.png)).

### Findings

1. **observation** — On the mobile viewport the "Let’s complete your profile" heading card is not shown (only the compact 0% pill); it is desktop-only. Consistent with the design comment in ProfilePage.tsx; not a criterion failure.
2. **observation** — Dashboard link for a fresh org redirects to /onboarding (test accounts), unrelated to this story.

### Not checked

- axe-core accessibility scan: `@axe-core/playwright` is not installed yet (T003). The DoD line "axe report in qa/evidence/005/US1/" is therefore open; NFR-005 remains for a later scan (T075 follows it).
- Real-device/headed beforeunload UI: verified through Playwright's dialog event in headless Chromium only.
- Unit/API suites (`packages/core/test/vault`, `apps/api/test/vault.test.ts`) and cairn review were not re-run by QA.
- Concurrent saves racing at the same millisecond (covered by API tests, not here).

### Bug issues filed

- none

### Verdict

`qa:approved` — every acceptance criterion met, evidence above.
