# Feature Specification: Analyse — Bid Documents, Eligibility Extraction & Go/No-Go Scoring

**Feature Branch**: `004-analyse-scoring`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Analyse area of TenderPilot in detail: tender documents (fetch from GeM / upload), PDF text
extraction, deterministic rules extractor for bilingual GeM labels, LLM enrichment with Claude, OCR path for scanned
documents, scoring engine (weights, MSE/Startup exemptions, blockers, manual overrides), required-documents checklist,
stale analyses on corrigendum or company-profile change, and the tender detail page. Compare with
Mujahid-Alam_gem-tender-pdf-extractor and erenmyeager15 `pdf.ts` for extraction ideas to port."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — User Story 2 ("Qualify a
tender: Go/No-Go with evidence"), FR-010…FR-016, SC-002. Sibling specs: [`002-platform-tenancy`](../002-platform-tenancy/spec.md)
(roles, org settings), [`003-identify-ingestion-alerts`](../003-identify-ingestion-alerts/spec.md) (ingestion, corrigendum
detection that feeds the stale flag). This spec refines US2 into independently testable slices, describes what is
**built today** (verified against the code on 2026-11-05: `packages/core/src/analyse/*`, `apps/api/src/services/analyse.ts`,
`apps/api/src/routes/analysis.ts`, `apps/web/src/features/tender/*`) and adds requirements for the gaps that matter.
Requirements marked *(gap)* are not implemented yet; everything else is implemented and covered by unit tests
(`packages/core/test/analyse/*.test.ts`, 42 cases) and API tests (`apps/api/test/analyse.test.ts`).

## Personas affected

| Persona | Role in the app (server-enforced) | What they do in this area |
|---|---|---|
| **Owner (MSME founder / OEM sales head)** | `owner` | Reads the verdict on the phone before deciding to commit money (EMD) and people; may override with business knowledge (JV partner, OEM tie-up). |
| **Bid Manager** | `bid_manager` | Owns the Go/No-Go decision: runs analyses, overrides factors with a reason, tunes the org's scoring weights, starts the bid. |
| **Bid Analyst** | `analyst` | Fetches/uploads the bid PDF, ATC, corrigenda and BOQ, runs (re-)analysis, reads evidence page by page, prepares the checklist. Cannot override or change weights. |
| **Viewer (sales / OEM partner / consultant)** | `viewer` | Read-only: opens tender detail, reads the verdict, factors, requirements and documents; downloads PDFs. Cannot upload, analyse or override. |
| **Platform operator (TenderPilot team)** | n/a (logs) | Watches extraction quality on new GeM layouts, LLM failures/cost, GeM document-download failures. |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. "At least X" means X or any higher role. A role check failure
returns `403 {"error":{"code":"forbidden","message":"You need to be at least an Analyst to do that"}}` (or "a Bid Manager").

## User Scenarios & Testing *(mandatory)*

> **QA conventions for every scenario.** E2E stack: `pnpm e2e` (Playwright; desktop 1440×900 and Pixel 7 / 375 px for
> `@mobile`) with `tools/mock-gem` on :4011 standing in for GeM BidPlus (`GET /showbidDocument/:id` serves a generated
> GeM-style bid PDF; `POST /__admin/fail {mode:'down'}` makes it answer 503; `POST /__admin/corrigendum/<bidNumber> {days}`
> extends a bid's end date; `POST /__admin/reset`). Deterministic fixture PDFs live in
> `packages/core/test/fixtures/bids/`:
>
> | Fixture | Bid number | Key contents (all on the pages noted) |
> |---|---|---|
> | `go-it-services.pdf` (4 pages) | GEM/2026/B/6120451 | Turnover "50 Lakh (s)" p1; experience 3 years p1; MSE & Startup exemption **Yes** p1; estimated value 48,00,000 p1; EMD 96,000 p1; ePBG 3% / 14 months; MII **Yes** p2; delivery 30 days p3; ATC p4: ISO 9001:2015, similar work 40 % of estimated value (= ₹19,20,000), non-blacklisting |
> | `review-hardware-oem.pdf` | GEM/2026/B/6133872 | Turnover "1.5 Crore (s)"; OEM turnover "200 Crore (s)"; 2 years; past performance 20 %; no exemptions; EMD 2,16,000; MII Yes; delivery 45 days; OEM authorisation (doc list + ATC); BIS |
> | `nogo-experience.pdf` | GEM/2026/B/6140019 | Turnover "75 Lakh (s)"; **5 years**; no exemptions; EMD 50,000; MII No; delivery 15 days; similar work 80 % (= ₹20,00,000); non-blacklisting |
> | `emd-exempt-mse.pdf` | GEM/2026/B/6151234 | Turnover "30 Lakh (s)"; 1 year; MSE exemption Yes; EMD 67,500; no ePBG; MII Yes; delivery 60 days; BIS |
>
> **"Demo company"** = an org after `POST /api/demo/seed` (Aarav Technologies Pvt Ltd, Pune): micro MSE with a valid Udyam
> certificate in the vault, turnover FY22-23 ₹1,82,30,000 / FY23-24 ₹2,46,10,000 / FY24-25 ₹3,18,40,000 (average
> **₹2.49 Cr**), MII Class-I 62 % local content, max EMD capacity ₹15 L, five past contracts (largest ₹96.4 L "CCTV
> surveillance for 42 ward offices (supply, installation, 3-year AMC)", earliest started 1,100 days ago → **3 years**),
> ISO 9001 in vault, valid CP PLUS and D-Link OEM authorisations (Dell expired 5 days ago), operating states Maharashtra,
> Goa, Gujarat, Madhya Pradesh, Karnataka. **"Target tender"** = any ingested mock-gem tender that is open and closes
> ≥ 3 days from now (`/tenders/<id>`). API errors always have the shape `{ "error": { "code", "message", "details?" } }`.
> Numbers in the scenarios below were produced by running the real engine on these fixtures.

### User Story 1 - Get the bid documents into TenderPilot (fetch from GeM or upload) (Priority: P1) (#167)

An analyst opens a tender and either clicks **Fetch from GeM** (TenderPilot politely downloads the public bid document
`/showbidDocument/<gemBidId>` once and shares it with every org) or drags in a PDF they downloaded themselves — the bid
document, a separately published ATC, a corrigendum or the BOQ. Each file is validated (PDF, ≤ 25 MB), stored privately,
and its text is extracted page by page immediately so the user sees "4 pages read". Documents are listed with kind,
source (From GeM / Uploaded), page count, size, upload time and a "No text — scanned?" warning; anyone in the org can view
inline or download.

**Why this priority**: Every verdict is grounded in the documents. Without a reliable way to get the right PDF in, nothing
else in Analyse works, and GeM-blocked or scanned documents are common in practice.

**Independent Test**: As an analyst on the target tender, upload `go-it-services.pdf` as "Bid document" and verify it is
listed with "4 pages", can be viewed inline, and that a viewer of the same org can download it while another org gets 404.
Then click **Fetch from GeM** and verify the GeM copy is added once.

**Acceptance Scenarios**:

1. **Given** an analyst on `/tenders/<id>?tab=documents` with no documents, **When** the page loads, **Then** the "Tender documents" card shows the empty state "No documents yet" with body "Fetch the bid document from GeM, or upload the PDF you downloaded." and the right-hand card "Upload a document" shows a "Document type" select defaulting to "Bid document" and a dropzone hinted "PDF up to 25 MB".
2. **Given** that state, **When** the analyst drops `go-it-services.pdf` with type "Bid document", **Then** `POST /api/tenders/<id>/documents` returns **201** with `{kind:'bid', pageCount:4, hasText:true, source:'upload', orgId:<org>}`, a success toast "go-it-services.pdf uploaded" with description "4 pages read" appears, and the list shows the row with badge "Bid document", "Uploaded", "4 pages", the file size and "just now".
3. **Given** an analysis already exists for the tender, **When** another document is uploaded, **Then** the success toast carries a **Re-analyse** action that starts a new analysis when clicked.
4. **Given** the analyst uploads a `.docx` renamed to `.pdf`, **When** the request reaches the API, **Then** it answers **415** `unsupported_media_type` "Only PDF files can be analysed. Export the document to PDF and try again." and an error toast shows that message; nothing is stored.
5. **Given** a 26 MB PDF, **When** it is uploaded, **Then** the API answers **413** `payload_too_large` "The file is larger than 25 MB" (the dropzone may reject it client-side first with the same meaning).
6. **Given** a 0-byte file, **When** uploaded, **Then** **400** `bad_request` "The file is empty"; **Given** a multipart request without `file`, **Then** **400** `validation_error` "Choose a PDF file to upload" with `details.fields.file = "Required"`.
7. **Given** a corrupted or password-protected PDF, **When** uploaded, **Then** **422** `unreadable_pdf` "We could not read this PDF. It may be password-protected or damaged."
8. **Given** a tender with a GeM bid id and no GeM document yet, **When** the analyst clicks **Fetch from GeM**, **Then** `POST /api/tenders/<id>/fetch-documents` returns **201** `{fetched:1, total:1}`, the toast "Bid document downloaded from GeM" appears, and the row shows file name `GEM-2026-B-<n>.pdf`, kind "Bid document", "From GeM"; mock-gem's document counter (`GET /__admin/state`) increased by exactly 1.
9. **Given** the GeM document is already stored (by any org), **When** any analyst clicks **Fetch from GeM** again, **Then** the API returns **200** `{fetched:0}`, the toast reads "The GeM bid document is already here", and mock-gem receives no new request.
10. **Given** mock-gem is in `down` mode, **When** the analyst fetches, **Then** the API returns **502** `gem_unavailable` "Could not download the bid document from GeM right now. Try again in a few minutes or upload the PDF." and the toast shows it; **Given** GeM answers 404, **Then** the message is "GeM no longer serves this bid document. Upload the PDF instead."
11. **Given** a tender with neither GeM bid id nor document URL, **When** the analyst opens the Documents tab, **Then** no **Fetch from GeM** button is shown and the empty-state body reads "Upload the bid PDF you downloaded from GeM."; a direct API call returns **422** `no_gem_document`.
12. **Given** a viewer, **When** they open the Documents tab, **Then** they see the list with **View** and **Download** buttons but no Fetch button, and the upload card is replaced by "Viewers can read documents. Ask an analyst to upload new ones."; `POST …/documents` as viewer returns **403** `forbidden`.
13. **Given** org A uploaded a document, **When** a member of org B lists the tender's documents or requests `…/documents/<docA>/download`, **Then** the list omits it and the download returns **404** `not_found` (GeM-fetched documents are visible to both).
14. **Given** any listed document, **When** the user clicks **View**, **Then** the PDF opens in a new tab inline (`content-disposition: inline`, `cache-control: private, no-store`, `x-content-type-options: nosniff`); **Download** saves it with the original file name.
15. **Given** a scanned PDF with no text layer, **When** it is uploaded, **Then** it is accepted (201, `hasText:false`), the toast description reads "N pages read — no text found; it may be a scan" and the row shows the warning badge "No text — scanned?".
16. *(gap)* **Given** an analyst uploads a PDF whose header bid number is `GEM/2026/B/6133872` to a tender with a different bid number, **When** the upload completes, **Then** the response carries `warnings:[{code:'bid_number_mismatch', found:'GEM/2026/B/6133872'}]`, the toast is a warning "This PDF looks like GEM/2026/B/6133872, not <tender bid number>" and the row shows a "Different bid?" badge; the document is still stored.
17. *(gap)* **Given** an analyst's own uploaded document, **When** they choose **Remove** in the row menu and confirm "Remove <file name>? The next analysis will no longer use it.", **Then** `DELETE /api/tenders/<id>/documents/<docId>` returns **204**, the row disappears, the latest analysis is marked stale ("A document was removed since this analysis"); deleting a GeM-fetched document returns **403** `forbidden` "Documents fetched from GeM are shared and cannot be removed".

---

### User Story 2 - Deterministic eligibility extraction with page-level evidence (Priority: P1) (#168)

When an analysis runs, TenderPilot reads every attached document (bid → ATC → BOQ → other → corrigendum, then by upload
time), strips the Hindi half of GeM's bilingual labels ("बोली समाप्ति तिथि/समय/Bid End Date/Time"), finds ~26 known
"Bid Details" labels and reads each value up to the next label (robust to labels wrapping over lines), parses Indian
amounts ("50 Lakh (s)" → ₹50,00,000; "1.5 Crore (s)" → ₹1,50,00,000), IST date-times, days, months, percentages and
Yes/No, splits "Document required from seller" into one item per document, and scans the ATC for similar-work value,
experience in prose, certificates (ISO/BIS/CMMI/NABL/STQC/PSARA), OEM authorisation and non-blacklisting. Every
requirement carries the document, page, a quote of ≤ 220 characters, method `RULE` and a confidence. Later documents
supersede earlier values (a corrigendum wins); listing data fills anything the documents lacked. The **Requirements** tab
shows all of it grouped, searchable and linked to the exact PDF page — with zero API keys.

**Why this priority**: Constitution III: every verdict must have a deterministic, traceable path. Analysts only trust a
score whose inputs they can check against the page in seconds.

**Independent Test**: Upload `go-it-services.pdf` to the target tender, run **Analyse eligibility** with no
`ANTHROPIC_API_KEY`, open the Requirements tab and verify the 32 requirements, their values, pages and the page links.

**Acceptance Scenarios**:

1. **Given** `go-it-services.pdf` attached and no LLM key, **When** the analyst runs the analysis, **Then** `POST /api/tenders/<id>/analyse` returns **201** with `method:'rules'` and 32 requirements (30 before FR-019 added `bid_published_at` and `consignee_state`) including: `turnover_min` value "50 Lakh (s)" numeric 5000000 page 1; `experience_years` "3 years" numeric 3 page 1; `mse_exemption` true; `startup_exemption` true; `estimated_value` numeric 4800000; `emd` numeric 96000; `epbg` "3%"; `epbg_duration` "14 months"; `mii` true page 2; `delivery_days` "30 days" page 3; `similar_work` "40% of estimated value (₹19,20,000)" numeric 1920000 page 4 confidence 0.85; `certificate` "ISO 9001" page 4; `undertaking` "non_blacklisting" page 4; 4 `document` items ("Experience Criteria", "Bidder Turnover", "Certificate (Requested in ATC)", "Additional Doc 1 (Requested in ATC)"); `bid_published_at` "2026-11-28T00:00:00+05:30" page 1 (the fixture's "Dated:" line); and `consignee_state` "Delhi" page 3 confidence 0.8.
2. **Given** that analysis, **When** the user opens the **Requirements** tab, **Then** the header reads "32 requirements extracted · 32 by rules", sections appear in the order "Eligibility criteria", "EMD, ePBG & exemptions", "Documents required from seller", "Bid details" each with a count, mandatory rows show a red dot labelled "mandatory", every row shows a "Rule" badge and a confidence bar (95 % green for label fields, 85 % for similar work).
3. **Given** the Requirements tab, **When** the user clicks the "p. 4" chip on the similar-work row, **Then** a new tab opens `…/documents/<docId>/download?inline=1#page=4` showing page 4 of the PDF; the chip's accessible name is "Open go-it-services.pdf at page 4".
4. **Given** the Requirements tab, **When** the user types "emd" in "Filter requirements…", **Then** only rows whose label, value or quote contain "emd" remain; typing "zzz" shows "Nothing matches" / "No requirement mentions “zzz”."
5. **Given** page text with bilingual labels such as "बोली समाप्ति तिथि/समय/Bid End Date/Time 28-11-2026 15:00:00" and a label wrapped across two lines, **When** extracted, **Then** `bid_end` = "2026-11-28T15:00:00+05:30" (unit test `handles bilingual labels, wrapped labels and odd spacing`).
6. **Given** a bid PDF plus an uploaded corrigendum whose "Bid End Date/Time" is later, **When** analysed, **Then** `bid_end` comes from the corrigendum document (its file name and page in the source) while multi-valued items (documents, certificates) from both are kept.
7. **Given** a document that lacks EMD and estimated value, **When** analysed, **Then** `emd`/`estimated_value` come from the listing with quote "GeM BidPlus listing data", no page chip ("Listing" in the Source column) and confidence 70 %.
8. **Given** `review-hardware-oem.pdf`, **When** analysed, **Then** `turnover_min` numeric 15000000, `oem_turnover` numeric 2000000000, `past_performance` "20%", `oem_auth` true confidence 0.95 (listed in documents), `certificate` "BIS", and a `document` item "Compliance of BoQ specification and supporting document".
9. **Given** a tender with no documents and no GeM link, **When** the analyst clicks **Analyse eligibility** via API, **Then** **422** `no_documents` "Add the bid document first — upload the PDF or fetch it from GeM."; in the UI the toast "Add the bid document first" has an **Upload PDF** action and the page switches to the Documents tab.
10. **Given** a tender with a GeM link and no documents, **When** the analyst clicks **Analyse eligibility**, **Then** the GeM document is fetched automatically first and the analysis returns 201 with `documents` listing it; if the auto-fetch fails the API returns 422 `no_documents`.
11. **Given** a GeM PDF using the newer labels "MSE Relaxation for Years Of Experience and Turnover: Yes | Complete" and "Startup Relaxation for Years Of Experience and Turnover: No | Complete", **When** extracted, **Then** `mse_exemption` = true and `startup_exemption` = false (label variants ported from erenmyeager15 `routes.ts`).
12. **Given** a service bid with "Contract Period 2 Year(s)" and a header "Dated: 01-11-2026", **When** extracted, **Then** `contract_period` = "2 years" (numeric 24, months) and `bid_published_at` = "2026-11-01T00:00:00+05:30", both in the "Bid details" group.
13. **Given** an uploaded document whose header bid number differs from the tender's, **When** analysed, **Then** the analysis still runs but its summary starts with "Check documents: go-it-services.pdf is for GEM/2026/B/6120451." and the Requirements tab shows a warning callout.

---

### User Story 3 - Explainable Go/No-Go score with exemptions and blockers (Priority: P1) (#169)

The scoring engine compares the extracted requirements with the org's company profile, past contracts, vault and
scoring weights and produces ten factors — turnover, experience, similar work, EMD, Make in India, OEM authorisation,
certificates, documents in vault, delivery feasibility, time to close — each with a status (pass / exempt / needs review
/ fail / not applicable), weight, "Hard criterion"/"Blocker" flag and a plain-English detail sentence with Indian rupee
formatting (₹2.49 Cr, ₹50 L, ₹96,000). MSE and Startup exemptions apply only when the bid allows them **and** the company
qualifies with a valid Udyam / DPIIT certificate in the vault; EMD exemption for MSEs/Startups always applies (GFR 2017
rule 170). Score = round(100 × Σ weight×value / Σ weight) over applicable factors (pass/exempt 1, needs review 0.5,
fail 0); verdict = **No-Go** on any failed blocker, otherwise **Go** ≥ 70, **Review** 40–69, **No-Go** < 40; confidence =
share of applicable factors that are not "needs review". The Analysis tab shows the score ring, verdict badge, summary,
blocker callout, confidence bar, factor breakdown with evidence quotes and the checklist.

**Why this priority**: This is the "aha" moment the product is sold on: a defensible bid/no-bid decision in under a minute.

**Independent Test**: In the demo company, upload `go-it-services.pdf` to the target tender, analyse, and verify "Go ·
100/100" with the exact factor sentences below; repeat in a fresh org with a weak profile and `nogo-experience.pdf` for a
blocked No-Go.

**Acceptance Scenarios**:

1. **Given** the demo company and `go-it-services.pdf` on the target tender (state Maharashtra), **When** the analyst clicks **Analyse eligibility**, **Then** the "Analysing this tender…" card shows four steps ("Reading bid document", "Extracting eligibility", "Comparing with your profile", "Scoring") for at least 2.4 s, then a toast "Go · 100/100" with description "Rules-only analysis complete", and the score ring's accessible name is "Score 100 of 100, Go".
2. **Given** that analysis, **Then** the factor breakdown shows: Average annual turnover — Pass, "Hard criterion" — "Your average turnover of ₹2.49 Cr (last 3 years) meets the required ₹50 L."; Years of experience — Pass — "You have 3 years of experience; the bid needs 3 years."; Similar work value — Pass — "Your largest past contract (₹96.4 L, CCTV surveillance for 42 ward offices (supply, installation, 3-year AMC)) meets the required ₹19.2 L."; EMD (earnest money) — Exempt — "Exempt (MSE): EMD of ₹96,000 is waived with your valid Udyam certificate."; Make in India — Pass — "You are a Class-I local supplier with 62% local content and get purchase preference."; Certificates — Pass — "You hold all requested certificates: ISO 9001."; Documents in vault — Pass — "All 7 required documents are in your vault and valid. Also check 1 bid-specific document listed in the ATC."; Delivery feasibility — Pass — "Delivery period of 30 days to Maharashtra looks feasible."; and "Not applicable to this bid (1)" collapsed containing OEM authorisation — "No OEM authorisation is required."
3. **Given** that analysis, **Then** the score card shows the badge "Rules only" (tooltip "Deterministic rules only — every value is traceable to a page of the bid document."), the summary "Go — 100/100 with 100% confidence. Average annual turnover, years of experience and similar work value are in your favour. EMD (earnest money) is exempt for you.", confidence "100%", status counts "8 pass" and "1 exempt", and "Analysed just now".
4. **Given** a factor with evidence, **When** the user clicks **Show evidence** on "Similar work value", **Then** a quote block expands (`aria-expanded="true"`) showing the ATC sentence, the "p. 4" chip, the file name and "· Rule · 85% confidence"; clicking **Hide evidence** collapses it.
5. **Given** a fresh org whose profile has incorporation date exactly 3 years ago, FY 2024-25 turnover ₹90,00,000, max EMD capacity ₹1,00,000, no past contracts and an empty vault, and `nogo-experience.pdf` attached, **When** analysed, **Then** the verdict is **No-Go 58/100** with confidence 86 %, the red callout reads "Hard blocker: Years of experience — a failed blocker means No-Go regardless of score.", the blocker row is listed first with a "Blocker" badge and the detail "You have 3 years of experience (based on your incorporation date — add past contracts as proof); the bid needs 5 years.", Similar work value is "Needs review" ("Bid needs one similar work of ₹20 L; add your past contracts to check.") and EMD is Pass ("EMD of ₹50,000 is within your capacity of ₹1 L.").
6. **Given** the demo company and `review-hardware-oem.pdf` (no exemptions allowed), **When** analysed, **Then** (on a tender whose title/category name no product, e.g. "QA tender / IT Services"; on a product-named tender the OEM factor becomes Needs review per criterion 16 and the score is lower, e.g. Go 76 for "Desktop Computers") the verdict is **Go 82/100**, Certificates = Fail "Missing 1 certificate: BIS.", Documents in vault = Fail "7 of 8 required documents are ready. Missing: Past performance proof (supply orders for similar quantity). Also check 2 bid-specific documents listed in the ATC.", EMD = Exempt "Exempt (MSE): EMD of ₹2.16 L is waived with your valid Udyam certificate." and the summary ends "Fix: certificates and documents in vault."
7. **Given** an MSE profile whose Udyam certificate in the vault expired yesterday and a bid with MSE exemption Yes whose turnover the company misses, **When** analysed, **Then** turnover is Fail with the hint "Your Udyam certificate has expired — renew it to claim the MSE exemption." and EMD is not exempt; after uploading a valid Udyam and re-analysing, turnover becomes "Exempt (MSE): the bid waives the ₹… turnover criterion for MSEs…".
8. **Given** an org with no company profile and `go-it-services.pdf`, **When** analysed, **Then** the verdict is **Review 46/100** with confidence 44 %, five factors are "Needs review" with actionable sentences (e.g. "Bid needs ₹50 L average turnover, but your profile has no financial years yet. Add turnover to your company profile.") and the summary ends "Needs review: average annual turnover, years of experience, similar work value, EMD (earnest money) and make in India."
9. **Given** a tender whose end date has passed, **When** analysed via API, **Then** "Time to bid closing" is a failed blocker "This bid has already closed." and the verdict is No-Go; in the UI the hero's **Analyse eligibility** button is disabled for closed tenders that were never analysed.
10. **Given** a tender closing in 20 hours, **Then** "Time to bid closing" fails with "Closes in 20 hours — too little time to prepare a complete bid." (not a blocker); closing in 2 days → Needs review "Closes in 2 days — tight; start now."
11. **Given** a delivery period of 5 days, **Then** Delivery feasibility = Fail "Only 5 days to deliver — very tight."; **Given** delivery to Kerala while operating states exclude it, **Then** Needs review "Delivery in 30 days to Kerala, outside your operating states — check logistics."
12. **Given** a viewer, **When** they open the Analysis tab of an analysed tender, **Then** they see the full result but no **Re-analyse** and no **Override** buttons; with no analysis yet they see "Ask an analyst or bid manager on your team to run the analysis."; `POST …/analyse` as viewer returns **403**.
13. **Given** an analysis exists, **When** a member of another org calls `GET /api/tenders/<id>/analysis`, **Then** **404** `not_found` (analyses are per org).
14. *(gap)* **Given** an analysis already running for this org and tender, **When** a second `POST …/analyse` arrives, **Then** **409** `analysis_running` "An analysis is already running for this tender" and the UI keeps a single "Analysing…" state.
15. *(gap)* **Given** a successful analysis followed by a failed re-analysis, **When** the page reloads, **Then** the last successful result (with its overrides) is still shown under an inline warning "The last re-analysis failed: <reason>. Showing the previous result from <relative time>." with **Try again**.
16. *(gap)* **Given** the demo company and `review-hardware-oem.pdf` (Desktop Computers), **When** analysed, **Then** OEM authorisation is "Needs review" with "None of your valid OEM authorisations (CP PLUS, D-Link India) mention Desktop Computers — confirm one covers this product." because the only desktop OEM (Dell) expired.

---

### User Story 4 - Override a factor with a reason and tune scoring weights (Priority: P2) (#170)

A Bid Manager who knows something the documents don't (a JV partner's experience, an OEM letter in transit) overrides a
factor's status with a mandatory reason; the score, verdict, confidence and summary are recalculated instantly, the factor
shows who changed it, when and why, the change is written to the activity log, and the override survives re-analysis. Bid
Managers also tune the org's ten factor weights in **Settings → Scoring weights**; new analyses use them.

**Why this priority**: The engine is deliberately conservative; without an audited human override the team would ignore
it. Weights let each business express what matters (e.g. EMD capacity for a cash-tight MSE).

**Independent Test**: As a Bid Manager on the No-Go analysis from US3 #5, override "Years of experience" to Pass with a
reason, verify the verdict flips to Go and the History tab shows the audit entry; then change weights and verify the next
analysis uses them.

**Acceptance Scenarios**:

1. **Given** a Bid Manager viewing a done analysis, **When** they click **Override** on "Years of experience", **Then** a dialog "Override “Years of experience”" opens with the computed status and detail, a "New status" segmented control (Pass / Exempt / Unknown / Fail / N/A) preselected to **Pass** (or **Fail** if the computed status is Pass), and a required "Reason" textarea (max 500) with hint "Visible to your team in the activity log."
2. **Given** the dialog, **When** they click **Save override** with an empty or 2-character reason, **Then** the field shows "Give a short reason — it is kept in the audit log." and no request is sent; the API rejects such a body with **400** `validation_error` "Give a short reason (at least 3 characters)".
3. **Given** the No-Go analysis from US3 #5, **When** the Bid Manager sets experience to Pass with reason "JV partner Acme Systems brings 6 years of CCTV AMC experience", **Then** `POST /api/analyses/<id>/override` returns **200**, the toast "Years of experience set to pass" with description "New score 82/100 · Go" appears, the blocker callout disappears, the row shows an "Overridden" badge (tooltip "Originally fail — overridden by <name>") and the line "<name> set this to pass just now: “JV partner…”", and the score card shows "1 overridden".
4. **Given** that override, **When** the user opens the History tab, **Then** an entry "<name> overrode a factor" (activity `analysis.factor_overridden`) shows "Years of experience: fail → pass — “JV partner…”".
5. **Given** an overridden factor, **When** the Bid Manager overrides it again choosing the computed status, **Then** the dialog notes "Same as computed — this removes the override." and saving removes the badge and restores the computed score.
6. **Given** an overridden factor, **When** the analyst re-analyses, **Then** the override is re-applied to the new analysis as long as the newly computed status differs from the override.
7. **Given** an analyst (not Bid Manager), **Then** no **Override** buttons are rendered and the API returns **403** `forbidden`; **Given** an analysis with status other than `done`, **Then** **409** `conflict` "Only a completed analysis can be overridden"; **Given** an unknown factor key, **Then** **400** `validation_error`.
8. **Given** a Bid Manager on **Settings → Scoring weights**, **When** the page loads, **Then** ten labelled sliders with help text show the defaults (Turnover 20, Experience 18, Similar work 12, EMD 10, MII 6, OEM 10, Certificates 8, Documents 8, Delivery 4, Time to close 4), "Total weight 100", each "N · P% of score", and the badge "Default weights".
9. **Given** that page, **When** they set EMD to 30 and click **Save weights**, **Then** `PUT /api/scoring-weights {…}` returns **200** `{custom:true}`, the toast "Scoring weights saved" / "New analyses use them; open a tender and Re-score to update an existing result." appears, the badge becomes "Custom weights", the EMD help shows "Default 10."; the next analysis's EMD factor shows "Weight 30".
10. **Given** custom weights, **When** they click **Reset to default** then **Save weights**, **Then** the request body is `{}` and the response is `{custom:false}` with defaults.
11. **Given** all sliders at 0, **Then** "Total weight 0" is shown in red and **Save weights** is disabled; the API rejects `{turnover:0, …all 0}` with **400** `validation_error` "At least one weight must be above 0", an unknown key with 400, and a value 101 with 400.
12. **Given** an analyst or viewer, **When** they open Scoring weights, **Then** sliders are disabled and the footer reads "Only Bid Managers and Owners can change scoring weights."; `PUT` returns **403**.
13. *(gap)* **Given** custom weights saved, **When** a member opens an analysed tender, **Then** the analysis shows the stale banner with reason "Scoring weights changed since this analysis" and **Re-score** recomputes without re-reading documents (`POST /api/analyses/<id>/rescore`, 200).
14. *(gap)* The slider range matches the API range (0–100) so a value set via API (e.g. 80) is displayed and editable without clamping.

---

### User Story 5 - Required-documents checklist from the bid (Priority: P2) (#171)

Every analysis produces a checklist of what to submit: GST and PAN always; audited balance sheets and a CA turnover
certificate when turnover is asked; work orders + CRAC for experience and similar work; OEM authorisation (MAF); each
certificate from the ATC; Udyam + "EMD exemption declaration" for MSEs (or DPIIT for Startups) or a non-mandatory "EMD of
₹… — pay online or submit bank guarantee on GeM"; "Make in India self-certificate"; the non-blacklisting undertaking; and
any bid-specific "Additional Doc (Requested in ATC)". Items TenderPilot can generate (annexures) are marked "Generated";
item ids are stable so the bid workspace's checklist→vault mapping survives re-analysis.

**Why this priority**: It turns the verdict into a to-do list and feeds the Apply module's packet builder.

**Independent Test**: Analyse `go-it-services.pdf` in the demo company and verify the 13 mandatory items, 4 generated.

**Acceptance Scenarios**:

1. **Given** the demo company's analysis of `go-it-services.pdf`, **Then** the "Required documents" card shows count badge **13** and "13 to submit · 4 we generate for you. Start a bid to auto-match them with your vault.", with items in this order: GST registration certificate; PAN card of the firm; Audited balance sheets — last 3 financial years; CA certificate of average annual turnover; Work orders with completion certificates (CRAC) as proof of experience; Additional Doc 1 — as specified in the ATC; Work order + CRAC for one similar work of at least ₹19.2 L; ISO 9001 certificate; Udyam registration certificate (MSE); EMD exemption declaration (Generated); MSE exemption declaration (Generated); Make in India self-certificate (local content %) (Generated); Non-blacklisting / non-debarment undertaking (Generated).
2. **Given** each item, **Then** it shows a reason (≤ 2 lines, e.g. "Minimum average turnover of ₹50 L required (bid document, page 1)") and a badge: "Generated" (tooltip "TenderPilot fills this annexure from your company profile — review and sign it."), the vault document type (e.g. "GST certificate") or "Action on GeM".
3. **Given** a non-MSE, non-Startup company and `nogo-experience.pdf`, **Then** the EMD item is "EMD of ₹50,000 — pay online or submit bank guarantee on GeM" and appears under the collapsed "Optional & informational (1)" toggle (`aria-expanded` toggles), and "Certificates requested in the ATC" is listed because the doc list says "Certificate (Requested in ATC)" without a specific certificate.
4. **Given** the tender already has a bid workspace, **Then** the card description ends "Map them to your vault in the bid workspace." instead of "Start a bid…".
5. **Given** a re-analysis after uploading an ATC adding "CMMI Level 3", **Then** a new item "CMMI Level 3 certificate" appears and existing item ids (e.g. `gst`, `udyam`, `cert_iso_9001`) are unchanged.
6. **Given** an analysis with no checklist items (theoretical), **Then** the card shows "No documents identified" / "Re-analyse after uploading the ATC or corrigendum."
7. *(gap)* **Given** the demo company, **When** viewing the checklist on the tender page (no workspace yet), **Then** each item that maps to a vault type shows its readiness: "In vault" (valid), "Expires in 10 days" (ISO 9001, warning tone) or "Missing" (danger tone), computed with the same validity rule as scoring (expiry date ≥ today 23:59:59 IST).

---

### User Story 6 - Know when an analysis is outdated and re-analyse (Priority: P2) (#172)

A verdict is only valid for the inputs it was computed from. When ingestion detects a corrigendum (end/opening date,
quantity, items, EMD, estimated value, ePBG, document URL or title changed), every org's analysis of that tender is marked
**stale**; the tender page shows a "Re-analysis needed" banner, the score card an "Outdated" badge, the feed card a
"Re-check" badge and the workspace header "Re-analysis needed". Re-analysing clears it. *(gap)*: changes on the company
side (profile, past contracts, vault documents, scoring weights) and document changes (upload/remove, a new GeM document
after a corrigendum) also mark analyses stale, with the reason shown.

**Why this priority**: A stale Go is worse than no verdict — GeM corrigenda frequently change EMD, dates and quantities.

**Independent Test**: Analyse a mock-gem tender, `POST /__admin/corrigendum/<bidNumber> {days:7}`, run **Sync now**,
reload the tender and verify the banner, badges and that **Re-analyse now** clears them.

**Acceptance Scenarios**:

1. **Given** an analysed mock-gem tender, **When** mock-gem extends its end date by 7 days and a sync runs, **Then** `GET /api/tenders/<id>/analysis` returns `stale:true`, a `corrigendum` event exists, and the Analysis tab shows a `role="status"` banner "Re-analysis needed" — "A corrigendum changed this bid after it was analysed. The score below may be outdated." with **Re-analyse now** (analyst+ only).
2. **Given** the stale analysis, **Then** the score card shows the "Outdated" badge, the feed card shows "Re-check" (tooltip "A corrigendum changed this bid after it was scored — re-run the analysis."), the History tab shows "Corrigendum issued" with badge "Re-check eligibility" and "Bid end date: <old> → <new>", and the History tab trigger shows a warning dot labelled "corrigendum".
3. **Given** the banner, **When** the analyst clicks **Re-analyse now**, **Then** a new analysis is created with `stale:false`, the banner and badges disappear, and the time-to-close factor reflects the new end date.
4. **Given** a viewer on a stale analysis, **Then** the banner is shown without the button.
5. **Given** two orgs that analysed the same tender, **When** the corrigendum is ingested, **Then** both orgs' analyses are stale (corrigendum is public), while a re-analysis by org A leaves org B's analysis stale.
6. *(gap)* **Given** an analysed open tender, **When** a member with at least the Analyst role changes the company profile (e.g. financials or MII class), adds/edits/deletes a past contract, or uploads/edits/deletes a vault document, **Then** the org's analyses for **open** tenders are marked stale with reason `profile_changed` / `vault_changed` and the banner reads "Your company profile changed since this analysis. Re-score to update the score." (vault: "Your document vault changed since this analysis. Re-score to update the score.") with **Re-score** (analyst+) instead of **Re-analyse now**; analyses of other orgs are untouched.
7. *(gap)* **Given** a stale analysis, **Then** the banner shows when it became stale ("since 2 hours ago") and the API exposes `staleReason` and `staleAt`.
8. *(gap)* **Given** a corrigendum changed the tender's `documentUrl` and a GeM document was fetched before it, **When** the analyst re-analyses, **Then** TenderPilot fetches the new GeM document (shown as a second "From GeM" row with kind "Corrigendum") and the analysis uses it; the older GeM copy is kept for history.

---

### User Story 7 - AI enrichment and OCR for scanned documents with Claude (Priority: P3) (#174)

When `ANTHROPIC_API_KEY` is configured, after the rules each document's text is sent to Claude (default model
`claude-sonnet-5-5`) to find what rules miss — ATC-specific documents and certificates (labour licence, ESI/EPF, PSARA),
conditions, undertakings — returning validated JSON items with page and quote. The model's confidence is capped at 0.9
so a clean rule match (0.95) is never displaced; AI items are badged "AI"; the analysis shows "AI-assisted"; any LLM error
silently falls back to rules (logged). The LLM never decides the verdict. *(gap)*: scanned PDFs (no text layer) are sent
as PDF document input to a vision-capable model (default `claude-opus-5-5`) for page-wise transcription so rules can run;
structured outputs replace loose JSON parsing; long documents are chunked instead of truncated; an optional escalation
model (e.g. `claude-fable-5-1`, off by default) adjudicates low-confidence or conflicting blocking requirements.

**Why this priority**: Rules cover the standard "Bid Details" table reliably; AI adds recall on free-text ATC and makes
scanned corrigenda usable. It must stay optional (Constitution III, VII).

**Independent Test**: Run the API with a fake LLM client (as in `apps/api/test/analyse.test.ts`) or a real key in staging;
analyse `go-it-services.pdf` and verify an ATC item appears with an "AI" badge and the score card says "AI-assisted";
make the client throw and verify the result is identical to rules-only with `method:'rules'`.

**Acceptance Scenarios**:

1. **Given** an LLM is configured and returns `{"requirements":[{"key":"certificate","label":"ESI registration","value":"ESI registration","page":4,"quote":"…ESI…","confidence":0.95}]}`, **When** analysed, **Then** the response has `method:'rules+llm'`, the item has `method:'LLM'`, `confidence:0.9` (capped), and the Requirements header reads "33 requirements extracted · 32 by rules · 1 by AI"; the success toast description is "Rules + AI analysis complete".
2. **Given** the LLM returns a different `turnover_min` with confidence 0.9 while the rule has 0.95, **Then** the rule value is kept; **Given** the LLM finds a key the rules missed, **Then** it is added; duplicate documents/certificates (fuzzy label match) are not added twice.
3. **Given** the LLM call throws, times out (90 s) or returns non-JSON, **Then** the analysis completes with `method:'rules'`, identical factors to a rules-only run, and the API logs `analyse: LLM enrichment failed; using rules only`.
4. **Given** no `ANTHROPIC_API_KEY`, **Then** zero outbound LLM requests are made, the empty state says "Works without AI keys · AI adds ATC extras when enabled", and the "Analysing…" copy reads "Deterministic rules read the standard GeM fields — no AI key needed."
5. **Given** the score card of an AI-assisted analysis, **Then** the "AI-assisted" badge's tooltip reads "Rules extracted the standard GeM fields; AI added ATC-specific requirements. AI never decides the verdict."
6. *(gap)* **Given** AI is enabled, **When** the analysis is running, **Then** the "Analysing…" copy reads "Deterministic rules first, then AI reads the ATC for anything the rules missed." (the UI learns `ai:true` from `GET /api/analysis/capabilities`).
7. *(gap)* **Given** OCR is enabled and a scanned 3-page corrigendum (`hasText:false`), **When** the analyst clicks **Read with AI (OCR)** on its row or runs an analysis, **Then** the document is transcribed, the row's badge changes to "Text via OCR", `pageCount` is unchanged, requirements from it show source page numbers, a confidence ≤ 0.8 and the tooltip "Read from a scanned page by AI OCR — check against the PDF".
8. *(gap)* **Given** OCR is not configured and a scanned document is the only document, **When** analysed, **Then** `POST …/analyse` returns **422** `scanned_document` (008/FR-030: a scan without text cannot be analysed; `details.documents` lists the file names), and the Analysis tab (alongside the error toast) and the Documents tab show the notice "We couldn't read text from <file>. Upload a text PDF or ask your admin to enable AI OCR." with a link to the Documents tab (when OCR is available the notice points at "Read with AI (OCR)" instead); `POST …/documents/<docId>/ocr` returns **503** `ocr_unavailable`. When the tender also has a readable document, the analysis completes from that document and listing data, and the scan is reported in the analysis notes.
9. *(gap)* **Given** the model replies with `stop_reason:"refusal"` or `max_tokens`, **Then** it is treated as an LLM failure (rules fallback) and logged with the stop reason; token usage (input/output) and model id are logged for every call.
10. *(gap)* **Given** a document whose text exceeds 60,000 characters, **Then** it is sent in ≤ 60,000-character chunks (at most 4 per document) instead of being silently truncated, and items from all chunks are merged.
11. *(gap)* **Given** any LLM call, **Then** its payload contains only tender-document text or bytes and the list of rule-extracted requirements — never the company profile, financials, past contracts or vault documents (asserted by an API test inspecting the fake client's requests).

---

### Edge Cases

- **Same label repeated** (e.g. "Bid End Date/Time" on page 1 and in a corrigendum annexure on page 5 of one PDF): the first occurrence per document wins; across documents the later document (by kind order, then upload time) wins.
- **Amount without unit or with "(For 3 Years)"**: "Minimum Average Annual Turnover of the bidder (For 3 Years) 50 Lakh (s)" → 50,00,000 (the "(For 3 Years)" text is stripped before parsing); "Rs. 2,50,000/-" → 2,50,000; "0" turnover → factor Pass "The bid sets no minimum turnover."
- **Similar work as % but no estimated value** anywhere (document or listing): requirement value "40% of estimated bid value", numeric null, confidence 0.7 → factor "Needs review" "…but the estimated value is unknown — check manually."
- **Experience stated only in ATC prose** ("minimum of three years of experience"): extracted with confidence 0.75; numbers ≥ 40 are ignored as noise.
- **OEM authorisation mentioned only as text "Document required from seller…" context** without being in the list: not extracted (guard against false positives); listed in documents → confidence 0.95.
- **Expired vault documents**: a document is valid through its expiry date 23:59:59 IST; expired Udyam/DPIIT removes the exemption and adds a renewal hint; documents factor reports "N documents expired."
- **Both MSE and Startup**: MSE exemption is preferred when both apply.
- **Profile without financial years but with a turnover requirement**: turnover is "Needs review" (not fail) — unknowns lower confidence instead of silently passing or failing.
- **All factors not applicable** (e.g. an RA document with no criteria): score 50, confidence 0, verdict Review.
- **Weights with a factor at 0**: the factor still appears with "Weight 0" but contributes nothing; a blocking failure still forces No-Go.
- **Override to N/A**: removes the factor from the score; overriding a blocker to Pass removes the No-Go forcing.
- **Re-analysis while a corrigendum arrives**: whichever finishes last wins; the stale flag set by ingestion after the analysis started *(gap: must not be cleared by an analysis that started before the corrigendum — compare `stale_at` with analysis `created_at`)*.
- **PDF with a BOM or whitespace before `%PDF-`**: accepted (magic searched in the first 1 KiB).
- **Very large text PDF (25 MB, 400+ pages)**: extraction must finish within Worker limits *(gap: measure; if > 25 s CPU on Workers, extract on upload in Node only or cap pages at 300 with a warning)*.
- **GeM returns HTML instead of a PDF** (session page / error): `GemError` "GeM did not return a PDF for this bid document" → 502 `gem_unavailable`.
- **Unicode file names** ("निविदा.pdf"): stored name is sanitised to `_.pdf`-style ASCII for the header, the original is sent in `filename*=UTF-8''…`.
- **Tender removed / unknown id / malformed uuid**: 404 `not_found` "Tender not found"; the page shows "Tender not found" with **Back to tenders**.
- **Analysis requested on a closed tender**: allowed via API (closed bids can be studied) — the hero disables the button only when no analysis exists yet; time-to-close becomes a failed blocker.
- **LLM returns items with unknown keys**: coerced to `other`; an `other` item is added to the checklist only if its label looks like a document (certificate, registration, licence, undertaking, declaration, "copy of").

## Requirements *(mandatory)*

### Functional Requirements

#### Tender documents (US1)

- **FR-001**: The system MUST list a tender's documents visible to the caller's org — GeM-fetched (`org_id` null) plus the org's own uploads, oldest first — via `GET /api/tenders/:id/documents` (viewer+), returning `{items: TenderDocumentDto[], total}` with `id, tenderId, orgId, kind, fileName, sizeBytes, pageCount, sourceUrl, hasText, source ('gem'|'upload'), createdAt` and never the extracted text.
- **FR-002**: Users with at least the Analyst role MUST be able to upload a document via `POST /api/tenders/:id/documents` (multipart `file`, optional `kind` ∈ bid|atc|corrigendum|boq|other, default `bid`) and receive **201** with the DTO; the API MUST reject an empty file (400 `bad_request`), a missing file (400 `validation_error`, `details.fields.file`), > 25 MB (413 `payload_too_large`), a non-PDF (415 `unsupported_media_type`, `%PDF-` magic within the first 1 KiB) and an unreadable PDF (422 `unreadable_pdf`).
- **FR-003**: On upload or fetch the system MUST extract text per page (`unpdf`, Node and Workers), store it joined with form feeds in `tender_documents.text`, record `page_count`, and set `hasText` false when the text has no non-whitespace characters; it MUST log activity `tender.document_uploaded` / `tender.document_fetched` with file name, kind, pages and a `scanned` flag (average < 40 non-space characters per page).
- **FR-004**: Uploaded files MUST be stored privately under `tenders/<tenderId>/<orgId>/<uuid>.pdf` (GeM copies under `tenders/<tenderId>/gem/<uuid>.pdf`) with the file name sanitised to ≤ 120 safe characters.
- **FR-005**: Users with at least the Analyst role MUST be able to fetch the public GeM bid document via `POST /api/tenders/:id/fetch-documents`; the system MUST download `/showbidDocument/<gemBidId>` (or the stored document URL) through the polite GeM client (≤ 1 request/s, honest User-Agent, 2 retries with back-off, 45 s timeout), store it once per tender as a shared document (`org_id` null, name `<bid-number>.pdf`, `source_url` set), set `tenders.document_url` if empty, and return 201 `{fetched:1}`, or 200 `{fetched:0}` without contacting GeM when a GeM copy exists; errors: 422 `no_gem_document` when the tender has no GeM reference, 502 `gem_unavailable` with the 404-specific or generic message.
- **FR-006**: The system MUST stream a document via `GET /api/tenders/:id/documents/:docId/download` (viewer+, `?inline=1` for inline) with `content-disposition` (ASCII `filename` + RFC 5987 `filename*`), `cache-control: private, no-store` and `x-content-type-options: nosniff`.
- **FR-007**: Uploaded documents MUST be visible only to the uploading org; any other org MUST receive 404 for list, metadata and download (Constitution IV).
- **FR-008** *(gap)*: The GeM document download MUST abort and answer 502 `gem_unavailable` "The GeM document is larger than 25 MB — download it from GeM and upload it here." when the response exceeds 25 MB (stream with a byte cap, as erenmyeager15 `fetchWithRetries({maxBytes})` does).
- **FR-009** *(gap)*: Users with at least the Analyst role MUST be able to remove their org's uploaded document via `DELETE /api/tenders/:id/documents/:docId` (204; blob deleted; activity `tender.document_removed`); GeM-fetched documents MUST NOT be removable (403 `forbidden`).
- **FR-010** *(gap)*: On upload the system MUST detect the bid number printed in the document (`GEM/\d{4}/[A-Z]/\d+` in the first page header/footer) and, when it differs from the tender's bid number, return `warnings:[{code:'bid_number_mismatch', found}]` in the upload response and `bidNumberFound` on the DTO so the UI can show "Different bid?".

#### Extraction (US2)

- **FR-011**: The rules extractor MUST normalise each page (remove Devanagari U+0900–U+097F and zero-width characters, normalise dashes/quotes/non-breaking spaces, drop "/ /" leftovers, collapse whitespace) and locate the known GeM "Bid Details" labels — bid end / opening date-time, offer validity, ministry/state, department, organisation, office, total quantity, item category, estimated bid value, minimum average annual turnover, OEM average turnover, years of past experience, past performance, MSE exemption, Startup exemption, documents required from seller, bid to RA, type of bid, evaluation method, EMD amount, ePBG percentage, ePBG duration, MII compliance/purchase preference, MSE purchase preference, delivery days/period — reading each value from the end of the label to the next known label (including boundary-only labels) within 260 characters (600 for the document list).
- **FR-012**: The extractor MUST parse Indian amounts with crore/lakh/lac/thousand units and "(s)" suffixes, "Rs."/"₹"/"INR" prefixes and Indian digit grouping into integer rupees; GeM date-times "dd-mm-yyyy hh:mm[:ss]" as IST (`+05:30`); days, months, percentages, integers and Yes/No.
- **FR-013**: The "Document required from seller" value MUST be split on commas outside parentheses into one `document` requirement per item (mandatory, confidence 0.9), ignoring the "*In case any bidder…" footnote.
- **FR-014**: The extractor MUST scan every page for: similar work as "% of estimated value" (converted to rupees using the estimated value from the document or listing; confidence 0.85, 0.7 when no value) or as an absolute value (0.8); years of experience in prose including number words one–ten (0.75, only when not found as a label); certificates ISO 9001/14001/27001/45001/20000/22000/13485/50001, BIS, CMMI Level n, NABL, STQC, PSARA (0.8, one per name); OEM authorisation (0.95 when in the documents list, else 0.8 with a false-positive guard); non-blacklisting/non-debarment undertaking (0.85).
- **FR-015**: Every requirement MUST carry `key, label, value, numeric, mandatory, source {documentId, fileName, page (1-based), quote ≤ 220 chars}, method ('RULE'|'LLM'|'MANUAL'), confidence 0..1`; label-table matches have confidence 0.95.
- **FR-016**: When no document yields them, the system MUST fill `bid_end`, `emd`, `estimated_value`, `epbg` and `item_category` from the listing with confidence 0.7 and quote "GeM BidPlus listing data".
- **FR-017**: Requirements from several documents MUST be combined in the order bid → ATC → BOQ → other → corrigendum (ties by upload time): single-valued keys take the later document's value; `document`, `certificate`, `undertaking` and `other` are unioned by normalised value.
- **FR-018**: The extractor MUST also recognise the newer GeM label variants "MSE Relaxation for Years Of Experience and Turnover" and "Startup Relaxation for Years Of Experience and Turnover" and the value forms "Yes | Complete" / "No | Complete" (ported from erenmyeager15 `buildEligibilitySummary`).
- **FR-019**: The extractor MUST extract `contract_period` ("Contract Period … Year(s)/Month(s)/Day(s)" → months) for service bids and `bid_published_at` from "Dated: dd-mm-yyyy", treat "Years of Past Experience Required for same/similar service" as the experience label, and extract `consignee_state` from the consignee/reporting-officer address (Indian state list, ported from erenmyeager15 `inferIndianState`) so delivery feasibility can use it when the listing has no state.
- **FR-020**: The Requirements tab MUST show the count line ("N requirements extracted · X by rules[ · Y by AI]"), a filter box matching label, value and quote, groups "Eligibility criteria", "EMD, ePBG & exemptions", "Documents required from seller", "Bid details" with counts, and per row the label with mandatory dot, one-line quote, formatted value, a page chip linking to `…/download?inline=1#page=N` (or "Listing"), a method badge (Rule / AI / Manual) and a confidence bar (≥ 85 % green, ≥ 65 % amber, else red); with no done analysis it shows "No requirements yet".

#### Scoring & analysis (US3)

- **FR-021**: The scoring engine MUST produce exactly ten factors with keys `turnover, experience, similarWork, emd, mii, oem, certificates, documents, deliveryFeasibility, timeToClose`, labels as in `FACTOR_LABELS`, the org's resolved weights (defaults 20/18/12/10/6/10/8/8/4/4), a status, a `blocking` flag, a human detail sentence and the `requirementKey` it derives from.
- **FR-022**: Factor rules MUST be: **turnover** — average of the latest ≤ 3 financial years with turnover > 0 vs `turnover_min` (blocking); **experience** — years since the earliest past-contract start (fallback incorporation date, flagged in the sentence) vs `experience_years` (blocking; a failed factor whose contract years are below the incorporation years, and whose incorporation years would meet the bid, appends "(incorporated N years ago — add older contracts as proof)"); **similarWork** — largest past contract vs `similar_work` rupees; **emd** — exempt for a qualified MSE/Startup, else vs `maxEmdCapacity` (unknown when unset); **mii** — Class-I pass with purchase preference, Class-II pass without, non-local fail, unset unknown, n/a when MII not required; **oem** — any valid authorisation in profile or vault passes (blocking when mandatory), none → fail, no profile → unknown; **certificates** — each requested certificate must be in `profile.certifications` or as a valid vault document (ISO by number, BIS by type, else by title) else fail listing the missing; **documents** — mandatory checklist items with a vault type (excluding generated, certificate and `other` items) must be valid in the vault, else fail "H of N required documents are ready. Missing: …"; **deliveryFeasibility** — < 7 days fail, outside operating states unknown, else pass; **timeToClose** — closed → failed blocker, < 1 day fail, < 3 days unknown, else pass.
- **FR-023**: Score, verdict, confidence and summary MUST be computed as: value pass/exempt = 1, unknown = 0.5, fail = 0, `na` excluded; score = round(100 × Σ w·v / Σ w) (50 when Σ w = 0); verdict No-Go on any blocking fail, else Go ≥ 70, Review ≥ 40, No-Go < 40; confidence = known ÷ applicable rounded to 2 decimals; summary "<Verdict> — S/100 with C% confidence." followed by blockers, favourable factors (≤ 3), exemptions, "Fix: …", "Needs review: …" and "N factors manually overridden." as applicable.
- **FR-024**: MSE/Startup exemptions for turnover, experience and similar work MUST apply only when the bid's `mse_exemption`/`startup_exemption` is Yes AND the profile is MSE (category or Udyam number) / Startup (flag or DPIIT number) AND a valid `udyam` / `startup_dpiit` vault document exists; EMD MUST be exempt for any qualified MSE/Startup regardless of the bid flag; when the company is MSE/Startup but not qualified the detail MUST include the upload/renewal hint.
- **FR-025**: `POST /api/tenders/:id/analyse` (analyst+) MUST auto-fetch the GeM document when none is attached, return 422 `no_documents` when still none, insert an `analyses` row (`running`), extract per document (rules, then LLM when configured), combine with listing fallback, load profile/past contracts/vault/weights, score with overrides carried from the previous analysis, build the checklist, update the row to `done` with `method`, `stale:false`, log `tender.analysed {analysisId, score, verdict, method, bidNumber}` and return 201 `AnalysisDto` with `documents`; on any error it MUST mark the row `failed` with the error (≤ 500 chars) and return 500 `analysis_failed` "The analysis failed. Please try again; if it keeps failing, upload a cleaner PDF."
- **FR-026**: `GET /api/tenders/:id/analysis` (viewer+) MUST return the org's latest analysis with its documents, or 404 `not_found`.
- **FR-027**: The Analysis tab MUST show: while running, the 4-step "Analysing this tender…" card (≥ 2.4 s, `aria-busy`, `aria-live="polite"`); with no analysis, the empty state "Should you bid on this tender?" with four check bullets and **Analyse eligibility** (or **Upload the bid PDF** when no document and no GeM link; or the viewer sentence); with a done analysis, the score card (ring, verdict badge, method badge, overridden/outdated badges, summary, blocker callout, confidence bar with tooltip, status counts, "Analysed <relative time>", **Re-analyse**), the factor breakdown sorted failed blockers → fail → needs review → pass → exempt then by weight, each with icon, help tooltip, status badge, "Hard criterion"/"Blocker" badge, detail, override note, **Show evidence** quote with page chip, file, method and confidence, weight bar (≥ 640 px) and **Override** (bid_manager+), a collapsible "Not applicable to this bid (n)", and the checklist card; with a failed analysis, "The last analysis failed" with the error and **Try again**.
- **FR-028** *(gap)*: The system MUST reject a second analyse request for the same org and tender while one is `running` and younger than 2 minutes with 409 `analysis_running`; older `running` rows MUST be treated as failed (`error: 'timed out'`).
- **FR-029** *(gap)*: `GET …/analysis` MUST return the latest **done** analysis plus `lastAttempt {status, error, at}` when a newer row is `running` or `failed`; overrides MUST be carried from the latest done analysis (today a failed attempt drops them because its factors are empty); the UI MUST show the previous result under the warning of US3 #15 and, while another member's analysis is running, "Analysis in progress…" polling every 3 s.
- **FR-030** *(gap)*: The OEM factor MUST be `unknown` (not pass) when valid authorisations exist but none of their OEM names, product descriptions or vault tags share a significant word with the tender's title, category or items, with the detail of US3 #16.
- **FR-031**: The hero MUST show **Analyse eligibility** (or **Re-analyse** when done) for analyst+, disabled for closed tenders without a done analysis, and a compact score ring when analysed; the success toast MUST read "<Go|Review|No-Go> · S/100" with "Rules-only analysis complete" or "Rules + AI analysis complete".

#### Overrides & weights (US4)

- **FR-032**: `POST /api/analyses/:id/override` (bid_manager+) MUST accept `{factorKey ∈ FACTOR_KEYS, status ∈ pass|fail|unknown|exempt|na, reason 3–500 chars}`, require the analysis to belong to the org (404) and be `done` (409 `conflict`), store `overridden {status, reason, by (user name), at}` on the factor (or remove it when the status equals the computed one), recompute score/verdict/confidence/summary without re-extraction, log `analysis.factor_overridden {analysisId, factorKey, label, from, to, reason, score, verdict}` and return 200 `AnalysisDto`.
- **FR-033**: Overrides MUST be re-applied on re-analysis to factors whose newly computed status differs from the override.
- **FR-034**: `GET /api/scoring-weights` (viewer+) MUST return `{weights, defaults, custom}`; `PUT /api/scoring-weights` (bid_manager+) MUST accept a strict partial map of factor → number 0..100 with at least one > 0 (or `{}` to reset), persist the resolved map in `organizations.scoring_weights` (null when reset), log `org.scoring_weights_updated` and apply to analyses created afterwards.
- **FR-035**: The Scoring weights settings section MUST show total weight, each factor's weight and share of the score, help text, "Default N." when changed, the Default/Custom badge, **Reset to default** and **Save weights** (disabled when unchanged or total 0) for bid_manager+, and the read-only footer for others.
- **FR-036** *(gap)*: The weights sliders MUST cover 0–100 to match the API.
- **FR-037** *(gap)*: `POST /api/analyses/:id/rescore` (analyst+) MUST recompute factors from the stored requirements with the current profile, vault and weights (no document re-read, no LLM), keep overrides, clear `stale`, and return 200. It MUST refuse with **409** `reanalysis_required` when the analysis is stale for a reason a re-score cannot fix (`corrigendum`, `document_added`, `document_removed`, or no recorded reason); those need a full re-analysis. A reason that needs re-analysis MUST NOT be replaced by a later re-scorable one (`profile_changed` / `vault_changed` / `weights_changed`).

#### Checklist (US5)

- **FR-038**: Every analysis MUST include a checklist built from its requirements and the profile with stable ids: `gst`, `pan` always; `balance_sheets` + `ca_turnover_certificate` when turnover is required or listed; `experience_proof` (CRAC) for experience; mappings for listed documents (OEM turnover, past performance, OEM authorisation, BOQ technical compliance (generated), `atc_<slug>` for "Additional Doc", `doc_<slug>` otherwise); `similar_work_proof`; `cert_<slug>` per certificate (ISO → `iso`, BIS → `bis` vault type) or `atc_certificates`; `oem_authorization`; EMD: MSE → `udyam` + `emd_exemption` (generated), Startup → `startup_dpiit` + `emd_exemption`, else optional `emd_payment`; `udyam` + `mse_declaration` (generated) when MSE exemption is claimed; `startup_dpiit` for Startup exemption; `mii_self_cert` (generated) when MII is required; `non_blacklisting` (generated, mandatory only when requested); other undertakings; LLM `other` items that look like documents.
- **FR-039**: The checklist card MUST show the mandatory count, "M to submit · G we generate for you." plus the workspace hint, mandatory rows (icon, label, 2-line reason, Generated / vault-type / "Action on GeM" badge), a collapsed "Optional & informational (n)" section, sticky positioning on ≥ 1280 px, and the empty state.
- **FR-040** *(gap)*: The tender-page checklist MUST show per-item vault readiness (In vault / Expires in N days / Expired / Missing) for items with a vault type, using the scoring validity rule, without requiring a bid workspace. The chips are shown only when no workspace is attached (an attached workspace maps documents to the vault itself) and are omitted, with a "Vault status unavailable" hint, if the vault cannot be loaded. Items typed `other` (ATC/free-text documents, unrecognised certificates) have no chip; `cert_*` items use the same certificate matcher as the scoring Certificates factor.

#### Staleness (US6)

- **FR-041**: When ingestion records a corrigendum (changes to end/opening date, quantity, items, EMD, estimated value, ePBG, document URL or title) the system MUST set `stale = true` on all analyses of that tender.
- **FR-042**: The UI MUST surface stale analyses: the "Re-analysis needed" banner with **Re-analyse now** (analyst+), the "Outdated" badge on the score card, "Re-check" on feed cards, "Re-analysis needed" in the workspace header and "Corrigendum since analysis" in the workspace Qualify step; a successful analysis MUST reset `stale` to false.
- **FR-043** *(gap)*: Analyses MUST record `stale_reason` ∈ corrigendum | document_added | document_removed | profile_changed | vault_changed | weights_changed and `stale_at`; the API MUST expose `staleReason`/`staleAt` and the banner MUST use reason-specific copy.
- **FR-044** *(gap)*: Changes to the company profile, past contracts or vault documents MUST mark the org's analyses of open tenders stale (`profile_changed` / `vault_changed`); uploading or removing a tender document MUST mark the org's latest analysis of that tender stale (`document_added` / `document_removed`); saving weights that change the effective weights MUST mark the org's analyses of open tenders stale (`weights_changed`); a save that leaves them unchanged marks nothing.
- **FR-045** *(gap)*: A stale flag set after an analysis started MUST NOT be cleared by that analysis completing (compare `stale_at` with the analysis `created_at`).
- **FR-046** *(gap)*: When a corrigendum changed the tender's document URL after the GeM copy was fetched, the next fetch/analyse MUST download the new GeM document as kind `corrigendum` and keep the old one.

#### AI enrichment & OCR (US7)

- **FR-047**: When an LLM client is configured, the system MUST, per document with text, send the pages (marked "=== Page N ===", ≤ 60,000 characters) and the rule-extracted requirements to the model, validate each returned item (zod; invalid items dropped; unknown keys → `other`), cap confidence at 0.9, merge (single keys replaced only by strictly higher confidence and never over MANUAL; multi-valued items added unless a fuzzy duplicate), set `method: 'rules+llm'` when at least one call succeeded, and on any error fall back to the rule results and log a warning.
- **FR-048**: The LLM MUST NOT decide or alter a verdict directly; it only contributes requirements that the deterministic engine scores (Constitution III).
- **FR-049** *(gap)*: The adapter MUST request structured output (`output_config.format` JSON schema mirroring the item schema), treat `stop_reason` `refusal` / `max_tokens` as failures, and log model id, stop reason and input/output token usage per call.
- **FR-050** *(gap)*: Model choice MUST be configurable per purpose: `LLM_MODEL` (enrichment, default `claude-sonnet-5-5`), `LLM_OCR_MODEL` (scanned-PDF transcription, default `claude-opus-5-5`) and optional `LLM_ESCALATION_MODEL` (e.g. `claude-fable-5-1`, unset by default) used only when a blocking requirement (`turnover_min`, `experience_years`, `oem_auth`, `emd`) has rule confidence < 0.75 or rule and LLM values conflict; the escalation returns a requirement with a quote like any other LLM item. *Implementation note (PR #560 review):* an escalation answer never silently replaces a RULE item — only when its quote is found on the cited page and its confidence is ≥ the rule's; otherwise the rule stays and carries `needsReview` with what the model read.
- **FR-051** *(gap)*: Documents longer than 60,000 characters MUST be processed in up to 4 page-aligned chunks; anything beyond MUST be reported in the analysis (`notes: ['Pages 181–240 of X.pdf were not read by AI']`) rather than silently dropped.
- **FR-052** *(gap)*: For a document with `hasText:false` (or `looksScanned`), when an OCR model is configured, the system MUST send the PDF (≤ 100 pages per call, split with pdf-lib; ≤ 22 MB raw per call so the base64 request stays under 32 MB) as a `document` content block asking for page-wise transcription, store the text with `text_source = 'ocr'`, and mark requirements extracted from it with `source.ocr = true` and confidence capped at 0.8. `POST /api/tenders/:id/documents/:docId/ocr` (analyst+) MUST run it on demand (200 DTO; 409 when the document already has text; 503 `ocr_unavailable` without an OCR model). *Implementation note (PR #560 review):* the API sends ≤ 5 pages per call (≤ 90 s, ≤ 16k output tokens); a run takes one monthly AI slot (402 when used up, ADR-0008 amendment); a reply that leaves out a page fails the run (502, nothing stored); `?force=1` (bid_manager+) re-reads OCR text; `TenderDocumentDto.needsOcr` drives the UI.
- **FR-053** *(gap)*: `GET /api/analysis/capabilities` (viewer+) MUST return `{ai: boolean, ocr: boolean, models: {enrichment?, ocr?, escalation?}}` so the UI can choose copy and show OCR actions.
- **FR-054** *(gap)*: LLM requests MUST contain only tender-document content and rule-extracted requirements; company profile, financials, past contracts and vault contents MUST never be sent.

#### Tender detail page (all stories)

- **FR-055**: `/tenders/:id` MUST render a breadcrumb (Tenders / bid number), the hero (bid number with copy, status, title, buyer chain, place, key facts, countdown, actions **Analyse eligibility**/**Re-analyse**, **Open on GeM**, **Start bid**, more-menu **Dismiss from feed**), and tabs **Analysis**, **Requirements** (count badge), **Documents** (count badge), **History** (corrigendum dot) whose selection is kept in `?tab=` (Analysis is the default and omits the parameter); loading shows skeletons with `aria-busy`, a 404 shows "Tender not found" with **Back to tenders**, other errors show the retryable error state.
- **FR-056** *(gap)*: The page MUST pass an automated axe scan (no serious/critical violations) on all four tabs in light and dark themes at 375 px and 1440 px.

### Non-Functional Requirements

- **NFR-001**: Rules-only analysis of a ≤ 10-page text PDF MUST complete server-side in p95 < 5 s; with LLM enrichment, the whole analysis MUST complete in < 60 s for a ≤ 40-page bid (SC-002 of the parent spec); OCR of a 10-page scan in < 90 s.
- **NFR-002**: Extraction and scoring MUST be deterministic and pure: identical requirements, profile, vault, weights and `now` produce identical factors, score and summary; the full verdict path MUST work with zero API keys.
- **NFR-003**: Every query in this area MUST be scoped by organization; GeM-fetched documents are the only cross-org rows and contain only public data.
- **NFR-004**: GeM document downloads MUST respect the polite-client limits (≤ 1 request/s, honest User-Agent, back-off, no login, public URLs only) and be fetched at most once per tender (plus once per corrigendum document change).
- **NFR-005**: Uploads up to 25 MB MUST be accepted on both Node and Workers runtimes without exceeding the Worker memory limit (128 MB); text extraction MUST not block other requests for more than the request's own duration.
- **NFR-006**: All screens in this area MUST meet WCAG 2.1 AA contrast in light and dark themes, be keyboard operable, announce progress and status changes politely, and never use colour as the only signal (every status has a text badge).
- **NFR-007**: LLM usage MUST be bounded: ≤ 8 model calls per analysis, `max_tokens` ≤ 4,096 for enrichment, request timeout 90 s; usage MUST be logged per call for cost tracking.
- **NFR-008**: Errors MUST use the standard envelope; user-facing messages MUST be plain English and actionable (what to do next).
- **NFR-009**: Code reused from reference repositories MUST be Apache-2.0/MIT and attributed in `NOTICE`; repositories without a licence are used for ideas only.
- **NFR-010**: Test coverage: unit tests for every label, parser and factor branch; API tests for every endpoint and error code; one Playwright E2E per user story with screenshots, video and trace in `qa/evidence/004/US<n>/`.

### UX Specification

**Screens & components** (`apps/web/src/features/tender/*`, `apps/web/src/features/settings/sections/ScoringSection.tsx`):

| Screen / component | Desktop (1440 px) | Mobile (375 px) |
|---|---|---|
| Tender hero (`TenderHero`) | Facts in a 4-column grid; actions in one row (Analyse, Open on GeM, Start bid, ⋯) | Facts 2 columns; actions wrap full-width; bid number copy button stays tappable (≥ 44 px) |
| Tabs | Horizontal tab list with icons and count badges | Same list, horizontally scrollable without page overflow |
| Analysis tab (`AnalysisPanel`) | Two columns: score card + factor breakdown (min 0 1fr) and 360 px checklist sticky at top 80 px (≥ 1280 px) | Single column: score ring centred above text; factor weight bars hidden; **Override** moves below each factor; checklist after factors |
| Analysing state (`AnalysingState`) | Ring (180 px) left, steps right | Ring above steps |
| Override dialog | Medium dialog, segmented status control in one row | Full-width dialog; segmented control wraps; textarea autofocus |
| Requirements tab | Grouped tables (Requirement 34 %, Value 26 %, Source, Method, Confidence) | `ResponsiveTable` renders cards (label primary, other columns as labelled rows); filter input full width |
| Documents tab | List (min 0 1fr) + 340 px upload card | Upload card below list; row actions under file info |
| Settings → Scoring weights | Sliders list in the settings panel | Same, full width; footer buttons stack |

**States**:

- *Loading*: tender skeleton (breadcrumb, hero, 4 fact tiles, tabs, analysis skeleton) with `aria-busy="true"` and label "Loading tender"; analysis skeleton; document list skeleton (2 rows); history skeleton (4 rows); weights skeleton (6 rows).
- *Empty*: Analysis — "Should you bid on this tender?" card; Requirements — "No requirements yet"; Documents — "No documents yet"; Checklist — "No documents identified"; History — "No history yet"; filter — "Nothing matches".
- *Error*: tender 404 → "Tender not found"; other load errors → `ErrorState` with **Retry**; analysis failed → "The last analysis failed" card; mutation errors → toast with the API message (no_documents → toast with **Upload PDF** action and tab switch).
- *Stale*: warning banner (role status) above the analysis; "Outdated" badge.
- *Permission*: controls hidden (not disabled) for insufficient roles, with explanatory sentences where a whole card is replaced; weight sliders disabled with footer text.
- *Busy*: buttons show a spinner and keep their label (`loading`); upload dropzone title "Uploading and reading…" and disabled.

**Copy rules**: Indian rupee compact format (₹96,000, ₹19.2 L, ₹2.49 Cr); IST for all times with relative time and an absolute tooltip; procurement terms explained in tooltips (`FACTOR_HELP`: EMD, MII, OEM/MAF, CRAC, ATC).

**Accessibility**: Score ring `role="img"` with label "Score S of 100, Verdict"; evidence and "Not applicable" toggles are buttons with `aria-expanded`; page chips have descriptive `aria-label`; mandatory dots have `aria-label="mandatory"`; confidence bars have `aria-label="N% confidence"`; the analysing card is `aria-live="polite"`/`aria-busy`; motion respects `prefers-reduced-motion`; focus is trapped in dialogs and returned to the trigger; all actions are reachable by keyboard in visual order.

### Key Entities *(include if feature involves data)*

- **Tender** (`tenders`): public GeM bid — bid number, GeM bid id (`/showbidDocument/<id>`), document URL, end date, state, EMD, estimated value, ePBG, category, status. Shared by all orgs.
- **Tender Document** (`tender_documents`): a PDF attached to a tender — kind (bid/ATC/corrigendum/BOQ/other), file name, private blob key, size, page count, extracted text (pages separated by form feed), source URL; `org_id` null = fetched from GeM (shared), else uploaded by that org. *(gap)* `text_source` (pdf | ocr).
- **Analysis** (`analyses`): one run of the engine for an org and tender — status (pending/running/done/failed), method (rules / rules+llm), requirements, factors, checklist, score, confidence, verdict, summary, error, stale, created by/at. *(gap)* `stale_reason`, `stale_at`, `notes`.
- **Requirement** (jsonb): an extracted condition with value, numeric value, mandatory flag, provenance (document, page, quote), method and confidence.
- **Score Factor** (jsonb): key, label, status, weight, blocking, detail, requirement key, optional override {status, reason, by, at}.
- **Checklist Item** (jsonb): stable id, label, vault document type or null, mandatory, reason, generated annexure key.
- **Scoring Weights** (`organizations.scoring_weights`): per-org factor → weight map; null = defaults.
- **Company Profile / Past Contract / Vault Document** (`company_profiles`, `past_contracts`, `vault_documents`): inputs to scoring (owned by the Vault/Profile area).
- **Activity** (`activity_log`): audit of `tender.document_uploaded|fetched`, `tender.analysed`, `analysis.factor_overridden`, `org.scoring_weights_updated`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the extraction corpus (4 generated fixtures + ≥ 3 real-layout bilingual GeM PDFs added under `packages/core/test/fixtures/bids/`), ≥ 95 % of labelled fields are extracted with the correct value and page by rules alone.
- **SC-002**: An analyst goes from an empty tender page to a verdict (upload + analyse) in under 60 seconds of wall time for a ≤ 10-page PDF; rules-only server time p95 < 5 s.
- **SC-003**: 100 % of applicable factors show a detail sentence, and 100 % of factors derived from a document requirement offer evidence with a working page link.
- **SC-004**: Rules-only analysis produces a verdict for 100 % of text PDFs with zero API keys; with an LLM configured, an LLM failure never changes the outcome compared to rules-only.
- **SC-005**: A corrigendum on an analysed tender is visible as "Re-analysis needed" within one ingestion cycle (≤ 30 minutes) for every org that analysed it.
- **SC-006**: Every override is attributable (who, when, why) in the activity log — 100 % of override API calls produce exactly one `analysis.factor_overridden` entry.
- **SC-007**: Playwright E2E for US1–US7 pass in CI against a real Postgres with evidence (screenshots, video, trace) attached under `qa/evidence/004/US<n>/` and a QA `VERDICT.md` per story.
- **SC-008**: With AI enabled, AI-assisted analyses add at least one correct ATC-specific requirement on ≥ 60 % of real ATC-heavy bids in the corpus, with zero AI items displacing a correct rule value.

## Assumptions

- GeM keeps publishing the bid document at the public `/showbidDocument/<b_id>` endpoint without login; ATC and corrigendum PDFs that are only linked from inside GeM's logged-in pages are uploaded manually by users.
- One "bid document" per tender is shared publicly between orgs; uploads remain private. Re-analysis creates a new `analyses` row (history kept; only the latest is shown).
- Experience is computed from past contracts when any exist (the GeM criterion is about supplying similar goods/services), falling back to the incorporation date; this can under-state a company's age, which the detail sentence makes visible.
- Scoring weights are org-wide (not per category); thresholds Go ≥ 70 / Review ≥ 40 are product constants.
- The financial bid (price) is out of scope (Constitution I); Analyse never reads or proposes prices.
- Manual requirements (`method: 'MANUAL'`) are supported by the data model but adding/editing requirements by hand is out of scope for this spec (future story).
- LLM features use Anthropic's Messages API through `apps/api/src/adapters/llm.ts`; model ids in this spec are defaults and are overridable by environment variables; Claude PDF input limits (32 MB request, 600 pages for 1M-context models, 100 for 200K-context models) bound the OCR path.
- Corrigendum alerts to users (notifications) are specified in `003-identify-ingestion-alerts`; this spec covers only the analysis staleness.
- The reference repo `Mujahid-Alam_gem-tender-pdf-extractor` has no licence file: only its field list is used as an idea source (no code copied); `erenmyeager15_india-government-tenders-scraper` (Apache-2.0) code may be ported with attribution.
