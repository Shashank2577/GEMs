## QA verdict — APPROVED

**Work item:** #184 · **PR:** #488 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mHape454W5kq4qhhfS

Tested at branch head `9606a8c`. Spec: `e2e/006-apply-packet-assist/US4-annexures.e2e.ts` (T051). Run: `pnpm exec playwright test e2e/006-apply-packet-assist/US4*` -> **18 passed, 0 failed** (17 desktop + 1 @mobile), two consecutive clean full runs (see Findings 4 for one earlier flaky failure). PDF text assertions use the system `pdftotext` (poppler); pdf-lib in the workspace cannot extract text.

### Acceptance criteria

| # | Criterion (from #184) | Verdict | Evidence |
|---|---|---|---|
| 1 | Annexures step lists 6 in order: Covering Letter (Optional), Non-Blacklisting (Required by this bid), Make in India (Required by this bid), Request for MAF (Recommended), Technical Compliance (Optional), Letter of Authority (Optional) | met | test S1; UI + API order/required flags; [S1-annexures-list](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S1-annexures-list-desktop.png) |
| 2 | ...first required is previewed | met | S1: Non-Blacklisting card `aria-current`, iframe src `non_blacklisting.pdf` |
| 3 | Blank placeholders show 'N blank(s)' badge with tooltip | met | S2a: badge N == API `missing.length` for every annexure; tooltip "Blank: ... Model"; [S2a](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S2a-blank-badge-tooltip-desktop.png) |
| 4 | profileGaps banner 'Some blanks will print as “__________”' + 'Complete company profile →' | met | S2b (org with blanked profile; link href `/profile`; absent for complete org); [S2b](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S2b-profile-gaps-banner-desktop.png) |
| 5 | Preview iframe with skeleton timeout and Edit template/Open/Download | met | S3a: src ends `?v=0#toolbar=0&navpanes=0`; with PDF response held 8 s the skeleton is removed by the timeout; buttons/hrefs checked; [S3a-skeleton](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S3a-skeleton-desktop.png), [S3a-buttons](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S3a-buttons-desktop.png) |
| 6 | Phones show 'PDF previews open full-screen on phones.' + 'Preview PDF' | met | S3b @mobile (375 px, desktop and mobile projects): text, new-tab link, no iframe, no horizontal scroll; [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S3b-phone-preview-button-mobile.png) |
| 7 | GET annexures/mii_self_cert.pdf -> 200 application/pdf, inline filename mii_self_cert_GEM_2026_B_700001.pdf, private no-store, nosniff | met | S4 exact header equality |
| 8 | ?download=1 attachment; alias works; unknown key 404 'Annexure template not found' | met | S4: attachment header; `mii_self_certificate.pdf` returns identical text; 404 `{"error":{"code":"not_found","message":"Annexure template not found"}}` |
| 9 | text contains Class-I wording and 62% | met | S4: "'Class-I local supplier' (local content of 50% or more)" and "62%"; also non_blacklisting contains company name, bid no, GSTIN, signatory line |
| 10 | PDF layout: letterhead, Ref/Date, underlined title, numbered clauses, bold Subject, signature block (Place Maharashtra, Ravi Sharma, Director), footer on every page | met | S5: text checks; 4-page draft has footer on every page; bold font embedded; underline, double rule, hanging indent and bold Subject confirmed visually in [page 1](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S5-non_blacklisting-page1-desktop.png) and [page 2](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S5-long-body-page2-desktop.png) (underline/rule are not text-checkable) |
| 11 | PUT template as Analyst -> 403 | met | S6a: 403 "You need to be at least a Bid Manager to do that" (also Viewer PUT and Analyst DELETE) |
| 12 | (gap FR-043) Edit template button shown only to Bid Manager+ | met | S6b: absent for Analyst and Viewer, present for Bid Manager and Owner; [analyst](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S6b-analyst-no-edit-button-desktop.png), [owner](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S6b-owner-edit-button-desktop.png) |
| 13 | Bid Manager editor: Title/Body, Insert placeholder, Preview (no save) | met | S7: explainer text, palette inserts `{{company.legalName}}`, Preview POSTs `{title, body}` to `/preview`, iframe shown, template still `custom:false` |
| 14 | Save disabled until title >= 3 and body >= 20 | met | S7 boundaries 2/3 and 19/20 |
| 15 | Save -> 'Template saved for your organisation', custom:true | met | S8; [toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S8-saved-toast-desktop.png); `systemTitle`/`systemBody` unchanged |
| 16 | ...applies to all org workspaces only | met | S8: two workspaces of the org render the custom clause; other org's workspace does not and its template stays `custom:false` |
| 17 | Restore default -> custom:false, 'Restored the TenderPilot template' | met | S8 via UI and via API DELETE; [toast](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S8-restored-toast-desktop.png) |
| 18 | Body < 20 chars -> 400 'The template body is too short' | met (see Findings 1) | S9: 400, `validation_error`, message "body: The template body is too short", `details.fields.body` = "The template body is too short"; 20 chars accepted |
| 19 | (gap FR-041) {{company.gstn}} -> 400 unknown_placeholder with details.unknown | met | S10: code `unknown_placeholder`, message "Unknown placeholder {{company.gstn}} — use one from the list.", `details.unknown=["company.gstn"]`, preview endpoint also 400, nothing saved; UI shows error + highlighted mark + Preview disabled, server refusal on Save keeps dialog open; [S10](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S10-unknown-placeholder-desktop.png) |
| 20 | ₹ prints as 'Rs. ', ≥ as '>=', undrawable chars dropped; never fails | met | S11: company name/address and template body/title with ₹ ≥ Devanagari render 200; text has "Rs. ", ">=", no Devanagari; [S11](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S11-sanitised-page1-desktop.png) |
| T050 | Closing editor with edits asks "Discard unsaved changes?" (Keep editing / Discard changes) | met | T050: pristine close has no prompt; edited Esc shows confirm; Keep editing preserves edit; Discard closes and original is restored; [confirm](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/T050-discard-confirm-desktop.png) |
| FR-092 | (added at 9606a8c) Back / navigation while dirty | met | FR-092 test: Back shows the same confirm and stays on `step=annexures`; Keep editing stays; Back + Discard proceeds to `step=documents`; pristine editor does not prompt; [back-confirm](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/FR092-back-confirm-desktop.png) |

Videos: one `.webm` per test in the same folder.

### Findings

1. **observation** — Short-body message carries a field prefix. API returns `message: "body: The template body is too short"` with `details.fields.body: "The template body is too short"`. The criterion text is contained verbatim in the message and exactly in the field-level detail, and the same shared formatting is used everywhere, so I judge the criterion met. A client wanting the bare sentence must read `details.fields.body`.
   - Where: shared zod error formatting (API validation layer)
2. **minor** — Spec scenario 3 says phones are < 640 px; the app uses `useIsMobile` = < 768 px. At 700 px the phone panel (no iframe) is shown. [S3c-700px](https://github.com/Shashank2577/GEMs/blob/story/GEM-184-annexures/qa/evidence/006/US4/S3c-700px-desktop.png). Where: `apps/web/src/lib/hooks.ts:15` used by `AnnexuresStep.tsx`. Not a stated acceptance clause of #184 (which says "phones").
3. **minor** — axe (WCAG 2.1 A/AA), serious/critical: the Annexures step (list + preview panel, scoped) passes. The template editor dialog reports `label-content-name-mismatch` on the placeholder palette buttons (aria-label "Insert Legal name ({{company.legalName}})" does not contain the visible text `company.legalName`). Page-level run also reports `color-contrast` (success badges, a `.mb-1.5` element) and `label-content-name-mismatch` on workspace-header buttons ("Owner and assignees", "Internal due date"), which are outside AnnexuresStep. Recorded, not blocking; axe JSON files were not committed (evidence budget).
4. **observation** — One of four full runs had a single failure in S7 ("Save template" not disabled with a 2-char title, 12 s run); not reproduced in 3 isolated reruns or 2 further full runs. Possibly a race between editor seeding and typing; worth a look but no criterion fails consistently.

### Not checked

- Real in-browser PDF rendering inside the iframe (headless Chromium); the iframe src and response were checked, and the PDF itself was checked via poppler. Skeleton-timeout was verified with the response delayed, not with a genuinely silent `load`.
- Underline/rule/bold are visual only (rasterised PNGs reviewed by the QA agent), not machine-asserted.
- Real device phone testing; mobile run is Pixel 7 emulation plus a 375 px viewport.

### Bug issues filed

- none (findings above are observations/minor; not filed).

### Verdict

`qa:approved` — every criterion met, evidence above.

---
_Generated by [Claude Code](https://claude.ai/code)_
