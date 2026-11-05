## QA verdict — APPROVED (re-review after rejection 1)

**Work item:** #116 · **PR:** #477 · **Reviewer:** qa (claude-code / sonnet) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Re-review of fix commit cbe30ba (grid-cols-1 / min-w-0 in ExpiryTimeline, VaultPage grids, DocumentDrawer dl). Rejection 1 finding is resolved; evidence below was re-recorded on this run.

Suite: `e2e/005-profile-vault/US3-vault.e2e.ts` (helpers in `e2e/005-profile-vault/support.ts`).
Run: `E2E_PORT=8803 E2E_GEM_PORT=4014 E2E_DB_NAME=tenderpilot_e2e_us3 pnpm exec playwright test e2e/005-profile-vault/US3` — desktop 17 passed, mobile 1 passed (full suite: 18 passed, 1 skipped = the @mobile test on the desktop project).
(Local note: a shared Postgres already held :5433, so `scripts/local-pg.sh` could not start a second one; I created `tenderpilot_e2e_us3` on it and set `E2E_DATABASE_URL`. App under test is unchanged.)

Evidence base: https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/

### Acceptance criteria

| # | Criterion (from #116 / spec US3) | Verdict | Evidence |
|---|---|---|---|
| 1 | Empty vault shows onboarding with 10 common bid document tiles; tile opens upload dialog preset (also `?upload=1`, page drop of `GST_REG06_2023.pdf` -> "GST registration" / "GST REG06 2023") | met | [onboarding](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac01-onboarding-10-tiles.png), [preset](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac01-tile-opens-dialog-preset.png), [drop](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac01-page-drop-preselects-gst.png) |
| 2a | `BS_FY2024-25.pdf` pre-fills "Audited balance sheet", title "BS FY2024-25", FY 2024-25 | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac02-guessed-metadata-balance-sheet.png) |
| 2b | ISO with issue 2026-01-10 offers "Use 09 Jan 2029" and fills 2029-01-09 | met | [hint](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac02-iso-validity-hint.png), [applied](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac02-iso-suggestion-applied.png) |
| 3a | Valid PDF -> 201 DTO (status valid, daysToExpiry null, pageCount 2, downloadUrl) | met | asserted in test; [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac03-upload-toast-and-drawer.png) |
| 3b | Toast "“<title>” added to the vault" + "<n> pages · stored privately"; drawer opens; card "PDF · 2p"/"No expiry" | met | [toast+drawer](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac03-upload-toast-and-drawer.png), [card](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac03-card-valid-no-expiry-pdf-2p.png) |
| 3c | Activity `vault.uploaded`; downloaded bytes equal the original | met | GET /api/activity assertion; byte-equality assertion in test |
| 4a | PNG ISO expiring +10 -> expiring, "Expires in 10d", toast "It expires in 10 days — we’ll remind you." | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac04-expiring-in-10d.png) |
| 4b | Yesterday -> "Expired 1d ago" + "Heads up: this document has already expired." | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac04-expired-1d-ago.png) |
| 5a | 415 `unsupported_media_type`, 422 `unreadable_pdf`, 413 `payload_too_large` (20 MB+10 B) exact messages | met | API assertions; dialog [415](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac05-dialog-415-message.png), [422](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac05-dialog-422-message.png); [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-ac05-rejections.zip) |
| 5b | 400 no file (`fields.file`), 400 empty file, 400 expiry before issue (`fields.expiryDate`) | met | same test |
| 5c | In every failure no row and no blob stored | met | `vault_documents` count 0 via psql and empty blob dir after all 6 failures |
| 6a | 25 MB in dropzone -> "<name> is larger than 20 MB." with no upload | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac06-dropzone-25mb.png); zero POST/PUT requests recorded |
| 6b | (gap) same check on page drop, Change and Replace | met | [change](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac06-change-25mb.png), [page drop](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac06-page-drop-25mb.png), [replace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac06-replace-25mb.png) |
| 7a | Demo tiles 15 / 12 / 2 / 1 with hints; 90-day timeline markers (ISO 10d, CA 25d, expired Dell) | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac07-demo-tiles-and-timeline.png) |
| 7b | Expired tile toggles `?status=expired` showing only Dell; second click clears | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac07-expired-filter-only-dell.png) |
| 8a | Search "dell" debounced into `?q=dell` -> "1 of 15 documents" | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac08-search-dell.png) (URL updated well under 1.5 s; exact 250 ms not asserted) |
| 8b | Category Financial + type balance sheet -> 3; Expiring first (Dell, ISO, CA, CP PLUS, rest last); Title A-Z; grid/list persists after reload | met | [financial](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac08-financial-balance-sheets.png), [expiry](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac08-sort-expiring-first.png), [title](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac08-sort-title-az.png), [list](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac08-list-view-persisted-after-reload.png) |
| 9 | "No documents match" / "Nothing has expired. Nice." with Clear filters | met | [match](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac09-no-documents-match.png), [expired](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac09-nothing-has-expired.png) |
| 10 | Drawer `?doc=<id>`: PDF iframe / image preview, metadata, uploader; Download attachment + Open inline, `private, no-store` + `nosniff` | met | [pdf](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac10-drawer-pdf-preview-metadata.png), [image](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac10-drawer-image-preview.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-ac10-drawer-preview-download.zip) |
| 11 | Edit details -> PATCH 200, "Document updated", expiry change resets `last_reminder_days` (title-only edit does not) | met | [form](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac11-edit-form.png), [badge](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac11-updated-badge.png); psql before/after |
| 12 | Replace -> PUT 200 new file fields, metadata kept, "File replaced" toast, old blob deleted, `vault.file_replaced` | met | [after](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac12-after-replace.png); blob dir listing asserted |
| 13a | Delete confirm -> 200 `{ok:true}`, row + blob removed, CRAC link cleared, toast "“<title>” deleted", drawer closes | met | [confirm](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac13-delete-confirm.png), [after](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac13-after-delete.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-ac13-delete.zip) |
| 13b | (gap) OEM `documentId` links cleared, other OEM links untouched | met | GET /api/profile asserted `[Dell:null, HP:<kept id>, Lenovo:null]` |
| 14 | Viewer: no upload/replace/edit/delete/drag-drop/chips, tiles disabled, download works; POST/PATCH/PUT/DELETE -> 403 `forbidden` | met | [tiles](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac14-viewer-onboarding-tiles-disabled.png), [drawer](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac14-viewer-drawer-no-write-controls.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-ac14-viewer.zip) |
| 15 | Other org id / malformed id -> 404 `not_found` "Document not found" on GET/download/PATCH/PUT/DELETE; unauthenticated -> 401 | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac15-cross-org-doc-link-not-found.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-ac15-cross-org-404.zip); org B doc verified untouched |
| 16 | (gap) `/vault?doc=<deleted id>` -> toast "That document could not be found. It may have been deleted." and `doc` removed (also unknown UUID and malformed id) | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/ac16-deleted-doc-link.png) |
| R1 | Review fix: long Hindi file name (> 255 bytes) uploads and downloads | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/review-fix-hindi-filename.png); 201, bytes equal, `filename*=UTF-8''` |
| M1 | T043 / NFR-006 @mobile: vault tiles 2x2 | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/mobile-tiles-2x2.png) |
| M2 | T043 / NFR-006 @mobile: no horizontal page scroll at 375 px (and Pixel 7, 412 px) on `/vault` | met | [375 px](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/mobile-375px-vault.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/trace-mobile-layout-nfr006.zip); was failing in rejection 1 (scrollWidth 527), now within viewport at both widths |
| M3 | T043 / NFR-006 @mobile: drawer full width | met | [png](https://github.com/Shashank2577/GEMs/blob/story/GEM-116-vault/qa/evidence/005/US3/mobile-drawer-full-width.png); drawer width equals the viewport (soft assertions in test pass) |
| A1 | NFR-005 axe-core (no serious/critical violations) | not checked (out of this review) | `@axe-core/playwright` is not installed yet (T003); not run |

### Findings

1. **resolved** — phone horizontal scroll on `/vault` (rejection 1, NFR-006): fixed in cbe30ba; mobile test now passes at 412 px and 375 px.
2. **observation** — search debounce verified as "URL updated within 1.5 s", not 250 ms exactly.
3. **observation** — 413 is only reachable via the API; the UI shows the client-side "<name> is larger than 20 MB." first (by design, AC 6).
4. **observation** — axe-core (NFR-005) remains unrun until T003 adds `@axe-core/playwright`; recommend running it then on `/vault` at desktop and 375 px.

### Not checked

- axe-core accessibility (NFR-005): dependency not installed (T003). Needs `@axe-core/playwright` run on `/vault` desktop and 375 px.
- NFR-003 performance (covered by `apps/api/test/vault.perf.test.ts`; not re-run here); real PDF rendering inside the iframe in headless Chromium (iframe presence, src and bytes verified, not pixels).
- Exact 250 ms debounce; S3/R2 blob store (fs store only); reminder job (US4).

### Bug issues filed

- none (finding 1 is in scope: NFR-006 / T043).

### Verdict

`qa:approved` — all 16 issue acceptance criteria, the review-fix behaviours and the T043 mobile checks are met with evidence above. axe (NFR-005) is listed as not checked (dependency pending T003), not as a failed criterion.
