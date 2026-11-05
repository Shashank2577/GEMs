## QA verdict — APPROVED

**Work item:** #167 · **PR:** #478 · **Reviewer:** qa (claude-code/Opus 5.5) · **Session:** https://claude.ai/code/session_01BUi6mJEssFE1nnr8kMX8Ue

Criteria were read from issue #167 and spec 004 User Story 1 before the diff. Test file: `e2e/004-analyse/US1-documents.e2e.ts` (one test per criterion; API requests for status codes, UI for toasts/rows/badges). Videos for every test are in `qa/evidence/004/US1/*.webm` ([folder](https://github.com/Shashank2577/GEMs/tree/story/GEM-167-documents/qa/evidence/004/US1)).

### Acceptance criteria

| # | Criterion (from the work item) | Verdict | Evidence |
|---|---|---|---|
| 1 | Empty Documents tab shows 'No documents yet' with GeM/upload body, type select defaulting to 'Bid document', dropzone hint 'PDF up to 25 MB' | met | test 1 (desktop+mobile); [01-empty-documents-tab](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/01-empty-documents-tab-desktop.png), [01-empty-documents-tab(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/01-empty-documents-tab-mobile.png) |
| 2 | Uploading go-it-services.pdf returns 201 {kind:'bid', pageCount:4, hasText:true, source:'upload'} (orgId present) | met | test 2 asserts body; [02-upload-row](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/02-upload-row-desktop.png) |
| 3 | Toast '<file> uploaded' / '4 pages read' | met | test 2; [02-upload-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/02-upload-toast-desktop.png), [02-upload-toast(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/02-upload-toast-mobile.png) |
| 4 | Row shows Bid document, Uploaded, 4 pages, size, 'just now' | met | test 2; [02-upload-row](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/02-upload-row-desktop.png), [02-upload-row(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/02-upload-row-mobile.png) |
| 5 | When an analysis exists, the upload toast offers a Re-analyse action (click starts a new analysis) | met | test 3: Re-analyse clicked -> POST /analyse 201 with a new analysis id; [03-reanalyse-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/03-reanalyse-toast-desktop.png), [03-after-reanalyse](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/03-after-reanalyse-desktop.png) |
| 6 | Non-PDF -> 415 unsupported_media_type 'Only PDF files can be analysed…' (+ error toast, nothing stored) | met | test 4; [04-non-pdf-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/04-non-pdf-toast-desktop.png) |
| 7 | > 25 MB -> 413 payload_too_large 'The file is larger than 25 MB' | met | test 5 (26 MiB buffer); [05-oversize-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/05-oversize-toast-desktop.png) |
| 8 | Empty file -> 400 bad_request 'The file is empty' | met | test 6; [06-empty-file-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/06-empty-file-toast-desktop.png) |
| 9 | Missing file -> 400 validation_error with details.fields.file='Required' | met | test 6 (API assertion on body) |
| 10 | Corrupt/password PDF -> 422 unreadable_pdf | met | test 7 (corrupt buffer and a pypdf-encrypted PDF, e2e/004-analyse/fixtures/password-protected.pdf); [07-unreadable-pdf-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/07-unreadable-pdf-toast-desktop.png) |
| 11 | Fetch from GeM -> 201 {fetched:1}, toast 'Bid document downloaded from GeM', row 'From GeM' | met | test 8+9 (file name GEM-2026-B-<n>.pdf); [08-fetched-from-gem](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/08-fetched-from-gem-desktop.png), [08-fetched-from-gem(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/08-fetched-from-gem-mobile.png) |
| 12 | mock-gem document counter +1 | met | test 8+9: /__admin/state requests.documents == before+1 |
| 13 | Second fetch -> 200 {fetched:0}, toast 'The GeM bid document is already here', no GeM request | met | test 8+9 (same org via UI, and another org via API); counter unchanged; [09-already-here](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/09-already-here-desktop.png), [09-already-here(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/09-already-here-mobile.png) |
| 14 | mock-gem down -> 502 gem_unavailable with generic message | met | test 10a (API + toast); [10a-gem-down-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/10a-gem-down-toast-desktop.png) |
| 15 | GeM 404 -> 'GeM no longer serves this bid document. Upload the PDF instead.' | met | test 10b; [10b-gem-404-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/10b-gem-404-toast-desktop.png) |
| 16 | Oversize GeM document -> 502 'The GeM document is larger than 25 MB — download it from GeM and upload it here.' | met | test 10c; [10c-gem-oversize-toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/10c-gem-oversize-toast-desktop.png) |
| 17 | Tender without GeM link: no Fetch button, body 'Upload the bid PDF you downloaded from GeM.' | met | test 11 (tender inserted via SQL with null gem_bid_id/document_url); [11-no-gem-link](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/11-no-gem-link-desktop.png) |
| 18 | API 422 no_gem_document for that tender | met | test 11 |
| 19 | Viewer sees list with View/Download, no Fetch, card 'Viewers can read documents. Ask an analyst to upload new ones.' | met | test 12 (desktop+mobile); [12-viewer-documents-tab](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/12-viewer-documents-tab-desktop.png), [12-viewer-documents-tab(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/12-viewer-documents-tab-mobile.png) |
| 20 | POST as viewer -> 403 forbidden | met | test 12 |
| 21 | Other org cannot list or download an org's upload (404); GeM docs visible to both | met | test 13 (list omits upload, download 404 not_found, GeM doc listed and downloadable by org B) |
| 22 | View opens inline with content-disposition inline, cache-control private no-store, nosniff | met | test 14: asserted on the browser's own View-link response and via API; [14-view-download](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/14-view-download-desktop.png) |
| 23 | Download keeps file name | met | test 14: browser download suggestedFilename == go-it-services.pdf; attachment filename header |
| 24 | Scanned PDF accepted (hasText:false), toast '… no text found; it may be a scan', badge 'No text — scanned?' | met | test 15 (desktop+mobile; text-less PDF); [15-scanned-pdf](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/15-scanned-pdf-desktop.png), [15-scanned-pdf(m)](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/15-scanned-pdf-mobile.png) |
| 25 | (gap) Bid-number mismatch upload returns warnings bid_number_mismatch, warning toast and 'Different bid?' badge | met | test 16 with a PDF headed GEM/2026/B/6133872; document still stored; [16-bid-number-mismatch](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/16-bid-number-mismatch-desktop.png) |
| 26 | (gap) Remove own upload -> 204 (confirm dialog, row gone), stale 'A document was removed…' | met | test 17; [17-remove-confirm](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/17-remove-confirm-desktop.png), [17-stale-banner](https://github.com/Shashank2577/GEMs/blob/story/GEM-167-documents/qa/evidence/004/US1/17-stale-banner-desktop.png) |
| 27 | (gap) Removing a GeM doc -> 403 'Documents fetched from GeM are shared and cannot be removed' | met | test 17 (also: no Remove action on the GeM row) |

### Commands run

- `pnpm exec playwright test e2e/004-analyse/US1*` -> **23 passed, 0 failed** (18 desktop + 5 `@mobile`), real Postgres + API + built SPA + mock-gem, no skips.
- `TEST_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_test pnpm --filter @tp/api exec vitest run` -> **13 files, 165 tests passed, 0 failed**.

### Findings

1. **observation** — The criterion's example header number `GEM/2026/B/6133872` is not the number printed in `go-it-services.pdf` (that fixture's page-1 header is `GEM/2026/B/6120451`). The behaviour is correct (the fixture also triggers the warning, naming 6120451); the mismatch test therefore uses a generated PDF with the 6133872 header to match the criterion literally.
   - Where: `packages/core/test/fixtures/bids/go-it-services.pdf`; screenshot `02-upload-row-desktop.png` shows the 6120451 warning.
2. **observation** — When a PDF triggers a bid-number mismatch, the warning toast stacks on top of the "<file> uploaded / N pages read" success toast, so the Re-analyse action on the success toast is partially covered (it is still clickable programmatically; a real pointer click may hit the warning toast first). Cosmetic, outside the stated criteria.

### Not checked

- Real GeM BidPlus (only mock-gem); real-world scanned/OCR PDFs (a generated text-less PDF and mock-gem scanned mode were used).
- Password protection was tested with a pypdf-encrypted fixture only (one encryption flavour).
- Cross-browser (Chromium only). Headless Chromium has no inline PDF viewer, so "View opens in a new tab" was verified from the browser's actual response (headers) plus the link's `target=_blank`/`inline=1` href, not a rendered PDF page.
- The "Only PDF" client-side dropzone path was exercised by renamed files; a >25 MB file and 0-byte file via UI were rejected with the same messages.

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.

---
_Generated by [Claude Code](https://claude.ai/code)_
