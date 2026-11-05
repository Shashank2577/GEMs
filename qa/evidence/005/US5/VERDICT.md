## QA verdict — REJECTED

**Work item:** #118 · **PR:** #484 · **Reviewer:** qa (claude-code/sonnet) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Spec: `e2e/005-profile-vault/US5-experience-oem.e2e.ts` (20 test runs: desktop + `@mobile`) — 19 pass, 1 fails (AC6b). Run: `E2E_PORT=8805 E2E_GEM_PORT=4016 E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e_us5 pnpm exec playwright test e2e/005-profile-vault/US5`. Videos (one per test) are alongside the screenshots in this folder; Playwright traces are available locally (`qa/.runs/8805/artifacts/*/trace.zip`) / in a CI run and are not committed.

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
| 13 | Delete confirm 'Delete this contract?' -> 200, toast 'Contract deleted' | **not met** | Choosing Delete in the row actions menu ALSO opens 'Edit past contract' (see Finding 1); AC6b fails. The delete itself returns 200 + toast once the stray dialog is dismissed. [ac06b-delete-menu-dialogs.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06b-delete-menu-dialogs.png), [ac06-delete-confirm.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06-delete-confirm.png), [ac06-deleted.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06-deleted.png) |
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

### Findings

1. **major (blocking)** — Choosing **Delete** (or Edit) from a contract row's actions menu also fires the row's click handler, so an "Edit past contract" dialog opens behind/over the "Delete this contract?" confirmation.
   - Observed: add a contract, open `Actions for <title>` -> **Delete**. Two `[role=dialog][data-state=open]` exist: `Delete this contract?` and `Edit past contract`. The Edit dialog is on top, hiding the confirmation from assistive tech/role queries. After confirming delete (200, toast) the Edit dialog stays open for a contract that no longer exists (saving would 404). Test `AC6b` fails: expected open dialogs `['Delete this contract?']`, received an extra `'Edit past contract'`. Evidence: [ac06b-delete-menu-dialogs.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-118-experience-oem/qa/evidence/005/US5/ac06b-delete-menu-dialogs.png).
   - Expected: AC "Delete confirm 'Delete this contract?' -> 200, toast 'Contract deleted'" — only the confirmation opens.
   - Where: `apps/web/src/features/profile/PastContracts.tsx` (actions `DropdownMenu` inside the `ResponsiveTable` row with `onRowClick`). The menu content is portalled but React synthetic click events still bubble to the row's `onClick`; only the trigger calls `stopPropagation`. Likely fix: stop propagation on the `DropdownMenuContent` (`onClick`) / items.
2. **observation** — `scripts/local-pg.sh` could not start Postgres when another worktree's instance already holds :5433; QA created the DB manually and passed `E2E_DATABASE_URL`.

### Not checked

- Accessibility audit with axe: `@axe-core/playwright` not installed (T003 later). Only role/label queries and a keyboard-only Esc path were exercised.
- Cross-browser (Chromium only); visual design fidelity; load/concurrency.
- Exact completeness percentage delta (only asserted that it rises).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none (Finding 1 blocks AC6 directly)

### Verdict

`qa:rejected` — criterion 13 (delete flow) not met. Rejection 1 of 3 on this item.
