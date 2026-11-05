## QA verdict — APPROVED

**Work item:** #186 · **PR:** #498 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mHape454W5kq4qhhfS

Run at HEAD ba67c2b: `pnpm exec playwright test e2e/006-apply-packet-assist/US5*` → **19 passed, 0 failed** (18 desktop + 1 @mobile on Pixel 7 / 375 px). Edited US4 spec re-run → 18 passed. Spec: `e2e/006-apply-packet-assist/US5-packet.e2e.ts`. Built packet saved as [packet.pdf](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/packet.pdf) (11 pages).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Default contents: 8 rows in specified order | met | [S1](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S1-default-contents-desktop.png) (UI + `defaultPacketItems` titles/kinds) |
| 2 | Documents 8, Pages (est.) 11, size bar green | met | [S1](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S1-default-contents-desktop.png) (bar class `bg-success`) |
| 3 | Add more lists other annexures (not MAF request), vault and bid documents | met | [S1](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S1-default-contents-desktop.png) (Technical Compliance, Balance sheet 2023-24, seeded bid document; no "Request for MAF") |
| 4 | Reorder by drag, Move up arrow, keyboard on grip; 'Default order' appears | met | [drag](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S2-after-drag-default-order-button-desktop.png), [keyboard](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S2-after-keyboard-desktop.png) |
| 5 | Order survives reload (unsaved local draft per FR-055) | met | [S2 reload](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S2-order-survives-reload-desktop.png) ("Unsaved order on this device"; draft dropped after a successful build) |
| 6 | Remove/Add update counters | met | [S3](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S3-removed-and-added-desktop.png) (8→7 docs/10 pages, then 8/12) |
| 7 | Empty list shows 'Nothing in the packet' and disables Build | met | [S3 empty](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S3-empty-build-disabled-desktop.png) |
| 8 | Build → progress texts in live region (4 texts, aria-live polite) | met | [S4 building](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S4-building-live-region-desktop.png) (POST delayed ~4 s via route so all phases observable) |
| 9 | 201 ready, pageCount 11, startPages 1,3,4,5,6,7,8,11, downloadUrl | met | S4 test asserts the response body |
| 10 | Toast 'Packet ready — 11 pages' + '2 warnings to review' | met | [S4 toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S4-toast-and-latest-card-desktop.png) |
| 11 | Latest card: builder, just now, 11 pages, size, both MAF warnings, Download PDF / Open / Submit step → | met | [S4 card](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S4-latest-card-warnings-buttons-desktop.png) |
| 12 | Build from Go → Preparing with activity '(after building the packet)'; later builds don't change stage | met | [S5](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S5-stage-preparing-activity-desktop.png); second build leaves stage and adds no second auto move |
| 13 | Download: attachment GEM_2026_B_700001_technical_packet.pdf, no-store | met | S6: `attachment; filename="…"; filename*=UTF-8''…` (FR-059 form), inline variant, `cache-control: private, no-store`, nosniff; UI link downloads that filename |
| 14 | 11 pages; cover texts | met | [cover](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/packet-p1-cover.png) (pdftotext on every cover field + disclaimer) |
| 15 | 'Index of documents' rows with links | met | [index](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/packet-p2-index.png); 7 link annotations → pages 3,4,5,6,7,8,11 |
| 16 | Outline Cover, Index + 7 titles | met | pdf-lib outline = Cover, Index, + 7 titles; PageMode UseOutlines |
| 17 | Footer 'GEM/2026/B/700001 · Page x of 11' on every page | met | S6, all 11 pages |
| 18 | Blob key org/<org>/packets/<id>/… | met | S6 reads `packets.blob_key` and the file on disk |
| 19 | Foreign/unknown items → 400 'Unknown packet item(s): …', no row | met | S7: other-org vault doc, unknown annexure key, other tender's bid document, combined; row count unchanged |
| 20 | Images placed on A4 | met | [S8 PNG on A4](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S8-png-on-a4-page4.png) (PNG and JPG, 595×842, `pdfimages`) |
| 21 | Corrupt/unsupported skipped with specified warnings; encrypted PDF warning | met | [warnings](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S8-warnings.json), [index omits skipped](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S8-index-skipped-omitted.png) |
| 22 | >20 MB output warning text | met | [S9a](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S9a-oversize-warning.json): real 21.7 MB packet, saved and downloadable |
| 23 | UI estimate red >20 MB with message, amber >15 MB | met | [amber](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S9b-amber-over-15MB-desktop.png), [red](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S9b-red-over-20MB-desktop.png) |
| 24 | >26 documents → 'Index of documents (continued)', start pages shifted | met | [S10 p3](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S10-index-continued-p3.png): 26 docs = 1 index page; 27 = 2, start 4..30, links correct |
| 25 | Earlier builds list with download; GET ≤50 newest first; Viewer downloads, POST 403 | met | [S11](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S11-earlier-builds-desktop.png), [viewer](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S11-viewer-no-build-button-desktop.png) |
| 26 | Merge failure → 500 packet_build_failed, 'The last build failed', activity packet_failed | met | [S12](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S12-last-build-failed-desktop.png), [toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S12-error-toast-desktop.png) (fault induced as storage-write error, see Not checked) |
| 27 | (FR-055) teammates see last successful build's order; removed items stay removed; Default order resets; POST {} builds same order | met | [S13](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S13-teammate-sees-last-build-order-desktop.png) |
| 28 | (FR-056) >60 MB → 413 packet_too_large before loading | met | [S14](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S14-413-toast-desktop.png): "These documents add up to 7x.x MB … (limit 60 MB).", no row |
| 29 | (FR-057) building >10 min → failed 'Build interrupted — try again.' | met | [S15](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/S15-build-interrupted-desktop.png): 5-min row stays building (control); 11-min row reported and persisted failed |
| 30 | FR-059 RFC 5987 filename* on packet and annexure downloads | met | S6 here; US4 spec updated to the new full strings and passes |
| 31 | Mobile 375 px: no horizontal scroll | met | [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/mobile-packet-step-mobile.png), [card](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/mobile-latest-card-mobile.png) |
| 32 | Accessibility (axe, Packet step scope) | met | [packet-step-desktop.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-186-packet/qa/evidence/006/US5/packet-step-desktop.axe.json): 0 violations; full-page axe saved as observation |

### Findings

1. **observation** — During the first run (pre-fix HEAD 923275f) S13 failed: a removed item reappeared in the teammate's proposed order, and the progressbar lacked an accessible name. Both are fixed at ba67c2b and pass now.
2. **observation** — A failed build leaves a `failed` row but a later successful build still works (verified after unblocking storage in S12).

### Not checked

- Recovery from a genuine merge exception: `buildPacket` never throws on bad files, so S12 induces failure by making the blob write fail (ENOTDIR). The 500 / UI / activity behaviour is the same code path.
- 413 and the red/amber estimate use stored `size_bytes` edited directly in the DB (the check sums stored sizes); no 60 MB files exist. The >20 MB warning is real (two 11.4 MB PDFs).
- Stuck-build, 50+ history, bid document, corrupt/text blobs were created with direct DB/blob writes (no public API).
- Touch drag (150 ms delay) not exercised; pointer and keyboard were. Full-page axe and shared-header violations are outside US5.
- Videos: one .webm per test; traces not committed.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.

---
_Generated by [Claude Code](https://claude.ai/code)_
