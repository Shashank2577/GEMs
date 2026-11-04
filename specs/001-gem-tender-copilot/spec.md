# Feature Specification: TenderPilot — GeM Tender Co-Pilot

**Feature Branch**: `claude/gem-tender-automation-om9hyj`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: "GeM (Government e-Marketplace) tender automation. Identify: monitor GeM
BidPlus across the client's categories, HSN codes, states and ministries and alert instantly via
WhatsApp, email or dashboard. Analyse: parse bid PDFs, ATC, corrigenda and BOQs; compare against the
company profile (turnover, past experience, EMD limits, MSME/Startup exemptions, Make in India
Class-I/II) and output a weighted Go/No-Go score and a required-documents checklist. Apply
(co-pilot): a document vault that fetches matching certificates (GST, PAN, balance sheets, OEM
authorisations, past CRACs), generates undertakings/annexures, flags expired certificates and compiles
the merged PDF packet for technical upload; an optional browser extension pre-fills form fields while
price entry and OTP/DSC authentication stay with a human. Sellable, top-notch UX for every persona."

## Personas

- **Owner / Director (MSME promoter)** — signs bids, wants a weekly view of pipeline value, win odds
  and what needs their signature. Uses a phone more than a laptop.
- **Bid Manager** — runs the bid desk: triages alerts, decides Go/No-Go, assigns work, assembles packets.
- **Bid Analyst / Executive** — reads tender documents, fills the eligibility checklist, prepares
  annexures and uploads documents.
- **Compliance / Accounts** — keeps certificates, financials and authorisations current in the vault.
- **Viewer (sales, OEM partner, consultant)** — read-only access to tenders and packets.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover matching GeM bids and get alerted (Priority: P1)

A Bid Manager saves "watchlists" (keywords, categories, HSN codes, states, ministries/organisations,
value range, closing-within). The system regularly ingests new public bids from GeM BidPlus,
matches them against every watchlist, and shows a live feed of matched tenders with key facts
(bid number, item, ministry/department, quantity, start/end date, EMD, estimated value when known).
Matches trigger alerts on the channels each user chose (in-app, email, WhatsApp) — instantly or as
a daily digest.

**Why this priority**: Finding the right bid before it closes is the first value a seller pays for;
everything else depends on tenders being in the system.

**Independent Test**: Seed a company and a watchlist, run an ingestion against a recorded BidPlus
response, and verify the matching tenders appear in the feed with match reasons and an alert record.

**Acceptance Scenarios**:

1. **Given** a watchlist for "laptop" in Maharashtra, **When** ingestion finds a laptop bid from a
   Maharashtra buyer, **Then** the tender appears in the feed tagged with that watchlist and the
   reasons it matched, and an in-app notification is created.
2. **Given** the same bid is ingested twice, **When** the second ingestion runs, **Then** no duplicate
   tender or alert is created.
3. **Given** a user opted into email and WhatsApp alerts, **When** a match is found, **Then** an alert is
   queued for each channel and its delivery status is visible.
4. **Given** a corrigendum extends a bid's end date, **When** it is ingested, **Then** the tender shows the
   new date and the change is recorded in its history.
5. **Given** the feed, **When** the user filters by state, ministry, closing date or status, or searches
   free text, **Then** results update immediately and can be saved as a watchlist.

---

### User Story 2 - Analyse a tender and get a Go/No-Go score (Priority: P1)

The Bid Analyst opens a tender. The system parses the bid document, ATC, corrigenda and BOQ (from the
GeM document link or an uploaded PDF) and extracts eligibility requirements: minimum average
turnover, years of past experience, similar-work value, OEM authorisation, EMD amount and exemption
rules, ePBG, Make in India local-content class, MSE/Startup preferences, required certificates and
delivery period. It compares them with the company profile and produces a weighted Go/No-Go score
(0–100) with a verdict (Go / Review / No-Go), every factor's pass/fail/unknown status, the evidence
quote and page, and a checklist of documents required for this bid.

**Why this priority**: Qualifying a bid by hand takes hours of reading; a trusted score is the core
differentiator.

**Independent Test**: Upload a sample bid PDF for a seeded company and verify the extracted
requirements, the score, the verdict and the document checklist.

**Acceptance Scenarios**:

1. **Given** a bid requiring ₹50 lakh average turnover and a company with ₹2 crore, **When** analysed,
   **Then** the turnover factor passes and cites the bid text and page.
2. **Given** a bid with EMD and a company registered as MSE with a valid Udyam certificate, **When**
   analysed, **Then** the EMD factor shows "Exempt (MSE)" and the checklist asks for the Udyam certificate.
3. **Given** a bid that requires 3 years' experience and a company with 1 year, **When** analysed,
   **Then** the verdict is No-Go and the blocking factor is highlighted.
4. **Given** no LLM key is configured, **When** a bid is analysed, **Then** the deterministic rules still
   extract the standard GeM fields and produce a score, labelled "rules only".
5. **Given** a requirement the system could not determine, **Then** it is shown as "Unknown — needs
   review" and lowers confidence rather than silently passing or failing.

---

### User Story 3 - Company profile and document vault with expiry tracking (Priority: P1)

Compliance maintains the company profile (legal name, GSTIN, PAN, Udyam/MSE status and category,
Startup (DPIIT) status, Make in India class, turnover per financial year, net worth, past
contracts/CRACs with values, OEM authorisations, product categories) and uploads documents into a
vault. Each document has a type, number, issue date, expiry date and tags. The vault flags expiring
(within 30 days) and expired documents and sends reminders.

**Why this priority**: The score and the packet both depend on accurate profile and documents.

**Independent Test**: Create a profile, upload documents with different expiry dates, and verify
statuses, reminders and that the profile feeds the score.

**Acceptance Scenarios**:

1. **Given** a GST certificate uploaded with no expiry, **Then** it is "Valid".
2. **Given** an ISO certificate expiring in 10 days, **Then** it is "Expiring soon" and the dashboard and
   a reminder alert surface it.
3. **Given** an invalid GSTIN or PAN format, **When** saved, **Then** the form explains the error inline.
4. **Given** a Viewer, **When** they try to upload or delete a document, **Then** they are refused.

---

### User Story 4 - Assemble the bid packet (Priority: P2)

From an analysed tender, the Bid Manager opens the Bid Workspace. The system maps the checklist to vault
documents automatically, flags missing or expired ones, generates the standard undertakings and annexures
(e.g. declaration of non-blacklisting, MII local-content self-certificate, MSE declaration, OEM
authorisation request, EMD exemption declaration, technical compliance sheet) from templates filled
with company and tender data, lets the user reorder pages, and compiles one merged, bookmarked PDF
packet for technical upload, with a cover index. The workspace tracks status (Identified → Analysing →
Go → Preparing → Ready to submit → Submitted → Won/Lost) and assigned owners.

**Why this priority**: This is the hours-saving "apply" step; it builds on stories 2 and 3.

**Independent Test**: For an analysed tender with vault documents, generate the packet and verify the
merged PDF contains the index, generated annexures and selected documents in order.

**Acceptance Scenarios**:

1. **Given** a checklist item "GST certificate" and a valid GST document in the vault, **Then** it is
   auto-matched.
2. **Given** an expired required document, **Then** packet generation warns and blocks "Ready to submit"
   until it is replaced or explicitly overridden by a Bid Manager with a reason.
3. **Given** the packet is generated, **Then** the user can download the merged PDF and each annexure.
4. **Given** the packet exceeds GeM's per-file upload size, **Then** the user is warned.

---

### User Story 5 - Assisted submission with a human at the controls (Priority: P2)

On GeM's bid participation pages, a browser extension (or a copy-panel in the web app) shows the
prepared values for the open tender (technical compliance fields, make/model, document names) and
pre-fills non-financial fields on request. It never fills the price, never touches CAPTCHA/OTP/DSC/
e-Sign, and never clicks the final submit. After the human submits, they record submission in TenderPilot.

**Why this priority**: Saves form-filling time while respecting GeM rules; optional add-on.

**Independent Test**: Load a fixture page that mimics GeM form fields, run the extension's fill logic
with a packet payload, and verify only allowed fields were filled.

**Acceptance Scenarios**:

1. **Given** a GeM form with price and technical fields, **When** the user clicks "Fill", **Then** only
   technical/non-financial fields are filled and the price field stays empty.
2. **Given** the extension is not installed, **Then** the web app's "Submission assistant" lists each
   value with one-click copy and a step-by-step human checklist (price, DSC/OTP, submit).

---

### User Story 6 - Pipeline dashboard and team collaboration (Priority: P2)

Owners and Bid Managers see a dashboard: new matches today, bids closing this week, pipeline by stage
(Kanban), total EMD at stake, Go/No-Go distribution, expiring documents and win/loss rate. Teammates
can be invited with roles, assigned to tenders, and leave comments; every important action is in an
activity log.

**Why this priority**: Makes the product feel like a command centre and supports team selling.

**Independent Test**: Seed tenders in several stages and verify the dashboard numbers and that moving a
card changes the stage and writes an activity entry.

**Acceptance Scenarios**:

1. **Given** five tenders closing within seven days, **Then** the "Closing this week" tile shows 5 and lists them.
2. **Given** a Bid Manager drags a tender from "Go" to "Preparing", **Then** the stage persists and the
   activity log records who moved it.
3. **Given** an Owner invites a teammate as Analyst, **Then** the teammate can analyse but cannot change roles.

---

### User Story 7 - Onboarding and self-serve sign-up (Priority: P3)

A new seller signs up, creates an organization, and a guided onboarding (company basics → categories &
states → first watchlist → upload key documents) gets them to a first matched feed in under 5 minutes,
with a demo dataset available to explore before GeM data arrives.

**Independent Test**: Sign up a new user, complete onboarding and verify the feed shows matches.

**Acceptance Scenarios**:

1. **Given** a new user, **When** they complete onboarding, **Then** they land on a populated feed.
2. **Given** they skip steps, **Then** a checklist on the dashboard shows remaining setup.

### Edge Cases

- GeM is unreachable, rate-limits, or changes its response format → ingestion logs the failure, keeps
  previous data, retries with back-off and surfaces "Last successful sync" in the UI.
- Bid documents are scanned images → OCR path via the vision model; with no model, mark "needs manual review".
- Bids with multiple items / BOQ lines → each line is extracted and shown.
- Reverse auction (RA) and bunch bids → shown with their type label.
- Corrigendum changes requirements after analysis → tender is flagged "re-analysis needed".
- Very large PDFs (> 20 MB) → processed page-limited, with a warning.
- Amounts in "lakh"/"crore" and Indian digit grouping → normalised to rupees.
- Time zone: all GeM times are IST; display in IST.

## Requirements *(mandatory)*

### Functional Requirements

**Identify**
- **FR-001**: The system MUST ingest public GeM BidPlus bid listings on a schedule (default every 30
  minutes) and on demand, storing bid number, title/items, category, quantity, ministry, department,
  organisation, buyer location/state, start and end dates, EMD, estimated value when available, bid
  type (bid/RA/bunch), and document URLs.
- **FR-002**: Ingestion MUST be idempotent by bid number and record changes (e.g. end date) as tender history.
- **FR-003**: Users MUST be able to create, edit, pause and delete watchlists with keywords (include and
  exclude), categories, HSN codes, states, ministries/organisations, value range and minimum days to close.
- **FR-004**: The system MUST match each new or changed tender against all active watchlists and record
  the match with its reasons.
- **FR-005**: The system MUST deliver alerts via in-app notifications, email and WhatsApp, per user
  preference (instant or daily digest), and record delivery status.
- **FR-006**: Users MUST be able to search and filter tenders (free text, state, ministry, category,
  closing window, status, verdict, value) and sort by closing date, score or value.
- **FR-007**: The system MUST show ingestion health: last run, records fetched, errors.

**Analyse**
- **FR-010**: The system MUST fetch or accept upload of bid documents (bid PDF, ATC, corrigenda, BOQ)
  and extract text (with OCR fallback when an LLM vision model is configured).
- **FR-011**: The system MUST extract eligibility requirements with deterministic rules for standard
  GeM bid-document fields, and MAY enrich with an LLM when configured.
- **FR-012**: Each extracted requirement MUST carry source document, page, quote, method (RULE/LLM)
  and confidence.
- **FR-013**: The system MUST compute a weighted Go/No-Go score (0–100) and verdict (Go ≥ 70, Review 40–69,
  No-Go < 40, or No-Go on any hard-blocking failure) with per-factor breakdown; weights are configurable
  per organization.
- **FR-014**: The system MUST apply MSE and Startup exemptions (EMD, turnover, experience) when the bid
  allows them and the company qualifies with valid evidence.
- **FR-015**: The system MUST produce a required-documents checklist per tender.
- **FR-016**: Users MUST be able to override a factor (with reason) and re-score; overrides are audited.

**Apply (co-pilot)**
- **FR-020**: The system MUST maintain a company profile with the fields listed in User Story 3,
  validating GSTIN, PAN and Udyam formats.
- **FR-021**: The system MUST store vault documents privately with type, number, issue/expiry dates and tags,
  and classify status (Valid / Expiring soon ≤ 30 days / Expired).
- **FR-022**: The system MUST send expiry reminders at 30, 7 and 1 days before expiry.
- **FR-023**: The system MUST auto-match checklist items to vault documents and flag missing/expired items.
- **FR-024**: The system MUST generate undertakings/annexures from editable templates filled with company
  and tender data, as PDFs.
- **FR-025**: The system MUST compile a merged PDF packet with cover index and bookmarks, in a user-chosen
  order, and warn on size limits.
- **FR-026**: The system MUST NOT store GeM credentials, enter prices, or automate CAPTCHA/OTP/DSC/e-Sign or
  final submission.
- **FR-027**: The browser extension MUST pre-fill only allow-listed non-financial fields and require a
  user click for each fill.
- **FR-028**: The system MUST track each tender's bid stage, assignees, due dates and outcome (won/lost,
  L1 price, notes).

**Platform**
- **FR-030**: Users MUST sign up/sign in with email and password; sessions expire; passwords are hashed.
- **FR-031**: Organizations MUST support members with roles Owner, Bid Manager, Analyst, Viewer, enforced server-side.
- **FR-032**: All data MUST be scoped to the organization.
- **FR-033**: The system MUST keep an activity log of key actions.
- **FR-034**: The UI MUST be responsive (375–1920 px), support light/dark themes, keyboard navigation and
  WCAG 2.1 AA contrast, with loading, empty and error states on every screen.
- **FR-035**: A demo mode MUST seed realistic sample tenders, a company and documents.

### Non-Functional Requirements

- **NFR-001**: Feed and dashboard pages load in under 2 s at p95 for 10,000 tenders.
- **NFR-002**: Ingestion stays under 1 request/second to GeM with exponential back-off.
- **NFR-003**: Runs on Cloudflare Workers + Neon Postgres + R2; runs locally with Node + Postgres.

### Key Entities

- **Organization**, **User**, **Membership(role)**
- **CompanyProfile**: statutory ids, MSE/Startup/MII status, financial years, net worth, categories, states.
- **PastContract**: buyer, value, dates, CRAC/completion certificate link.
- **VaultDocument**: type, number, issue/expiry, file, tags, status.
- **Tender**: GeM bid identity and attributes; **TenderDocument**; **TenderEvent** (history).
- **Watchlist** and **TenderMatch** (org-scoped match with reasons).
- **Analysis**: requirements, factors, score, verdict, checklist, method.
- **BidWorkspace**: org-scoped tender pipeline stage, assignees, checklist mapping, overrides, outcome.
- **Packet**: ordered items, generated annexures, merged file.
- **Alert / Notification**, **ActivityLog**, **IngestionRun**.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A matching new bid appears in the feed and in-app alerts within one ingestion cycle (≤ 30 min).
- **SC-002**: Analysing a standard GeM bid PDF produces a score and checklist in under 60 seconds.
- **SC-003**: Assembling a complete packet for a tender with all documents in the vault takes under 10
  minutes of user time (vs. ~3 hours manual).
- **SC-004**: A new user reaches a populated feed within 5 minutes of sign-up.
- **SC-005**: 100% of E2E tests for P1/P2 stories pass in CI against a real Postgres.
- **SC-006**: Zero automated actions on GeM beyond public reads and user-clicked pre-fills.

## Assumptions

- The client is a GeM-registered seller; GeM account actions stay with the client.
- GeM BidPlus public listing (`/all-bids-data`) and bid documents (`/showbidDocument/{id}`) are the data
  sources; their formats can change, so parsers are tolerant and fixture-tested.
- WhatsApp alerts use the WhatsApp Business Cloud API with a pre-approved template; email uses a
  transactional email API. Both are optional.
- LLM provider is Anthropic Claude by default; the deterministic path works without it.
- Pricing/billing pages are out of scope for v1 beyond a plan badge.
