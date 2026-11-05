# Feature Specification: Apply — Bid Workspace, Annexures, Packet & Assisted Submission

**Feature Branch**: `006-apply-packet-assist`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Apply area of TenderPilot in detail: bid workspace lifecycle/stages and the 'Ready to submit'
stage guard, checklist → vault auto-mapping and readiness, Bid Manager overrides, comments, annexure templates and
rendering, merged packet builder (cover/index/bookmarks/size limits), submission-assist allow-list and payload, browser
extension (MV3) behaviour and safety, submission & outcome recording, and the workspace page. Describe what is built, add
requirements for the gaps that matter, and make every acceptance scenario verifiable by QA in a browser or via the API."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — User Story 4 ("Assemble the
bid packet"), User Story 5 ("Assisted submission with a human at the controls"), FR-023…FR-028 and Constitution
Principle I (Human-in-the-Loop Submission, NON-NEGOTIABLE). This spec refines those stories into independently testable
slices, describes what is **built today** (verified against the code on 2026-11-05: `packages/core/src/{packet,assist}/*`,
`packages/core/src/contracts/apply.ts`, `apps/api/src/routes/{workspaces,packets,assist}.ts`,
`apps/api/src/services/packet.ts`, `apps/web/src/features/workspace/*`, `apps/extension/*`) and adds requirements for the
gaps that matter. Requirements and scenarios marked *(gap)* are not implemented yet; everything else is implemented and
covered by unit/API tests (`packages/core/test/{packet,assist}/*`, `apps/api/test/{workspace,packet,assist}.test.ts`,
`apps/extension/test/fill.test.ts`, `apps/extension/test/smoke.e2e.mjs`).

**Boundaries**: The Kanban board UI (`/pipeline`) and the dashboard win-rate charts consume this area's stage model and
`GET /api/workspaces` contract but are specified with the Track area; the checklist itself is produced by Analyse
(spec 004); vault documents and the company profile come from spec 005. This spec owns everything from "Start bid" to
"Record result".

## Personas affected

| Persona | Role in the app (server-enforced) | What they do in this area |
|---|---|---|
| **Bid Manager** | `bid_manager` | Owns the bid: assigns people, sets the internal due date, overrides a blocking checklist item with a reason, customises the organisation's annexure templates, moves the bid to "Ready to submit". |
| **Bid Analyst** | `analyst` | Starts the workspace from an analysed tender, maps checklist items to vault documents, previews annexures, orders and builds the merged packet, prepares the non-financial GeM values, marks the bid submitted and records the result. |
| **Owner (MSME founder / OEM sales head)** | `owner` | Same powers as a Bid Manager; usually the person who prices the bid and presses Final Submit on GeM with their DSC/OTP. |
| **Viewer (sales / OEM partner / consultant / CA)** | `viewer` | Read-only: sees the workspace, readiness, annexure PDFs, packet downloads, comments and activity; cannot change anything. |
| **GeM operator at the keyboard** | any role with an API token | Uses the Chrome extension on `bidplus.gem.gov.in` to highlight and pre-fill allow-listed, non-financial fields, then enters the price, authenticates and submits **personally**. |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. "At least X" means X or any higher role. A Viewer calling
an Analyst+ endpoint gets **403** `forbidden` "You need to be at least an Analyst to do that"; an Analyst calling a Bid
Manager+ endpoint gets **403** "You need to be at least a Bid Manager to do that"; any id belonging to another
organisation answers **404** `not_found` (e.g. "Bid workspace not found") — never 403, never data.

## User Scenarios & Testing *(mandatory)*

> **QA conventions for every scenario.** The E2E stack is `pnpm e2e` (Playwright; desktop 1440×900 and Pixel 7 / 375 px
> for `@mobile`) with the API + built SPA on :8788 and mock-gem on :4011 against a fresh `tenderpilot_e2e` database.
> API errors always have the shape `{ "error": { "code", "message", "details?" } }`. Dates are shown in IST.
>
> **"Apply fixture"** (built by E2E helper `seedApplyFixture()`, task T003 — it mirrors
> `apps/api/test/workspace-fixtures.ts::seedApply` with dates relative to *now*): an org with all four roles
> (`owner`, `bidManager` "Test bid manager", `analyst`, `viewer`); company profile "Sharma Infotech Pvt Ltd", GSTIN
> `27AAPFU0939F1ZV`, PAN `AAPFU0939F`, Small MSE `UDYAM-MH-19-0012345`, MII Class-I with local content 62 %, signatory
> "Ravi Sharma, Director", OEM authorisation "Dell — Laptops"; tender **`GEM/2026/B/700001`** "Supply of Laptops batch 1"
> (Indian Oil Corporation Limited, Panipat Refinery; quantity 40; item "Laptop i5 16GB"; EMD ₹1,50,000; closes *now* + 15
> days); a `done` analysis with score 78, verdict `go`, delivery 30 days and this 7-item checklist:
>
> | itemId | Label | Kind | Mandatory |
> |---|---|---|---|
> | `gst` | GST registration certificate | vault `gst` | yes |
> | `pan` | PAN card of the firm | vault `pan` | yes |
> | `balance_sheets` | Audited balance sheets — last 3 financial years | vault `balance_sheet` | yes |
> | `oem_authorization` | OEM authorisation certificate (MAF) for this bid | vault `oem_authorization` | yes |
> | `udyam` | Udyam registration certificate (MSE) | vault `udyam` | no |
> | `non_blacklisting` | Non-blacklisting / non-debarment undertaking | generated `non_blacklisting` | yes |
> | `mii_self_cert` | Make in India self-certificate (local content %) | generated `mii_self_cert` | yes |
>
> and five vault documents: "GST REG-06" (1 page), "PAN card" (1 page), "Balance sheet 2023-24" (FY 2023-24, 2 pages),
> "Balance sheet 2024-25" (FY 2024-25, 3 pages) and "Dell MAF" (`oem_authorization`, expired 35 days ago, 1 page). No Udyam
> certificate is uploaded. "Demo org" = a fresh org after `POST /api/demo/seed` (16 workspaces across all stages).

### User Story 1 - Start a bid workspace and move it through the stages with a "Ready to submit" guard (Priority: P1) (#176)

From an analysed tender an Analyst clicks **Start bid**. TenderPilot creates (or reopens) the single bid workspace for
that tender in the organisation, picks the starting stage from the analysis (verdict Go → **Go**, analysis still running
→ **Analysing**, otherwise **Identified**), makes the clicking user the owner, sets the internal due date to the GeM
closing time and auto-maps the checklist to the vault. The workspace header shows the bid number (click to copy), the
stage badge (a dropdown for Analyst+), the eligibility score, the buyer, a closing countdown, EMD and estimated value,
owner/assignees and the internal due date. Any stage can be chosen from the dropdown, but **Ready to submit** is refused
while a mandatory checklist item is missing or expired and not overridden. Every change is written to the activity log;
newly assigned people get an in-app notification.

**Why this priority**: The workspace is the container for every other Apply story; the stage guard is the single most
important safety net against uploading an incomplete bid (a missing mandatory document is the commonest cause of
technical disqualification on GeM).

**Independent Test**: In the Apply fixture, `POST /api/tenders/{tenderId}/workspace` as the Analyst → 201 with
`stage: "go"`; `PATCH /api/workspaces/{id}` `{ "stage": "ready" }` → 409 `not_ready` listing `oem_authorization`.

**Acceptance Scenarios**:

1. **Given** the Apply fixture and the Analyst signed in, **When** they call `POST /api/tenders/{tenderId}/workspace`,
   **Then** the response is **201** with `created: true`, `stage: "go"`, `owner.id` = the Analyst, `dueAt` = the tender's
   `endAt`, `assignees: []` and an empty stored `mapping` (`{}` — every item automatic, FR-014); a following
   `GET /api/workspaces/{id}` returns `readiness.items` resolving gst, pan, balance_sheets → "Balance sheet 2024-25" and
   oem_authorization → "Dell MAF" with `auto: true` (4 picks; `udyam` unmatched because nothing matches); the activity log
   has `workspace.created` for both the workspace and the tender, with meta `autoMatched: 4`.
2. **Given** the workspace exists, **When** any Analyst+ calls the same endpoint again (or two calls race), **Then** the
   response is **200** with `created: false` and the same `id`; no second row exists (`workspace_org_tender_uq`).
3. **Given** the Viewer, **When** they call `POST /api/tenders/{tenderId}/workspace`, **Then** the response is **403**
   "You need to be at least an Analyst to do that"; for an unknown tender id the response is **404** "Tender not found".
4. **Given** the workspace page `/workspaces/{id}` opened by the Analyst, **Then** the breadcrumb reads "Pipeline ›
   GEM/2026/B/700001", the tab title is "GEM/2026/B/700001 · Bid workspace", the header shows the stage badge "Go" with a
   chevron, the title "Supply of Laptops batch 1", "Indian Oil Corporation Limited", a countdown, "EMD ₹1,50,000", an
   **Eligibility** chip with score ring 78 and verdict "Go", an **Owner** button and a **Due** button showing the closing date.
5. **Given** the header, **When** the user clicks the bid number button, **Then** `GEM/2026/B/700001` is on the clipboard and
   a check icon replaces the copy icon for ~1.4 s.
6. **Given** the stage dropdown is opened, **Then** it is titled "Move to stage" and lists Identified, Analysing, Go,
   Preparing, Ready to submit, Submitted, Won, Lost, Dropped in that order; the current stage has a check mark and the
   "Ready to submit" row shows "1 blocker" in red.
7. **Given** the Dell MAF is expired and not overridden, **When** the user picks **Ready to submit**, **Then**
   `PATCH /api/workspaces/{id}` answers **409** `not_ready` with message "1 required document is missing or expired. Replace
   it in the vault, or ask a Bid Manager to override with a reason." and `details.blockers = [{ itemId:
   "oem_authorization", label: "OEM authorisation certificate (MAF) for this bid", state: "expired" }]`; the UI shows an
   error toast with that message, the description "OEM authorisation certificate (MAF) for this bid" and a **Fix documents**
   action that opens the Documents step; the stage stays "Go".
8. **Given** a workspace whose tender has **no analysis**, **When** the user picks Ready to submit, **Then** the API answers
   **409** `conflict` "Analyse the tender before marking the bid ready to submit." with `details.reason = "not_analysed"`.
9. **Given** the Analyst picks **Preparing**, **Then** the response is 200 with `stage: "preparing"`, the success toast reads
   "Moved to Preparing", the workspace gets `position` = (max position in Preparing) + 1 and the activity log has
   `workspace.stage_changed` with `{ from: "go", to: "preparing" }` by the Analyst, rendered in the Activity rail as
   "moved it from Go to Preparing".
10. **Given** the **Owner** popover, **When** the Bid Manager makes the Analyst the owner and assigns the Viewer, **Then**
    the toast "Owner updated" appears, the avatars update, each newly added person (except the actor) gets one in-app
    notification titled "You were assigned to GEM/2026/B/700001" linking to `/workspaces/{id}`, and the activity log has
    `workspace.assigned`.
11. **Given** `PATCH` with `assigneeIds` containing a user of another organisation, **Then** the response is **400**
    `validation_error` "Only members of your organization can be assigned" with `details.fields.assigneeIds = "Not a member
    of this organization"`; `PATCH` with an unknown property (e.g. `{ "foo": 1 }`) or `stage: "won_big"` is **400**.
12. **Given** the **Due** popover, **When** the user picks a date, **Then** the due date is stored as 18:00 IST of that day,
    the toast "Due date updated" appears, the date input cannot go past the closing date (`max`), a due date later than the
    closing time shows a warning border, and **Clear** removes it (`dueAt: null`).
13. **Given** the Viewer opens the workspace, **Then** the stage badge has no chevron/dropdown, the Owner and Due buttons are
    inert and no edit, override, build, save or mark-submitted controls are rendered anywhere on the page.
14. *(gap — FR-008)* **Given** a workspace in Go, **When** an Analyst PATCHes `{ "stage": "won" }` (or "lost"), **Then** the
    API answers **409** `invalid_transition` "Record the submission on GeM first — a bid can only be won or lost after it was
    submitted." and the stage is unchanged; from **Submitted** the same call succeeds.
15. *(gap — FR-009)* **Given** a workspace with no analysis, **When** the pipeline list (`GET /api/workspaces`) returns its
    card, **Then** `readiness` is `{ percent: 0, total: 0, covered: 0, blockers: 0, analysed: false }` (today it reports
    100 %) and the workspace's Documents step hint reads "Not analysed".

---

### User Story 2 - Map the checklist to vault documents and see bid readiness (Priority: P1) (#179)

The **Documents** step lists every checklist item from the latest analysis with its state — Ready, Expiring soon,
Generated, Overridden, Missing, Expired — whether it is Required or Optional, and the vault document chosen for it.
TenderPilot picks the best document automatically (exact type first, then valid over expiring over expired, then
title/tag relevance, newest financial year for per-FY documents, then latest expiry/issue/upload). An item the user has
not touched stays "automatic", so a document uploaded later is matched without any action. The user can choose another
document, mark the item "Not available", go back to "Auto-match" or jump to the vault upload pre-set to the right type. A
readiness ring shows the share of mandatory items covered, the blockers before "Ready to submit", and filter tabs.

**Why this priority**: Matching 20–40 documents by hand for every bid is the core time sink this product removes, and the
readiness number is what managers look at to decide whether a bid can still make the deadline.

**Independent Test**: In the Apply fixture open the Documents step: the ring shows **83%**, "1 blocker before “Ready to
submit”" and "5 of 6 required items covered · 7 items in the checklist"; upload a Udyam certificate and reload: the Udyam
row turns **Ready** with an **Auto-matched** badge without any mapping call.

**Acceptance Scenarios**:

1. **Given** the Apply fixture workspace, **When** the Analyst opens the **Documents** step, **Then** the ring shows
   **83%** (amber), the heading reads "1 blocker before “Ready to submit”", the sub-line reads "5 of 6 required items covered
   · 7 items in the checklist", the **Upload to vault** and **Annexures →** buttons are visible, and one red blocker chip
   "Expired · OEM authorisation certificate (MAF) for this bid" links to `#item-oem_authorization`.
2. **Given** the list, **Then** the rows show: GST registration certificate — **Ready**, Required, **Auto-matched**, "GST
   REG-06"; PAN card — Ready, Auto-matched; Audited balance sheets — Ready, Auto-matched, "Balance sheet 2024-25" with "FY
   2024-25" (the newest FY wins over 2023-24); OEM authorisation — **Expired**, Required, "Dell MAF" with an expired badge,
   red-tinted card, buttons **Change**, **Upload renewed**; Udyam — **Missing**, Optional, "No matching document in the
   vault.", buttons **Choose document**, **Upload Udyam (MSE) certificate** (label from the document-type catalog);
   Non-blacklisting and Make in India — **Generated**, "Generated from your profile · Print, sign and stamp before upload",
   **Preview**.
3. **Given** the filter tabs "All 7", "Needs attention 2", "Covered 5", **When** the user selects "Needs attention",
   **Then** only the OEM and Udyam rows are shown and the tab has `aria-selected="true"`; when a filter is empty the panel
   shows "Nothing here — Everything in this view is covered."
4. **Given** the OEM row, **When** the user clicks **Change**, **Then** a popover opens with a search box ("Search the
   vault…", focused), a group "OEM authorisation" containing "Dell MAF" (checked), a group "Other documents" (max 30 rows),
   and footer buttons **Auto-match**, **Not available**, **Upload new**.
5. **Given** the popover, **When** the user picks "Balance sheet 2023-24" for the OEM item, **Then**
   `PUT /api/workspaces/{id}/mapping` `{ "oem_authorization": "<docId>" }` returns 200 with `{ workspace, readiness }`, the
   toast reads "Using “Balance sheet 2023-24”", the **Auto-matched** badge disappears from that row, and the activity log has
   `workspace.mapping_changed` rendered "changed the document for 1 checklist item(s)".
6. **Given** the popover, **When** the user clicks **Not available**, **Then** the mapping stores `null`, the toast reads
   "Marked as not available", and the row shows **Missing** with the note "Marked as not available."; **When** they click
   **Auto-match**, **Then** the key is removed from the stored mapping, the toast reads "TenderPilot will pick the best
   document", and the row returns to "Dell MAF" with Auto-matched.
7. **Given** the Udyam row is Missing and untouched, **When** the Analyst uploads a `udyam` document to the vault and
   reopens the workspace, **Then** the Udyam row is **Ready** and **Auto-matched** with that document (no mapping call was
   made) — but if the user had explicitly marked it "Not available", it stays Missing.
8. **Given** `PUT /mapping` with an itemId that is not in the checklist, **Then** 400 `validation_error` with
   `details.fields.<itemId> = "Not an item of this bid’s checklist"`; with a document id from another organisation or a
   deleted document, 400 with "Document not found in your vault"; the Viewer gets 403.
9. **Given** a mapped document is deleted from the vault, **When** the workspace is reloaded, **Then** the explicitly mapped
   item shows Missing (the dangling id resolves to no document) and auto items fall back to the next best document.
10. **Given** a vault document that expires in 12 days is mapped to a mandatory item, **Then** the row shows **Expiring
    soon**, the note "Expires in 12 day(s).", an **Upload renewed** button, the item counts as covered (not a blocker) and is
    listed in `readiness.warnings`.
11. **Given** the analysis has not run, **When** the user opens Documents, **Then** an empty state reads "No checklist yet —
    Analyse the tender to get the list of documents this bid needs." with an **Analyse tender →** button to `/tenders/{id}`.
12. **Given** a checklist item of type `other`, **Then** it maps only to a document whose title/tags/file name share at least
    half of the item's significant words (or that is tagged with the exact item id).
13. **Given** the Documents step at 375 px, **Then** each row stacks the document box under the label, the popover is at
    most 92 vw wide, there is no horizontal page scroll, and the readiness ring and buttons wrap without overlap.

---

### User Story 3 - Override a blocking item with a reason and coordinate in comments (Priority: P2) (#181)

When a mandatory document will only arrive at the last minute (a renewed MAF, a CA certificate being signed), a Bid
Manager can override that item with a written reason. The item turns **Overridden**, stops blocking "Ready to submit"
and the reason is shown on the row and recorded with the Bid Manager's name. The team coordinates in the **Discussion**
rail (comments + activity) — on desktop a sticky right rail, on mobile a "Discussion (n)" tab. The owner and assignees
are notified of every new comment.

**Why this priority**: Real bids are submitted with documents in flight; without a traceable override the guard would be
switched off informally. Comments replace WhatsApp threads that lose context.

**Independent Test**: In the Apply fixture, as Bid Manager override `oem_authorization` with "Renewed MAF arriving tomorrow
from Dell" → readiness 100 %, then PATCH stage `ready` as Analyst → 200; delete the override → 1 blocker again.

**Acceptance Scenarios**:

1. **Given** the Analyst on the OEM row, **Then** no **Override** button is visible; `POST /api/workspaces/{id}/overrides`
   as the Analyst answers **403** "You need to be at least a Bid Manager to do that".
2. **Given** the Bid Manager, **When** they click **Override** on the Expired OEM row, **Then** a dialog titled "Override
   “OEM authorisation certificate (MAF) for this bid”" explains "The item stops blocking “Ready to submit”. Your name and
   reason are recorded in the activity log. Make sure the bid will not be rejected for it." with a required **Reason**
   textarea (max 500) and the hint "e.g. “Renewed MAF arrives Friday; upload before submission.”"; the **Override** button
   is disabled until the trimmed reason has 5+ characters; typing 1–4 characters shows "Explain in a few more words".
3. **Given** the reason "Renewed MAF arriving tomorrow from Dell", **When** the Bid Manager confirms, **Then** the API
   answers **201** with `readiness.canMarkReady: true` and `workspace.overrides[0]` = `{ itemId: "oem_authorization",
   reason, by, byName: "Test bid manager", at }`; the toast reads "Override recorded"; the row shows **Overridden** and
   "Override: Renewed MAF arriving tomorrow from Dell"; the ring shows **100%** and "All required documents are covered";
   the activity rail shows "overrode “OEM authorisation certificate (MAF) for this bid”: Renewed MAF arriving tomorrow from Dell".
4. **Given** the override, **When** the Analyst moves the stage to **Ready to submit**, **Then** the PATCH succeeds (200).
5. **Given** the overridden row, **When** the Bid Manager clicks **Remove override**, **Then** `DELETE
   /api/workspaces/{id}/overrides/oem_authorization` answers 200 with one blocker, the toast reads "Override removed" and
   the row is Expired again; deleting a non-existent override answers **404** "Override not found".
6. **Given** an override with reason "" or an itemId not in the checklist, **Then** the API answers **400** (`reason`: "Explain
   why in a few words (at least 5 characters)"; itemId: "Not an item of this bid’s checklist").
7. *(gap — FR-027)* **Given** an item that is Ready, Expiring or Generated, **When** a Bid Manager posts an override for it,
   **Then** the API answers **409** `nothing_to_override` "Only a missing or expired item can be overridden." (today it is
   stored silently).
8. **Given** the Discussion rail with no comments, **Then** it reads "No comments yet. Coordinate who is chasing which
   document."; **When** the Analyst types "Chasing Dell for the renewed MAF" and presses **Ctrl/⌘+Enter** (or the send
   button), **Then** `POST /api/workspaces/{id}/comments` answers 201 `{ id, body, user, createdAt }`, the textarea clears,
   the comment appears with the author's avatar and relative time, and the owner and every assignee except the author get
   an in-app notification "New comment on GEM/2026/B/700001" whose body starts with "<author name>: Chasing Dell…".
9. **Given** an empty or whitespace-only comment, **Then** the API answers 400 "Write a comment"; bodies over 4000 characters
   are rejected; the Viewer sees comments but no composer, and `POST` as Viewer is 403.
10. **Given** the workspace at 375 px, **Then** a segmented control "Bid steps | Discussion (1)" appears above the steps;
    choosing Discussion hides the steps and shows comments + activity full-width; at ≥1024 px the rail is a sticky
    300–340 px right column and the segmented control is hidden.
11. *(gap — FR-032)* **Given** a comment containing `@Ravi` where "Ravi Sharma" is an org member who is neither owner nor
    assignee, **When** it is posted, **Then** Ravi also receives the notification; *(gap — FR-033)* the author (or a Bid
    Manager+) can delete a comment via `DELETE /api/workspaces/{id}/comments/{commentId}` → 204, others get 403.

---

### User Story 4 - Generate annexures and undertakings from editable templates (Priority: P1) (#184)

The **Annexures** step lists the annexures relevant to the bid — the covering letter first, then the undertakings the
checklist requires (in checklist order), the OEM authorisation request (MAF) when the checklist needs an OEM document,
then the technical compliance statement, non-blacklisting undertaking and letter of authority. Each is rendered on the
company letterhead as an A4 PDF filled from the company profile, the tender and the workspace's non-financial values,
with a signature block; anything missing prints as "__________" so it can be completed by hand. A Bid Manager can
customise any of the 8 system templates for the whole organisation, preview the draft with this bid's data, and restore
the default.

**Why this priority**: Undertakings are mandatory on almost every GeM bid and are retyped for every tender today; wrong
bid numbers or GSTINs on them are a classic rejection reason.

**Independent Test**: In the Apply fixture open `GET /api/workspaces/{id}/annexures/non_blacklisting.pdf` → 200
`application/pdf` whose text contains "SHARMA INFOTECH PVT LTD", "GEM/2026/B/700001", "27AAPFU0939F1ZV" and
"Authorised Signatory (Seal & Signature)".

**Acceptance Scenarios**:

1. **Given** the Apply fixture, **When** the user opens the **Annexures** step, **Then** the list shows 6 annexures in this
   order: "Covering Letter for Technical Bid" (Optional), "Undertaking regarding Non-Blacklisting / Non-Debarment"
   (**Required by this bid**), "Self-Certificate of Local Content (Make in India)" (Required by this bid), "Request for
   Manufacturer’s Authorisation (MAF)" (**Recommended**), "Technical Compliance Statement" (Optional), "Letter of Authority
   for Bid Signatory" (Optional); the first required annexure is selected and previewed.
2. **Given** an annexure whose template uses placeholders that are empty for this org/bid, **Then** its card shows a
   warning badge "N blank(s)" (N = `missing.length` in the API) with a tooltip listing friendly names (e.g. "Model"); when
   `profileGaps` is non-empty a banner reads "Some blanks will print as “__________”" with "Add <up to 4 fields>… to fill
   them automatically." and a **Complete company profile →** link to `/profile`.
3. **Given** the selected annexure, **Then** the preview panel shows its PDF in an iframe (`#toolbar=0&navpanes=0`) with a
   skeleton until it loads (the skeleton is removed after a timeout even if the browser never fires `load`), and the buttons
   **Edit template**, **Open** and **Download**; on phones (< 640 px) the panel says "PDF previews open full-screen on
   phones." and offers a **Preview PDF** button (new tab) instead of the iframe.
4. **Given** `GET /api/workspaces/{id}/annexures/mii_self_cert.pdf`, **Then** the response is 200, `content-type:
   application/pdf`, `content-disposition: inline; filename="mii_self_cert_GEM_2026_B_700001.pdf"`, `cache-control:
   private, no-store`, `x-content-type-options: nosniff`; with `?download=1` the disposition is `attachment`; the PDF text
   contains "'Class-I local supplier' (local content of 50% or more)" and "62%"; the alias
   `mii_self_certificate.pdf` returns the same document and an unknown key answers 404 "Annexure template not found".
5. **Given** the PDF, **Then** page 1 has the letterhead (company name in capitals, address, "GSTIN: … | PAN: … | email |
   phone", a double rule), "Ref: GEM/2026/B/700001" and "Date: dd-mm-yyyy" (IST), the underlined title in capitals, the body
   with numbered clauses as hanging-indent lists and the "Subject:" line in bold, a signature block "Place: Maharashtra /
   Date: … / For Sharma Infotech Pvt Ltd / Authorised Signatory (Seal & Signature) / Name: Ravi Sharma / Designation:
   Director", and a footer "Bid No. GEM/2026/B/700001 … <title>" on every page; long bodies flow onto further pages.
6. **Given** the Analyst, **When** they call `PUT /api/annexure-templates/non_blacklisting`, **Then** the API answers 403 "You
   need to be at least a Bid Manager to do that". *(gap — FR-043)* The **Edit template** button is currently rendered for
   every role (Analyst/Viewer get a 403 toast on save); it MUST be rendered only for Bid Manager+.
7. **Given** the Bid Manager clicks **Edit template**, **Then** a dialog explains "Changes apply to every bid in your
   organisation. Use placeholders like {{company.legalName}}; blank lines separate paragraphs, lines starting with “1.”
   become numbered clauses.", shows Title and Body fields and an "Insert placeholder" palette; **Preview** posts the draft to
   `POST /api/workspaces/{id}/annexures/{key}/preview` and shows the returned PDF without saving; **Save template** is
   disabled until title ≥ 3 and body ≥ 20 characters.
8. **Given** a saved custom template, **Then** the toast reads "Template saved for your organisation", `GET
   /api/annexure-templates` returns that key with `custom: true`, `systemTitle`/`systemBody` still holding the defaults, and
   every workspace of the org (but not of other orgs) renders the custom text; **Restore default** (`DELETE
   /api/annexure-templates/{key}`) returns `custom: false` and the toast "Restored the TenderPilot template".
9. **Given** a body shorter than 20 characters, **Then** the API answers 400 "The template body is too short".
10. *(gap — FR-041)* **Given** a body containing `{{company.gstn}}` (typo), **When** the Bid Manager saves, **Then** the API
    answers 400 `unknown_placeholder` "Unknown placeholder {{company.gstn}} — use one from the list." with
    `details.unknown = ["company.gstn"]`, and the preview highlights it.
11. **Given** company or tender text containing "₹", "≥" or Devanagari, **Then** rendering never fails: "₹" prints as "Rs. ",
    "≥" as ">=", and characters the PDF font cannot draw are dropped.

---

### User Story 5 - Build one merged, bookmarked packet for the GeM technical upload (Priority: P1) (#186)

The **Packet** step proposes a default order — cover page & index, covering letter, the annexures the checklist requires,
then each mapped vault document once, in checklist order — and lets the user reorder (drag, touch or keyboard, or the
up/down arrows), remove and add items (other annexures, any vault document, the tender's own bid documents). A side
panel estimates document count, pages and size against the 20 MB limit. **Build packet** merges everything into a single
PDF with a cover page, an index with page numbers that link to each document, one outline bookmark per document, and a
"<bid number> · Page x of N" footer stamp on every page. Images are placed on A4 pages; damaged or missing files are
skipped with a warning; expired documents and open blockers are listed as warnings. A successful build moves an early-
stage bid to **Preparing**. Every build is kept in the history and can be downloaded.

**Why this priority**: Merging, ordering and bookmarking 15–40 PDFs into one upload under GeM's size limit takes hours in
desktop tools and is error-prone; this is the headline "apply" time saving.

**Independent Test**: In the Apply fixture `POST /api/workspaces/{id}/packets` `{}` → 201 `status: "ready"`,
`pageCount: 11`, 8 items with start pages 1,3,4,5,6,7,8,11 and a warning about the expired MAF; the downloaded PDF's
outline is "Cover, Index, Covering Letter for Technical Bid, …, OEM authorisation certificate (MAF) for this bid".

**Acceptance Scenarios**:

1. **Given** the Apply fixture, **When** the Analyst opens **Packet**, **Then** "Packet contents" lists in order: Cover page &
   index, Covering Letter for Technical Bid, Undertaking regarding Non-Blacklisting / Non-Debarment, Self-Certificate of
   Local Content (Make in India), GST registration certificate, PAN card of the firm, Audited balance sheets — last 3
   financial years, OEM authorisation certificate (MAF) for this bid; the summary shows **Documents 8**, **Pages (est.) 11**
   and "Estimated size … / 20 MB" with a green bar; "Add more" lists the remaining annexures (Request for MAF excluded),
   vault documents (e.g. "Balance sheet 2023-24") and bid documents.
2. **Given** the list, **When** the user drags "PAN card of the firm" above "GST registration certificate" (or presses its
   **Move up** arrow, or uses Space + arrow keys on the grip handle "Reorder PAN card of the firm"), **Then** the order
   updates immediately, a **Default order** button appears, and the order survives a page reload in the same browser.
3. **Given** the user removes an item with **Remove <title>** and adds "Balance sheet 2023-24" with **Add Balance sheet
   2023-24**, **Then** the counts and size estimate update; with every item removed the list shows "Nothing in the packet —
   Add documents from the list below." and **Build packet** is disabled.
4. **Given** the default order, **When** the Analyst clicks **Build packet**, **Then** the button shows a spinner and a
   polite live region cycles "Rendering annexures…", "Merging documents…", "Writing index & bookmarks…", "Saving the
   packet…"; `POST /api/workspaces/{id}/packets` returns **201** with `status: "ready"`, `pageCount: 11`, `items[].startPage`
   = 1, 3, 4, 5, 6, 7, 8, 11, `downloadUrl: "/api/packets/{packetId}/download"`; the toast reads "Packet ready — 11 pages"
   with "2 warnings to review"; the card "Latest packet is ready" shows the builder's name, "just now", "11 pages", the size
   and the warnings, including "OEM authorisation certificate (MAF) for this bid: the vault document has expired — replace
   it or ask a Bid Manager to override." and "“OEM authorisation certificate (MAF) for this bid” uses an expired document
   (Dell MAF)."; buttons **Download PDF**, **Open** and **Submit step →**.
5. **Given** the build in a workspace at stage Go, **Then** the stage becomes **Preparing** and the activity log shows "built
   the packet (11 pages)" and "moved it from Go to Preparing (after building the packet)"; a build from Preparing or later
   does not change the stage.
6. **Given** `GET /api/packets/{packetId}/download`, **Then** the response is 200 `application/pdf`, `content-disposition:
   attachment; filename="GEM_2026_B_700001_technical_packet.pdf"` (`?inline=1` → `inline`), `cache-control: private,
   no-store`; the PDF has 11 pages; page 1 is the cover ("TECHNICAL BID PACKET", the tender title, "Bid No.
   GEM/2026/B/700001", Buyer, Bid closes, Bidder "Sharma Infotech Pvt Ltd", GSTIN, PAN, Address, "Contents 7 documents, 11
   pages (index on page 2)", "Prepared on", and the box "Prepared with TenderPilot — for human review and upload"); page 2 is
   "Index of documents" with rows "01 … 07" giving pages and start page, each row a link to that page; the outline lists
   Cover, Index and the 7 document titles in order; every page footer reads "GEM/2026/B/700001 · Page x of 11"; the blob is
   stored at `org/<orgId>/packets/<packetId>/GEM_2026_B_700001_technical_packet.pdf`.
7. **Given** a custom order `{ items: [...] }` including a vault document id of another org, an unknown annexure key or a
   tender document of another tender, **Then** the API answers **400** `validation_error` "Unknown packet item(s): <titles>"
   with `details.items`, and no packet row is created.
8. **Given** a vault item whose stored file is a PNG/JPG, **Then** it is placed on its own A4 page scaled to fit; a corrupt PDF
   or a file of another type is skipped with the warning "“<title>” is damaged and could not be opened — skipped." /
   "“<title>” is not a PDF, PNG or JPG file — skipped." and the index omits it; a password-protected PDF is included with
   the warning "“<title>” is password-protected; its pages may not display correctly. Upload an unlocked copy to the vault."
9. **Given** a packet whose output exceeds 20 MB, **Then** it is still saved and the warning reads "The packet is 23.4 MB,
   above the 20.0 MB upload limit. Compress large scans in the vault or split the packet before uploading on GeM."; in the
   UI the size estimate turns red above 20 MB with "Above GeM’s typical per-file limit — remove large scans or compress them
   in the vault." (amber above 15 MB).
10. **Given** more than 26 documents, **Then** the index continues on extra pages titled "Index of documents (continued)" (34
    rows per continuation page) and every start page accounts for the extra index pages.
11. **Given** two or more builds, **Then** "Earlier builds" lists each with author, relative time, pages and a **Download this
    build** link; `GET /api/workspaces/{id}/packets` returns at most 50, newest first; the Viewer can download but sees no
    Build button and `POST` as Viewer is 403.
12. **Given** the merge throws unexpectedly, **Then** the API answers **500** `packet_build_failed` with the first warning as
    message and `details.packet` (status `failed`); the UI shows "The last build failed" with the reason; the activity log
    has `workspace.packet_failed`.
13. *(gap — FR-055)* **Given** a teammate builds the packet in a custom order, **When** another member opens the Packet step
    in a different browser, **Then** the proposed order is the last successful build's order (not the default); **Default
    order** resets to the computed default.
14. *(gap — FR-056)* **Given** selected inputs whose total stored size exceeds 60 MB, **When** the user builds, **Then** the API
    answers **413** `packet_too_large` "These documents add up to 72.0 MB — remove or compress some before building (limit
    60 MB)." before loading any file, and no packet row is created.
15. *(gap — FR-057)* **Given** a packet row stuck in `building` for more than 10 minutes (worker killed), **When** the
    workspace is read, **Then** that row is reported (and persisted) as `failed` with the warning "Build interrupted — try
    again.".

---

### User Story 6 - Assisted submission: copy-ready values and the browser extension, never prices (Priority: P2) (#188)

The **Submit** step shows "Human-only steps" (enter the price, upload the documents, authenticate with OTP/DSC/e-Sign,
click Final Submit), the **Values to enter on GeM** — 14 allow-listed, non-financial fields (Make, Brand, Model, OEM name,
Product description, HSN/SAC, Offered quantity, Delivery period, Warranty, Country of origin, Local content %,
Specification compliance, MSE claim, Startup claim) prefilled from the profile, tender and analysis and editable by
Analyst+ — each with a copy button, the **Upload in this order** list (merged packet first, then mapped vault documents,
then required annexures) with file names, and a card explaining the Chrome extension. The extension (MV3) connects with a
personal API token, lists the active bids, shows the same values, and on the GeM page highlights fillable fields (dashed
indigo + a "TP" chip), marks forbidden ones in red, and fills allow-listed empty fields **only when the user clicks**.
Prices, rates, amounts, bid values, CAPTCHA, OTP, DSC, e-Sign, Aadhaar, passwords and any submit control are never
filled, stored or clicked — enforced in the shared allow-list, the API and the extension.

**Why this priority**: Saves form-filling time on GeM's long bid participation pages while keeping the bid legally the
bidder's own (Constitution I); it is optional because the copy panel already works without the extension.

**Independent Test**: `PUT /api/workspaces/{id}/assist-values` `{ "unit_price": "1000" }` → 400 `forbidden_field`; load the
GeM-like fixture page with the built extension, click **Fill allowed fields**: Make/Model/Country of origin are filled,
price/CAPTCHA/OTP/DSC inputs stay empty and the form is not submitted.

**Acceptance Scenarios**:

1. **Given** the Apply fixture, **When** the user opens **Submit**, **Then** "Human-only steps" lists 1 "Enter your price on
   GeM", 2 "Upload the documents", 3 "Authenticate with OTP / DSC / e-Sign", 4 "Click Final Submit" with their detail text and
   the line "TenderPilot never stores GeM passwords, enters prices, solves CAPTCHA or performs OTP / DSC / e-Sign."
2. **Given** `GET /api/assist/{id}`, **Then** the payload has `noFinancials: true`, `tender.bidNumber`, `stage`,
   `readiness: { percent, blockers }`, `workspaceUrl`, the 4 `humanSteps` and 14 `fields` in catalog order with `value` and
   `source`: make/brand/oem_name "Dell" (`profile`), offered_quantity "40" (`tender`), delivery_period_days "30"
   (`analysis`), country_of_origin "India" (`profile`, from MII Class-I), local_content_pct "62", specs_compliance "Yes",
   mse_claim "Yes", startup_claim "No", product_description "Laptop i5 16GB" (`tender`), and model, warranty_months, hsn_code
   empty (`source: "empty"`); no key or value in the JSON matches price/rate/amount/value/₹.
3. **Given** the values card, **Then** it is titled "Values to enter on GeM" with "Non-financial fields only. Copy each one, or
   let the browser extension fill them on your click.", grouped Product / Offer / Compliance / Declaration; empty values read
   "Not set" in italics; each value has a **Copy <label>** button (disabled when empty) that copies the value.
4. **Given** the Analyst clicks **Edit values**, types Model "Latitude 5450" and Warranty "36" and clicks **Save**, **Then**
   only changed keys are sent to `PUT /api/workspaces/{id}/assist-values`, the response is 200 `{ assistValues }`, the toast
   reads "Values saved", the values show `source: "saved"`, and the Model now prints in annexures that use `{{offer.model}}`;
   saving an empty string removes the key (falls back to the derived default); **Cancel** discards the draft.
5. **Given** `PUT /assist-values` with `{ "unit_price": "1000" }`, `{ "totalBidValue": "5" }`, `{ "otp": "1234" }`,
   `{ "captcha": "x" }`, `{ "dsc_pin": "1" }` or `{ "final_submit": "yes" }`, **Then** each answers **400**
   `forbidden_field` with message `"unit_price" looks like a price field. TenderPilot never stores or fills prices, OTP,
   CAPTCHA, DSC/e-Sign or submit actions.` (reason varies) and `details.forbidden` listing the key; nothing is stored;
   `{ "foo": "x" }` → 400 `validation_error` `"foo" is not an allow-listed field`; `{ "make": 5 }` → 400 "Must be text";
   a value over 2000 characters → 400 "Keep it under 2000 characters"; Viewer → 403.
6. **Given** "Upload in this order" after a packet build, **Then** the first row is "Technical bid packet (merged PDF)" with a
   **Merged** badge and file name `GEM_2026_B_700001_technical_packet.pdf`, followed by the mapped vault documents (each
   once) and the required annexures (Request for MAF excluded); each row has a copy-file-name button and a **Download
   <title>** link; before any build the list reads "Build the packet first — the merged PDF will appear here."
7. **Given** the extension is loaded unpacked from `apps/extension/dist`, **When** the user opens the popup without a token,
   **Then** "Connect to TenderPilot" asks for the TenderPilot URL and an API token; a URL without `http(s)://` shows "Enter
   the full URL, e.g. https://app.tenderpilot.in"; a token not starting with `tp_` shows "API tokens start with tp_"; Chrome
   asks for host permission for that origin only; a revoked token shows "The API token is invalid or was revoked. Create a
   new one in TenderPilot → Settings → API tokens."; success shows "Connected as <name> (<org>)".
8. **Given** a connected popup, **Then** the "Bid workspace" select lists only bids in Go, Preparing, Ready to submit or
   Submitted as "<bid number> — <first 48 chars of title>" (or "No active bids — start one in TenderPilot"), the last chosen
   workspace is remembered, and the popup shows Bid, Readiness %, an **Open workspace ↗** link, "Prepared values
   (non-financial only)" with Copy buttons, "Upload in this order" and "Only you can do these on GeM".
9. **Given** the GeM-like fixture page (`apps/extension/test/fixtures/gem-form.html`) open in the active tab, **When** the user
   clicks **Highlight fields**, **Then** every fillable field gets a dashed indigo outline, a title "TenderPilot can fill:
   <label>" and a "TP" chip; price, CAPTCHA, OTP and DSC fields get a red outline titled "TenderPilot never fills this
   (<reason>) — you do it on GeM"; the popup status reads "<n> field(s) can be filled — click the TP chips or “Fill allowed
   fields”. <m> price/OTP/submit field(s) left for you."
10. **Given** the highlighted page, **When** the user clicks one "TP" chip, **Then** only that field is filled (overwriting),
    turns solid green with the title "<label> filled by TenderPilot — please verify", and the chip shows "✓".
11. **Given** the page, **When** the user clicks **Fill allowed fields**, **Then** every empty allow-listed field is filled and
    fires `input` and `change` events; selects choose the matching option (exact, yes/no synonyms such as "Comply", prefix,
    contains); fields the user already typed into are not overwritten; disabled/read-only fields and fields with no prepared
    value are skipped; the popup reads "Filled <n> field(s). <m> protected field(s) untouched — enter price and authenticate
    yourself."; price, CAPTCHA, OTP, DSC/e-Sign, Aadhaar, password, file, hidden, checkbox, radio and button controls are
    never written and the form is never submitted (`smoke.e2e.mjs` asserts this).
12. **Given** the popup is used on a non-GeM tab, **Then** it shows "Open the GeM bid participation page in this tab first
    (bidplus.gem.gov.in), then try again."
13. *(gap — FR-073)* **Given** a message to the content script from anything other than this extension's own popup, **Then** it
    is ignored (`sender.id !== chrome.runtime.id`), and the content script is injected only on `https://*.gem.gov.in/*` (plus
    the localhost test fixture), not on plain `http://` GeM URLs.
14. *(gap — FR-074)* **Given** a token created with scope "Extension (read-only)", **Then** `GET /api/assist/{id}`,
    `GET /api/workspaces` and `GET /api/auth/me` work but any write (e.g. `PUT /assist-values`, `POST /comments`) answers
    **403** "This API token is read-only".
15. *(gap — FR-075)* **Given** the popup after a fill, **Then** it lists each filled field and each skipped field with its
    reason ("already has a value", "no prepared value", "disabled"), and a **Clear highlights** button removes all outlines
    and chips (`tp:clear`).

---

### User Story 7 - Record the submission and the outcome (Priority: P2) (#191)

After the human presses Final Submit on GeM, they click **Mark as submitted** in TenderPilot and confirm three
statements (price entered personally, authenticated with OTP/DSC/e-Sign, Final Submit clicked and confirmation seen).
The bid moves to **Submitted** with a timestamp. When GeM publishes the result they **Record result** — Won or Lost, the
L1 (lowest) price disclosed by GeM, their own price and notes — for analytics only. Prices recorded here are never sent
anywhere and never used to fill GeM.

**Why this priority**: Keeps the pipeline truthful and feeds win-rate and L1 analytics, but the bid itself is already done.

**Independent Test**: `POST /api/workspaces/{id}/submitted` `{}` → 200 `stage: "submitted"` with `submittedAt`; then `PATCH`
`{ "outcome": { "result": "won", "l1Price": 2950000 } }` → 200 `stage: "won"`.

**Acceptance Scenarios**:

1. **Given** a workspace in Ready to submit, **When** the user opens **Submit**, **Then** a card "Done on GeM?" reads "After you
   press Final Submit on GeM, record it here so your team and pipeline stay in sync." with **Mark as submitted** (Analyst+).
2. **Given** the user clicks **Mark as submitted**, **Then** a dialog "Confirm you submitted on GeM" ("TenderPilot only records
   this — the submission itself happened on the GeM portal.") shows three checkboxes "I entered the price myself on GeM", "I
   authenticated with OTP / DSC / e-Sign", "I clicked Final Submit and saw the confirmation" and an optional note; the
   confirm button stays disabled until all three are ticked.
3. **Given** all three ticked, **When** the user confirms, **Then** `POST /api/workspaces/{id}/submitted` answers 200 with
   `stage: "submitted"` and `submittedAt` = now (or the provided `submittedAt`), the toast reads "Marked as submitted. Good
   luck!", the card changes to "Submitted on GeM" with the IST date-time and "When GeM publishes the result, record it here —
   the L1 price helps you price the next bid." plus **Record result**, the Submit step shows a check, and the activity log
   has `workspace.submitted` with the note.
4. **Given** a workspace already Won/Lost, **Then** `POST /submitted` answers **409** "This bid already has an outcome
   recorded."; for a Dropped bid **409** "This bid was dropped. Move it back to the pipeline first."
5. **Given** the user clicks **Record result**, **Then** a dialog "Record the result" ("Prices here are for your records and
   analytics only — TenderPilot never enters prices on GeM.") offers Won/Lost, "L1 price (₹)" (hint "The lowest price
   disclosed by GeM", live Indian-format preview, error "Enter a number"), "Our price (₹)" and Notes (max 1000).
6. **Given** Won with L1 "29,50,000", **When** saved, **Then** `PATCH /api/workspaces/{id}` with `outcome: { result: "won",
   l1Price: 2950000, ourPrice, notes }` answers 200 with `stage: "won"` and `outcome.at`; the toast reads "Congratulations on
   the win!" (Lost: "Result recorded"); the card shows "Bid won", L1 "₹29,50,000", Our price "—" when empty, and "Recorded
   <date>"; the header shows a "Won · L1 <compact ₹>" badge; the activity rail shows "recorded the result: Won (L1 ₹29,50,000)".
7. **Given** a stage change to Won/Lost from the dropdown without an outcome, **Then** a minimal outcome `{ result, at }` is
   stored so the card still shows "Bid won"/"Bid lost".
8. **Given** an outcome with `l1Price: -5` or a non-integer, **Then** the API answers 400; prices above 10^13 are rejected.
9. *(gap — FR-085)* **Given** the user has saved the public GeM RA/bid-result page for this bid as HTML, **When** they choose
   **Suggest from GeM result** and pick the file, **Then** TenderPilot parses the evaluation table (rank/price columns) and
   pre-fills L1 price and the L1 seller name in the dialog for the user to confirm; a page without a price table shows
   "No price table found in this page." and nothing is pre-filled.
10. *(gap — FR-084)* **Given** open blockers at the time of marking submitted, **Then** the confirm dialog shows "<n> checklist
    item(s) were still open: …" (informational, does not block) and the activity entry records `openBlockers: n`.

---

### Edge Cases

- **Re-analysis changes the checklist**: readiness always uses the latest analysis; stored mapping keys for items that no
  longer exist are ignored; new items are auto-mapped at read time. If the analysis is `stale`, the header shows
  "Re-analysis needed".
- **Concurrent "Start bid"**: two clicks race → one insert wins (`onConflictDoNothing`), the other returns the winner with
  `created: false`.
- **Workspace of another org**: every `/workspaces/:id…`, `/packets/:id/download` and `/assist/:id` answers 404 (UUID check
  first, then org filter); malformed ids answer 404, not 500.
- **Vault document deleted after mapping or after a packet build**: explicit mapping resolves to Missing; an already-built
  packet stays downloadable (its blob is separate); a rebuild drops the item with a warning ("… is missing — the file was not
  found — skipped.").
- **Empty checklist with a done analysis**: readiness is 100 % with 0 items; Documents shows the empty filter state; the
  stage guard passes.
- **No company profile**: annexures render with "Company name" in the letterhead and blanks everywhere; the cover page shows
  Bidder "—"; nothing fails.
- **Encrypted, image-only or zero-page PDFs** in the vault: handled per US5 #8; a zero-page PDF is skipped with "has no pages".
- **Very long titles**: cover title wraps to at most 4 lines; index titles are truncated with "…" to fit; bookmark titles are
  full UTF-16 strings.
- **Non-WinAnsi text** (₹, Devanagari, smart quotes) in profile/tender/template: sanitised, never throws.
- **Due date after closing**: allowed (UI warning border only).
- **Stage moved back** from Submitted to Preparing: allowed; `submittedAt` is kept (records that a submission happened).
- **Extension on a page that changes dynamically** (GeM SPA sections): Highlight must be re-run; chips from an earlier scan
  are cleared before every scan.
- **Select with no matching option**: the field is reported as skipped "value not accepted by the field" and left untouched.
- **Number input with a non-numeric prepared value**: not written ("value not accepted by the field").
- **A field whose label contains both an allowed and a forbidden word** (e.g. "Delivery charges amount"): forbidden wins.
- **API token revoked while the popup is open**: next call shows the revoked-token message and re-opens settings.
- **Packet of 0 documents with only a cover**: builds a 2-page PDF (cover + "No documents were included.").
- **Packet build on the Worker** with large scans: CPU/memory limits → FR-056 pre-check; on failure the row is `failed`
  and the error is surfaced (US5 #12).

## Requirements *(mandatory)*

### Functional Requirements

**Workspace lifecycle & stages**

- **FR-001**: The system MUST provide `POST /api/tenders/:id/workspace` (Analyst+) that creates-or-gets the single workspace
  per (org, tender) — 201 `{…WorkspaceDto, created: true}` on create, 200 `created: false` when it exists or a concurrent
  create won — enforced by the unique index `workspace_org_tender_uq`.
- **FR-002**: On create the system MUST set `stage` to `go` when the latest analysis verdict is `go`, `analysing` when the
  analysis is running, else `identified`; `ownerId` = the caller; `dueAt` = tender `endAt`; `position` = max position in that
  stage + 1; and store an empty `doc_mapping` — automatic picks are resolved at read time (FR-014) so they keep the **Auto-matched**
  badge and fall back when a document is deleted; the `workspace.created` activity records the auto-match count.
- **FR-003**: The stage set MUST be exactly `identified, analysing, go, preparing, ready, submitted, won, lost, dropped` with the
  labels Identified, Analysing, Go, Preparing, Ready to submit, Submitted, Won, Lost, Dropped (`STAGES`, `STAGE_LABELS`).
- **FR-004**: `PATCH /api/workspaces/:id` (Analyst+) MUST accept only `stage, ownerId, assigneeIds (≤20, de-duplicated), dueAt
  (ISO with offset or null), position, outcome` (strict schema; unknown keys → 400) and return the updated `WorkspaceDto`.
- **FR-005**: Moving to `ready` MUST be refused with **409** `not_ready` and `details.blockers` while any mandatory item is
  missing or expired and not overridden, and with **409** `conflict` (`details.reason = "not_analysed"`) when the tender has no
  analysis.
- **FR-006**: Owner and assignees MUST be members of the organisation (else 400 with `details.fields`); newly added people
  other than the actor MUST receive one in-app `assignment` notification linking to `/workspaces/:id`.
- **FR-007**: Every stage change, assignment, due-date change, mapping change, override, comment, packet build, assist-value
  save, submission and outcome MUST write one activity entry (`workspace.*`) with actor and meta, shown newest first in the
  Activity rail with human sentences.
- **FR-008** *(gap)*: Moving to `won` or `lost` (by `stage` or `outcome`) MUST be refused with **409** `invalid_transition`
  unless the workspace is `submitted` (or already won/lost, to correct the result).
- **FR-009** *(gap)*: When the tender has no analysis, workspace readiness in `GET /api/workspaces` cards and
  `GET /api/workspaces/:id` MUST report `analysed: false` with `percent: 0` instead of 100 %, and the UI MUST show "Not
  analysed".
- **FR-010**: `GET /api/workspaces` (Viewer+) MUST support `stage` (repeatable or comma-separated; unknown → 400 "stage:
  unknown stage …"), `mine=1|true` (owner or assignee) and `q` (bid number/title), returning `{ items: WorkspaceCard[],
  total, byStage }`.
- **FR-011**: `GET /api/workspaces/:id` (Viewer+) MUST return `WorkspaceDetail` (workspace, tender, analysis, readiness,
  annexures, packets, comments, activity ≤ 50, vaultDocs, tenderDocs, members, defaultPacketItems, profileGaps).
- **FR-012**: `submittedAt` MUST be set the first time a workspace reaches `submitted` (via PATCH or `POST /submitted`) and kept
  if the stage later moves back.

**Checklist → vault mapping & readiness**

- **FR-013**: `bestDocFor` MUST choose, among documents of the item's exact type (falling back to related types:
  `crac`↔`work_order`, `emd_exemption`→`udyam`/`startup_dpiit`), by: exact type, status valid > expiring > expired,
  title/tag relevance, newest financial year (balance sheet, ITR, CA turnover certificate), latest expiry, latest issue,
  latest upload. Generated items never map to a document; `other` items map only with relevance ≥ 0.5.
- **FR-014**: The stored mapping MUST use: absent key = automatic (resolved at read time), document id = explicit choice,
  `null` = "not available".
- **FR-015**: `PUT /api/workspaces/:id/mapping` (Analyst+) MUST accept `{ itemId: docId | null | "auto" }`, validate every
  itemId against the latest checklist and every docId against the org's vault (400 with per-item `details.fields`), apply
  `"auto"` as key removal, and return `{ workspace, readiness }`.
- **FR-016**: Readiness item state MUST be `generated` (generated item), `missing` (no doc), `expired`, `expiring` (≤ 30 days),
  `ready`, or `overridden` (missing/expired with an override), each with a human note ("Matched automatically from the
  vault.", "Selected from the vault.", "Marked as not available.", "No matching document in the vault.", "Expired N day(s)
  ago — upload the renewed document.", "Expires in N day(s).", "Expires today.", "Overridden: <reason>").
- **FR-017**: `percent` MUST be round(covered / scope × 100) where scope = mandatory items (all items when none is mandatory)
  and covered = not missing and not expired; `blockers` = mandatory missing/expired without override; `warnings` = expiring
  items and optional uncovered items; `canMarkReady` = no blockers.
- **FR-018**: The Documents step MUST show the readiness ring (green 100 %, amber ≥ 60 %, red < 60 %), the blocker chips linking
  to their rows, filter tabs All / Needs attention / Covered with counts, and per row: state chip, Required/Optional, an
  **Auto-matched** badge for automatic picks, label, reason, override note, the chosen document (title, file name, FY, valid
  till, expiry badge, open link) or the note.
- **FR-019**: Analyst+ MUST be able to pick a document from a searchable popover grouped "<type label>" / "Other documents"
  (≤ 30), choose **Auto-match** or **Not available**, and open `/vault?upload=1&uploadType=<docType>`; rows in
  missing/expired/expiring state MUST offer **Upload <type label>** / **Upload renewed**.
- **FR-020**: A vault document uploaded after the workspace was created MUST be picked for untouched items on the next read
  without any user action.
- **FR-021**: Readiness MUST be computed with the injected clock (deterministic; Constitution III).
- **FR-022**: The Kanban card readiness MUST equal the detail readiness (`percent, blockers, total, covered`).
- **FR-023**: The workspace step strip MUST show per step: Qualify "Score N"/"Not analysed", Documents "<percent>% ready",
  Annexures "<n> required", Packet "<pages> pages"/"Not built", Submit "Submitted"/"Human-only", with a check when done.
- **FR-024**: A Viewer MUST see the Documents step without picker, upload, override or remove controls.

**Overrides & comments**

- **FR-025**: `POST /api/workspaces/:id/overrides` (Bid Manager+) MUST take `{ itemId, reason (5–500 chars) }`, replace any
  existing override for that item, store `{ itemId, reason, by, at }` and return 201 `{ workspace, readiness }` with
  `overrides[].byName`.
- **FR-026**: `DELETE /api/workspaces/:id/overrides/:itemId` (Bid Manager+) MUST remove it (404 "Override not found" when
  absent) and return the recomputed readiness.
- **FR-027** *(gap)*: Overriding an item that is not missing/expired MUST be refused with 409 `nothing_to_override`.
- **FR-028**: The override dialog MUST require a 5+ character reason with inline guidance and record the Bid Manager's name;
  only Bid Manager+ see **Override** / **Remove override**, and only on mandatory missing/expired rows.
- **FR-029**: `GET /api/workspaces/:id/comments` (Viewer+) and `POST …/comments` (Analyst+, body 1–4000 trimmed) MUST list and
  create comments; a new comment MUST notify the owner and assignees except the author (`mention` kind, dedupe per comment).
- **FR-030**: The Discussion rail MUST show comments (author, avatar, relative time) and Activity; send with button or
  Ctrl/⌘+Enter; empty state "No comments yet. Coordinate who is chasing which document."; Viewers see no composer.
- **FR-031**: On < 1024 px the rail MUST be reachable through a "Bid steps | Discussion (n)" segmented control; on ≥ 1024 px it
  MUST be a sticky right column.
- **FR-032** *(gap)*: `@FirstName` / `@Full Name` mentions of org members MUST additionally notify the mentioned members.
- **FR-033** *(gap)*: The author or a Bid Manager+ MUST be able to delete a comment (`DELETE …/comments/:commentId` → 204;
  others 403; another org's comment 404), logged as `workspace.comment_deleted`.

**Annexure templates & rendering**

- **FR-034**: The system MUST ship 8 system templates — `non_blacklisting`, `mii_self_cert`, `mse_declaration`,
  `emd_exemption`, `oem_auth_request`, `technical_compliance`, `authority_letter`, `bid_cover_letter` — with title,
  description, signature role and `{{placeholder}}` body; aliases `mii_self_certificate`, `oem_authorization_request`,
  `oem_authorisation_request`, `cover_letter` MUST resolve to their keys.
- **FR-035**: `GET /api/annexure-templates` (Viewer+) MUST return the 8 templates merged with the org's overrides (`custom`,
  `systemTitle`, `systemBody`, `placeholders`, `updatedAt`).
- **FR-036**: `PUT /api/annexure-templates/:key` (Bid Manager+, title 3–200, body 20–20 000) MUST upsert the org override and
  `DELETE` MUST restore the system template; both MUST be logged (`annexure.template_updated` / `annexure.template_reset`).
- **FR-037**: The workspace annexure list MUST be: covering letter; each checklist-generated annexure in checklist order
  (`required` = item mandatory); `oem_auth_request` when the checklist has an `oem_authorization` item (Recommended);
  then technical compliance, non-blacklisting and authority letter if not already present — each with `missing`
  placeholders and `pdfUrl`.
- **FR-038**: `GET /api/workspaces/:id/annexures/:key.pdf` (Viewer+) MUST render the org's template with the context built
  from profile, tender and the workspace's assist values (`company.*`, `signatory.*`, `tender.*`, `oem.*`, `offer.*`,
  `emd.basis`, `date`, `place`); empty values print "__________"; headers as in US4 #4.
- **FR-039**: The renderer MUST produce A4 PDFs with letterhead, ref/date line, underlined capitalised title, paragraph and list
  layout, bold "Subject:" lines, automatic page breaks with footer, and the signature block; it MUST sanitise text to the
  standard font's character set.
- **FR-040**: `POST /api/workspaces/:id/annexures/:key/preview` (Analyst+) MUST render a draft `{ title, body }` without saving.
- **FR-041** *(gap)*: Saving or previewing a template with placeholders outside the supported context paths MUST be refused with
  400 `unknown_placeholder` listing them; the editor's placeholder palette MUST list exactly the supported paths.
- **FR-042**: The Annexures step MUST show the list with Required by this bid / Recommended / Optional badges and "N blank(s)"
  warnings, the profile-gaps banner, the PDF preview (iframe on ≥ 640 px, open-in-new-tab on phones), and **Build the
  packet →**.
- **FR-043**: The template editor MUST be reachable only by Bid Manager+ *(gap: the Edit template button is shown to every
  role today)* and MUST offer title/body, placeholder insertion, Preview, Save template and
  Restore default (when custom), with the toasts in US4.
- **FR-044**: Annexure PDF metadata MUST set Title "<title> — <bid number>", Author = legal name, Creator "TenderPilot".

**Packet builder**

- **FR-045**: `defaultPacketItems` MUST be: cover; covering letter; checklist-required annexures except `oem_auth_request`;
  each resolved vault document once, in checklist order, titled with the checklist label.
- **FR-046**: `POST /api/workspaces/:id/packets` (Analyst+) MUST accept `{ items?: [{ kind: cover|annexure|vault|tender_doc,
  refId?, title, pages? }] (≤ 200) }`, default to `defaultPacketItems` when absent/empty, validate every reference against
  the org (vault), system template keys (annexure) and this tender's documents (tender_doc) → 400 "Unknown packet item(s):
  …" with no row created.
- **FR-047**: The builder MUST load each item (annexures rendered on the fly; blobs from the store), sniff PDF/PNG/JPG by magic
  bytes, copy PDF pages, place images on A4 scaled to fit (≤ 2×), and skip missing/damaged/unsupported/zero-page files with a
  warning — never crash.
- **FR-048**: With a cover item, the output MUST start with the cover page and ⌈index pages⌉ (26 rows on the first, 34 on
  each continuation) and every start page MUST account for them.
- **FR-049**: The cover MUST show "TECHNICAL BID PACKET", title (≤ 4 lines), bid number, buyer, closing time (IST), bidder
  name/GSTIN/PAN/address, contents count, prepared date and the human-review disclaimer.
- **FR-050**: The index MUST list number, title (truncated), kind label (Annexure / Bid document), pages and start page, each row
  a link annotation to the item's first page.
- **FR-051**: The PDF MUST have a flat outline (Cover, Index, then one bookmark per included item) with `PageMode
  UseOutlines`, and stamp "<bid number> · Page x of N" on every page.
- **FR-052**: The service MUST add warnings for open blockers and for expired documents included, de-duplicated, and warn when
  the output exceeds 20 MB (`DEFAULT_MAX_PACKET_BYTES`).
- **FR-053**: The packet row MUST go `building` → `ready` (blob stored at `org/<orgId>/packets/<packetId>/<BID>_technical_packet.pdf`,
  `sizeBytes`, `pageCount`, built items with `startPage`/`included`) or `failed` (500 `packet_build_failed`).
- **FR-054**: A `ready` build MUST move a workspace in identified/analysing/go to `preparing` (logged with `auto: true`).
- **FR-055** *(gap)*: The proposed packet order MUST default to the last successful build's items (still-valid references only,
  new required items appended) so the whole team sees the same order; per-browser storage becomes a draft cache only.
- **FR-056** *(gap)*: Before loading files the service MUST sum the stored sizes of the selected items and refuse with **413**
  `packet_too_large` above 60 MB (configurable `PACKET_MAX_INPUT_BYTES`).
- **FR-057** *(gap)*: Packet rows in `building` for more than 10 minutes MUST be marked `failed` ("Build interrupted — try
  again.") when read.
- **FR-058**: `GET /api/workspaces/:id/packets` (Viewer+) MUST list ≤ 50 builds newest first; `GET /api/packets/:id/download`
  (Viewer+) MUST stream only `ready` packets of the caller's org (else 404) with `content-disposition` (`attachment`, or
  `inline` with `?inline=1`), `cache-control: private, no-store`, `x-content-type-options: nosniff`.
- **FR-059** *(gap)*: Packet and annexure downloads MUST also send an RFC 5987 `filename*=UTF-8''…` parameter (consistent with
  spec 004 FR-006).
- **FR-060**: The Packet step MUST support drag (pointer, touch with 150 ms delay, keyboard), up/down/remove buttons with
  accessible names, "Add more", a live estimate of documents/pages/size with a 20 MB bar (amber > 75 %, red > 100 %), build
  progress messages in a polite live region, the latest packet card with warnings and download/open, and earlier builds.

**Assist allow-list, payload & extension**

- **FR-061**: The allow-list MUST contain exactly the 14 fields of US6 with label, group, help, input kind and selector hints;
  no other key may be stored, returned or filled.
- **FR-062**: `forbiddenReason` MUST classify a field as forbidden when its input type is password/submit/button/reset/image/
  file/hidden/checkbox/radio, its tag is `button`, or its normalised descriptor (name, id, label, placeholder, aria-label,
  nearby text; camel/snake/kebab-case split) matches price, rate, amount, unit price/cost, bid/total/contract/quoted/offered/
  estimated value, cost/tariff/discount/tax/financial, ₹/INR/Rs/rupee, CAPTCHA/security or verification code, OTP, DSC/
  digital signature, e-Sign, Aadhaar/UID, password/passcode/PIN, submit/submission/final/confirm bid/place bid. Forbidden
  MUST win over any allowed match.
- **FR-063**: `PUT /api/workspaces/:id/assist-values` (Analyst+) MUST check keys before types: any forbidden key → 400
  `forbidden_field` with `details.forbidden`; unknown key → 400 `validation_error`; non-string → "Must be text"; > 2000 chars
  rejected; empty string deletes; values are trimmed; logged as `workspace.assist_values_saved` with keys only.
- **FR-064**: `GET /api/assist/:workspaceId` (Viewer+, session cookie or `Bearer tp_…`) MUST return `AssistPayload`
  (`noFinancials: true`, 14 fields with saved > derived value and `source`), documents in upload order (latest ready
  packet, then mapped vault docs de-duplicated, then required annexures except the MAF request), the 4 human steps, `stage`,
  `readiness { percent, blockers }` and `workspaceUrl`.
- **FR-065**: Derived defaults MUST be: make/brand/oem_name from the first OEM authorisation; offered quantity from the tender;
  delivery days from the analysis requirement `delivery_days`; country of origin "India" for MII Class-I/II; local content
  from the profile; HSN from the tender, else the profile; specs compliance "Yes"; MSE claim Yes/No from Udyam/MSE category;
  startup claim Yes/No from DPIIT; product description from the first tender item.
- **FR-066**: The Submit step MUST show human-only steps, the editable values card with copy buttons, the upload order with
  copy-file-name and download, and the extension card with a link to `/settings/api-tokens`.
- **FR-067**: The extension MUST be MV3 with permissions `storage`, `activeTab` only, optional host permission requested for the
  configured TenderPilot origin only, and no remote code.
- **FR-068**: The popup MUST validate URL and token format, request host permission, verify with `GET /api/auth/me`, store
  `apiBase`, `token`, `workspaceId` in `chrome.storage.local`, and list workspaces in go/preparing/ready/submitted.
- **FR-069**: The content script MUST do nothing until the popup sends `tp:scan`, `tp:fill` or `tp:clear`; it MUST collect only
  visible text-like inputs, textareas and selects, plus radio/checkbox questions, which are reported as left for the user
  and never written (FR-077).
- **FR-070**: `plan` MUST classify each control as fillable / forbidden / unmatched / no_value / disabled; `fillOne` MUST re-check
  `forbiddenReason` immediately before writing; `fillAll` MUST not overwrite non-empty fields unless asked and MUST report
  filled, skipped (with reason), forbidden and unmatched counts.
- **FR-071**: Writes MUST use the native value setter and dispatch bubbling `input` and `change` events; selects MUST use
  `pickOption` (exact → yes/no synonyms → prefix → contains ≥ 3 chars); number inputs MUST reject non-numeric values.
- **FR-072**: The extension MUST never click, submit, focus-trap or navigate the GeM page, and never read or send page content to
  TenderPilot.
- **FR-073** *(gap)*: The content script MUST ignore messages whose `sender.id` is not the extension's own id, and match only
  `https://*.gem.gov.in/*` (plus the localhost fixture patterns).
- **FR-074** *(gap)*: API tokens MUST support a read-only scope ("Extension (read-only)"); requests authenticated with a
  read-only token MUST be refused on every non-GET route with 403 "This API token is read-only"; the extension setup copy
  MUST recommend the read-only scope.
- **FR-075** *(gap)*: After a fill the popup MUST list filled and skipped fields with reasons and offer **Clear highlights**.
- **FR-076**: The shared allow-list MUST be the single source of truth used by the API (payload and validation) and the
  extension (bundled from `@tp/core`).
- **FR-077** *(gap)*: Radio-button and checkbox questions (e.g. "MSE: Yes/No" as radios) MUST be reported in the scan as "left
  for you" with the prepared answer shown in the chip title, never clicked.
- **FR-078**: The extension README MUST document build, load-unpacked, token creation, the four human-only steps and the
  safety rules.

**Submission & outcome**

- **FR-079**: `POST /api/workspaces/:id/submitted` (Analyst+, `{ submittedAt?, note? ≤ 1000 }`) MUST set stage `submitted`
  (new position when changed) and `submittedAt`, refuse won/lost (409 "This bid already has an outcome recorded.") and
  dropped (409 "This bid was dropped. Move it back to the pipeline first."), and log `workspace.submitted` with the note.
- **FR-080**: The UI MUST require the three confirmations before **Mark as submitted** is enabled.
- **FR-081**: `outcome` (`result` won|lost, `l1Price`, `ourPrice` integers 0…10^13 or null, `notes` ≤ 2000) MUST be stored with
  `at`, and set the stage to the result when no stage is given; logged as `workspace.outcome_recorded` with `l1Price`.
- **FR-082**: Choosing Won/Lost without an outcome MUST store `{ result, at }`.
- **FR-083**: Outcome prices MUST never appear in the assist payload, the extension or any GeM-facing output.
- **FR-084** *(gap)*: The submit confirmation MUST list open blockers (informational) and log `openBlockers`.
- **FR-085** *(gap)*: The outcome dialog MUST offer **Suggest from GeM result**: parse a user-supplied HTML file of the public
  GeM RA/bid result page (rank/price/seller evaluation-table reader, clean-room implementation from `award-parser-spec.md` (issue #537)) via a pure `parseAwardResult(html)` in `@tp/core/gem/award.ts`, returning `{ l1Price, l1Seller,
  bidders }` for the user to confirm; TenderPilot MUST NOT log in to GeM or fetch non-public pages.
- **FR-086**: The header MUST show a Won/Lost badge with the compact L1 price when recorded.

**Workspace page**

- **FR-087**: `/workspaces/:id` MUST show breadcrumb, header, the 5-step strip (Qualify, Documents, Annexures, Packet, Submit),
  the active step from `?step=` (else a computed default: Qualify if not analysed; Submit when ready/submitted/won/lost;
  Documents if blockers; Packet if no packet; else Submit), and the Discussion rail; step changes push history.
- **FR-088**: Loading MUST show a skeleton (`aria-busy`, "Loading bid workspace"); 404 MUST show "Bid workspace not found — It
  may belong to another organisation, or the link is wrong." with **Go to pipeline**; other errors MUST show the error state
  with Retry.
- **FR-089**: Step transitions MUST animate (fade/slide 200 ms) unless `prefers-reduced-motion`.
- **FR-090**: The page title MUST be "<bid number> · Bid workspace".
- **FR-091**: The Qualify step MUST summarise the analysis (score ring, verdict, blocking factors first, then factors by
  weight) with **Continue to documents →** and **Full analysis** (`/tenders/:id#analysis`); without analysis it MUST show an
  empty state with **Open tender analysis →**.
- **FR-092** *(gap)*: Unsaved edits in the assist-values editor or the template editor MUST prompt "Discard unsaved changes?"
  before navigating away or closing.

### Non-Functional Requirements

- **NFR-001 (Performance)**: `GET /api/workspaces/:id` p95 < 600 ms with a 40-item checklist and 500 vault documents;
  `GET /api/workspaces` p95 < 800 ms for 200 workspaces; mapping/override/comment writes p95 < 400 ms.
- **NFR-002 (Packet build)**: A 30-document / 120-page / 25 MB-input packet MUST build in < 15 s on Node and within Worker CPU
  limits; annexure PDF render < 500 ms.
- **NFR-003 (Memory)**: Packet input is capped (FR-056) so a build never exceeds 128 MB of heap on the Worker.
- **NFR-004 (Security & isolation)**: Every query is filtered by `org_id` (Constitution IV); cross-org ids answer 404; blobs live
  under `org/<orgId>/…`; all PDF responses are `private, no-store` + `nosniff`; API tokens are stored hashed and the
  extension sends them only to the configured origin.
- **NFR-005 (Human-in-the-loop)**: No code path in API, web or extension may submit a GeM form, click a GeM control, enter a
  price, solve CAPTCHA, or perform OTP/DSC/e-Sign; this MUST be guarded by unit tests (allow-list), API tests (assist
  payload/value validation) and the real-browser extension smoke test, all in CI.
- **NFR-006 (Accessibility)**: WCAG 2.1 AA in light and dark themes; all controls keyboard-operable (including packet reorder);
  status changes announced politely; state never conveyed by colour alone (text chips); axe scan with no serious/critical
  violations on each step.
- **NFR-007 (Responsive)**: No horizontal page scroll at 375 px; step strip scrolls horizontally inside its own container; tap
  targets ≥ 32 px.
- **NFR-008 (Determinism)**: Mapping, readiness, template rendering and packet layout are pure functions of their inputs and the
  injected clock; identical inputs give identical page plans.
- **NFR-009 (Traceability)**: Code comments cite FR/T ids; ported code is attributed in root `NOTICE`.
- **NFR-010 (Evidence)**: Every user story has a Playwright E2E with screenshots, video and trace in `qa/evidence/006/US<n>/`
  and a QA `VERDICT.md`.

## UX Specification

### Screens

| Screen | Route / surface | Purpose |
|---|---|---|
| Bid workspace | `/workspaces/:id?step=qualify|documents|annexures|packet|submit&view=discussion&annexure=<key>` | Header + 5 steps + Discussion rail |
| Documents step | `?step=documents` | Readiness ring, blockers, filters, checklist rows, doc picker, override dialog |
| Annexures step | `?step=annexures&annexure=<key>` | Annexure list, PDF preview, template editor dialog (Bid Manager+) |
| Packet step | `?step=packet` | Ordered contents, add more, estimate panel, build, latest packet, earlier builds |
| Submit step | `?step=submit` | Human-only steps, values card, upload order, extension card, submission/outcome card and dialogs |
| Extension popup | Chrome toolbar | Settings, workspace picker, values, upload order, human-only steps, Highlight / Fill |
| GeM page overlay | `bidplus.gem.gov.in` | Outlines (indigo dashed / green solid / red), "TP" chips |

### States

- **Loading**: page skeleton (header block, 5 step tiles, list rows); annexure iframe skeleton; build progress bar with phase
  text; buttons show spinners and are disabled while pending.
- **Empty**: no analysis (Documents/Qualify "No checklist yet"); filter with no rows ("Nothing here"); packet with no items;
  upload order before build; no comments; no activity ("Nothing yet."); extension "No active bids — start one in TenderPilot".
- **Error**: 404 workspace; generic error with Retry; toasts for mutation errors with the API message; 409 stage-guard toast
  with **Fix documents**; failed packet card; extension inline error (`role="alert"`).
- **Read-only (Viewer)**: all editing controls hidden; downloads and previews available.
- **Done states**: step tiles with green check; "Latest packet is ready"; "Submitted on GeM"; "Bid won/lost".

### Responsive behaviour

- **375 px**: header stacks (bid chip + stage, title, meta lines, score chip below); step strip is a horizontally scrollable row of
  132 px tiles; "Bid steps | Discussion (n)" segmented control; checklist rows stack; doc picker ≤ 92 vw; annexure preview is
  an Open button; packet estimate panel below the list; dialogs full-width.
- **≥ 640 px**: step strip becomes a 5-column grid; annexure iframe preview.
- **≥ 1024 px**: Discussion is a sticky right rail (300 px; 340 px at ≥ 1280 px); Packet and Submit use a two-column layout at
  ≥ 1280 px (content + 320/360 px side panel).

### Accessibility

- Breadcrumb `nav[aria-label="Breadcrumb"]` with `aria-current="page"`; step strip `nav[aria-label="Bid steps"]`, active tile
  `aria-current="step"`; Documents filter `role="tablist"` with `aria-selected`; annexure list buttons `aria-current`.
- All icon buttons have names ("Copy bid number …", "Reorder <title>", "Move <title> up", "Remove <title>", "Add <title>",
  "Download this build", "Copy <label>"); avatars have names; decorative icons `aria-hidden`.
- Live regions: build progress (`role="status"`, `aria-live="polite"`), extension status (`role="status"`), toasts.
- Dialogs trap focus, have titles/descriptions and return focus; the override reason and comment textarea have labels.
- Keyboard: dnd-kit keyboard sensor on the grip handle (Space to lift, arrows to move, Space to drop); Ctrl/⌘+Enter sends a
  comment.
- PDF iframes have titles ("<annexure title> preview", "Draft preview").

### Key Entities *(include if feature involves data)*

- **Bid workspace** (`bid_workspaces`): one per (org, tender); stage, position, owner, assignees, due date, `doc_mapping`
  (itemId → docId | null), `overrides[]` ({itemId, reason, by, at}), `assist_values` (allow-listed keys only), `outcome`
  ({result, l1Price?, ourPrice?, notes?, at}), `submitted_at`, timestamps.
- **Comment** (`comments`): body, author, workspace, org, created at.
- **Annexure template** (`annexure_templates`): org override (org_id) of a system template key (title, body); system templates
  live in code (`SYSTEM_TEMPLATES`).
- **Packet** (`packets`): status draft/building/ready/failed, items (kind, refId, title, pages, startPage, included), warnings,
  blob key, size, page count, created by/at.
- **Readiness** (computed): per-item state/doc/note/blocking, percent, total, covered, blockers, warnings, canMarkReady.
- **Assist payload** (computed): 14 fields with values and sources, documents in upload order, human steps, `noFinancials`.
- **Activity entry** (`activity_log`): `workspace.*` and `annexure.*` actions with actor and meta.
- **API token** (`api_tokens`): personal Bearer `tp_…` used by the extension (gap: scope).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For the Apply fixture, a user goes from "Start bid" to a downloaded, bookmarked 11-page packet in under 3 minutes
  and fewer than 10 clicks (measured in the US5 E2E video).
- **SC-002**: 100 % of forbidden fields in the GeM-like fixture (price, CAPTCHA, OTP, DSC, final submit) remain untouched and the
  form is never submitted across all extension unit and smoke tests; 0 price-like keys are ever persisted in
  `assist_values` (API test asserts 400 for 10+ price/auth key spellings).
- **SC-003**: The "Ready to submit" guard blocks 100 % of attempts with an unresolved mandatory blocker (API test matrix) and every
  override is attributable (who, when, why) in the activity log.
- **SC-004**: Auto-mapping picks the expected document for ≥ 95 % of items in the core mapping test corpus (newest FY, valid over
  expired, related-type fallback).
- **SC-005**: Packet page plans are exact: start pages in the index, bookmarks and API `items[].startPage` agree for 100 % of
  builds in tests (1, 27 and 61 documents).
- **SC-006**: All 7 user stories have a passing Playwright E2E with screenshots, video and trace in `qa/evidence/006/US<n>/` and a
  QA verdict of `qa:approved`; axe reports no serious/critical violations on any step at 1440 px and 375 px.
- **SC-007**: Workspace detail p95 < 600 ms and packet build < 15 s for the NFR-002 workload in the perf check.

## Assumptions

- The checklist, its item ids and `generated` annexure keys come from Analyse (spec 004) and are stable across re-analysis for
  the same requirement.
- GeM's technical-bid upload limit is treated as 20 MB per file (the commonly observed limit); it is a warning, not a block,
  because limits vary by bid.
- The extension targets Chrome/Edge (MV3) on desktop; Firefox and mobile browsers are out of scope.
- Users print, sign and stamp generated annexures (or e-sign them outside TenderPilot) before upload; TenderPilot does not
  apply signatures.
- Outcome data is entered by humans; the optional GeM-result parser (FR-085) only reads a page the user saved themselves.
- The Kanban board UI and dashboards are specified in the Track area; this spec owns their data contract.
- Reference-repo code may be copied (approved by the user); every port is attributed in root `NOTICE` with source path and
  licence (or "no licence file — copied with the user's approval").
- E2E runs use the real clock; the Apply fixture therefore uses dates relative to "now".
