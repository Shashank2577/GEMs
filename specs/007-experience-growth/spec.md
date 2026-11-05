# Feature Specification: Experience & Growth — Dashboard, Pipeline, Onboarding, Landing & Demo

**Feature Branch**: `007-experience-growth`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Experience area of TenderPilot in detail: dashboard aggregates & widgets per persona, pipeline
kanban, onboarding wizard, marketing landing page & pricing, demo seed, mobile experience for Owners, accessibility &
responsiveness standards across pages, empty/loading/error states. Describe what is built, add requirements for the gaps
that matter, and make every acceptance scenario verifiable by QA in a browser or via the API."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — User Story 6 ("Pipeline
dashboard and team collaboration"), User Story 7 ("Onboarding and self-serve sign-up"), FR-028 (stage tracking),
FR-033 (activity log), FR-034 (responsive, themed, accessible, loading/empty/error states), FR-035 (demo mode),
NFR-001 (dashboard < 2 s p95) and SC-004 (populated feed within 5 minutes of sign-up). This spec refines those into
independently testable slices, describes what is **built today** (verified against the code on 2026-11-05: 001 tasks
T070–T076) and adds requirements for the gaps that matter. Requirements and scenarios marked *(gap)* are not implemented
yet; everything else is implemented and covered by API tests (`apps/api/test/dashboard.test.ts`,
`apps/api/test/demo.test.ts`, `apps/api/test/workspace.test.ts`) and web unit tests
(`apps/web/src/features/pipeline/position.test.ts`) unless a task in `tasks.md` says a test is missing.

## Personas affected

| Persona | Role (server-enforced) | What they do in this area |
|---|---|---|
| **Owner (MSME founder / OEM sales head)** | `owner` | Opens the dashboard on a phone each morning: new matches, bids closing this week, EMD at stake, win rate, expiring documents; approves Go / No-Go; runs onboarding and loads demo data. |
| **Bid Manager** | `bid_manager` | Runs the pipeline Kanban on desktop: moves bids through stages, hits the "Ready" guard, records outcomes, completes setup, loads or removes demo data. |
| **Bid Analyst** | `analyst` | Works the bids assigned to them ("My bids"), moves cards between stages, checks eligibility; cannot change org settings, onboarding state or demo data. |
| **Viewer (sales / OEM partner / CA / consultant)** | `viewer` | Read-only dashboard and pipeline (board and table); sees no actions they cannot perform. |
| **Prospect (signed-out visitor)** | none | Lands on `/` from search, WhatsApp or a referral; reads how it works, the compliance promise and pricing on a phone; starts a free trial. |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. "At least X" means X or any higher role. A user below the
required role gets **403** `forbidden`; ids belonging to another organisation answer **404** `not_found`; no session
answers **401** `unauthorized`. API errors always have the shape `{ "error": { "code", "message", "details?" } }`.

## User Scenarios & Testing *(mandatory)*

> QA conventions for every scenario: the E2E stack is `pnpm e2e` (Playwright; projects `desktop` 1440×900 and `mobile`
> Pixel 7 for tests tagged `@mobile`; scenarios that say **375 px** use `page.setViewportSize({ width: 375, height: 812 })`)
> with the API + built SPA on :8788 against a fresh `tenderpilot_e2e` database and mock-gem on :4011; browser time zone
> `Asia/Kolkata`, locale `en-IN`. "Fresh org" = a user created with `signupViaApi()` (role Owner, `onboardingState = {}`,
> no profile, no watchlists, no vault documents). "Demo org" = a fresh org after `POST /api/demo/seed` (company "Aarav
> Technologies Pvt Ltd", 40 GeM-like tenders, 3 watchlists "IT hardware – Maharashtra & Goa", "CCTV & surveillance – West
> India", "Networking & power (pan-India, ≥ ₹5 L)", 20 analyses, 16 workspaces — Identified 3, Analysing 2, Go 2,
> Preparing 2, Ready to submit 1, Submitted 3, Won 2, Lost 1 — 5 past contracts and 15 vault documents of which an ISO
> 9001 certificate expires in 10 days, a CA turnover certificate in 25 days and the Dell OEM authorisation expired 5 days
> ago). Other roles are added by inviting users from Settings → Team (`seedOrgWithRoles` in API tests). All dates and
> times are IST. "Today" is the IST calendar day.

### User Story 1 - Owner's morning dashboard (Priority: P1)

An Owner opens `/dashboard` (on a phone or desktop) and, in one screen, sees a greeting with today's IST date, a one-line
summary of what is urgent, six KPI tiles (New matches today, Closing this week, Active bids, EMD at stake, Win rate, Docs
expiring), the bids closing in the next 7 days with countdowns, a 14-day matches trend, a Go / No-Go donut, a pipeline
funnel, expiring documents, the latest matches and team activity. Every tile and list row deep-links to the screen where
the user acts on it. All numbers come from one `GET /api/dashboard` call computed with org-scoped SQL aggregates.

**Why this priority**: The dashboard is the product's front door and the Owner persona's only daily touch-point — if
the numbers are wrong or slow, the product feels untrustworthy. It also anchors SC-004/NFR-001 of the parent spec.

**Independent Test**: In a demo org, open `/dashboard` and check the tiles against the seeded data: Active bids **13**,
Win rate **67%** ("2 won · 1 lost"), Docs expiring **3** ("1 expired"); click each tile and verify the destination URL.

**Acceptance Scenarios**:

1. **Given** no session, **When** `GET /api/dashboard` is called, **Then** it answers **401**.
2. **Given** a fresh org, **When** the Owner calls `GET /api/dashboard`, **Then** it answers **200** with
   `tiles = { newMatchesToday: 0, closingThisWeek: 0, activeBids: 0, emdAtStake: 0, winRate: null, expiringDocs: 0 }`,
   `matchesByDay` has exactly 14 entries whose last `date` is today (IST, `YYYY-MM-DD`) and first is today − 13 days,
   `closingSoon = []`, `verdicts = { go: 0, review: 0, no_go: 0 }`, `setupComplete = false` and `demo = false`.
3. **Given** a demo org, **When** the dashboard API is called, **Then** `pipeline` equals `{ identified: 3, analysing: 2,
   go: 2, preparing: 2, ready: 1, submitted: 3, won: 2, lost: 1, dropped: 0 }`, `tiles.activeBids = 13`,
   `tiles.winRate = 67`, `tiles.expiringDocs = 3`, `stats.expiredDocs = 1`, `verdicts.go + verdicts.review +
   verdicts.no_go = 20`, `recentMatches` has 6 entries, `activity` has ≤ 15 entries including one `demo.seeded`,
   `setupComplete = true` and `demo = true`.
4. **Given** a demo org, **When** the dashboard API is called, **Then** `closingSoon` has 1–8 entries sorted by `endAt`
   ascending, every `endAt` is between now and now + 7 days, `tiles.closingThisWeek ≥ closingSoon.length`,
   `stats.closingToday ≥ 1`, and at least one entry carries `workspace.stage = "ready"`.
5. **Given** a demo org, **When** `tiles.emdAtStake` is compared with `SUM(tenders.emd_amount)` over the org's workspaces
   in stages identified…submitted, **Then** the two are equal and greater than 0.
6. **Given** a demo org opened at 09:30 IST by an Owner named "Priya Sharma", **When** `/dashboard` renders, **Then** the
   `h1` reads "Good morning, Priya", the line above it shows today's date in `en-IN` long form with weekday, and the
   summary line lists the urgent items joined by " · " (e.g. "1 bid closing today · 1 expired document.").
7. **Given** a demo org, **When** the Owner clicks each KPI tile, **Then** the browser navigates to, respectively,
   `/tenders?matched=1`, `/tenders?matched=1&closing=7&sort=endAt`, `/pipeline`, `/pipeline`, `/pipeline?stage=won` and
   `/vault?status=expiring`.
8. **Given** a demo org, **When** the dashboard renders, **Then** the "Win rate" tile shows "67%" with hint "2 won · 1
   lost", the "Docs expiring" tile shows "3" with "1 expired" in the danger colour, the "Active bids" tile shows "13" with
   "1 ready to submit", and a "Demo data" badge is visible in the header.
9. **Given** a demo org, **When** the Owner opens the "Expiring documents" card, **Then** the first row is the Dell OEM
   authorisation with badge "Expired 5d ago", followed by rows with "10d left" and "25d left" in that order.
10. **Given** a fresh org (no watchlist, no bids, not demo), **When** an Owner opens `/dashboard` after having already
    been redirected to onboarding once in this browser session, **Then** the banner "Your command centre fills up as GeM
    bids arrive" shows with buttons "Explore with demo data" and "Create a watchlist", the "Closing soon" card shows
    "Nothing closing this week", "Latest matches" shows "No matches yet", and "Team activity" shows the `org.created`
    entry.
11. **Given** the dashboard API answers 500 on first load, **When** `/dashboard` renders, **Then** an alert "We couldn’t
    load this" with a "Try again" button replaces the widgets; **When** the API recovers and "Try again" is clicked,
    **Then** the widgets render.
12. **Given** a slow API (2 s delay), **When** `/dashboard` loads, **Then** six tile skeletons and per-card skeleton rows are
    visible (`aria-hidden`) until data arrives and no layout shift moves the header.
13. **Given** a demo org and the dashboard open, **When** a teammate moves a workspace from Identified to Analysing via
    `PATCH /api/workspaces/:id`, **Then** within 120 s (auto-refresh) the pipeline funnel shows Identified 2 / Analysing 3
    and the top activity entry reads "<name> moved a bid from Identified to Analysing" linking to `/workspaces/<id>`.
14. *(gap)* **Given** the dashboard has rendered data, **When** a background refresh fails (API 503), **Then** the widgets
    stay visible and a non-blocking banner "Couldn’t refresh — showing data from HH:MM IST" with "Retry" appears; the
    full-page error state is used only when there is no data at all.
15. **Given** a second org, **When** its Owner calls `GET /api/dashboard` after the first org was demo-seeded, **Then**
    `activeBids = 0`, `closingSoon = []`, `recentMatches = []` and its activity contains only its own `org.created`.

---

### User Story 2 - Run bids on the pipeline Kanban (Priority: P1)

A Bid Manager opens **Pipeline** (`/pipeline`) and sees every bid workspace as a card in eight columns — Identified,
Analysing, Go, Preparing, Ready to submit, Submitted, Won, Lost — with per-column counts and EMD totals. Cards show the
eligibility score ring, title, bid number, buyer and state, countdown (or submitted date / Won / Lost badge), comment
count, EMD, owner avatar and packet readiness ("N% " or "N blockers"). Analysts and above drag cards between and within
columns with a mouse, touch (long-press) or the keyboard; the server persists stage and fractional position, writes an
activity entry and refuses "Ready to submit" while required documents are missing or expired. A table view, search,
owner filter and closing-window filter help on large pipelines.

**Why this priority**: The pipeline is the Bid Manager's daily command centre and the bridge between analysis (004) and
packet building (006); the "Ready" guard is a core compliance promise shown on the landing page.

**Independent Test**: In a demo org, drag an Identified card to Analysing and confirm the toast "Moved to Analysing", the
column counts (Identified 2, Analysing 3) after reload, and a `workspace.stage_changed` activity entry; then drag the
blocked Preparing card (Dell desktops) to "Ready to submit" and confirm it snaps back with a "Can’t move to Ready to
submit yet" toast listing the missing items.

**Acceptance Scenarios**:

1. **Given** a demo org, **When** a Viewer calls `GET /api/workspaces`, **Then** it answers **200** with `total = 16`,
   `items` of length 16 and `byStage` matching the seeded distribution; **When** called with `?stage=won,lost`, **Then**
   `total = 3`; **When** called with `?stage=archived`, **Then** it answers **400** `validation_error` with
   `details.fields.stage`.
2. **Given** a demo org, **When** `/pipeline` opens on desktop, **Then** eight columns appear in the order Identified,
   Analysing, Go, Preparing, Ready to submit, Submitted, Won, Lost with counts 3, 2, 2, 2, 1, 3, 2, 1, each with its hint
   (e.g. Ready to submit — "Packet complete — submit on GeM yourself") and the line "16 bids · EMD ₹… at stake" is shown.
3. **Given** a demo org and an Analyst, **When** they drag the first Identified card onto the Analysing column, **Then** a
   toast "Moved to Analysing" appears, `PATCH /api/workspaces/:id` is sent with `{ stage: "analysing", position }`, and
   after a reload the card is in Analysing.
4. **Given** the same move, **When** `GET /api/dashboard` is called, **Then** the latest activity is
   `workspace.stage_changed` with `meta = { from: "identified", to: "analysing" }`, the actor's name and target href
   `/workspaces/<id>`.
5. **Given** a demo org, **When** an Analyst drags the Preparing card whose readiness shows blockers onto "Ready to
   submit", **Then** the API answers **409** `not_ready` with `details.blockers` (≥ 1), the card returns to Preparing, and
   a toast titled "Can’t move to Ready to submit yet" shows the server message plus "Missing: …" and an "Open workspace"
   action that navigates to `/workspaces/<id>`.
6. **Given** a workspace whose tender has no completed analysis, **When** it is moved to Ready, **Then** the API answers
   **409** `conflict` "Analyse the tender before marking the bid ready to submit." with `details.reason = "not_analysed"`.
7. **Given** a demo org, **When** an Analyst moves a Submitted card to Won without an outcome, **Then** the API answers
   **200**, the workspace's `outcome = { result: "won", at: <now> }`, a toast "Marked as won" suggests recording the L1
   price, and the dashboard Win rate becomes 75% (3 won, 1 lost).
8. **Given** a Viewer, **When** they open `/pipeline`, **Then** cards have no drag handles, empty columns read "No bids",
   the note "You have view-only access…" is shown below the board, and a direct `PATCH /api/workspaces/:id` answers
   **403**.
9. **Given** a workspace id from another org, **When** an Analyst sends `PATCH /api/workspaces/<foreign-id>`, **Then** it
   answers **404**.
10. **Given** a demo org, **When** the user types "dell" into "Search title, bid number or buyer", **Then** only cards whose
    title, bid number or buyer contains "dell" (case-insensitive) remain and "Clear filters" appears; **When** "Closing in
    3 days" is chosen, **Then** the URL gains `closing=3` and only cards with `endAt` within 72 h remain; **When** "Clear
    filters" is clicked, **Then** all 16 cards return and the URL has no filter params.
11. **Given** a demo org, **When** the user switches the view to "Table", **Then** a table with columns Tender, Stage, Score,
    Closes, EMD, Readiness, Owner lists 16 rows sorted by stage order then closing date; a reload keeps the Table view
    (`localStorage["tp:pipeline-view"] = "table"`); clicking a row opens `/workspaces/<id>`.
12. **Given** a demo org, **When** `/pipeline?stage=won` opens, **Then** the Won column is scrolled into view and outlined;
    in Table view only Won rows are listed.
13. **Given** keyboard only, **When** an Analyst tabs to a card's "Move <title>" handle, presses Space, presses → twice and
    Space again, **Then** the card lands two columns to the right, and the live region announced "Picked up …", "Over
    <stage>." and "Dropped in <stage>."; **When** Escape is pressed mid-drag, **Then** "Drag cancelled." is announced and
    the card returns.
14. **Given** a phone at 375 px, **When** `/pipeline` opens, **Then** a "Jump to stage" chip row shows every stage with its
    count, columns are 84 vw wide (max 320 px) with snap scrolling, tapping the "Won" chip scrolls the Won column into
    view, and the page itself has no horizontal scroll (only the board container scrolls).
15. **Given** an org with no workspaces, **When** `/pipeline` opens, **Then** the empty state "Your pipeline is empty" with
    "Browse matched tenders" (→ `/tenders?matched=1`) is shown; **Given** filters that match nothing in Table view,
    **Then** "No bids match these filters" is shown.
16. *(gap)* **Given** an Analyst on any card, **When** they open the card's "Move to…" menu and choose "Go", **Then** the card
    moves exactly as with drag-and-drop (same API call, toast and activity), satisfying WCAG 2.5.7 (dragging movements)
    without a pointer drag.
17. *(gap)* **Given** an Analyst drops a card on Won or Lost, **When** the move succeeds, **Then** an "Record the result"
    dialog asks for L1 price (₹), our price (₹) and notes (all optional); "Save" sends `PATCH` with `outcome` and the card
    shows "Won · L1 ₹x L" in the workspace header; "Skip" keeps the stage-only outcome.
18. *(gap)* **Given** a demo org with one workspace moved to `dropped`, **When** the board renders, **Then** a "Show dropped
    (1)" toggle appears; enabling it adds a ninth "Dropped" column; dropping via "Move to… → Dropped" asks for
    confirmation "Drop this bid? It leaves the active pipeline but keeps its history."
19. *(gap)* **Given** the search box, **When** the user types "dell" quickly, **Then** at most one `GET /api/workspaces?q=dell`
    is sent after 300 ms of inactivity and the URL gains `q=dell`, so the filtered view survives reload and can be shared.

---

### User Story 3 - Guided onboarding to a matched feed in under 5 minutes (Priority: P1)

A new seller signs up and lands on `/onboarding`, a five-step wizard: **Company basics** (registered name, GSTIN with
live validation that derives State and PAN, home state, MSE/Udyam, DPIIT Startup, Make in India Class-I), **What you
sell** (16 popular GeM categories as toggle chips plus custom categories, states supplied to, HSN/SAC codes), **First
watchlist** (name and keywords pre-filled from the categories, states, live "open bids match today" preview), **Key
documents** (GST, PAN, Udyam upload cards — optional) and **Done** (confetti, "Go to my feed", "Explore with demo
data"). Every step saves as it goes (`PUT /api/profile`, `POST /api/watchlists`, `POST /api/vault`) and ticks
`organizations.onboarding_state` via `PATCH /api/org`, so leaving and coming back resumes at the first unfinished step.
"Skip for now" exits to the dashboard, where a six-item "Finish setting up" checklist keeps remaining steps visible.

**Why this priority**: Parent SC-004 (populated feed within 5 minutes of sign-up) and self-serve growth depend on it; an
empty product after sign-up is the main churn risk.

**Independent Test**: Sign up through `/signup`; complete Company basics with "Aarav Technologies Pvt Ltd" / GSTIN
`27AAJCA4721K1ZK`, pick "Desktop computers" and "CCTV & surveillance", create the pre-filled watchlist, skip documents,
click "Go to my feed" and verify `/tenders?matched=1` lists at least one mock-gem bid after the next ingestion run; total
scripted time < 90 s.

**Acceptance Scenarios**:

1. **Given** a visitor on `/signup`, **When** they submit valid details, **Then** they are navigated to `/onboarding` (or a
   safe `?next=` path) and the stepper shows "Company basics" as current; on 375 px the text "Step 1 of 5 · Company
   basics" is shown under the stepper.
2. **Given** an Owner of a fresh org (empty `onboardingState`), **When** they open `/dashboard` for the first time in a
   browser session, **Then** they are redirected to `/onboarding` once; a second visit to `/dashboard` in the same session
   shows the dashboard (sessionStorage key `tp:onboarding-redirected` = org id).
3. **Given** step 1, **When** "Continue" is clicked with an empty name, **Then** the field shows "Enter your registered
   company name" and no request is sent; **When** GSTIN `27AAJCA4721K1ZA` (bad check character) is typed, **Then** a
   validation error is shown under GSTIN once 15 characters are entered.
4. **Given** step 1, **When** GSTIN `27AAJCA4721K1ZK` is typed, **Then** the hint reads "Valid · Maharashtra · PAN
   AAJCA4721K", a green check appears, and Home state is pre-selected "Maharashtra"; **When** "Continue" is clicked,
   **Then** `PUT /api/profile` is sent with `legalName`, `gstin`, `pan = "AAJCA4721K"`, `state`, `mseCategory`,
   `isStartup` (and `miiClass = "class_1"` when the toggle is on), `PATCH /api/org` merges `{ company: true }` into
   `onboardingState`, and step 2 opens.
5. **Given** step 2, **When** "Continue" is clicked with no category, **Then** "Pick at least one category so we can find
   matching bids" is shown (`role="alert"`); **When** HSN "84" is entered, **Then** "HSN/SAC codes have 4, 6 or 8
   digits" is shown and the chip is not added; **When** "Desktop computers" and "CCTV & surveillance" are toggled
   (`aria-pressed="true"`) and the custom category "Biometric devices" is added, **Then** "Continue" saves `categories`,
   `hsnCodes`, `operatingStates` and ticks `{ categories: true }`.
6. **Given** step 3 after the above with operating state Maharashtra only, **When** it opens, **Then** the watchlist name
   is "Desktop computers & CCTV & surveillance – Maharashtra", keywords are `desktop, cctv, surveillance, network video
   recorder, biometric devices`, and the "Live preview" panel shows a number followed by "open bids match today" (or
   "open bid matches today" for 1) within 1 s of the last edit (400 ms debounce).
7. **Given** step 3, **When** all keywords and states are removed and "Create watchlist" is clicked, **Then** "Add at
   least one keyword" is shown; **When** valid, **Then** `POST /api/watchlists` answers **201**, a toast "Watchlist
   created" appears, `{ watchlist: true }` is ticked and step 4 opens.
8. **Given** step 4, **When** a 21 MB PDF is chosen for "GST certificate", **Then** a toast "That file is larger than 20
   MB" appears and nothing is uploaded; **When** a valid PDF is chosen, **Then** the card shows "Uploading…" then the file
   name with "Replace", a badge "1 uploaded" appears, and the footer button reads "Continue" (it reads "Skip for now"
   when nothing is uploaded); continuing ticks `{ documents: true }` (or `false` when skipped).
9. **Given** step 5, **When** it renders, **Then** "You’re ready to win more bids" is shown, `{ completed: true }` is
   ticked, confetti plays unless `prefers-reduced-motion: reduce`, and "Go to my feed" navigates to `/tenders?matched=1`;
   for Owner/Bid Manager "Explore with demo data" seeds the demo, toasts "Demo data loaded" and navigates to
   `/dashboard`.
10. **Given** the user completed step 1 and step 2 and closed the tab, **When** they reopen `/onboarding`, **Then** the
    wizard opens at step 3 with step 1–2 values pre-filled from the saved profile; clicking a completed step in the
    stepper navigates back to it.
11. **Given** any step before Done, **When** "Skip for now" is clicked, **Then** `{ skipped: true }` is ticked and the user
    lands on `/dashboard`, which shows "Finish setting up" with a progress bar, "k/6" and the items "Add company basics",
    "Tell us what you sell", "Create a watchlist", "Upload key documents", "Check eligibility on a tender", "Invite a
    teammate" linking to `/profile`, `/profile`, `/watchlists?new=1`, `/vault?upload=1`, `/tenders?matched=1` and
    `/settings/team`; the first unfinished item is highlighted and "Open the guided setup" returns to `/onboarding`.
12. **Given** the setup rules, **When** the org has legal name + GSTIN, ≥ 1 category, ≥ 1 watchlist, ≥ 3 vault
    documents, ≥ 1 completed analysis and (> 1 member or a pending invitation), **Then** `setupComplete = true` and the
    dashboard shows the Go / No-Go card instead of "Finish setting up".
13. **Given** an Analyst or Viewer, **When** they open `/onboarding`, **Then** they see "You’re all set" — "Your
    organization’s owners handle setup…" — with "Go to dashboard", and `PATCH /api/org` by them answers **403**.
14. *(gap)* **Given** `onboardingState.watchlist = true` and the user returns to step 3 after a reload, **When** they click
    the primary button, **Then** it reads "Continue", no second watchlist is created, and `GET /api/watchlists` still
    returns exactly one onboarding watchlist.
15. *(gap)* **Given** a Bid Manager, **When** `PATCH /api/org` is sent with `onboardingState = { hacked: true }` or with
    more than 16 keys, **Then** it answers **400** `validation_error` (`details.fields.onboardingState`); allowed keys are
    `company`, `categories`, `watchlist`, `documents`, `skipped`, `completed`, `demo`.
16. *(gap)* **Given** `PATCH /api/org` fails with 500 while ticking a step, **When** the user continues, **Then** the wizard
    still advances, retries the tick once, and if that fails shows a toast "Couldn’t save your progress — your data is
    saved, but setup may restart at this step".
17. *(gap)* **Given** the org already has GST and PAN documents in the vault, **When** step 4 opens, **Then** those two
    cards show as uploaded (with the vault title) and the badge reads "2 uploaded".

---

### User Story 4 - Explore with demo data, then remove it (Priority: P2)

Before GeM data arrives, an Owner or Bid Manager loads a realistic sample company ("Aarav Technologies Pvt Ltd", Pune)
from the empty dashboard banner or the onboarding Done step. `POST /api/demo/seed` fills the org with a profile (if the
org has none), past contracts, vault documents with real one-page PDFs (some expiring, one expired), three watchlists,
~40 GeM-like tenders with dates relative to now, matches, analyses with explainable factors, workspaces in every
pipeline stage except Dropped, comments, in-app notifications and activity. It is idempotent and tenant-safe. Once
they are ready to work for real, they remove the demo data in one click without touching anything they created.

**Why this priority**: Demo data is what sells the product in a first session and in sales calls, but a demo that cannot
be removed pollutes real pipelines and win-rate figures.

**Independent Test**: In a fresh org, click "Explore with demo data" on the dashboard; verify the "Demo data" badge, 16
pipeline cards and 15 vault documents; create one real watchlist; *(gap)* click "Remove demo data", confirm, and verify
0 workspaces, 0 vault documents and exactly one watchlist remain.

**Acceptance Scenarios**:

1. **Given** no session, **When** `POST /api/demo/seed` is called, **Then** **401**; **Given** a Viewer or Analyst, **Then**
   **403**.
2. **Given** a fresh org and a Bid Manager, **When** `POST /api/demo/seed` is called, **Then** it answers **201** with
   `{ ok: true, created: true, tenders: 40, watchlists: 3, workspaces: 16, analyses: 20, pastContracts: 5,
   vaultDocuments: 15, matches: >15 }` and `GET /api/auth/me` shows `org.onboardingState.demo = true`.
3. **Given** the same org, **When** the seed is called a second time (by the Owner), **Then** it answers **200** with
   `created: false` and the counts of analyses, workspaces, vault documents and the global tenders table (40) are
   unchanged.
4. **Given** a demo org, **When** `GET /api/profile` is called, **Then** the profile has legal name "Aarav Technologies
   Pvt Ltd", GSTIN `27AAJCA4721K1ZK`, `mseCategory = "micro"`, `miiClass = "class_1"` and 3 financial years.
5. **Given** an org whose profile legal name is "Shree Ganesh Traders LLP", **When** it seeds the demo, **Then** the
   legal name stays "Shree Ganesh Traders LLP" and the org still receives 16 workspaces of its own.
6. **Given** a demo org, **When** any vault document is downloaded, **Then** it is a valid one-page PDF starting with
   `%PDF-` and the footer "Sample document generated by TenderPilot demo data - not a real certificate."
7. **Given** a demo org, **When** the Kanban is listed, **Then** the Ready card has `analysis.verdict = "go"` and a
   Preparing card bound to the expired Dell authorisation is blocked (409 on move to Ready).
8. **Given** a fresh org on `/dashboard` (banner visible), **When** the Owner clicks "Explore with demo data", **Then** the
   button shows a spinner, a toast "Demo data loaded — explore away!" appears, every cached query is refreshed, and the
   header shows the "Demo data" badge without a page reload.
9. **Given** demo data was seeded, **When** the seeded in-app notifications are created, **Then** no email or WhatsApp
   message is sent (`channel = "in_app"` only).
10. *(gap)* **Given** a demo org in which the user also created a watchlist "My laptops" and uploaded "Real GST.pdf", **When**
    the Owner calls `DELETE /api/demo`, **Then** it answers **200** with counts of removed rows, the org has 0 demo
    workspaces, analyses, matches, comments, notifications, past contracts and vault documents (and their blobs are
    deleted), the 3 demo watchlists are gone, "My laptops" and "Real GST.pdf" remain, `onboardingState.demo` is `false`,
    and an activity entry `demo.removed` is written. A second call answers **200** with all counts 0.
11. *(gap)* **Given** a demo org, **When** a Viewer or Analyst calls `DELETE /api/demo`, **Then** **403**.
12. *(gap)* **Given** a demo org, **When** the Owner opens `/dashboard`, **Then** an info banner "You’re exploring sample data
    for Aarav Technologies Pvt Ltd." with "Remove demo data" is shown; clicking it opens a confirmation dialog "Remove all
    demo data? Your own watchlists, documents and bids stay." and confirming removes it, toasts "Demo data removed" and
    shows the empty dashboard.
13. *(gap)* **Given** a demo org, **When** the user views the tender feed or a demo tender page, **Then** demo tenders carry a
    "Sample" badge (from `tenders.raw.demo = true`) so they are never mistaken for live GeM bids.
14. *(gap)* **Given** an org whose profile was filled by the demo (legal name and GSTIN equal the demo company), **When**
    demo data is removed, **Then** the profile is reset to empty; a profile the user edited away from the demo values is
    kept.

---

### User Story 5 - Persona-aware dashboard widgets (Priority: P2)

The same dashboard adapts to who is looking. Owners and Bid Managers see an **Awaiting your decision** card listing
analysed bids still in "Analysing" with their score and verdict and one-tap **Go** / **Drop** buttons (the "Approve Go /
No-Go in one tap" promise on the landing page). Analysts and Bid Managers see **My bids** — the active workspaces they
own or are assigned to, by due date, with readiness. Analysts and Viewers do not see setup tasks or buttons for actions
their role cannot perform.

**Why this priority**: Without role-aware widgets the Owner has to open the pipeline to make decisions and Analysts
cannot see their own work at a glance; showing actions that return 403 erodes trust. Built pieces (role-gated demo
button, view-only Kanban) exist; the widgets are gaps.

**Independent Test**: In a demo org, assign two active workspaces to an Analyst with due dates; log in as the Analyst and
verify "My bids" lists exactly those two, earliest due first; log in as the Owner and tap "Go" on an "Awaiting your
decision" row and verify the card moves to Go.

**Acceptance Scenarios**:

1. **Given** a fresh org and a Viewer, **When** `/dashboard` renders, **Then** the empty banner shows no "Explore with demo
   data" button (built) and *(gap)* no "Create a watchlist" button; instead the text "Ask an Owner or Bid Manager to set up
   watchlists." is shown.
2. *(gap)* **Given** a demo org, **When** `GET /api/dashboard` is called by an Analyst who owns workspace A (due tomorrow,
   Preparing) and is an assignee on workspace B (due in 3 days, Go), **Then** `myWork` lists A then B with `id`, `title`,
   `bidNumber`, `stage`, `dueAt`, `endAt`, `readiness.percent` and `readiness.blockers`, at most 5 items, excluding stages
   submitted/won/lost/dropped.
3. *(gap)* **Given** the same Analyst, **When** `/dashboard` renders, **Then** a "My bids" card appears directly after the
   KPI tiles with A and B, each showing the stage badge, "Due <date>" (red when overdue) and readiness; **Given** no
   assignments, **Then** it shows "Nothing assigned to you — bids you own or are assigned to will appear here."
4. *(gap)* **Given** a demo org with two workspaces in Analysing whose latest analysis is done, **When** the Owner calls the
   dashboard API, **Then** `awaitingDecision` lists both (≤ 5, oldest first) with score and verdict.
5. *(gap)* **Given** the Owner on a phone at 375 px, **When** they tap "Go" on an "Awaiting your decision" row, **Then**
   `PATCH /api/workspaces/:id { stage: "go" }` is sent, the row disappears with a toast "Moved to Go", and the pipeline
   funnel updates; tapping "Drop" asks "Drop this bid?" and moves it to `dropped`.
6. *(gap)* **Given** an Analyst or Viewer, **When** `/dashboard` renders for an org with incomplete setup, **Then** the
   "Finish setting up" card is not shown (the Go / No-Go card is shown instead) and "Awaiting your decision" is read-only
   (no Go / Drop buttons) for Analysts and hidden for Viewers.

---

### User Story 6 - Marketing landing page & pricing for prospects (Priority: P2)

A signed-out visitor on `/` sees a fast, phone-friendly marketing page: sticky nav (How it works, Compliance, For teams,
Pricing, FAQ, Sign in, Start free trial), a hero ("Win more GeM bids. Spend minutes, not nights, on each one.") with a
crafted product mock, who it is built for, Identify / Analyse / Apply, the "co-pilot that never takes the wheel"
compliance section, headline metrics, persona tabs (Owner, Bid Manager, Analyst, Compliance), three pricing plans, an
FAQ accordion, a final call to action and a footer. Signed-in users never see it — they go straight to the app.

**Why this priority**: It is the top of the growth funnel and the place where the human-in-the-loop promise
(Constitution I) is made publicly; it must be accurate, accessible and shareable on WhatsApp/LinkedIn.

**Independent Test**: Open `/` signed-out on a 375 px phone: open the menu, jump to Pricing, read the three plans, open an
FAQ item with the keyboard, click "Start free trial" and land on `/signup`; then sign in and confirm `/` redirects to
`/dashboard`.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open `/`, `/login` or `/signup`, **Then** they are redirected to
   `/dashboard` (or to a safe same-origin `?next=` path; `//evil.com` is ignored).
2. **Given** a signed-out visitor, **When** `/` loads, **Then** the `h1` reads "Win more GeM bids. Spend minutes, not
   nights, on each one.", the pill "Account-safe: never auto-submits on GeM" links to `#control`, and the hero shows
   "Start free trial" (→ `/signup`), "See how it works" (→ `#how`) and the ticks "14-day free trial", "No card needed",
   "Set up in 5 minutes".
3. **Given** desktop, **When** a nav link (How it works, Compliance, For teams, Pricing, FAQ) is clicked, **Then** the page
   scrolls to `#how`, `#control`, `#teams`, `#pricing`, `#faq` respectively with the section heading not hidden under the
   sticky nav (`scroll-margin-top`).
4. **Given** 375 px, **When** the menu button ("Open menu", `aria-expanded="false"`) is tapped, **Then** a "Mobile" nav
   with the five links plus "Sign in" and "Start free trial" opens, the button becomes "Close menu"
   (`aria-expanded="true"`), and tapping a link closes it.
5. **Given** the Pricing section, **When** it is read, **Then** it shows "Starter ₹2,999/month", "Pro ₹7,999/month" with a
   "Most popular" badge and "Enterprise Custom", the note "Prices exclude 18% GST. Every plan starts with a 14-day free
   trial of Pro.", Starter/Pro buttons "Start free trial" (→ `/signup`) and Enterprise "Talk to sales" (→
   `mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise`).
6. **Given** the FAQ, **When** a keyboard user tabs to "Will TenderPilot submit bids on GeM for me?" and presses Enter,
   **Then** the answer starting "No — and that’s deliberate." expands and the trigger reports `aria-expanded="true"`.
7. **Given** the persona tabs, **When** "Bid Manager" is selected with arrow keys, **Then** the panel title "Run every bid
   like a well-oiled pipeline" is shown.
8. **Given** `prefers-reduced-motion: reduce`, **When** the page scrolls, **Then** sections appear without slide/fade
   animation.
9. **Given** the page copy, **When** it is reviewed, **Then** no text claims TenderPilot submits bids, enters prices or
   handles OTP/DSC/e-Sign (Constitution I); the Compliance section states the price is "typed by you, on GeM".
10. *(gap)* **Given** a crawler or a WhatsApp/LinkedIn link preview fetching `/`, **When** it reads the HTML `<head>`,
    **Then** it finds `<title>TenderPilot — GeM tender co-pilot for Indian sellers</title>` (no doubled "· TenderPilot"),
    `meta description`, `link rel="canonical"`, `og:title`, `og:description`, `og:image` (1200×630 `/og.png`),
    `og:locale = en_IN`, `twitter:card = summary_large_image` and a JSON-LD `SoftwareApplication` with two `Offer`s in
    INR (2999, 7999).
11. *(gap)* **Given** a visitor clicks "Start free trial" on the Pro card, **When** `/signup?plan=pro` opens, **Then** it shows
    "You’re starting a 14-day free trial of Pro — no card needed." and after sign-up the plan remains `trial`; Starter
    passes `?plan=starter`; unknown values are ignored.
12. *(gap)* **Given** `GET /robots.txt` and `GET /sitemap.xml`, **Then** robots allows `/` and disallows app routes
    (`/dashboard`, `/tenders`, `/pipeline`, `/vault`, `/profile`, `/settings`, `/onboarding`, `/workspaces`, `/api/`) and
    the sitemap lists `/`, `/signup`, `/login`.

---

### User Story 7 - Responsive, accessible pages with honest states everywhere (Priority: P2)

Every screen is usable on a 375 px phone and a 1440 px desktop, in light and dark themes, with the keyboard, with a
screen reader and with reduced motion; every data screen shows loading, empty and error states; navigation errors and
unknown URLs are handled gracefully. Owners on phones get a bottom tab bar (Home, Tenders, Pipeline, Vault, More), safe
area padding and *(gap)* can add TenderPilot to their home screen.

**Why this priority**: Constitution V makes UX a selling point; FR-034 of the parent spec requires it on every screen.
It is cross-cutting and verified by automated audits rather than one flow.

**Independent Test**: Run the 007 accessibility/responsiveness E2E over the 11 core pages (landing, login, signup,
onboarding, dashboard, tenders, pipeline, vault, profile, settings, notifications) at 375 px and 1440 px in light and dark
themes: zero serious/critical axe violations and `document.documentElement.scrollWidth ≤ window.innerWidth` on every
page.

**Acceptance Scenarios**:

1. **Given** any app page at < 768 px, **When** it renders, **Then** a bottom tab bar `nav[aria-label="Primary"]` shows
   Home, Tenders, Pipeline, Vault and More (More opens the full navigation sheet), the sidebar is hidden, and page content
   is not covered by the bar (bottom padding ≥ bar height + safe area).
2. **Given** ≥ 768 px, **When** the app renders, **Then** a collapsible sidebar (`aria-label="Sidebar"`) is shown and its
   collapsed state toggles with "Collapse sidebar" / "Expand sidebar".
3. **Given** a keyboard user on any app page, **When** they press Tab first, **Then** a "Skip to content" link appears and
   activating it moves focus to `#main`; **When** they navigate to another route, **Then** focus moves to `#main` and the
   page scrolls to top; `Ctrl/⌘+K` opens the command palette.
4. **Given** the theme toggle, **When** "Dark" is chosen and the page reloads, **Then** the dark theme is applied before
   first paint (no flash) from `localStorage["tp-theme"]`; "System" follows `prefers-color-scheme`.
5. **Given** a route chunk fails to load after a deploy, **When** the route renders, **Then** "A new version of
   TenderPilot is available" with a reload action is shown; **Given** a render error, **Then** "This page hit a snag" with
   "Try again" is shown inside the app shell.
6. **Given** an unknown URL such as `/nope`, **When** it opens, **Then** a 404 page shows "404", "This page went off the
   map" and "Open dashboard".
7. **Given** the dashboard charts, **When** read by a screen reader, **Then** each chart exposes `role="img"` with a text
   summary (e.g. "New matches over the last 14 days: 23 in total").
8. *(gap)* **Given** the 11 core pages × {375 px, 1440 px} × {light, dark}, **When** `@axe-core/playwright` runs with tags
   `wcag2a, wcag2aa, wcag21a, wcag21aa`, **Then** there are 0 serious or critical violations, and the JSON reports are
   saved in `qa/evidence/007/US7/axe/`.
9. *(gap)* **Given** those pages at 375 px, **When** measured, **Then** no page scrolls horizontally (the Kanban board
   scrolls inside its own container) and every interactive target is at least 24×24 CSS px (WCAG 2.5.8), with tab-bar
   targets at least 44×44.
10. *(gap)* **Given** an Owner on Android Chrome, **When** they open the app, **Then** `/manifest.webmanifest` is linked with
    name "TenderPilot", short_name "TenderPilot", `start_url = "/dashboard"`, `display = "standalone"`, theme colours,
    and 192/512 px (incl. maskable) icons, so "Add to Home screen" is offered.
11. *(gap)* **Given** the browser goes offline, **When** any app page is open, **Then** a polite banner "You’re offline —
    showing the last loaded data" appears within 2 s and disappears when back online; mutations show an error toast
    rather than spinning forever.

---

### Edge Cases

- **IST day boundaries**: a match created at 00:10 IST counts in today's "New matches today" even though it is the
  previous UTC day; `istMidnight()` is the single source (tested with 2026-11-03T19:00Z → 00:30 IST on the 4th).
- **Yesterday was zero**: the "vs yesterday" delta is hidden when yesterday was 0 and today > 0 (no "∞%"); shows 0%
  when both are 0.
- **No won/lost results**: Win rate shows "—" with hint "no results yet" (never "0%").
- **Dismissed matches** drop out of "New matches today", recent matches and "Closing soon" unless the tender is in the
  active pipeline.
- **Tenders without `endAt`** never appear in "Closing soon" and never match a closing filter except "Any closing date".
- **EMD at stake** sums only active stages (identified…submitted); tenders with null EMD count as 0; values ≥ ₹1 L are
  shown compact ("₹4.6 L").
- **Very long titles / buyer names** truncate with ellipsis on one or two lines; bid numbers use a monospace font and
  never wrap mid-number.
- **Concurrent moves**: two users moving the same card — last write wins; the board re-syncs from the server on settle
  (queries invalidated) so both users converge within one refetch.
- **Drag cancelled or dropped outside a column** restores the snapshot board; a failed PATCH (network/5xx) reverts the
  card and shows "Couldn’t move “<title>…”" with the error message.
- **Fractional positions** keep halving between neighbours; precision exhaustion (> ~50 consecutive inserts between the
  same pair) is acceptable for v1 and covered by a *(gap)* renumber-on-collision hardening task.
- **Onboarding as a second org**: a user who switches to another org with empty `onboardingState` is redirected once per
  org (the sessionStorage value is the org id).
- **Private browsing / blocked storage**: sessionStorage and localStorage failures are swallowed — no redirect loop, the
  view toggle falls back to Board.
- **Demo seeded twice by two users at once**: natural keys and existence checks keep it idempotent; the second call
  answers 200 `created: false` (or 201 if it created the remaining rows).
- **Demo removal after the user edited demo rows** (e.g. moved a demo card, commented on it): the rows are still demo rows
  and are removed; rows the user created themselves are never removed.
- **Landing visited with `?next=`** while signed in: only same-origin paths starting with a single `/` are honoured.
- **Reduced motion**: confetti, reveal animations and step slide transitions are disabled; content is shown immediately.
- **Slow 3G on a phone**: route chunks are lazy-loaded behind a splash (`role="status"`, "Loading TenderPilot").

## Requirements *(mandatory)*

### Functional Requirements

**Dashboard aggregates & widgets (US1)**

- **FR-001**: The system MUST expose `GET /api/dashboard` to any member (viewer+) of the active org, answering 401
  without a session, and computing every figure with org-scoped SQL in one request; the only global table read is
  `tenders`, always joined through the org's matches or workspaces.
- **FR-002**: The response MUST contain `tiles` = `newMatchesToday` (distinct non-dismissed matched tenders created since
  IST midnight), `closingThisWeek` (open, relevant tenders with `endAt` in [now, now + 7 d]), `activeBids` (workspaces in
  identified…submitted), `emdAtStake` (sum of EMD over active workspaces), `winRate` (round(won / (won + lost) × 100) or
  `null`), `expiringDocs` (vault documents with expiry ≤ today + 30 d, including expired).
- **FR-003**: The response MUST contain `stats` = `newMatchesYesterday`, `closingToday`, `won`, `lost`, `expiredDocs`,
  `analysesThisWeek`, `openTenders`; plus `pipeline` and `pipelineValue` per stage (all nine stages, zero-filled),
  `verdicts` (latest done analysis per tender), `matchesByDay` (14 IST days, oldest first, zero-filled), `generatedAt`
  and `demo` (`onboardingState.demo`).
- **FR-004**: `closingSoon` MUST list at most 8 relevant open tenders closing within 7 days, ascending by `endAt`, each
  with `bidNumber`, `title`, `buyer` (organisation → department → ministry), `state`, `emdAmount`, `estimatedValue`, latest
  `analysis {score, verdict}` and `workspace {id, stage}`; a row links to the workspace when one exists, else to the
  tender.
- **FR-005**: `recentMatches` MUST list the 6 most recent distinct matched tenders with `watchlistName`, `reasons`,
  `matchedAt` and `isNew = !seen`; `expiringDocuments` MUST list at most 6 documents ascending by expiry with
  `daysToExpiry` and `status` `expired|expiring`.
- **FR-006**: `activity` MUST list the 15 most recent org activity entries with actor and a resolved `target {label,
  href}` (workspace → `/workspaces/:id`, tender → `/tenders/:id`, vault → `/vault`, watchlist → `/watchlists`, profile →
  `/profile`, member → `/settings/team`); the web renders a plain-English sentence per action (`describeActivity`) and
  omits the target for self-contained actions.
- **FR-007**: `setup` MUST contain six steps (company, categories, watchlist, documents, analysis, team) with `done`,
  `label`, `description`, `href` and `setupComplete = every(done)`.
- **FR-008**: The dashboard page MUST show the IST date, an IST-hour greeting ("Working late" < 05:00, "Good morning"
  < 12:00, "Good afternoon" < 17:00, else "Good evening") with the first name, the summary line rules of US1-6, the
  "Demo data" badge when `demo`, and the buttons "Pipeline" and "Review matches".
- **FR-009**: The six KPI tiles MUST deep-link as in US1-7, show their hints/deltas as in US1-8, and the "EMD at stake"
  label MUST explain EMD in a tooltip ("Earnest Money Deposit on your active bids. MSEs with Udyam are usually exempt.").
- **FR-010**: Each widget MUST have a loading skeleton, a specific empty state (texts in US1-10 and US1-9) and the page
  MUST show an error state with "Try again" when the first load fails.
- **FR-011**: The dashboard MUST refetch every 120 s and be invalidated after Kanban moves and demo seeding.
- **FR-012** *(gap)*: When cached dashboard data exists and a refresh fails, the page MUST keep the data and show a
  non-blocking stale banner with the `generatedAt` time and "Retry" (US1-14) instead of replacing the page with the
  error state.
- **FR-013**: A brand-new org (empty `onboardingState`) MUST redirect an Owner/Bid Manager from `/dashboard` to
  `/onboarding` once per browser session per org.

**Pipeline Kanban (US2)**

- **FR-020**: `GET /api/workspaces` (viewer+) MUST return `{ items: WorkspaceCard[], total, byStage }` filtered by
  `stage` (repeatable or comma-separated; unknown stage → 400 `validation_error` with `details.fields.stage`), `mine=1|true`
  (owner or assignee is the caller) and `q` (title, bid number, buyer).
- **FR-021**: The board MUST render the eight `PIPELINE_STAGES` columns in order with label, hint, count and EMD total
  (tooltip "Total EMD (earnest money) in this column"); Dropped is excluded from the default board.
- **FR-022**: Analysts and above MUST be able to reorder and move cards by pointer (activation after 6 px), touch
  (220 ms long-press, 8 px tolerance) and keyboard (dnd-kit sortable keyboard coordinates), with screen-reader
  announcements for pick-up, over, drop and cancel; Viewers MUST get a static board.
- **FR-023**: `PATCH /api/workspaces/:id` (analyst+; 403 below; 404 cross-org) MUST persist `stage` and `position`
  (fractional; `positionAt()` between neighbours, append at end when only `stage` is sent), set `submittedAt` on first
  move to submitted, set `outcome {result, at}` on move to won/lost without an outcome, and log
  `workspace.stage_changed {from, to, fromLabel, toLabel}`.
- **FR-024**: Moving to `ready` MUST answer 409 `conflict` with `reason: not_analysed` when no analysis exists, and 409
  `not_ready` with `details.blockers` when required documents are missing or expired and not overridden; the web MUST
  revert the card and show the blocker toast with "Open workspace" (US2-5).
- **FR-025**: The page MUST offer search, owner filter (All owners, Owned by me, Unassigned, each other owner), closing
  filter (Any, 3, 7, 30 days, Already closed), "Clear filters", a "N bids · EMD ₹X at stake" summary over the filtered
  active cards, and keep `owner`, `closing` and `stage` in the URL.
- **FR-026**: The Table view MUST show Tender, Stage, Score, Closes, EMD, Readiness and Owner (Readiness and Owner hidden on
  mobile), sort by stage order then closing date, open the workspace on row click, filter by `?stage=` and persist the
  view choice in `localStorage["tp:pipeline-view"]`.
- **FR-027**: The pipeline MUST show a board skeleton while loading (`aria-busy`), an error state with retry, the empty
  pipeline state and the empty filtered state (US2-15).
- **FR-028**: On < 768 px the board MUST show the "Jump to stage" chip row and snap-scrolling columns (US2-14).
- **FR-029** *(gap)*: Every card MUST offer a "Move to…" menu (keyboard and touch accessible, analyst+) listing all other
  stages including Dropped, using the same API, toasts and error handling as drag-and-drop.
- **FR-030** *(gap)*: After a successful move to Won or Lost the web MUST open a "Record the result" dialog (L1 price,
  our price in whole rupees, notes ≤ 2000 chars; all optional) that sends `outcome` via `PATCH`; "Skip" leaves the
  stage-only outcome.
- **FR-031** *(gap)*: The board MUST offer a "Show dropped (N)" toggle (persisted per browser) that adds a Dropped column;
  moving to Dropped MUST require confirmation.
- **FR-032** *(gap)*: Search MUST be debounced (300 ms) and synced to `?q=`; the view-only note MUST read "You have
  view-only access. Ask an Analyst, Bid Manager or Owner to move bids between stages." (today it wrongly names only Bid
  Managers).
- **FR-033** *(gap)*: When the midpoint between two neighbouring positions is not representable (difference < 1e-9), the
  API MUST renumber the column's positions (1, 2, 3, …) in one transaction before applying the move.

**Onboarding wizard (US3)**

- **FR-040**: Sign-up MUST navigate to `/onboarding` (or a safe `next`); the wizard MUST have five steps (Company basics,
  What you sell, First watchlist, Key documents, Done) with a clickable stepper for completed steps and a mobile "Step n
  of 5 · <label>" line.
- **FR-041**: Step 1 MUST require the registered name, validate GSTIN with the shared validator (`validateGstin`), derive
  State (`gstinState`) and PAN (characters 3–12), and save via `PUT /api/profile` before ticking `company`.
- **FR-042**: Step 2 MUST offer the 16 `POPULAR_CATEGORIES` as `aria-pressed` toggle chips plus custom categories, operating
  states and HSN/SAC chips (4, 6 or 8 digits), require ≥ 1 category, save and tick `categories`.
- **FR-043**: Step 3 MUST pre-fill the watchlist name and keywords from the categories (`keywordsFor`, ≤ 30 keywords),
  show a debounced live preview count and up to 3 sample bids, create the watchlist via `POST /api/watchlists` and tick
  `watchlist`.
- **FR-044**: Step 4 MUST offer GST, PAN and Udyam upload cards (PDF/JPG/PNG ≤ 20 MB, client-side size check), upload via
  `POST /api/vault` with type and title, and tick `documents` with whether anything was uploaded.
- **FR-045**: Step 5 MUST tick `completed`, offer "Go to my feed" (`/tenders?matched=1`) and, for bid_manager+, "Explore
  with demo data"; confetti MUST respect reduced motion.
- **FR-046**: "Skip for now" MUST tick `skipped` and go to `/dashboard`; reopening the wizard MUST start at the first
  unticked step with values pre-filled from the saved profile.
- **FR-047**: Users below bid_manager MUST see the "You’re all set" screen; `PATCH /api/org` (bid_manager+) MUST merge
  `onboardingState` keys rather than replace them and MUST NOT log onboarding ticks to the activity feed.
- **FR-048** *(gap)*: `PATCH /api/org` MUST accept only the onboarding keys `company`, `categories`, `watchlist`,
  `documents`, `skipped`, `completed`, `demo` (≤ 16 keys) and answer 400 otherwise.
- **FR-049** *(gap)*: Step 3 MUST NOT create a second watchlist when `onboardingState.watchlist` is already true.
- **FR-050** *(gap)*: Onboarding tick failures MUST be retried once and then surfaced with a toast (US3-16).
- **FR-051** *(gap)*: Step 4 MUST pre-mark key-document cards already present in the vault (by type).
- **FR-052** *(gap)*: Completing the wizard MUST write one `onboarding.completed` activity entry with `durationSec` (sign-up
  to Done) so SC-001 can be measured from data.

**Demo data (US4)**

- **FR-060**: `POST /api/demo/seed` (bid_manager+) MUST seed the dataset described in US4 into the current org, answer 201
  when it created data and 200 with `created: false` otherwise, and set `onboardingState.demo = true`.
- **FR-061**: The seed MUST be idempotent (natural keys / existence checks), MUST never overwrite a non-empty company
  profile, MUST upsert the 40 demo tenders globally by bid number (`GEM/2026/B/NNNNNNN`, `raw.demo = true`) with dates
  relative to `now` (≥ 1 closing today, some closed), and MUST keep every org-scoped row in the calling org.
- **FR-062**: Demo vault documents MUST be real one-page PDFs stored through the blob store (or metadata-only when no
  store), including one expired and two expiring documents; one Preparing workspace MUST be blocked from Ready by the
  expired Dell authorisation.
- **FR-063**: Demo notifications MUST be in-app only; demo activity entries MUST carry `meta.demo = true`, including a
  `demo.seeded` entry.
- **FR-064**: The dashboard banner (empty org) and the onboarding Done step MUST offer "Explore with demo data" to
  bid_manager+; success MUST invalidate all cached queries. `pnpm db:seed` MUST seed a local demo account.
- **FR-065** *(gap)*: `DELETE /api/demo` (bid_manager+) MUST remove every org-scoped row created by the demo (workspaces,
  analyses, matches, comments, notifications, activity with `meta.demo`, past contracts, vault documents and their blobs,
  the three demo watchlists) while preserving every row the users created, reset a still-demo profile (US4-14), set
  `onboardingState.demo = false`, log `demo.removed`, and be idempotent.
- **FR-066** *(gap)*: The dashboard MUST show the demo banner with "Remove demo data" and a confirmation dialog (US4-12).
- **FR-067** *(gap)*: Demo tenders MUST be badged "Sample" wherever tenders are listed or shown.

**Persona-aware widgets (US5)** *(gap)*

- **FR-070** *(gap)*: `GET /api/dashboard` MUST add `myWork` (≤ 5 active workspaces where the caller is owner or assignee,
  ordered by `dueAt` nulls last, then `endAt`) and `awaitingDecision` (≤ 5 workspaces in `analysing` whose latest analysis
  is done, oldest first, with score and verdict).
- **FR-071** *(gap)*: The web MUST show "My bids" to analyst and bid_manager directly after the KPI tiles and to owners
  below the first row; Viewers MUST NOT see it.
- **FR-072** *(gap)*: The web MUST show "Awaiting your decision" with one-tap "Go" and "Drop" (with confirmation) to
  bid_manager+; read-only to analysts; hidden from viewers.
- **FR-073** *(gap)*: Role-gated CTAs on the dashboard MUST be hidden for roles that would get 403 ("Create a watchlist"
  for viewers; "Finish setting up" card for analysts and viewers).

**Landing page & pricing (US6)**

- **FR-080**: `/`, `/login` and `/signup` MUST be public-only routes that redirect signed-in users to `safeNext(next)`.
- **FR-081**: The landing page MUST contain, in order, nav, Hero, Built for, How it works (`#how`), Compliance
  (`#control`), Metrics, Personas (`#teams`), Pricing (`#pricing`), FAQ (`#faq`), final CTA and footer, with the texts
  in US6-2…US6-7.
- **FR-082**: Pricing MUST show Starter ₹2,999/month, Pro ₹7,999/month (featured), Enterprise Custom, with the GST and
  trial note and the CTA destinations of US6-5.
- **FR-083**: Landing copy MUST uphold Constitution I (US6-9).
- **FR-084** *(gap)*: The landing HTML MUST carry the SEO and social meta of US6-10 and the page title MUST NOT be suffixed
  twice.
- **FR-085** *(gap)*: Plan CTAs MUST pass `?plan=` to `/signup`, which shows the trial note (US6-11).
- **FR-086** *(gap)*: Plans MUST be defined once in `packages/core/src/contracts/plans.ts` (name, monthly price in INR,
  features, limits) and the landing page MUST render from it.
- **FR-087** *(gap)*: The static assets MUST include `robots.txt` and `sitemap.xml` (US6-12).

**Cross-page responsiveness, accessibility & states (US7)**

- **FR-090**: Every app page MUST provide loading, empty and error states; route-level errors MUST be caught by
  `RouteErrorBoundary` (chunk errors → reload prompt) and unknown URLs MUST show the 404 page.
- **FR-091**: The app shell MUST provide the mobile tab bar (< 768 px), the desktop sidebar (≥ 768 px), a "Skip to
  content" link, focus management to `#main` on navigation and the command palette (`Ctrl/⌘+K`).
- **FR-092**: Theme (light/dark/system) MUST be applied before first paint from `localStorage["tp-theme"]`.
- **FR-093**: All motion MUST respect `prefers-reduced-motion`; charts MUST expose text alternatives.
- **FR-094** *(gap)*: An automated E2E MUST audit the 11 core pages with axe at both viewports and both themes (US7-8) and
  assert no horizontal overflow at 375 px (US7-9).
- **FR-095** *(gap)*: The web app MUST ship a web app manifest and icons (US7-10).
- **FR-096** *(gap)*: The app MUST show an offline banner and fail mutations fast while offline (US7-11).

### Non-Functional Requirements

- **NFR-001**: `GET /api/dashboard` MUST answer in < 500 ms p95 and the dashboard MUST be interactive in < 2 s p95 for an
  org with 10,000 tenders, 2,000 matches, 200 workspaces and 500 activity entries on the reference environment
  (parent NFR-001); *(gap)* an index on `bid_workspaces(org_id, stage)` supports the stage aggregates.
- **NFR-002**: The pipeline MUST render 200 cards in < 1 s on a mid-range laptop and keep drag interactions responsive
  (no dropped frames > 100 ms while dragging).
- **NFR-003**: The landing page MUST score ≥ 85 Performance, ≥ 95 Accessibility, ≥ 90 Best Practices and ≥ 90 SEO in
  Lighthouse mobile emulation; LCP < 2.5 s and CLS < 0.1.
- **NFR-004**: All pages MUST meet WCAG 2.1 AA, plus WCAG 2.2 AA 2.5.7 (dragging alternatives) and 2.5.8 (target size).
- **NFR-005**: Every dashboard, pipeline and demo query MUST be org-scoped (Constitution IV); cross-org ids answer 404 and
  API tests MUST prove isolation.
- **NFR-006**: All dates and day boundaries MUST be IST; amounts MUST use Indian digit grouping and lakh/crore compact
  forms.
- **NFR-007**: Each user story MUST have a Playwright E2E with evidence (named screenshots, video, trace) in
  `qa/evidence/007/US<n>/` and a QA `VERDICT.md`; review uses the cairn review workflow (ai-sdlc conventions in
  `CONVENTIONS.md` for review/QA only).
- **NFR-008**: New runtime dependencies for the web app MUST be justified in `plan.md` and stay under 30 KB gzipped each.
- **NFR-009**: Any code or data ported from the reference repositories MUST be license-compatible (MIT/Apache-2.0) and
  attributed in `NOTICE`; unlicensed repositories may inform ideas only.

## UX Specification

### Screens

| Screen | Route | Built | Primary persona | Key content |
|---|---|---|---|---|
| Landing | `/` | Yes | Prospect | Nav, hero + product mock, built for, how it works, compliance, metrics, personas, pricing, FAQ, CTA, footer |
| Sign up / Sign in | `/signup`, `/login` | Yes (002) | Prospect | Forms; signup → `/onboarding` |
| Onboarding | `/onboarding` | Yes | Owner, Bid Manager | 5-step wizard outside the app shell, sticky mobile footer |
| Dashboard | `/dashboard` | Yes (+ gaps) | Owner (phone), Bid Manager | Greeting, KPI tiles, closing soon, setup / verdicts, trend, expiring, funnel, matches, activity; *(gap)* My bids, Awaiting your decision, demo banner |
| Pipeline | `/pipeline` | Yes (+ gaps) | Bid Manager, Analyst | Filters, board/table, *(gap)* Move to…, result dialog, dropped toggle |
| 404 / error | `*`, any | Yes | All | Recovery actions |

### States

| Screen | Loading | Empty | Error |
|---|---|---|---|
| Dashboard | Tile skeletons; skeleton rows per card; header summary skeleton | Banner "Your command centre fills up as GeM bids arrive"; per-card empties ("Nothing closing this week", "All documents are valid", "No matches yet", "It’s quiet here") | "We couldn’t load this" + "Try again"; *(gap)* stale banner when cached data exists |
| Pipeline | 5 skeleton columns (`aria-busy="true"`, "Loading pipeline") | "Your pipeline is empty" + "Browse matched tenders"; empty column "Drop a bid here" / "No bids"; table "No bids match these filters" | Error state + "Try again"; move errors as toasts with revert |
| Onboarding | Name input disabled while the profile loads; preview spinner; upload spinner per card | Preview "No open bids right now — that’s fine…" | Field errors inline; API errors as toasts; *(gap)* tick-failure toast |
| Landing | Splash while the chunk loads | n/a | Route error boundary |

### Responsive behaviour

- **375 px (Owner on a phone)**: Dashboard stacks KPI tiles 2 per row, then Closing soon, Setup/Verdicts, Trend,
  Expiring, Funnel, Matches, Activity; the first viewport (375×812) shows greeting, summary and at least four tiles. Bottom
  tab bar; header shows logo, search and menu. Pipeline: chip row + snap columns. Onboarding: single column, sticky
  footer with Back/Continue above the safe area. Landing: hamburger menu, stacked hero, single-column pricing.
- **768–1279 px**: Sidebar visible; dashboard tiles 3 per row; cards stack in one column below `lg`.
- **≥ 1280 px**: Tiles 6 per row; three-column card grid (closing soon spans two); pipeline shows ~4–5 columns at
  1440 px with horizontal scroll inside the board.

### Accessibility

- Landmarks: `nav[aria-label="Main"]` / `"Primary"` / `"Mobile"`, `main#main`, `section[aria-label="Key numbers"]`,
  Kanban columns as `section` with `aria-label="<Stage> — N bids"`.
- Keyboard: skip link, visible focus ring (`focus-ring`), dnd-kit keyboard sensor with announcements, *(gap)* "Move to…"
  menu, Radix accordion/tabs/select/dialog patterns, `Esc` closes overlays.
- Screen readers: charts as `role="img"` with summaries; status icons have `aria-label` ("Done", "To do", "New");
  decorative icons `aria-hidden`; error states `role="alert"`; live preview `aria-live="polite"`.
- Colour: tokens tuned for AA in light and dark; status never conveyed by colour alone (badges carry text, e.g.
  "Expired 5d ago").
- Motion: Framer Motion animations disabled with `useReducedMotion()`.

### Key Entities *(include if feature involves data)*

- **DashboardResponse**: computed view (`packages/core/src/contracts/experience.ts`) — tiles, stats, closingSoon,
  pipeline, pipelineValue, verdicts, matchesByDay, recentMatches, expiringDocuments, activity, setup, setupComplete, demo,
  generatedAt; *(gap)* myWork, awaitingDecision.
- **Bid workspace** (`bid_workspaces`): stage, position (real), owner, assignees, due date, outcome {result, l1Price,
  ourPrice, notes, at}, submittedAt; one per (org, tender).
- **Organization onboarding state** (`organizations.onboarding_state` jsonb): booleans `company`, `categories`,
  `watchlist`, `documents`, `skipped`, `completed`, `demo`; `organizations.plan` (`trial` default).
- **Activity entry** (`activity_log`): action, entity type/id, meta (incl. `demo: true` for demo rows), actor, time.
- **Demo dataset**: `DEMO_COMPANY`, `DEMO_WATCHLISTS`, 40 planned tenders (`raw.demo`), `SeedDemoResult`.
- **Plan** *(gap)*: name, monthly INR price, features, limits — marketing source of truth.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user reaches a populated matched feed within 5 minutes of sign-up (parent SC-004); the scripted E2E
  completes sign-up → onboarding → feed in < 90 s, and *(gap)* the median `onboarding.completed.durationSec` in production
  is ≤ 300.
- **SC-002**: For the demo org, 100% of the six KPI tiles and nine pipeline counts equal SQL ground truth (API test).
- **SC-003**: 0 serious/critical axe violations on 11 core pages × 2 viewports × 2 themes.
- **SC-004**: 0 pages with horizontal page scroll at 375 px.
- **SC-005**: 7/7 user-story E2E specs for 007 pass in CI against real Postgres with evidence attached.
- **SC-006**: Landing Lighthouse mobile scores meet NFR-003 on three consecutive runs.
- **SC-007**: After "Remove demo data", 0 rows with demo provenance remain in the org and 100% of user-created rows
  are preserved (API test).
- **SC-008**: Owners can act on "what needs me today" from the first phone viewport: greeting, summary line and ≥ 4 KPI
  tiles visible at 375×812 without scrolling.

## Assumptions

- Authentication, org switching, invitations and roles are delivered by 002; profile/vault by 005; analysis by 004; the
  workspace detail, readiness and packets by 006 — this spec only consumes their APIs.
- Billing and plan enforcement are out of scope: `organizations.plan` stays `trial`; pricing on the landing page is
  marketing copy that must match the plans config (FR-086).
- WhatsApp/email alert delivery is owned by 003; demo data never triggers it.
- The landing page stays part of the SPA (client-rendered) for v1; SEO needs are met with static `<head>` meta in
  `apps/web/index.html` plus `robots.txt`/`sitemap.xml`; prerendering is a later option.
- Reference repositories are scrapers/CLIs, not UI code; only `arush15june/gem-search` (MIT) has portable logic for this
  area (public award/result parsing for outcome hints, P3, via 003 ingestion). Unlicensed repos
  (`PranavTamada_Tender_Scraper`, `Giri-Aayush_gem`, `Giridar33_gem-tender-tracker`) inform ideas only (keyword-boundary
  matching for onboarding keywords, profile-driven setup, dashboard tabs).
- E2E runs in Chromium only (desktop + Pixel 7 emulation); real-device testing on iOS Safari is a manual QA check.
