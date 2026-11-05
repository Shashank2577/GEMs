## QA verdict — APPROVED (re-review after rejection 1, fix 663b8c0)

**Work item:** #118 · **PR:** #484 · **Reviewer:** qa (claude-code/sonnet) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Spec: `e2e/005-profile-vault/US5-experience-oem.e2e.ts` (24 test runs: desktop + `@mobile`) — all pass (23 passed, 1 skipped desktop-only; one mobile run is an expected-fail known-issue guard). Run: `E2E_PORT=8805 E2E_GEM_PORT=4016 E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e_us5 pnpm exec playwright test e2e/005-profile-vault/US5`. Videos (one per test) are alongside the screenshots in this folder; Playwright traces are available locally (`qa/.runs/8805/artifacts/*/trace.zip`) / in a CI run and are not committed.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Empty Experience section shows 'No past contracts yet' with Add contract | met | AC1 (desktop+mobile): [ac01-empty-experience-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac01-empty-experience-desktop.png), [ac01-empty-experience-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac01-empty-experience-mobile.png) |
| 2 | Empty submit shows 'Buyer is required', 'Describe the work or supply', 'Contract value must be more than ₹0' (no request sent) | met | AC2: [ac02-empty-submit-errors.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac02-empty-submit-errors.png) |
| 3 | End before start -> 'End date is before the start date' | met | AC2: [ac02-end-before-start.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac02-end-before-start.png) |
| 4 | Valid contract -> 201 | met | AC3 asserts POST status 201 and DTO fields; [ac03-added-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac03-added-desktop.png), [ac03-added-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac03-added-mobile.png) |
| 5 | Toast 'Contract added' 'Experience criteria will use it on the next analysis.' | met | AC3: [ac03-added-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac03-added-desktop.png) |
| 6 | Summary '1 contract · total ₹58.2 L · largest ₹58.2 L' | met | AC3: [ac03-added-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac03-added-desktop.png) |
| 7 | Completeness rises | met | AC3 polls GET /api/profile completeness > value before add |
| 8 | CRAC picker lists only Experience documents (crac, work_order + Not linked + Upload option; gst/oem excluded) | met | AC4: [ac04-crac-picker-options.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac04-crac-picker-options.png) |
| 9 | Rows show 'Linked' or 'No CRAC'; API cracDocumentId = upload id | met | AC4: [ac04-linked-and-no-crac-rows.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac04-linked-and-no-crac-rows.png) |
| 10 | Table collapses to cards on phones (Period/Proof hidden), no horizontal scroll | met | AC4b @mobile: [ac04b-layout-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac04b-layout-mobile.png), [ac04b-layout-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac04b-layout-desktop.png) |
| 11 | cracDocumentId of other org (and random UUID) -> 400 'That document is not in your vault' | met | AC5 API test: [ac05-api-checks-org-unchanged.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac05-api-checks-org-unchanged.png) |
| 12 | PATCH end < stored start -> 400; cross-org PATCH/DELETE -> 404 'Past contract not found' | met | AC5 API test (victim org data unchanged) |
| 13 | Delete confirm 'Delete this contract?' -> 200, toast 'Contract deleted' | met | Re-run after fix 663b8c0: AC6b now passes (only the confirmation opens), AC6 flow passes without any workaround. [ac06b-delete-menu-dialogs.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06b-delete-menu-dialogs.png), [ac06-delete-confirm.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06-delete-confirm.png), [ac06-deleted.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06-deleted.png) |
| 14 | Activity add/update/delete logged | met | AC6: dashboard activity contains profile.past_contract_added/updated/deleted. [ac06-edited.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06-edited.png) |
| 15 | List ordered by end date desc then created desc | met | AC7: API and UI order equal [C-new-second, C-new-first, C-mid, C-old]. [ac07-order.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac07-order.png) |
| 16 | OEM section empty prompt | met | AC8: [ac08-oem-empty-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-empty-desktop.png), [ac08-oem-empty-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-empty-mobile.png) |
| 17 | OEM rows: OEM required, products, valid till badge | met | AC8: [ac08-oem-required-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-required-desktop.png), [ac08-oem-filled-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-filled-desktop.png) |
| 18 | oem_authorization-only picker; saved with profile | met | AC8: picker == [Not linked, Dell MAF 2026]; persisted after reload. [ac08-oem-persisted-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-persisted-desktop.png), [ac08-oem-persisted-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac08-oem-persisted-mobile.png) |
| 19 | (gap) OEM documentId not in org vault or wrong type -> 400 fields['oemAuthorizations.0.documentId'] 'Pick an OEM authorisation from your vault' | met | AC9: wrong type, foreign org, random uuid, and index 1; nothing persisted. [ac09-oem-api-validated.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac09-oem-api-validated.png) |
| 20 | (gap) 'Upload a new CRAC…' opens upload dialog preset crac, stacked above the contract dialog | met | AC10: [ac10-upload-dialog-over-contract-dialog.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac10-upload-dialog-over-contract-dialog.png) |
| 21 | (gap) ...selects the new document keeping the draft | met | AC10: [ac10-new-crac-selected-draft-kept.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac10-new-crac-selected-draft-kept.png) |
| 22 | (review) keyboard-only path: Esc closes only the upload dialog, draft intact | met | AC10b: [ac10b-esc-closed-only-upload-dialog.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac10b-esc-closed-only-upload-dialog.png) |
| 23 | (review) non-Experience type uploaded inline -> 'Uploaded to the vault, but only Experience documents can be linked as proof' | met | AC10c: [ac10c-non-experience-warning.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac10c-non-experience-warning.png) |
| 24 | (gap) OEM row offers 'Use document expiry' from linked vault document; hint 'Document expires <date>'; fills Valid till | met | AC11: [ac11-doc-expiry-hint.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac11-doc-expiry-hint.png), [ac11-valid-till-filled.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac11-valid-till-filled.png), [ac11-differs-offers-button.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac11-differs-offers-button.png) |
| 25 | (extra) viewer role is read-only (no Add/Actions; writes 403) | met | Roles test: [roles-viewer-readonly.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/roles-viewer-readonly.png) |
| 26 | (extra) axe: Experience + OEM sections and contract dialog, no serious/critical violations | met | desktop clean; mobile clean except the known issue in Finding 2. [profile-experience-oem-desktop.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/profile-experience-oem-desktop.axe.json), [contract-dialog-desktop.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/contract-dialog-desktop.axe.json), [contract-dialog-mobile.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/contract-dialog-mobile.axe.json) |

### Findings

1. **resolved** — Delete from the actions menu also opened Edit (rejection 1). Fixed in 663b8c0; AC6b passes.
2. **minor (non-blocking, out of scope)** — axe `nested-interactive` (serious) on the mobile contract cards: `ResponsiveTable` card is `role=button` and contains the actions button. Filed as #493; guarded by a `test.fail()` known-issue test. Evidence: [mobile-cards-nested-interactive-mobile.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/mobile-cards-nested-interactive-mobile.axe.json). The criteria do not cover accessibility; desktop is clean.
3. **observation** — `scripts/local-pg.sh` fails to start Postgres when another worktree holds :5433; DB created manually with `E2E_DATABASE_URL`.

### Not checked

- Accessibility beyond axe on the Experience/OEM sections and contract dialog (no manual screen-reader pass).
- Exact completeness percentage delta (only asserted that it rises).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- #493 — ResponsiveTable mobile cards nest actions button in role=button card (out of scope for #118)

### Verdict

`qa:approved` — every criterion met, evidence above.
