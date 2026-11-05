# Feature Specification: Company Profile & Document Vault

**Feature Branch**: `005-profile-vault`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Company profile & document vault area of TenderPilot in detail: company profile fields and
validators (GSTIN/PAN/Udyam/CIN), completeness, past contracts/CRACs, OEM authorisations, vault upload/download/replace,
document-type catalog, expiry status and reminders (30/7/1), profile and vault pages. Describe what is built, add
requirements for the gaps that matter, and make every acceptance scenario verifiable by QA in a browser or via the API."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — User Story 3 ("Keep a
bid-ready company profile and document vault"), FR-020…FR-022, and the vault inputs of FR-023 (checklist auto-match) and
FR-024 (annexure generation). This spec refines that story into independently testable slices, describes what is
**built today** (verified against the code on 2026-11-05) and adds requirements for the gaps that matter. Requirements
and scenarios marked *(gap)* are not implemented yet; everything else is implemented and covered by unit/API tests
(`packages/core/test/vault/*`, `apps/api/test/vault.test.ts`).

## Personas affected

| Persona | Role in the app (server-enforced) | What they do in this area |
|---|---|---|
| **Owner (MSME founder / OEM sales head)** | `owner` | Fills the profile once during onboarding (GSTIN, PAN, Udyam, MII class, turnover), uploads statutory certificates, receives expiry reminders. |
| **Bid Manager** | `bid_manager` | Keeps the vault current: renews ISO/OEM authorisations before they lapse, triggers "Send reminders now", checks completeness before a bid season. |
| **Bid Analyst** | `analyst` | Adds past contracts with CRACs, links OEM authorisations, uploads balance sheets / CA certificates per FY, edits document metadata. |
| **Viewer (sales / OEM partner / consultant / CA)** | `viewer` | Read-only: views the profile and completeness, previews and downloads vault documents; cannot edit, upload, replace or delete. |
| **Downstream modules** | n/a | Eligibility scoring (004), checklist auto-match and packet builder (006), annexure templates and the extension allow-list read the profile and vault. |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. "At least X" means X or any higher role. A Viewer calling
an Analyst+ endpoint gets **403** `forbidden` "You need to be at least an Analyst to do that"; any id belonging to another
organisation answers **404** `not_found` (never 403, never data).

## User Scenarios & Testing *(mandatory)*

> QA conventions for every scenario: the E2E stack is `pnpm e2e` (Playwright, desktop 1440×900 and Pixel 7 / 375 px for
> `@mobile`) with the API + built SPA on :8788 against a fresh `tenderpilot_e2e` database. "Fresh org" = a user created with
> `signupViaApi()` (role Owner, empty profile and vault). "Demo org" = a fresh org after `POST /api/demo/seed` (company
> "Aarav Technologies Pvt Ltd", GSTIN `27AAJCA4721K1ZK`, PAN `AAJCA4721K`, CIN `U72900PN2016PTC165432`, Udyam
> `UDYAM-MH-26-0012345`, 5 past contracts, 15 vault documents including an ISO 9001 certificate expiring in **10** days, a
> CA turnover certificate expiring in **25** days and a Dell OEM authorisation that expired **5** days ago; the profile's
> CP PLUS and Dell Technologies OEM rows are linked to their vault letters, the D-Link India row is not). Other roles
> are added by inviting users from Settings → Team. API errors always have the shape
> `{ "error": { "code", "message", "details?" } }`; field errors are in `details.fields` keyed by path (e.g.
> `financials.1.fy`). Dates are calendar dates, "today" is the IST calendar day; all times are shown in IST. Fixture
> identifiers used below: valid GSTIN `27AAPFU0939F1ZV` (Maharashtra, PAN `AAPFU0939F`, a Firm/LLP), invalid-checksum GSTIN
> `27AAPFU0939F1ZA`, invalid PAN `AAPXU0939F`.

### User Story 1 - Maintain a validated company profile (Priority: P1) (#114)

An Owner or Analyst opens **Company profile** (`/profile`) and fills the statutory identity of the bidding entity (legal
and trade name, GSTIN, PAN, CIN, incorporation date, registered address, state, PIN code, maximum EMD), registrations
(MSE/Udyam with enterprise and owner category, DPIIT startup, Make in India class with local content %, quality
certifications), categories & reach (GeM categories, HSN/SAC codes, operating states) and signatory & contact. Every
identifier is normalised (trimmed, upper-cased, spaces removed) and validated with the same rules in the browser and on the
server, with a plain-English explanation of what is wrong. The GSTIN is checked against its embedded PAN and check
character, and can auto-fill PAN and State. Saving is a partial upsert: fields that are not sent keep their value.

**Why this priority**: Every downstream feature — eligibility scoring, EMD-exemption checks, MII restrictions, annexure
generation, extension pre-fill — reads the profile. A wrong GSTIN or PAN on an undertaking can disqualify a bid, so
validation at entry time is the cheapest place to stop errors.

**Independent Test**: In a fresh org, open `/profile`, type GSTIN `27AAPFU0939F1ZV`, click **Fill from GSTIN**, enter the
legal name, click **Save profile**, reload, and verify the values persisted (`GET /api/profile` returns
`gstin: "27AAPFU0939F1ZV"`, `pan: "AAPFU0939F"`, `state: "Maharashtra"`).

**Acceptance Scenarios**:

1. **Given** a fresh org, **When** the Owner opens `/profile`, **Then** the header shows "Company profile", the hint "Not
   saved yet", a disabled **Save profile** button, seven sections in this order — Company identity, Registrations & status,
   Financials, Experience, OEM authorisations, Categories & reach, Signatory & contact — and the completeness meter shows
   **0%** with the heading "Let’s complete your profile".
2. **Given** the identity section, **When** the user types `27aapfu0939f1zv` in GSTIN, **Then** the field shows
   `27AAPFU0939F1ZV` (upper-cased as typed, max 15 characters) and the hint "✓ Valid · Maharashtra · PAN AAPFU0939F";
   the **Fill from GSTIN** button appears in the section header; clicking it fills PAN `AAPFU0939F` and State
   "Maharashtra" only where those fields were empty, and the PAN hint shows "✓ Firm / LLP".
3. **Given** GSTIN `27AAPFU0939F1ZA` typed and the field blurred, **Then** the inline error reads "GSTIN check character
   does not match — please re-check for a typo"; for `00AAPFU0939F1ZV` it reads "\"00\" is not a valid GST state code
   (01–38, 97 or 99)"; for a 14-character value it reads "GSTIN has 15 characters, e.g. 27AAPCS1234K1Z2" *(gap: the
   example currently shown, `27AAPCS1234K1Z5`, is itself an invalid GSTIN — FR-004)*.
4. **Given** PAN `AAPXU0939F`, **When** blurred, **Then** the error reads "The 4th character "X" is not a valid PAN holder
   type (P, C, H, F, A, T, B, L, J or G)"; Udyam `UDYAM-1` → "Udyam number format is UDYAM-XX-00-0000000 (e.g.
   UDYAM-MH-26-0123456)"; CIN `U72200MH2015PTC12345` → "CIN has 21 characters, e.g. U72200MH2015PTC123456"; PIN `012345`
   → "PIN code is 6 digits and cannot start with 0"; mobile `12345` → "Enter a 10-digit Indian mobile number starting
   with 6–9"; email `bids@` → "Enter a valid email address".
5. **Given** GSTIN `27AAPFU0939F1ZV` and PAN `AAACI1681G`, **When** the user clicks **Save profile**, **Then** no request
   is sent, the toast "Please fix the highlighted fields" appears with the first error as description, the page scrolls to
   Company identity and focuses GSTIN, which shows "This GSTIN belongs to PAN AAPFU0939F, not AAACI1681G".
6. **Given** the API directly, **When** an Analyst sends `PUT /api/profile` with `{"gstin":"27AAPFU0939F1ZA","pan":"AAPXU0939F","pincode":"01234"}`,
   **Then** the response is **400** `validation_error` with `details.fields.gstin` matching "check character",
   `details.fields.pan` matching "4th character" and `details.fields.pincode` present; nothing is stored.
7. **Given** a stored profile with GSTIN `27AAPFU0939F1ZV`, **When** an Analyst sends `PUT /api/profile {"pan":"AAACI1681G"}`
   (PAN only), **Then** the response is **400** `validation_error` with `details.fields.pan` = "Your GSTIN is registered to
   PAN AAPFU0939F" (the cross-check uses stored values too).
8. **Given** a valid profile, **When** an Analyst sends `PUT /api/profile` with `{"legalName":"Sharma Infotech Pvt Ltd","gstin":"27aapfu0939f1zv","contactPhone":"98123 45678","udyamNumber":"udyam-mh-26-0123456","mseCategory":"small"}`
   and later `PUT /api/profile {"tradeName":"Sharma IT"}`, **Then** both return **200** `ProfileResponse`; the stored values
   are `27AAPFU0939F1ZV`, `+919812345678`, `UDYAM-MH-26-0123456`, and the second call did not clear any field it did not
   send; `activity_log` has two `profile.updated` rows whose `meta.fields` list the sent keys.
9. **Given** MII class **Class-I** selected, **When** local content `30` is entered, **Then** the field error reads
   "Class-I needs at least 50% local content"; with **Class-II** and `55` it reads "Class-II means 20% to under 50% local
   content"; choosing **Non-local** hides the local-content field.
10. **Given** the MSE switch ("We are a registered MSE") is turned on, **Then** Udyam number, Enterprise category (Micro /
    Small / Medium, default Small) and Owner category (General / SC / ST / Women-owned) appear; choosing **Medium** shows
    "Medium enterprises don’t get EMD exemption or MSE purchase preference."; turning the switch off clears Udyam, MSE and
    owner category in the draft.
11. **Given** unsaved edits, **When** the user looks at the bottom of the page, **Then** a floating bar shows "Unsaved
    changes" (plus "· N to fix" in red when invalid), **Discard** and **Save**; **Discard** restores the saved values;
    a successful save shows the toast "Profile saved" with description "<n>% complete · next: <top issue>", the header hint
    changes to "Saved just now" and the bar disappears.
12. **Given** unsaved edits, **When** the user closes or reloads the tab, **Then** the browser's "Leave site?" prompt
    appears; *(gap — FR-013)* **When** the user clicks a sidebar link instead, **Then** a dialog "Discard unsaved changes?"
    with **Stay** / **Discard and leave** appears and navigation happens only on **Discard and leave**.
13. **Given** a Viewer, **When** they open `/profile`, **Then** the banner "You have view-only access. Ask an owner or bid
    manager to make changes." is shown, every input is disabled, **Save profile**, **Fill from GSTIN**, the save bar and
    "Add contract" are absent; `PUT /api/profile` returns **403** `forbidden` "You need to be at least an Analyst to do that".
14. *(gap — FR-014)* **Given** two Analysts with the profile open, **When** A saves and then B saves a change made on the
    older copy, **Then** B's `PUT /api/profile` (carrying `expectedUpdatedAt`) returns **409** `conflict` "Someone else
    saved the profile at <time IST>. Reload to see their changes." and the page shows that message with a **Reload** button;
    nothing of B's is stored.

---

### User Story 2 - See profile completeness and keep 3 years of financials (Priority: P1) (#115)

The profile page shows a live completeness score (0–100%) with up to six prioritised, clickable suggestions (errors
first, then warnings, then info) that jump to the right field or open the vault upload dialog for missing backing
documents. The Financials section records turnover, net worth and "audited" per Indian financial year (April–March) and
shows the average annual turnover of the latest three years with figures — the number GeM ATCs check — plus a mini bar
chart.

**Why this priority**: The score is the user's to-do list for being bid-ready and directly drives scoring accuracy;
turnover criteria are the most common reason a bid is No-Go.

**Independent Test**: In a fresh org, add legal name, GSTIN and PAN and save: completeness becomes **27%**; upload a GST
certificate to the vault and return: it becomes **32%**; add FY 2025-26, 2024-25, 2023-24 turnovers ₹6,00,00,000,
₹4,50,00,000, ₹3,00,00,000: the average shows **₹4,50,00,000** for "Last 3 FYs (2023-24, 2024-25, 2025-26)".

**Acceptance Scenarios**:

1. **Given** a fresh org on 2026-11-05, **When** `GET /api/profile` is called, **Then** it returns **200** with
   `completeness: 0`, `averageTurnover: null` and 17 `issues` ordered error → warning → info; the first four are errors:
   "Add your legal company name exactly as registered on GeM.", "Add your GSTIN — almost every GeM bid asks for it.",
   "Add the PAN of the bidding entity.", "Add turnover for the last 3 financial years (2023-24, 2024-25, 2025-26) — used for
   turnover criteria.".
2. **Given** only legal name, GSTIN and PAN saved, **Then** completeness is **27%**; after a non-expired `gst` document is
   in the vault it is **32%** (weights in FR-016).
3. **Given** the completeness card, **Then** the heading is "Let’s complete your profile" below 55%, "Good progress" at
   55–84%, "Almost there" at 85–99% and "Bid-ready profile" at 100%; the ring is red/amber/green at <55 / 55–84 / ≥85; at
   most 6 suggestions are listed followed by "+N more suggestions"; with no issues it shows "Everything bids usually ask
   for is in place.".
4. **Given** the suggestion "Add your GSTIN — almost every GeM bid asks for it.", **When** clicked, **Then** the page
   scrolls to Company identity (instantly when `prefers-reduced-motion: reduce`) and focuses the GSTIN input; the
   suggestion "Upload your GST registration certificate to the vault." navigates to `/vault` and opens **Add a document**
   with type "GST registration" preselected; "… in the vault has expired — upload the renewed copy." opens
   `/vault?status=expired`.
5. **Given** the user edits a field, **Then** the meter recomputes immediately in the browser (before saving) using the
   same function as the API, and the desktop section nav shows a count of non-info issues per section and a red dot on
   sections with validation errors.
6. **Given** the Financials section on 2026-11-05 with no rows, **Then** the button reads "Add FY 2025-26" and the
   average card reads "Add at least one year"; clicking adds FY 2025-26, then "Add FY 2024-25", etc.; a FY already used
   is not offered again in another row's FY picker.
7. **Given** turnovers for FY 2025-26 ₹6,00,00,000, FY 2024-25 ₹4,50,00,000 and FY 2023-24 ₹3,00,00,000, **Then** the
   card reads "Last 3 FYs (2023-24, 2024-25, 2025-26) · ₹4,50,00,000" and the chart draws a dashed average line;
   `GET /api/profile` returns `averageTurnover: {"avg":45000000,"years":["2025-26","2024-25","2023-24"]}`.
8. **Given** the API, **When** `financials` contains `{"fy":"2024-25"}` and `{"fy":"FY 2024-2025"}`, **Then** **400**
   with `details.fields["financials.1.fy"]` = "2024-25 is listed twice"; `fy:"2024-26"` → "Use a financial year like
   2024-25"; `turnover:-1` → "Turnover cannot be negative"; `turnover:1.5` → "Whole rupees only"; net worth may be
   negative.
9. **Given** only FY 2025-26 entered, **Then** the financials suggestion reads "Add turnover for 2024-25, 2023-24 so the
   3-year average is accurate." (severity warning) and the section contributes 4 of 12 points.
10. **Given** the demo org on 2026-11-05, **When** `/profile` opens, **Then** completeness is **96%**, the heading is
    "Almost there" and the suggestions are: "Add turnover for 2025-26 so the 3-year average is accurate.", "OEM
    authorisation from Dell Technologies has expired — request a fresh one." and ""OEM authorisation – Dell Technologies
    (desktops & servers)" in the vault has expired — upload the renewed copy.", followed by one info suggestion "Link the
    D-Link India authorisation letter from the vault so packets can attach it." (the demo's CP PLUS and Dell rows are linked
    to their vault letters; info suggestions do not change the 96%).
11. *(gap — FR-020)* **Given** an OEM authorisation in the profile valid till today + 20 days, **Then** an info suggestion
    "OEM authorisation from <OEM> expires in 20 days — ask for a renewed MAF." appears (no score change); and for an OEM
    row with no linked vault document, an info suggestion "Link the <OEM> authorisation letter from the vault so packets can
    attach it." appears.

---

### User Story 3 - Store, find, preview and manage bid documents in a private vault (Priority: P1) (#116)

An Analyst uploads certificates (PDF, PNG or JPG up to 20 MB) via the **Upload document** button, the onboarding tiles,
the "Commonly asked for" chips, `?upload=1`, or by dropping a file anywhere on `/vault`. TenderPilot guesses type, title
and financial year from the file name, sniffs the real file type from its bytes, counts PDF pages, stores the file
privately under `org/<orgId>/vault/<docId>/<file>` and shows it with a validity badge. Members browse by grid or list,
search, filter by category/type/status, sort, open a preview drawer, download, edit metadata, replace the file or delete.

**Why this priority**: The vault is what makes TenderPilot "upload once, reuse on every tender"; the checklist auto-match
and packet builder cannot work without it.

**Independent Test**: In a fresh org, drop `GST_REG06_2023.pdf` (2 pages) on `/vault`; the dialog preselects "GST
registration" and title "GST REG06 2023"; click **Upload document**; the card shows "Valid"/"No expiry" and "PDF · 2p";
open it, click **Download**, and verify the bytes equal the original.

**Acceptance Scenarios**:

1. **Given** a fresh org, **When** `/vault` opens, **Then** the onboarding card "Build your bid-ready vault once, reuse it
   on every tender" lists the 10 "Documents most GeM bids ask for" (GST registration, PAN card, Udyam (MSE) certificate,
   Audited balance sheet, CA turnover certificate, OEM authorisation, CRAC / completion certificate, Work / purchase
   order, ISO certificate, Make in India declaration); clicking a tile opens **Add a document** with that type preset.
2. **Given** **Add a document** open, **When** the user picks `BS_FY2024-25.pdf`, **Then** type "Audited balance sheet",
   title "BS FY2024-25" and Financial year "FY 2024-25" are pre-filled; **When** they pick `ISO_9001_cert.pdf` and set
   Issue date 2026-01-10 with no expiry, **Then** a hint "ISO certificates are typically valid for 3 years." with
   **Use 09 Jan 2029** appears and fills Expiry date 2029-01-09 when clicked.
3. **Given** a valid PDF with no expiry, **When** uploaded, **Then** `POST /api/vault` returns **201** `VaultDocumentDto`
   with `status: "valid"`, `daysToExpiry: null`, `pageCount` = actual pages, `mimeType: "application/pdf"`,
   `downloadUrl: "/api/vault/<id>/download"`; the toast reads "“<title>” added to the vault" with description "<n> pages ·
   stored privately"; the drawer opens on the new document; `activity_log` has `vault.uploaded`.
4. **Given** an ISO certificate PNG with expiry today + 10 days, **When** uploaded, **Then** `status: "expiring"`,
   `daysToExpiry: 10`, the badge reads "Expires in 10d" (amber) and the toast description reads "It expires in 10 days —
   we’ll remind you."; an expiry of yesterday gives "Expired 1d ago" (red) and "Heads up: this document has already
   expired.".
5. **Given** a text file renamed `a.pdf`, **When** uploaded, **Then** **415** `unsupported_media_type` "Only PDF, PNG and
   JPG files can be stored in the vault." shown under the file; `%PDF-1.7 garbage` → **422** `unreadable_pdf` "This PDF
   looks damaged and could not be opened. Re-export or re-scan it and try again."; a 20 MB + 10 byte file → **413**
   `payload_too_large` "Files can be at most 20 MB. Compress the scan or split it and try again."; a form without `file`
   → **400** `validation_error` (`details.fields.file` "Choose a PDF, PNG or JPG file"); a 0-byte file → **400** "The file
   is empty"; issue 2025-01-01 with expiry 2024-01-01 → **400** with `details.fields.expiryDate` "Expiry date is before
   the issue date". In every failure case no row and no blob is stored.
6. **Given** a 25 MB file chosen in the dropzone, **Then** the dialog shows "<name> is larger than 20 MB." without
   uploading; *(gap — FR-033)* the same check applies to files dropped on the page and chosen with **Change**.
7. **Given** the demo org, **When** `/vault` opens, **Then** tiles show All documents **15**, Valid **12**, Expiring soon **2**
   ("Within 30 days") and Expired **1** ("Renew to keep bidding"); "Expiring in the next 90 days" shows markers for the ISO
   certificate (10 days), the CA certificate (25 days) and the expired Dell authorisation; clicking the "Expired" tile adds
   `?status=expired` and lists exactly the Dell authorisation; clicking it again clears the filter.
8. **Given** the demo org, **When** the user types `dell` in "Search title, number, issuer, tag…", **Then** after ≤ 250 ms
   the URL has `?q=dell` and only documents whose title, number, issuer, file name or tags contain "dell"
   (case-insensitive) are listed with "1 of 15 documents · Clear filters"; category **Financial** + type "Audited balance
   sheet" lists the 3 balance sheets; sort "Expiring first" lists documents by days to expiry ascending with non-expiring
   documents last; "Title A–Z" sorts alphabetically; the grid/list choice persists across reloads.
9. **Given** filters that match nothing, **Then** the empty state "No documents match" with "Try a different search or
   clear the filters." and **Clear filters** is shown (for status Expired: "Nothing has expired. Nice.").
10. **Given** a document card, **When** opened, **Then** the drawer (URL `?doc=<id>`) shows an inline preview (PDF in an
    iframe, images as `<img>` with alt "Scan of <title>"), Number, Issued by, Issue date, Expiry date ("Does not expire"
    when empty), Tags, File ("<name> · <size> · <n> pages") and "Uploaded <relative> by <name>"; **Download** returns the
    file with `content-disposition: attachment`, **Open** opens it inline in a new tab (`?inline=1`); both carry
    `cache-control: private, no-store` and `x-content-type-options: nosniff`.
11. **Given** **Edit details**, **When** the user changes the expiry date and clicks **Save changes**, **Then**
    `PATCH /api/vault/:id` returns **200**, the toast "Document updated" appears, the badge updates, and if the expiry date
    changed `last_reminder_days` is reset to null (the 30/7/1 cycle restarts).
12. **Given** **Replace file** with a new PDF, **Then** `PUT /api/vault/:id/file` returns **200** with the new file name,
    size and page count, metadata unchanged; the toast "File replaced" has description "Metadata kept. Update the expiry
    date if this is a renewed copy."; the old blob is deleted when its key differs; `activity_log` has
    `vault.file_replaced`.
13. **Given** the delete (trash) button, **When** the user confirms "Delete “<title>”?" with **Delete document**, **Then**
    `DELETE /api/vault/:id` returns **200** `{ok:true}`, the row and blob are removed, any past contract whose CRAC pointed
    to it is unlinked, the toast "“<title>” deleted" appears and the drawer closes; *(gap — FR-041)* any OEM
    authorisation in the profile linked to it is unlinked too.
14. **Given** a Viewer, **Then** **Upload document**, **Replace file**, **Edit details**, delete, the "Commonly asked for"
    strip and drag-and-drop are absent/inactive and onboarding tiles are disabled, while **Download**/**Open** work;
    `POST /api/vault`, `PATCH`, `PUT …/file` and `DELETE` return **403** `forbidden`.
15. **Given** org B's document id, **When** a member of org A calls `GET /api/vault/<id>`, `…/download`, `PATCH`, `PUT …/file`
    or `DELETE`, **Then** **404** `not_found` "Document not found"; a malformed id also answers **404**; unauthenticated
    calls answer **401**.
16. *(gap — FR-040)* **Given** `/vault?doc=<id of a deleted document>`, **When** the page loads, **Then** the toast "That
    document could not be found. It may have been deleted." appears and `doc` is removed from the URL.

---

### User Story 4 - Know what is expiring and get reminded 30, 7 and 1 day before (Priority: P1) (#117)

Every vault document with an expiry date is classified as **Valid**, **Expiring soon** (0–30 days left, still valid on
its expiry date) or **Expired** (expiry before today, IST). On every scheduler tick (every 30 minutes) TenderPilot sends
each member who has "Expiry reminders" on an in-app notification and, if email is on, an email, when a document crosses
30, 7 or 1 day before expiry, and once when it has expired (only within 30 days of expiry). Reminders never repeat for the
same threshold and expiry date; changing the expiry date restarts the cycle.

**Why this priority**: An expired ISO certificate or OEM authorisation discovered on bid day is the classic way MSMEs
lose eligible bids; reminders are a key reason to keep using the product.

**Independent Test**: In a fresh org with default notification preferences, upload an ISO certificate expiring today +
10 days, trigger reminders (scheduler tick, or *(gap)* `POST /api/vault/reminders/run`), and verify the bell shows
"<title> expires in 10 days" linking to `/vault?doc=<id>`; trigger again and verify no duplicate.

**Acceptance Scenarios**:

1. **Given** documents expiring in 45, 30, 10, 0 and −1 days, **Then** their statuses/badges are Valid / "Valid",
   Expiring / "Expires in 30d", Expiring / "Expires in 10d", Expiring / "Expires today", Expired / "Expired 1d ago"; a
   document without an expiry date is Valid / "No expiry".
2. **Given** an org with Owner, Bid Manager, Analyst (email off) and Viewer (expiry reminders off) and an ISO certificate
   expiring in 10 days, **When** reminders run, **Then** exactly 5 notifications are created: in-app (`status: sent`) and
   email (`status: pending`) for Owner and Bid Manager, in-app only for Analyst, none for Viewer; the in-app title is
   "<title> expires in 10 days", the email title is "[<Org name>] <title> expires in 10 days", the body reads "Your ISO
   certificate "<title>" expires in 10 days (on <YYYY-MM-DD>). Renew it and upload the new copy to the vault so your bids
   stay compliant.", the link is `/vault?doc=<id>`, and `vault_documents.last_reminder_days` = 30.
3. **Given** reminders already sent for threshold 30, **When** they run again the same day, **Then** the report is
   `{documents: 0, notifications: 0}` (idempotent via `last_reminder_days` and dedupe key
   `expiry:<docId>:<expiryDate>:<threshold>`).
4. **Given** 4 days later (6 days left), **When** reminders run, **Then** the 7-day reminder "… expires in 6 days" is sent
   once; a document uploaded with 5 days left gets the 7-day reminder only, never the 30-day one.
5. **Given** the document expired yesterday and the last reminder was 7 or 1, **When** reminders run, **Then** one
   "<title> has expired" reminder is sent with body "Your <type> "<title>" expired 1 day ago. Bids that need it will be
   blocked from "Ready to submit" until you upload the renewed copy." and `last_reminder_days` = 0; a document that expired
   more than 30 days ago gets no reminder.
6. **Given** a sent reminder, **When** the user edits the expiry date to a later date, **Then** `last_reminder_days`
   becomes null and the next crossing sends a new reminder with a new dedupe key.
7. **Given** a reminder in the bell, **When** clicked, **Then** `/vault?doc=<id>` opens the drawer for that document even
   if it is not in the current filtered list.
8. **Given** the dashboard, **Then** the "Expiring documents" tile counts documents expired or expiring within 30 days
   (demo org: **3**) and links to the vault.
9. *(gap — FR-052)* **Given** a Bid Manager on `/vault`, **When** they choose **Send reminders now** (page header overflow
   menu), **Then** `POST /api/vault/reminders/run` runs the reminder job for their org only and returns **200**
   `{documents, notifications}`; the toast reads "Reminders sent for <n> document(s)" or "No reminders due"; an Analyst gets
   **403**; calling it twice the same day creates no duplicates.
10. *(gap — FR-053)* **Given** the drawer of an expiring or expired document, **Then** the line "Next reminder: 7 days
    before expiry (<date>)" or "All reminders sent" is shown under the expiry date.

---

### User Story 5 - Record past contracts with CRACs and OEM authorisations (Priority: P2) (#118)

In the Experience section, an Analyst records completed orders (buyer, buyer type, work/supply, category, value,
start/completion dates, GeM contract number) and links the CRAC / completion certificate from the vault; they are saved
immediately through their own endpoints. In OEM authorisations, they list manufacturer authorisations (OEM, products
covered, valid till) and link the MAF from the vault; these are saved with the profile.

**Why this priority**: Experience and OEM-authorisation criteria appear in most GeM product bids, but the profile and
vault already deliver value without them.

**Independent Test**: In a fresh org, upload a CRAC PDF, add a contract "Supply of 85 desktop computers" for "Central
Railway, Mumbai Division" worth ₹58,20,000 linked to that CRAC, and verify the table shows "Linked" and `GET
/api/past-contracts` returns `cracDocumentId` = the upload's id.

**Acceptance Scenarios**:

1. **Given** no contracts, **Then** the Experience section shows "No past contracts yet" — "Add completed orders with their
   values — they’re matched against each bid’s experience criteria." with **Add contract**.
2. **Given** **Add a past contract**, **When** the user submits it empty, **Then** errors "Buyer is required", "Describe the
   work or supply" and "Contract value must be more than ₹0" appear without a request; completion before start shows "End
   date is before the start date".
3. **Given** a valid contract, **When** saved, **Then** `POST /api/past-contracts` returns **201** `PastContractDto`, the
   toast "Contract added" — "Experience criteria will use it on the next analysis." appears, the summary line reads "1
   contract · total ₹58.2 L · largest ₹58.2 L", and the profile completeness rises (each of the first 3 contracts adds
   ~3.3 of 10 experience points).
4. **Given** the CRAC picker, **Then** it lists only vault documents of category Experience (CRAC / completion certificate,
   Work / purchase order) plus "Not linked"; rows show a green "Linked" or amber "No CRAC" badge (hidden on phones).
5. **Given** the API, **When** `cracDocumentId` is another org's document or a random UUID, **Then** **400**
   `validation_error` with `details.fields.cracDocumentId` "That document is not in your vault"; `PATCH` with only
   `endDate` earlier than the stored `startDate` → **400** "End date is before the start date"; `PATCH`/`DELETE` of another
   org's contract → **404** "Past contract not found".
6. **Given** a contract row, **When** **Delete** is confirmed in "Delete this contract?" ("“<title>” for <buyer> will no
   longer count towards experience criteria."), **Then** `DELETE /api/past-contracts/:id` returns **200**, toast "Contract
   deleted"; `activity_log` has `profile.past_contract_added/updated/deleted` for the lifecycle.
7. **Given** contracts listed, **Then** they are ordered by completion date (newest first), then creation date.
8. **Given** the OEM section empty, **Then** it reads "Reselling branded products? Add each manufacturer authorisation —
   bids for OEM items usually require a valid MAF." with **Add OEM authorisation**; a row has OEM (required, "OEM name is
   required"), Products covered, Valid till (with an expiry badge) and Vault document (lists only `oem_authorization`
   documents); rows save with **Save profile**.
9. *(gap — FR-061)* **Given** the API, **When** `PUT /api/profile` sets `oemAuthorizations[0].documentId` to a document
   that is not in the org's vault or is not of type `oem_authorization`, **Then** **400** `validation_error` with
   `details.fields["oemAuthorizations.0.documentId"]` "Pick an OEM authorisation from your vault".
10. *(gap — FR-062)* **Given** the CRAC picker in the contract dialog, **When** the user chooses **Upload a new CRAC…**,
    **Then** the vault upload dialog opens with type "CRAC / completion certificate" preset and, after upload, the new
    document is selected in the picker without losing the contract draft.
11. *(gap — FR-063)* **Given** an OEM row with a linked vault document that has an expiry date and an empty Valid till,
    **Then** Valid till shows the document's expiry as a placeholder with **Use document expiry**, so the profile and vault
    do not disagree.

---

### User Story 6 - Renew a document in one step and keep its history (Priority: P3) *(gap)* (#119)

When a renewed certificate arrives, the Analyst clicks **Renew** on the document, picks the new file and confirms the new
issue/expiry dates (pre-filled with the suggested validity) in one dialog. The previous file is kept as a version that can
still be downloaded, reminders restart for the new expiry, and re-uploading a file that is already in the vault is caught.

**Why this priority**: Today "Replace file" keeps the old expiry and silently discards the old file; users must remember to
edit the date separately. Valuable hardening, but the P1 flows already work.

**Independent Test**: With an ISO certificate expiring in 10 days, click **Renew**, choose a new PDF, accept the suggested
expiry (issue date + 36 months − 1 day), save; the badge turns "Valid", the drawer's "Versions" lists the old file, and no
further 7/1-day reminders arrive for the old expiry.

**Acceptance Scenarios**:

1. **Given** a document in the drawer, **When** the Analyst clicks **Renew**, **Then** a dialog "Renew “<title>”" shows a
   file picker, Issue date (default today), Expiry date (pre-filled with `suggestExpiry(type, issueDate)` when the type
   expires) and Number; **Renew document** sends `PUT /api/vault/:id/file` with the file and those fields.
2. **Given** a renewal with a new expiry, **Then** the response is **200**, metadata is updated, `last_reminder_days` is
   null, the toast reads "“<title>” renewed — valid till <date>", and `activity_log` has `vault.renewed` with old and new
   expiry dates.
3. **Given** a renewed document, **When** the drawer opens, **Then** a "Versions" list shows the previous file(s) ("<file
   name> · <size> · replaced <relative> by <name>", newest first, max 5 kept) each with **Download**
   (`GET /api/vault/:id/versions/:versionId/download`); older versions beyond 5 are purged with their blobs.
4. **Given** a file whose SHA-256 equals an existing document's in the same org, **When** uploaded, **Then** the API returns
   **409** `duplicate_document` with `details: {existingId, title}` and the dialog shows "This file is already in your vault
   as “<title>”." with **Open existing** and **Upload anyway** (re-sends with `allowDuplicate=1` → **201**).
5. **Given** a Viewer, **Then** **Renew** is absent and version downloads still work; another org's version id → **404**.

---

### Edge Cases

- **Expiry on the boundary**: a document is still Valid/Expiring on its expiry date (`daysToExpiry: 0`, "Expires today")
  and Expired from the next IST day; "today" is computed in IST even when the server runs in UTC (e.g. 2026-11-05T20:00Z is
  already 2026-11-06 IST).
- **Reminder skipped thresholds**: if the scheduler was down across the 7-day threshold and resumes with 1 day left, only
  the 1-day reminder is sent (smallest crossed threshold), never a burst of three.
- **Expiry moved earlier**: editing expiry from +40 to +3 days resets the cycle and sends the 7-day reminder on the next tick.
- **Document without expiry but type usually expires** (ISO, OEM, BIS, DPIIT, PoA, test report, EMD exemption): status is
  Valid and the form hints "This type usually expires — add the date to get reminders 30, 7 and 1 day before."
- **Uploads that lie about their type**: the content-type and extension sent by the browser are ignored; magic bytes decide
  (`%PDF` within the first 1 KB, PNG signature, JPEG `FF D8 FF`). The stored file name is sanitised (no path separators,
  ≤ 120 chars + correct extension); non-ASCII names are served with RFC 5987 `filename*`.
- **Encrypted PDFs** open with `ignoreEncryption` so pages are counted; damaged PDFs are rejected with 422.
- **Blob written but DB insert fails**: the blob is deleted (best effort) so no orphan files remain; on delete, a failing
  blob delete is logged and the row is still removed.
- **Replace with a different type** (PDF → PNG): the blob key changes and the old blob is deleted; `mimeType` and
  `pageCount` (1 for images) are updated.
- **Profile row missing**: `GET /api/profile` returns an empty DTO (`legalName: ""`, empty arrays, `updatedAt: null`);
  the first `PUT` inserts.
- **GSTIN whose state code is not an Indian state option** (97 Other Territory, 99 Centre Jurisdiction): the hint shows the
  state name but **Fill from GSTIN** does not set State.
- **FY labels**: "2024-25", "FY 2024-25", "FY24-25", "2024-2025" and "2024/25" are accepted and normalised to "2024-25";
  "2024-26" is rejected. The last 3 *completed* FYs are computed from today in IST (in Nov 2026: 2025-26, 2024-25, 2023-24).
- **Average turnover** ignores rows with unparseable FY or negative turnover, de-duplicates by FY and uses at most the
  latest 3 FYs with figures (not necessarily consecutive).
- **Deleting a document linked from a past contract** unlinks it (contract shows "No CRAC"); *(gap)* the same must happen
  for OEM authorisations in the profile.
- **Large vaults**: list is capped at 2,000 rows per request; search escapes `%`, `_` and `\`.
- **Concurrent profile edits**: last write wins today; *(gap)* FR-014 adds a 409.
- **Session expiry while the profile has unsaved edits**: the save returns 401; the draft remains in the page so the user
  can sign in in another tab and retry (no data loss).

## Requirements *(mandatory)*

### Functional Requirements

**Company profile (US1)**

- **FR-001**: System MUST store one company profile per organisation (`company_profiles`, PK `org_id`) with: legal name,
  trade name, GSTIN, PAN, CIN, Udyam number, MSE category (micro/small/medium), MSE owner category (general/sc_st/women),
  is-startup, DPIIT number, MII class (class_1/class_2/non_local), local content %, incorporation date, address, state,
  PIN code, contact name/email/phone, signatory name/designation, financials, categories, HSN/SAC codes, operating states,
  OEM authorisations, certifications and maximum EMD capacity.
- **FR-002**: `GET /api/profile` (viewer+) MUST return `{ profile, completeness, issues, averageTurnover }`; an org without a
  profile row gets an empty profile with `updatedAt: null`.
- **FR-003**: `PUT /api/profile` (analyst+) MUST validate with the shared `profileInputSchema`, treat omitted keys as
  "keep stored value", upsert, log `profile.updated` with the changed keys, and return the same shape as `GET`.
- **FR-004**: Identifiers MUST be normalised (trim, upper-case, remove spaces) and validated: GSTIN (15 chars, format, state
  code 01–38/97/99, embedded PAN valid, mod-36 check character), PAN (10 chars, `AAAAA9999A`, 4th character a valid holder
  type), Udyam (`UDYAM-XX-00-0000000`), CIN (21 chars, L/U + industry + state + year 1850…next year + type + 6 digits),
  DPIIT (`DIPP`/`DPIIT` + 3–8 digits, lenient), PIN code (6 digits, not starting with 0). Every validator MUST return a
  plain-English message; *(gap)* example values quoted in messages, placeholders and hints MUST themselves be valid (GSTIN
  example `27AAPCS1234K1Z2`, not `27AAPCS1234K1Z5`).
- **FR-005**: System MUST reject a GSTIN whose characters 3–12 differ from the PAN, checking the incoming values and,
  when only one of them is sent, the stored other value; the error is attached to the field that was sent.
- **FR-006**: Contact email MUST be a valid, lower-cased email ≤ 254 chars; contact phone MUST be normalised to E.164
  `+91XXXXXXXXXX` from inputs like `98123 45678`, `+91 98123-45678`, `09812345678`, `919812345678`.
- **FR-007**: MII local content MUST be 0–100 and consistent with the class (Class-I ≥ 50, Class-II 20 to < 50).
- **FR-008**: HSN/SAC codes MUST be 4, 6 or 8 digits; lists are capped (categories 100, HSN 200, states 40, OEM 100,
  certifications 50, financial years 30); text fields have the length limits in `contracts/vault.ts`.
- **FR-009**: The profile page MUST validate in the browser with the same schema and show errors only after the field is
  blurred, edited (for list fields) or a save was attempted; server field errors MUST be mapped back to inputs.
- **FR-010**: The page MUST offer **Fill from GSTIN** when the GSTIN is valid and PAN or State is empty, filling only empty
  fields.
- **FR-011**: The page MUST show a floating "Unsaved changes" bar with **Discard**/**Save**, disable **Save profile** when
  nothing changed, and warn on tab close/reload with unsaved changes.
- **FR-012**: Viewers MUST see the profile read-only with the view-only banner; all profile and past-contract write
  endpoints MUST require analyst+.
- **FR-013** *(gap)*: In-app navigation away from `/profile` with unsaved changes MUST ask "Discard unsaved changes?"
  (**Stay** / **Discard and leave**).
- **FR-014** *(gap)*: `PUT /api/profile` MUST accept an optional `expectedUpdatedAt`; when it is present and differs from the
  stored `updated_at`, respond **409** `conflict` "Someone else saved the profile at <time IST>. Reload to see their
  changes." The web app MUST send it on every save.
- **FR-015** *(gap)*: The Udyam validator MUST also check the 2-letter state code against the list of Indian state/UT
  codes and explain "\"XX\" is not a valid state code in a Udyam number"; the CIN year check MUST use an injectable "now"
  so it is deterministic in tests.

**Completeness & financials (US2)**

- **FR-016**: Completeness MUST be a weighted score (rounded %) computed by `profileCompleteness()` in `@tp/core`, used by
  both the API and the browser: identity — legal name 8, GSTIN 10, PAN 8, address/state/PIN 5 (partial), incorporation
  date 3; registrations — Udyam+MSE category 6 (only if either is set), DPIIT number 4 (only if startup), MII class 6;
  financials — last 3 completed FYs 12 (partial), any net worth 2; experience — past contracts 10 (partial, 3 = full);
  categories 6, HSN 3, operating states 3; signatory name+designation 5 (partial), email+phone 4 (partial); vault — non-
  expired `gst` 5, `pan` 4, `ca_turnover_certificate` or `balance_sheet` 4, `udyam` 3 (only if Udyam set),
  `startup_dpiit` 3 (only if startup).
- **FR-017**: Each missing item MUST produce an issue `{field, section, message, severity}` (error / warning / info),
  sorted error → warning → info; expired OEM authorisations in the profile and expired vault documents MUST produce warnings
  without changing the weight total.
- **FR-018**: The completeness card MUST show the ring, the heading by band, up to 6 issues and "+N more suggestions";
  clicking an issue MUST scroll/focus the field or, for `vault.*` issues, open `/vault` with the upload dialog preset to
  the missing type (`vault.expired` → `/vault?status=expired`).
- **FR-019**: Financial years MUST be Indian FYs (April–March, IST) normalised to "YYYY-YY", unique per profile, with
  whole-rupee non-negative turnover, optional net worth (may be negative) and an "audited" flag; the average annual turnover
  MUST use the latest 3 FYs with figures and be returned as `averageTurnover {avg, years}`.
- **FR-020** *(gap)*: Completeness MUST add info issues (no weight) for OEM authorisations expiring within 30 days and for
  OEM authorisations without a linked vault document, with the messages in US2 scenario 11.

**Vault (US3)**

- **FR-021**: System MUST store vault files privately in blob storage (R2 in production, filesystem locally) under
  `org/<orgId>/vault/<docId>/<sanitised file name>` and serve them only through authorised, org-scoped routes.
- **FR-022**: `POST /api/vault` (analyst+, multipart) MUST accept a `file` plus optional `type`, `title`, `number`,
  `issuer`, `issueDate`, `expiryDate`, `financialYear`, `tags` (JSON array or comma list, ≤ 20 tags of ≤ 40 chars); missing
  type/title/FY MUST be guessed from the file name; it MUST return **201** `VaultDocumentDto`.
- **FR-023**: Uploads MUST be limited to 20 MB (413 `payload_too_large`, checked from `content-length` and actual size),
  MUST be non-empty (400), MUST be PDF/PNG/JPEG by magic bytes (415 `unsupported_media_type`), and PDFs MUST open
  (422 `unreadable_pdf`); `pageCount` is the PDF page count or 1 for images.
- **FR-024**: Metadata MUST validate: title 1–200 chars, number ≤ 100, issuer ≤ 200, ISO dates, expiry ≥ issue date, FY
  normalised, type from the catalog.
- **FR-025**: The document-type catalog (`DOC_TYPES`) MUST define, for each of the 20 types, label, icon, description,
  category (Statutory, Financial, Experience, OEM, Quality, Other), whether it expires, typical validity in months,
  per-FY flag, "common in bids" flag and filename keywords; unknown types fall back to "Other document".
- **FR-026**: `guessDocType(fileName)` MUST pick the type with the longest matching keyword (word-boundary match after
  replacing `_ - .` with spaces) or `other`; `guessFinancialYear` MUST recognise `2024-25`, `2024_25`, `2024-2025` and
  reject non-consecutive years; `suggestExpiry(type, issueDate)` MUST return issue date + typical validity − 1 day for
  expiring types.
- **FR-027**: `GET /api/vault` (viewer+) MUST support `type`, `status`, `category`, `q` (title/number/issuer/file name/tags,
  case-insensitive, wildcards escaped) and `sort` (`recent` default, `expiry`, `title`, `type`) and return `{items, total}`.
- **FR-028**: `GET /api/vault/summary` (viewer+) MUST return totals by status, counts by type, `nextExpiries` (documents
  with expiry from 30 days ago to 90 days ahead, soonest first, max 20) and `missingCommon` (common-in-bids types not in
  the vault).
- **FR-029**: `GET /api/vault/:id` (viewer+) MUST return the DTO including derived `status`, `daysToExpiry`, uploader
  `{id, name}` and `downloadUrl`.
- **FR-030**: `GET /api/vault/:id/download` (viewer+) MUST stream the file with the stored MIME type, `content-length`,
  `content-disposition` attachment (or inline with `?inline=1`) with ASCII `filename` and UTF-8 `filename*`,
  `cache-control: private, no-store` and `x-content-type-options: nosniff`.
- **FR-031**: `PATCH /api/vault/:id` (analyst+) MUST update metadata, re-check issue ≤ expiry against stored values, reset
  `last_reminder_days` when the expiry date changes, bump `updated_at` and log `vault.updated`.
- **FR-032**: `PUT /api/vault/:id/file` (analyst+) MUST replace the file with the same checks as upload, keep metadata,
  delete the old blob when the key changed and log `vault.file_replaced`.
- **FR-033**: `DELETE /api/vault/:id` (analyst+) MUST unlink past contracts' CRAC references, delete the row and the blob,
  and log `vault.deleted`. *(gap)* The web app MUST check the 20 MB limit on every file-selection path (dropzone, page
  drop, **Change**, **Replace file**) before uploading.
- **FR-034**: All vault queries MUST be scoped by `org_id`; ids from another org or malformed ids MUST answer 404.
- **FR-035**: The vault page MUST show: onboarding for an empty vault; 4 status tiles that toggle the status filter;
  the 90-day expiry timeline; the "Commonly asked for, not in your vault yet" chips (analyst+); search with 250 ms
  debounce; category segmented control; type and sort selects; grid/list toggle persisted in `localStorage`
  (`tp.vault.view`); filters reflected in the URL (`q`, `status`, `category`, `type`, `sort`).
- **FR-036**: Upload MUST be possible from the header button, onboarding tiles, missing-type chips, `?upload=1&uploadType=<type>`
  (consumed and removed from the URL) and page-level drag & drop (analyst+ only).
- **FR-037**: The upload dialog MUST pre-fill type/title/FY from the file name without overwriting values the user typed,
  offer a "typically valid for …" expiry suggestion, validate title and date order client-side and show server field
  errors inline.
- **FR-038**: The document drawer (`?doc=<id>`) MUST preview PDFs and images inline, show metadata, uploader and timestamps,
  an expired banner, and offer Download / Open (all roles) and Edit details / Replace file / Delete (analyst+).
- **FR-039**: Grid cards MUST show type icon (colour by category), title, type label, number, status badge, FY badge, up to
  2 tags, expiry or "Added <relative>" and "PDF · <n>p" / image type.
- **FR-040** *(gap)*: When `?doc=<id>` cannot be loaded (404), the page MUST show the toast "That document could not be
  found. It may have been deleted." and remove `doc` from the URL.
- **FR-041** *(gap)*: Deleting a vault document MUST also clear `documentId` from any profile OEM authorisation pointing
  to it, in the same request.

**Expiry & reminders (US4)**

- **FR-042**: `docStatus(expiryDate, now)` MUST return `valid` (no expiry or > 30 days), `expiring` (0–30 days) or
  `expired` (< 0 days) with `daysToExpiry` in whole IST calendar days.
- **FR-043**: `runExpiryReminders()` MUST run on every scheduler tick (Worker Cron `*/30 * * * *` and the Node in-process
  cron) after alerts, scanning only documents with an expiry date ≤ today + 30 days.
- **FR-044**: `reminderDue()` MUST return the smallest crossed threshold of 30/7/1, or 0 for documents expired within the
  last 30 days, and nothing when the last sent threshold is ≤ that threshold.
- **FR-045**: For each due document, System MUST create, per member whose `expiry_reminders` preference is on (default on),
  an in-app notification (`kind: expiry`, `status: sent`) if in-app is on, and a pending email (title prefixed with
  "[<Org name>]") if email is on, with dedupe key `expiry:<docId>:<expiryDate>:<threshold>` and link `/vault?doc=<id>`; then
  set `last_reminder_days`.
- **FR-046**: Reminder copy MUST use `reminderCopy()` ("expires in N days", "expires today", "expired N days ago",
  "expired today") and the bodies in US4 scenarios 2 and 5.
- **FR-047**: Email reminders MUST be delivered by the alerts dispatcher with the same retry/skip rules as other emails
  (missing `RESEND_API_KEY` → `skipped`).
- **FR-048**: The dashboard MUST count expired + expiring documents (`tiles.expiringDocs`) and list them
  (`expiringDocuments`) linking to the vault.
- **FR-049**: Re-running reminders MUST never create duplicates (idempotent per threshold and expiry date).
- **FR-050**: A reminder notification link MUST open the drawer even when the document is filtered out of the list.
- **FR-051**: Reminders MUST be org-isolated: a member only receives reminders for documents of orgs they belong to.
- **FR-052** *(gap)*: `POST /api/vault/reminders/run` (bid_manager+) MUST run `runExpiryReminders({orgId})` for the
  caller's org and return `{documents, notifications}`; the vault page MUST expose it as **Send reminders now**.
- **FR-053** *(gap)*: The drawer MUST show the next reminder date (or "All reminders sent") for documents with an expiry
  date, computed with `REMINDER_THRESHOLDS` and `last_reminder_days` (exposed as `nextReminder` on the DTO).

**Experience & OEM (US5)**

- **FR-054**: `GET/POST/PATCH/DELETE /api/past-contracts[/:id]` MUST manage org-scoped past contracts (buyer 1–200 chars,
  buyer type central/state/psu/private/other default central, title 1–300, category ≤ 120, value positive whole rupees,
  optional start/end dates with end ≥ start, GeM contract number ≤ 80, optional CRAC document id).
- **FR-055**: `cracDocumentId` MUST reference a document in the caller's vault (400 "That document is not in your
  vault" otherwise).
- **FR-056**: The list MUST be ordered by end date desc then created desc and return `{items, total}`.
- **FR-057**: Past-contract writes MUST log `profile.past_contract_added`, `…_updated` (with changed fields) and
  `…_deleted`.
- **FR-058**: The Experience section MUST show an empty state, a summary (count, total, largest in compact INR), a
  responsive table (Contract, Value, Period, Proof) with row click to edit (analyst+) and an actions menu (Edit, Delete
  with confirmation).
- **FR-059**: The contract dialog MUST validate client-side with `pastContractCreateSchema` and offer only Experience-
  category documents in the CRAC picker.
- **FR-060**: OEM authorisations MUST be stored in the profile (`oem`, `products`, `validTill`, `documentId`) with an expiry
  badge per row and a vault picker limited to `oem_authorization` documents; expired ones produce a completeness warning
  and are ignored by eligibility scoring.
- **FR-061** *(gap)*: `PUT /api/profile` MUST verify that each OEM `documentId` belongs to the org's vault and has type
  `oem_authorization` (400 `details.fields["oemAuthorizations.<i>.documentId"]` "Pick an OEM authorisation from your vault").
- **FR-062** *(gap)*: The CRAC picker MUST offer **Upload a new CRAC…** which opens the upload dialog (type preset `crac`) on
  top of the contract dialog and selects the uploaded document on success.
- **FR-063** *(gap)*: An OEM row linked to a vault document with an expiry date MUST offer **Use document expiry** when Valid
  till is empty or differs.

**Renewal & history (US6)** *(gap)*

- **FR-064** *(gap)*: `PUT /api/vault/:id/file` MUST accept optional `issueDate`, `expiryDate` and `number` fields; when
  `expiryDate` changes it MUST reset `last_reminder_days` and log `vault.renewed` `{fromExpiry, toExpiry}`.
- **FR-065** *(gap)*: Before replacing, System MUST record the previous file as a row in `vault_document_versions`
  (`id, org_id, document_id, blob_key, file_name, mime_type, size_bytes, page_count, expiry_date, replaced_by, replaced_at`)
  instead of deleting its blob; at most 5 versions per document are kept (oldest purged with blob); deleting the document
  deletes its versions and their blobs.
- **FR-066** *(gap)*: `GET /api/vault/:id/versions` (viewer+) and `GET /api/vault/:id/versions/:versionId/download` MUST be
  org-scoped (404 otherwise).
- **FR-067** *(gap)*: System MUST store `content_sha256` for each upload and reject an identical file in the same org with
  **409** `duplicate_document` `{existingId, title}` unless `allowDuplicate=1` is sent.
- **FR-068** *(gap)*: The drawer MUST offer **Renew** (analyst+) with the dialog in US6 scenario 1 and a "Versions" list.

### Non-Functional Requirements

- **NFR-001 (Tenant isolation)**: Every query on `company_profiles`, `past_contracts`, `vault_documents` (and the new
  `vault_document_versions`) MUST filter by `org_id`; blob keys are prefixed by org; API tests MUST prove cross-org 404 for
  every vault and past-contract route (Constitution IV).
- **NFR-002 (Privacy)**: Vault files MUST never be publicly addressable (no signed public URLs); downloads require a
  session or API token of an org member and are served `private, no-store`. Logs MUST NOT contain file contents, PAN or
  GSTIN values beyond what activity meta already records (type, title, file name).
- **NFR-003 (Performance)**: `GET /api/profile` p95 < 300 ms; `GET /api/vault` and `/vault/summary` p95 < 400 ms for an org
  with 500 documents; a 20 MB PDF upload completes server-side in < 5 s on Node and within Worker CPU limits (page count
  via `pdf-lib` with `updateMetadata:false`).
- **NFR-004 (Reminder job cost)**: The reminder job MUST only load documents with expiry ≤ today + 30 days and finish in
  < 10 s for 10,000 such documents.
- **NFR-005 (Accessibility)**: `/profile` and `/vault` MUST have no serious/critical axe-core violations; every input has a
  label; the MII choice is a `radiogroup` of `role="radio"` cards; the completeness ring has `role="img"` with "Profile N%
  complete"; status is never conveyed by colour alone (badges carry text); focus is visible; dialogs trap focus and
  return it on close; reduced motion disables smooth scrolling.
- **NFR-006 (Responsive)**: At 375 px both pages MUST have no horizontal page scroll; profile section nav becomes a sticky
  pill bar with a compact meter; the save bar sits above the bottom tab bar; vault tiles are 2×2, filters wrap, the drawer
  is full-width and tables collapse to cards (hidden columns: Number, FY, Added; Period, Proof).
- **NFR-007 (Determinism)**: Validators, status, reminder and completeness logic are pure functions in `@tp/core` with
  injected `now`; no LLM is used in this area (Constitution III).
- **NFR-008 (Test coverage)**: Each FR has a unit or API test; each user story has a Playwright E2E with evidence
  (screenshots, video, trace) in `qa/evidence/005/US<n>/` and a QA `VERDICT.md`.
- **NFR-009 (Traceability & licences)**: Code adapted from reference repos MUST be attributed in the root `NOTICE` and in a
  header comment; only Apache-2.0/MIT sources may be copied (Constitution VIII).
- **NFR-010 (Edge-native)**: The same code paths MUST run on the Cloudflare Worker (R2 blobs) and Node (filesystem blobs);
  no Node-only APIs in `apps/api/src/routes/vault.ts` (use Web Crypto for SHA-256).

## UX Specification

### Screens

| Screen | Route | Key elements |
|---|---|---|
| Company profile | `/profile` | Page header (title, description, "Saved <relative>" / "Not saved yet", **Save profile**); view-only banner (viewer); desktop left section nav (7 items with issue counts / error dot); 7 section cards; right completeness card (≥ 1280 px; under the nav at 1024–1279 px); floating "Unsaved changes" bar; footer link "Documents backing this profile live in the document vault." |
| Past contract dialog | `/profile` (modal) | "Add a past contract" / "Edit past contract"; Buyer / organisation*, Work / supply*, Buyer type, Contract value*, Start date, Completion date, Category, GeM contract no., CRAC / completion certificate picker; **Cancel** / **Add contract** or **Save contract**. |
| Document vault | `/vault` | Header with **Upload document**; onboarding (empty vault) or: 4 status tiles, "Expiring in the next 90 days" timeline, missing-common chips, toolbar (search, type, sort, grid/list), category segmented control + status chip, result count + **Clear filters**, grid or list. Full-page drop overlay "Drop to add to the vault". |
| Add a document | `/vault` (modal) | Dropzone or selected-file row with **Change**; type picker with description; Title*; Number (label varies by type, e.g. "GSTIN", "UDIN"); Issued by; Issue date; Expiry date with hint; validity suggestion; Financial year (per-FY types); Tags; "Private to your organisation"; **Cancel** / **Upload document**. |
| Document drawer | `/vault?doc=<id>` | Icon, title, type, badge, FY; expired banner; preview; metadata grid; uploader line; **Download**, **Open**, delete, **Replace file**, **Edit details**; edit mode with **Cancel** / **Save changes**. *(gap)* **Renew**, Versions list, next-reminder line. |

### States

- **Loading**: profile — skeleton of nav + 3 section cards + completeness card; past contracts — 3-row skeleton list;
  vault — tiles show skeleton values, grid shows 8 skeleton cards; drawer preview shows a skeleton until the iframe/img
  loads; list refetches keep previous results at 60% opacity.
- **Empty**: profile sections show inline prompts (OEM dashed panel, "No past contracts yet", "Add at least one year");
  vault shows onboarding; filtered vault shows "No documents match"; timeline shows "Nothing expires in the next 90 days.
  You’re bid-ready."
- **Error**: profile load failure — `ErrorState` with **Retry** under the header; past contracts — compact error with
  **Retry**; vault summary or list failure — `ErrorState` with **Retry**; mutations — toast with the API message and
  inline field errors from `details.fields`.
- **Success feedback**: toasts listed in the scenarios; save bar disappears; new upload opens its drawer.
- **Read-only**: viewer banner on profile; write controls hidden on vault and drawer.

### Responsive behaviour

- **Desktop ≥ 1280 px**: profile is 3 columns (13 rem nav · form · 19 rem completeness); vault grid 3–4 columns.
- **Tablet 768–1279 px**: profile nav column hidden below 1024 px (pill bar used); completeness card moves under the nav
  at 1024–1279 px; vault grid 2 columns.
- **Phone 375 px**: profile shows a sticky pill bar (compact ring + "N%" + horizontally scrollable section pills) under the
  top bar; form fields stack in one column; the save bar floats above the bottom tab bar (`bottom: 4.25rem + safe area`);
  dialogs become near-full-screen; vault tiles 2×2, toolbar stacks (search full width, selects wrap), category control
  scrolls horizontally, drawer full width, list view renders as cards with primary column + status + expiry.

### Accessibility

- Section nav and pills use `aria-current` for the active section; scroll-spy updates it.
- Inputs have visible labels, `required` markers, and errors linked via the `Field` component (`aria-invalid`,
  `aria-describedby`); toggle switches have explicit `aria-label`s ("We are a registered MSE", "We are a DPIIT-recognised
  startup"); "What is …?" help buttons have labels and tooltip content.
- Vault cards expose a full-card button "Open <title>"; timeline markers have `aria-label` "<title>, <status>"; the
  status tiles are toggle buttons with `aria-pressed`; drag overlay is `aria-hidden` (upload is always reachable by button).
- The upload error is announced with `role="alert"`; the expired banner uses `role="status"`.
- Keyboard: every action is reachable with Tab/Enter/Space; Esc closes dialogs and the drawer; "G" then "V"/"C" navigates
  to Vault / Company profile (shell shortcut).

### Key Entities *(include if feature involves data)*

- **CompanyProfile** (`company_profiles`): one per organisation; identity, registrations, contact, JSON lists
  (financials `{fy, turnover, netWorth?, audited?}`, categories, hsnCodes, operatingStates, oemAuthorizations
  `{oem, products, validTill?, documentId?}`, certifications), `max_emd_capacity`, `updated_at`.
- **PastContract** (`past_contracts`): org-scoped order with buyer, buyer type, title, category, value (₹), dates, GeM
  contract number and optional `crac_document_id` → VaultDocument.
- **VaultDocument** (`vault_documents`): org-scoped file + metadata (type, title, number, issuer, issue/expiry dates, FY,
  tags), blob key, file name, MIME, size, page count, uploader, `last_reminder_days`, timestamps; status is derived, never
  stored.
- **DocTypeInfo** (code catalog `DOC_TYPES`): 20 document types with category, expiry behaviour, typical validity, FY flag,
  common-in-bids flag and filename keywords.
- **Notification** (`notifications`, kind `expiry`) and **NotificationPrefs** (`expiry_reminders`, `in_app`, `email`):
  reminder output and per-member opt-outs (owned by 003/002).
- **VaultDocumentVersion** *(gap, new table `vault_document_versions`)*: previous files of a renewed document.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new Owner reaches ≥ 85% profile completeness ("Almost there") in under 15 minutes using only the profile
  page and vault upload (measured in moderated tests with the demo company's data).
- **SC-002**: 100% of invalid GSTIN/PAN/Udyam/CIN/PIN inputs in the validator test corpus are rejected with a field-level
  message, and 0 valid identifiers in the corpus are rejected.
- **SC-003**: 100% of documents crossing a 30/7/1-day threshold receive exactly one reminder per opted-in member within one
  scheduler cycle (≤ 30 minutes); 0 duplicates across 3 consecutive runs.
- **SC-004**: Uploading a 5 MB PDF and seeing it in the vault with correct type and status takes under 10 seconds end to
  end on a 10 Mbps connection.
- **SC-005**: 0 cross-tenant reads: every vault, version and past-contract route returns 404 for another org's id in the
  API test suite.
- **SC-006**: All 6 user-story E2E suites pass on desktop and 375 px with evidence attached, and axe reports 0
  serious/critical violations on `/profile` and `/vault`.
- **SC-007**: At least 80% of uploads in a sample of 50 realistic Indian bid-document file names get the correct type
  guessed (catalog keywords).

## Assumptions

- Roles, sessions, notification preferences, the scheduler and the notification dispatcher are provided by 002
  (platform & tenancy) and 003 (alerts); this spec only owns the reminder job and its copy.
- Users sign bids on GeM themselves; the profile is used for scoring and pre-filled annexures only (Constitution I) — no
  verification against GSTN/Udyam/MCA web services is performed (formats and checksums only).
- One profile per organisation (one bidding entity); groups with several GSTINs create one org per entity.
- Files are limited to PDF, PNG and JPEG; Word/Excel originals must be exported to PDF by the user.
- Document validity (e.g. "ISO valid 3 years") suggestions are hints; the date printed on the certificate is authoritative.
- Indian FY (April–March) and IST calendar days are used everywhere; currency is whole rupees.
- Vault storage quotas per plan are out of scope for this spec (owned by billing, if introduced).
- Reference repositories contain little profile/vault code; the only copy candidate is erenmyeager15 (Apache-2.0) GeM
  "Document required from seller" vocabulary for filename keywords (see plan.md); unlicensed repos are ideas only.
