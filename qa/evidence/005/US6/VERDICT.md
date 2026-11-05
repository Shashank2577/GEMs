## QA verdict — APPROVED

**Work item:** #119 · **PR:** #486 · **Reviewer:** qa (claude-code) · **Branch:** `story/GEM-119-renew-history` (merged with latest `origin/main`) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Run: `E2E_PORT=8806 E2E_GEM_PORT=4017 E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e_us6 pnpm exec playwright test e2e/005-profile-vault/US6` → **18 passed** (11 desktop 1440×900, 7 `@mobile` Pixel 7). Spec: `e2e/005-profile-vault/US6-renew-history.e2e.ts`. Real IST date 2026-11-05. Traces stay in git-ignored `qa/.runs/`.

### Acceptance criteria

Base: `https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/`

| # | Criterion (quoted from the work item) | Verdict | Evidence |
|---|---|---|---|
| 1a | Renew dialog with file … | met | [dialog](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac01-renew-dialog-defaults.png), [file chosen](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac01-renew-dialog-file-chosen.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/mobile-ac01-renew-dialog-defaults.png): heading `Renew “ISO 9001 certificate”`, file input present |
| 1b | … issue date (today) … | met | Issue date input = 2026-11-05 (IST today) |
| 1c | … expiry pre-filled by suggestExpiry … | met | Expiry = 2029-11-04 (issue + 36 months − 1 day, ISO); changing the issue date to 2026-12-01 moves it to 2029-11-30 while untouched |
| 1d | … number; sends PUT /api/vault/:id/file with fields | met | Number pre-filled `ISO-OLD-1`; captured `PUT /vault/:id/file` FormData fields = `{issueDate, expiryDate, number}` + file `iso-renewed.pdf` |
| 2a | Renewal -> 200, metadata updated | met | `PUT` status 200, body `expiryDate` 2029-11-04, `issueDate` today, `fileName` renewed, status `valid`; [drawer after](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac02-drawer-valid-after-renewal.png); card badge "Expires in 6d" → "Valid" ([before](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac02b-before-expiring-soon.png), [after](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac02b-after-valid.png)) |
| 2b | last_reminder_days null | met | DB `last_reminder_days` set to 7 before renewal → `NULL` after |
| 2c | toast '“<title>” renewed — valid till <date>' | met | [toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac02-toast-after-renewal.png): `“ISO 27001 certificate” renewed — valid till 04 Nov 2029` |
| 2d | activity vault.renewed | met | `/api/activity` has `vault.renewed` with meta `{fromExpiry: 2026-11-15, toExpiry: 2029-11-04}` |
| 3a | Drawer Versions list (max 5, newest first) | met | [versions](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac03-versions-list-five-newest-first.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/mobile-ac03-versions-list-five-newest-first.png): after 6 renewals exactly 5 rows, order v5,v4,v3,v2,v1; line format `cert-v5.pdf · 861 B · replaced just now by <name>` |
| 3b | download via /api/vault/:id/versions/:versionId/download | met | UI click on `Download cert-v3.pdf` yields bytes identical to the uploaded v3; direct GET of newest version returns identical bytes ([after download](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac03-after-version-download.png)) |
| 3c | older pruned with blobs | met | 5 renewals → 5 versions + 6 blobs; 6th renewal → still 5 `vault_document_versions` rows and 6 blob files (oldest blob deleted); deleting the document removes all versions and blobs (0 files, 0 rows) |
| 4a | Identical file (SHA-256) -> 409 duplicate_document {existingId,title} | met | API: 409, body contains `duplicate_document`, `details` = `{existingId: <A>, title: "Original X"}` (upload, renew and replace paths) |
| 4b | dialog offers Open existing … | met | Prompt `This file is already in your vault as “Original X”.` in [Upload dialog](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04a-upload-duplicate-prompt.png) and [Renew dialog](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04b-renew-duplicate-prompt.png); Open existing navigates to `?doc=<existing>` and shows it ([upload](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04a-open-existing-opens-original.png), [renew](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04b-renew-open-existing.png)); nothing replaced before confirming |
| 4c | … / Upload anyway (allowDuplicate=1 -> 201) | met | Upload dialog: re-send carries `allowDuplicate=1` → 201, new document created ([shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04a-upload-anyway-created.png)); Renew dialog: → 200 + toast ([shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04b-renew-upload-anyway-done.png)); API `allowDuplicate=1` → 201 |
| 4d | (review) drawer **Replace file** with a duplicate shows Open existing / Upload anyway | met | [prompt](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04c-replace-duplicate-prompt.png), [open existing](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04c-replace-open-existing.png), [upload anyway](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac04c-replace-upload-anyway-done.png); old file became a version |
| 5a | Viewer sees versions … | met | [viewer drawer](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac05-viewer-sees-versions-no-renew.png) (+[mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/mobile-ac05-viewer-sees-versions-no-renew.png)): Versions heading + 1 row; version download bytes identical; `GET versions` and `…/download` 200 |
| 5b | … but no Renew | met | Viewer drawer has 0 Renew, Replace file and Edit details controls; analyst [baseline](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac05-analyst-baseline-has-renew.png) has Renew; viewer `PUT …/file` → 403 |
| 5c | other org version id -> 404 | met | Other org: `GET /vault/<A doc>/versions` 404, `…/versions/<A version>/download` 404 (both against A's doc and its own doc), malformed id 404, `PUT` on A's doc 404; own version download 200 |
| 6 | (review) Renew blocks submit with "Add the new expiry date so reminders restart" when the type expires and expiry is empty | met | [error](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/desktop-ac06-expiry-required-error.png): message shown, no PUT sent, file unchanged; filling a date then succeeds; non-expiring type (PAN) renews without a date |
| 7 | (tasks T073) desktop + `@mobile` | met | Mobile project ran AC1–AC7 flows at 412×915; no horizontal overflow with drawer, Renew dialog and duplicate prompt ([layout](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/mobile-ac07-duplicate-prompt-layout.png)). One `.webm` per test in this folder |

### Findings

1. **observation** — axe (WCAG 2.1 A/AA) on `/vault` with the drawer and Renew dialog open reports 3 serious `color-contrast` nodes: muted 11px helper text (3.74:1), the green success panel text on the expired/valid banner (3.64:1) and the green "Valid" badge (3.53:1).
   - Observed: [`vault-drawer-renew-dialog-desktop.axe.json`](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/vault-drawer-renew-dialog-desktop.axe.json). The story's new surfaces are clean when scoped: [`renew-dialog-only-desktop.axe.json`](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/renew-dialog-only-desktop.axe.json) and [`versions-list-only-desktop.axe.json`](https://github.com/Shashank2577/GEMs/blob/story/GEM-119-renew-history/qa/evidence/005/US6/versions-list-only-desktop.axe.json) have 0 violations.
   - Expected: no serious/critical violations. The story's criteria do not require it and the nodes are the shared success-tone/muted tokens, so this is not blocking; worth a separate design-token issue.

### Not checked

- Real e-mail/in-app reminder delivery after renewal (covered by US4; here only `last_reminder_days` reset and the `vault.renewed` activity row were asserted).
- Files near the 20 MB limit through the Renew dialog; scanned/encrypted PDFs.
- Concurrent renewals of the same document (race on version pruning).
- Visual regression in browsers other than Chromium.

### Verdict

`qa:approved` — every criterion met, evidence above.
