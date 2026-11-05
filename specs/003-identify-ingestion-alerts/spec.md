# Feature Specification: Identify — GeM Ingestion, Watchlists, Matching & Alerts

**Feature Branch**: `003-identify-ingestion-alerts`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Identify area of TenderPilot in detail: GeM BidPlus client & parser, normalisers, mock-gem,
ingestion service & runs, corrigendum detection, watchlist criteria & matcher, notifications (in-app / email / WhatsApp,
instant / daily digest), tender feed with filters and saved views, watchlist builder, notifications UI. Port richer
capabilities from the reference repos (bid results / award status, reverse-auction results, change summaries, awarded-bid
winners as competitive intel) as P2/P3 stories where valuable."

**Parent spec**: [`specs/001-gem-tender-copilot/spec.md`](../001-gem-tender-copilot/spec.md) — User Story 1 ("Discover
matching GeM bids and get alerted"), FR-001…FR-007, SC-001. This spec refines that story into independently testable
slices, describes what is **built today** (verified against the code on 2026-11-05) and adds requirements for the gaps
that matter. Requirements marked *(gap)* are not implemented yet; everything else is implemented and covered by
unit/API tests.

## Personas affected

| Persona | Role in the app (server-enforced) | What they do in this area |
|---|---|---|
| **Owner (MSME founder / OEM sales head)** | `owner` | Wants to hear about relevant bids on WhatsApp while travelling; sets up first watchlists. |
| **Bid Manager** | `bid_manager` | Owns the feed every morning, triages matches, runs "Sync now", edits watchlists. |
| **Bid Analyst** | `analyst` | Creates/edits watchlists, scores tenders opened from the feed, dismisses irrelevant matches. |
| **Viewer (sales / OEM partner / consultant)** | `viewer` | Read-only: browses the feed, sees sync health, receives alerts, cannot create watchlists or sync. |
| **Platform operator (TenderPilot team)** | n/a (logs, cron) | Watches ingestion health, GeM format drift and alert delivery failures. |

Role hierarchy: `owner` > `bid_manager` > `analyst` > `viewer`. "At least X" means X or any higher role.

## User Scenarios & Testing *(mandatory)*

> QA conventions for every scenario: the E2E stack is `pnpm e2e` (Playwright, desktop 1440×900 and Pixel 7 for `@mobile`)
> with `tools/mock-gem` on :4011 standing in for GeM BidPlus. mock-gem serves 36 recorded bids (4 pages × 10, last page 6)
> rebased so that the fixture reference date maps to "now", plus 6 queued "extra" bids released with
> `POST /__admin/publish {count}` in order: `GEM/2026/B/6421101` (Laptop – Notebook, 75 units, Maharashtra / Higher and
> Technical Education Department), `…6421102` (CCTV Camera, Maharashtra / Home Department), `…6421103` (Manpower
> Outsourcing, Rajasthan), `…6421104` (Solar Power Pack, MNRE), `…6421105` (Office Chair, Karnataka), `…6421106` (Hiring of
> Vehicles, Gujarat). Outages: `POST /__admin/fail {mode:'down'|'html'|'off'}`; corrigendum: `POST /__admin/corrigendum/<bidNumber>
> {days}`; reset: `POST /__admin/reset`. API errors always have the shape `{ "error": { "code", "message", "details?" } }`.
> All times are shown in IST.

### User Story 1 - Polite, reliable GeM BidPlus ingestion with visible sync health (Priority: P1) (#62)

Every 30 minutes (Cloudflare Cron `*/30 * * * *`; Node in-process cron locally) and whenever a Bid Manager clicks
**Sync now**, TenderPilot fetches the newest public GeM BidPlus listing pages through a polite client (CSRF session
bootstrap, ≤ 1 request/second, honest User-Agent, retry with exponential back-off on network errors / 429 / 5xx,
re-bootstrap once on 403/419). Each bid is normalised (Indian amounts in lakh/crore → rupees, IST dates → UTC instants,
ministry/department/organisation, state & city derived from buyer office, bid type bid/RA/bunch/service, HSN codes,
status, document URL) and upserted idempotently by bid number with a content hash. Every run is recorded with counts and
errors, and every user sees a sync-health pill ("Synced 4 min ago · 1,243 open bids") on the feed.

**Why this priority**: Nothing else in Identify works without tenders in the database; ingestion that silently stops or
duplicates data destroys trust in alerts.

**Independent Test**: Against mock-gem, sign in as a Bid Manager on an empty database, click **Sync now**, and verify 36
tenders appear, the run is listed as `success` with "36 new · 0 updated", a second sync creates nothing new, and an
outage produces a `failed` run without losing data.

**Acceptance Scenarios**:

1. **Given** an empty `tenders` table and mock-gem with 36 bids, **When** a Bid Manager calls `POST /api/ingestion/run`
   with `{"pages":5}`, **Then** the response is `200` with `status:"success"`, `pagesFetched:4`, `tendersSeen:36`,
   `tendersCreated:36`, `tendersUpdated:0`, `error:null`, and 36 `tender_events` of kind `created` exist.
2. **Given** scenario 1 completed, **When** the tender `GEM/2026/B/6421001` is fetched via `GET /api/tenders?q=6421001`,
   **Then** it has `state:"Maharashtra"`, `emdAmount:240000`, `estimatedValue:9600000`, `bidType:"bid"`, `status:"open"`
   and `sourceUrl` ending in `/showbidDocument/7421001`.
3. **Given** scenario 1 completed and nothing changed on GeM, **When** a second sync runs, **Then** the run reports
   `tendersSeen:36`, `tendersCreated:0`, `tendersUpdated:0`, `matchesCreated:0`; the tender count stays 36; no new
   `tender_events` or notifications exist; only `fetchedAt` moves forward.
4. **Given** `POST /__admin/fail {"mode":"down"}` on mock-gem, **When** a sync runs, **Then** the run ends `failed` with an
   error containing `HTTP 503` or `unreachable`, the tender count is unchanged, `GET /api/ingestion/runs` returns
   `lastRun.status:"failed"` and a non-null `lastSuccessAt`, and the feed pill shows a red dot with the popover heading
   "Last sync failed" and the error text.
5. **Given** `POST /__admin/fail {"mode":"html"}`, **When** a sync runs, **Then** the run ends `failed` with an error
   containing "HTML" ("GeM returned HTML instead of JSON (portal changed or blocked)").
6. **Given** a run with `status:"running"` that started less than 15 minutes ago, **When** a Bid Manager clicks
   **Sync now**, **Then** the API returns `409` with `error.code:"ingestion_running"` and message "A GeM sync is already
   running — results will appear shortly."; **and given** the running row is older than 15 minutes, **When** a new sync
   starts, **Then** the old row is marked `failed` with error "Timed out (worker stopped)" and the new run proceeds.
7. **Given** an Analyst or Viewer, **When** they call `POST /api/ingestion/run`, **Then** the API returns `403` with
   message "You need to be at least a Bid Manager to do that", and the **Sync now** button is not rendered in the sync
   popover for them; `GET /api/ingestion/runs` returns `200` for every role.
8. **Given** the feed at `/tenders`, **When** the last successful run finished within 2 hours, **Then** the pill reads
   "Synced <relative time>" with a green pulsing dot and "· <n> open bids" (hidden below 640 px); **When** the last
   success is older than 2 hours **Then** the dot is amber and the popover heading is "Sync is overdue"; **When** no run
   ever happened **Then** it reads "Not synced yet" and the popover heading is "Waiting for the first sync".
9. **Given** the sync popover is open, **Then** it lists up to 6 recent runs with IST start time, "Manual"/"Scheduled",
   "<created> new · <updated> updated · <matches> matches" (or the error for failed runs) and a status badge
   (`success`/`partial`/`failed`/`running`), plus the footer "Public listings only · ≤ 1 request/sec".
10. *(gap)* **Given** the previous successful run was more than 2 hours ago (e.g. after an outage), **When** the next run
    starts, **Then** it pages until it reaches a page containing only already-known, unchanged bids or the catch-up cap
    of 20 pages, whichever comes first, and `pagesFetched` reflects that.
11. *(gap)* **Given** a Bid Manager triggered a manual sync less than 2 minutes ago that finished, **When** they click
    **Sync now** again, **Then** the API returns `429` with `error.code:"sync_cooldown"` and a message stating when the next
    manual sync is allowed; the button shows that as a tooltip.
12. *(gap)* **Given** a listing page where more than 50 % of the docs lack `b_bid_number` or the response lacks
    `response.response.docs`, **When** a sync runs, **Then** the run ends `failed` with error starting "GeM response
    format changed" and an `error`-level log entry `ingestion.format_drift` is emitted.

---

### User Story 2 - Build, preview and manage watchlists (Priority: P1) (#63)

A Bid Analyst (or higher) describes what the company sells: include keywords, exclude keywords, GeM categories, HSN codes,
buyer states, ministries/buyers, an estimated-value range, a minimum time-to-prepare and bid types. While typing, a live
preview shows how many open GeM bids match **right now** with up to 5 samples and the reasons they match. Saving back-fills
matches for currently open bids **silently** (no alert storm); alerts fire only for bids ingested afterwards. Watchlists
can be edited, paused/resumed and deleted. Matching is deterministic (Constitution III) and explains itself with reason
chips such as `Keyword “laptop”`, `State: Maharashtra`, `HSN 8471`, `Buyer: NTPC`, `Value ₹96 L`, `Value not published`.

**Why this priority**: Watchlists are how a seller tells the product what "relevant" means; without them there is no
matched feed and no alerts.

**Independent Test**: With 36 ingested bids, open `/watchlists`, create "Laptops — Maharashtra" (keyword `laptop`, state
Maharashtra), confirm the preview shows 2 bids before saving, save, and confirm the card shows "2" open bids and the feed's
**My matches** view lists exactly `GEM/2026/B/6421001` and `GEM/2026/B/6421010`, with no new notifications created.

**Acceptance Scenarios**:

1. **Given** an org with no watchlists and role ≥ Analyst, **When** the user opens `/watchlists`, **Then** the empty state
   "No watchlists yet" is shown with a **Build a watchlist** button and a "Quick start" grid of 6 templates (IT hardware;
   CCTV & security systems; Manpower & facility services; Medical equipment; Solar & electrical; Office furniture).
2. **Given** the **New watchlist** sheet is open and no criteria are entered, **Then** the preview panel reads "Add a
   keyword, state or buyer to see matching open bids."; **When** the user adds the keyword chip `laptop` and selects state
   `Maharashtra`, **Then** within ~1 s the preview shows the number `2`, the text "open GeM bids match right now", and two
   sample cards with bid number, countdown, buyer · state and reason badges `Keyword “laptop”` and `State: Maharashtra`.
3. **Given** criteria with zero matches (e.g. keyword `submarine`), **Then** the preview shows `0` and the note "Nothing open
   right now — that’s fine. You’ll be alerted the moment GeM publishes a matching bid."
4. **Given** a valid draft named "Laptops — Maharashtra", **When** the user clicks **Create watchlist**, **Then**
   `POST /api/watchlists` returns `201` with `matchCount:2`, `openCount:2`, `active:true`; a toast "“Laptops — Maharashtra”
   is live" with description "2 open bids already match — see them in your feed." appears; the sheet closes; and **no**
   notification rows are created for those 2 back-filled matches.
5. **Given** the draft name is empty or no criterion is set, **When** **Create watchlist** is clicked, **Then** inline
   errors read "Give the watchlist a name, e.g. “Laptops — Maharashtra”" and "Add at least one keyword, state, buyer,
   category, HSN code or value limit"; the API, if called directly with empty criteria, returns `400`
   `validation_error` "Add at least one keyword, category, HSN code, state, buyer, value limit or bid type".
6. **Given** min value 100 L and max value 10 L, **Then** the error "Maximum must be at least the minimum" is shown (API:
   `400` with field `criteria.maxValue`); **given** HSN chip `84A1`, **Then** the chip is rejected with "HSN codes are 2–8
   digits".
7. **Given** a watchlist with keyword `laptop` and exclude keyword `refurbished`, **When** a bid titled "Refurbished Laptop"
   is ingested, **Then** it is not matched. **Given** HSN `8471`, **Then** a bid with HSN `84713010` matches with reason
   `HSN 8471`. **Given** keyword `laptop`, **Then** a bid titled "Laptops" matches (plural) and a bid titled "Laptopbag"
   does not (word boundary).
8. **Given** a watchlist with min value ₹10 L, **When** a matching bid has no published value, **Then** it still matches
   and shows the reason `Value not published`. **Given** "Time to prepare: At least a week left", **Then** bids closing in
   fewer than 7 days are not matched.
9. **Given** an active watchlist card, **When** the user toggles its switch off, **Then** `PATCH /api/watchlists/:id
   {active:false}` returns `200`, the card shows a "Paused" badge, the toast "“<name>” paused" / "No alerts until you resume
   it." appears, and subsequent ingestions create no matches for it; toggling on shows "“<name>” resumed" and back-fills
   silently.
10. **Given** the user edits criteria so a previously matched bid no longer matches, **When** they click **Save changes**,
    **Then** the toast "Watchlist updated" appears and that bid disappears from `GET /api/tenders?watchlistId=<id>`.
11. **Given** **Delete** from the card menu, **Then** a confirm dialog "Delete “<name>”?" explains "Its matches disappear
    from the feed and no more alerts are sent. Tenders you’ve already analysed or started a bid for are kept."; confirming
    returns `200 {ok:true}`, shows "Watchlist deleted" and removes the card.
12. **Given** a Viewer, **Then** the **New watchlist** button and templates are hidden, the pause switch is disabled, and
    `POST /api/watchlists` returns `403` "You need to be at least an Analyst to do that". **Given** a watchlist id of
    another org, **Then** `PATCH`/`DELETE` return `404` "Watchlist not found".
13. **Given** watchlists exist, **Then** `/watchlists` shows 3 stat tiles — "Active watchlists" (`<active> / <total>`),
    "New matches this week" (links to `/tenders?matched=1&unseen=1`), "Open matched bids" (links to `/tenders?matched=1`) —
    and each card shows its criteria chips plus "Open bids", "This week", "All time" counts and a **View matches** action
    linking to `/tenders?watchlistId=<id>&matched=1`.
14. *(gap)* **Given** an org already has 50 watchlists, **When** a user creates another, **Then** the API returns `409`
    `watchlist_limit` "You can have up to 50 watchlists — pause or delete one first."
15. *(gap)* **Given** more than 5,000 open tenders satisfy the cheap SQL pre-filter, **When** a preview or back-fill runs,
    **Then** every matching open tender is still found (no silent truncation at 5,000).

---

### User Story 3 - Triage the tender feed: search, filters, sort, views (Priority: P1) (#64)

The `/tenders` feed is the hero screen. It lists open GeM bids (newest first by default) as cards or a table with bid
number, type badge (Reverse auction / Bunch bid / Service), corrigendum badge, title, buyer, location, matched watchlist and
reason chips, closing countdown, EMD, estimated value, quantity and the Go/No-Go score or a **Score it** button. Users
search free text, filter by state, ministry, category, closing window, value, verdict and bid type (with live facet
counts), toggle **Matched only**, switch quick views (**My matches**, **New**, **Closing this week**, **Go verdicts**,
**All open bids**), sort, page infinitely, mark matches seen, hide irrelevant matches and turn any search into a watchlist.
Filters live in the URL so every view is shareable (alert emails link to `/tenders?matched=1`).

**Why this priority**: The feed is where the Bid Manager spends the first 15 minutes of every day; finding the right
bids quickly is the core value.

**Independent Test**: With 36 ingested bids and the "Laptops — Maharashtra" watchlist, open `/tenders`, filter State =
Maharashtra, search `laptop`, verify the count updates to the matching bids, open **My matches**, open a card, return and
verify its "New" dot is gone; dismiss it and undo.

**Acceptance Scenarios**:

1. **Given** 36 open tenders, **When** the user opens `/tenders`, **Then** 5 skeleton cards render while loading, then the
   header "Tenders", the result count "36 tenders", the first 25 cards sorted newest first, and a **Load more (11 left)**
   button / auto-load sentinel; after loading the rest the footer reads "That’s all 36 tenders."
2. **Given** the feed, **When** the user types `laptop` in "Search item, buyer, bid number, city…" (or presses `/` to focus
   it), **Then** after ~350 ms the URL gains `?q=laptop` and the list/count update without a page reload; clearing with
   the × restores 36.
3. **Given** the filter rail (desktop ≥ 1024 px) or the **Filters** sheet (bottom sheet on phones, right sheet on tablets),
   **When** the user ticks State "Maharashtra", **Then** the URL gains `state=Maharashtra`, the list shows only Maharashtra
   bids, an active chip "Maharashtra" appears (click removes it), the **Filters** button shows a count badge `1`, and other
   facets show counts computed with the state filter applied while the State facet itself keeps all states selectable.
4. **Given** the filters "Closing within 7 days", value preset "₹10 L – ₹1 Cr", bid type "Reverse auction" and verdict
   "Not analysed", **Then** the API is called with `closingWithinDays=7&minValue=1000000&maxValue=10000000&bidType=ra&verdict=none`
   and every listed bid satisfies all of them; **Clear all** resets refinements but keeps the search text and sort.
5. **Given** sort options "Newest first", "Closing soonest", "Best match", "Highest score", "Highest value", **When** the user
   picks "Closing soonest", **Then** `sort=endAt` is set and cards are ordered by end date ascending with unknown dates last.
6. **Given** the org has matches, **When** the user clicks the **My matches** view, **Then** only tenders matched by one of
   the org's watchlists (not dismissed) are shown sorted by relevance, each with a primary badge naming the watchlist (or
   "<n> watchlists") and up to 3 reason chips plus "+<n> more".
7. **Given** a matched tender not yet opened by anyone in the org, **Then** its card shows a pulsing "New" label and a left
   accent bar; **When** a user opens it, **Then** `POST /api/tenders/:id/seen` marks the org's matches seen, the related
   in-app notification for that user becomes read, and the **New** view no longer lists it. When the **New** view is empty
   it shows "You’re all caught up".
8. **Given** a matched tender, **When** the user chooses "Not relevant — hide" in the card's "More actions" menu, **Then**
   the toast "Hidden from your feed" with **Undo** appears and the tender disappears from the feed; **Undo** restores it.
   **Given** an unmatched tender, `POST /api/tenders/:id/dismiss` returns `409` "Only tenders that match one of your
   watchlists can be dismissed".
9. **Given** the search `cctv` and state Maharashtra, **When** an Analyst clicks **Save as watchlist**, **Then** the
   watchlist sheet opens pre-filled with name "cctv · Maharashtra", keyword `cctv` and state Maharashtra. For Viewers the
   button is hidden; for a pristine feed it is disabled.
10. **Given** no tenders exist and the feed is pristine, **Then** the empty state "No tenders yet" shows with **Sync with GeM
    now** for Bid Managers; **given** **Matched only** is on and the org has no watchlists, **Then** "Tell us what you sell"
    shows with **Create a watchlist** and **Browse all open bids**; **given** filters exclude everything, **Then** "No tenders
    match these filters" shows with **Clear filters** and **Alert me when one appears**.
11. **Given** the API returns `500`, **Then** an error state with a **Retry** button is shown instead of the list.
12. **Given** a desktop viewport, **When** the user toggles the layout to table, **Then** a table renders (preference
    remembered in localStorage `tp.feed.layout`); on a 375 px viewport the toggle is hidden and cards are always used, with
    no horizontal scroll.
13. **Given** `GET /api/tenders?status=bogus` or `pageSize=500`, **Then** the API returns `400` `validation_error`.
14. *(gap)* **Given** a Bid Manager has a filtered feed (e.g. Maharashtra + Closing ≤ 7 days + Highest value), **When** they
    click **Save view** and name it "MH urgent", **Then** a personal tab "MH urgent" appears after the built-in views,
    persists across devices (server-side), re-applies the exact filters when clicked, and can be renamed or deleted from the
    tab's menu.
15. *(gap)* **Given** the status selector, **When** the user picks "Closed" or "Awarded", **Then** the feed lists bids with
    that status (the API already supports `status=closed|cancelled|awarded|all`).
16. *(gap)* **Given** the search box contains a full bid number such as `GEM/2026/B/6421001`, **When** the user presses
    Enter, **Then** the app navigates directly to that tender's page if exactly one tender has that bid number.

---

### User Story 4 - Get alerted in-app, by email and on WhatsApp — instantly or as a daily digest (Priority: P1) (#65)

When ingestion creates a new match, every member of that org gets alerts on the channels they chose in **Settings →
Notifications**: in-app (bell + `/notifications`), email (Resend) and WhatsApp (Meta Cloud API, approved template
`tender_alert`), either **Instant** or as one **Daily** digest at 08:00 IST. Each tender alerts an org member at most
once per channel. The in-app notification shows the delivery status of its email/WhatsApp copies ("delivered", "queued",
"not sent", "failed" with the reason). Missing integrations degrade to `skipped` with a clear reason, never to crashes.

**Why this priority**: Being told about a matching bid before competitors is what sellers pay for; alerts are the
product's heartbeat.

**Independent Test**: With the "Laptops — Maharashtra" watchlist, publish `GEM/2026/B/6421101` on mock-gem, run a sync,
and verify a bell badge "1", a notification "New match: Laptop - Notebook…" linking to the tender, an email row whose
delivery status is visible, and that a second sync sends nothing new.

**Acceptance Scenarios**:

1. **Given** the watchlist "Laptops — Maharashtra" and 4 org members with default preferences (in-app on, email on,
   WhatsApp off, instant), **When** `GEM/2026/B/6421101` is published and a sync runs, **Then** the run reports
   `tendersCreated:1, matchesCreated:1`; each member gets one in-app notification (status `sent`) titled
   "New match: Laptop - Notebook" with body "GEM/2026/B/6421101 · Higher and Technical Education Department, Maharashtra ·
   closes <d Mon, h:mm am/pm> IST · … — matched “Laptops — Maharashtra”" and link `/tenders/<id>`; and one email row
   (status `pending`) per member.
2. **Given** scenario 1, **When** the user looks at the top bar, **Then** the bell shows a red badge `1` and aria-label
   "Notifications, 1 unread"; opening it shows "Notifications", a "1 new" pill, **Mark all read**, the item, and links
   **View all** and **Alert settings**. The bell refreshes at least every 60 s without a page reload.
3. **Given** a manual **Sync now** or the next scheduled tick, **When** `dispatchNotifications` runs with email configured,
   **Then** each pending instant email is sent once with subject = notification title, an HTML card containing the bid
   number, buyer · state, "Closes" (IST, red when < 3 days), EMD, Value, Qty, "Matched “Laptops — Maharashtra”", a
   **Review & score this bid →** button and the footer "Price entry, OTP / DSC and final submission on GeM are always done by
   you."; the row becomes `sent` with `sentAt`, and the in-app item shows "Email delivered".
4. **Given** `RESEND_API_KEY` is not set, **Then** the email row becomes `skipped` with error "Email is not configured
   (RESEND_API_KEY)" and the in-app item shows "Email not sent" with that reason in its tooltip; **given** the provider
   throws, **Then** the row becomes `failed` with the provider error.
5. **Given** a user who enabled WhatsApp in settings, **When** they try to save without a valid mobile number, **Then** the
   form shows "Add a valid 10-digit mobile number to get WhatsApp alerts" (API: `400` "Add your mobile number in your
   profile to receive WhatsApp alerts"); with `98220 12345` it saves as `+919822012345` and the toast "Notification
   preferences saved" appears. On a match, a WhatsApp row is created `pending` and sent with template `tender_alert` and
   params [title, bid number, closes IST, link]; with `WHATSAPP_TOKEN` unset it becomes `skipped` "WhatsApp is not configured
   (WHATSAPP_TOKEN)"; if the phone was later removed it is created `skipped` "Add a mobile number in your account to receive
   WhatsApp alerts".
6. **Given** a user with frequency **Daily**, **When** matches are created at 06:00 IST, **Then** their email/WhatsApp rows
   stay `pending` (counted as `held`) until the first dispatch at or after 08:00 IST, which sends exactly one digest per
   channel with subject "Daily digest: <n> new GeM tender(s) matched today" and link `/tenders?matched=1`; a second
   dispatch the same IST day sends no second digest (new rows wait for the next day). In-app alerts remain instant.
7. **Given** the same tender is ingested again or re-matched by a second watchlist of the same org, **Then** no second
   notification is created for any (user, channel) — dedupe key `tender:<tenderId>:<orgId>`.
8. **Given** `/notifications`, **Then** items are grouped by day, the segmented filter **All / Unread (<n>)** works
   (`?unread=1`), **Mark all read** sets every in-app item to read (`POST /api/notifications/read-all` →
   `{ok:true, updated:<n>}`) and toasts "Marked <n> notifications as read", clicking an item marks it read and navigates to its link, and **Load older** pages 25 at a
   time. Empty states: "No notifications yet" (with **Set up watchlists** and **Alert settings**) and, under Unread,
   "You’re all caught up".
9. **Given** user A in org X, **Then** `GET /api/notifications` never returns user B's or org Y's notifications, and
   `POST /api/notifications/<other user's id>/read` returns `404` "Notification not found".
10. **Given** a user turned off in-app alerts, **Then** no in-app row is created for them but email/WhatsApp still follow
    their settings.
11. *(gap)* **Given** an email or WhatsApp send fails with a transient error (network, 429, 5xx), **Then** the row is retried
    on the next 2 dispatches with back-off and only marked `failed` after 3 attempts; the attempt count is stored.
12. *(gap)* **Given** an alert email, **Then** it carries `List-Unsubscribe` / `List-Unsubscribe-Post` headers whose one-click
    link turns off email match alerts for that user/org and shows "You won’t get match emails from <org> any more."
13. *(gap)* **Given** `GET /api/notifications?kind=bogus`, **Then** the API returns `400` `validation_error` (today the value is
    passed through unvalidated).

---

### User Story 5 - Corrigendum & change tracking with clear change summaries (Priority: P2) (#66)

GeM buyers frequently amend bids (end-date extensions, quantity or EMD changes, new documents). TenderPilot compares each
re-ingested bid with the stored copy on tracked fields; a change to end date, opening date, quantity, items, EMD, estimated
value, ePBG, document URL or title is recorded as a **corrigendum** event with a field diff, marks the org's existing
analyses **stale** ("Re-check"), shows a "Corrigendum" badge for 7 days and notifies orgs that track the tender. Closing and
cancellation are recorded as their own events. This story completes the built in-app heads-up with a human-readable change
summary and delivery on every channel the user chose (approach adapted from erenmyeager15's watchlist change summaries,
Apache-2.0).

**Why this priority**: Missing an end-date extension or a quantity change makes a prepared bid wrong; but it builds on
US1–US4 and affects fewer bids than new matches.

**Independent Test**: Analyse `GEM/2026/B/6421001`, extend its end date by 7 days on mock-gem, sync, and verify the
history entry "Corrigendum issued" with the before/after dates, the "Re-check" badge on the score, the "Corrigendum" badge
on the card, and an alert that names the change.

**Acceptance Scenarios**:

1. **Given** `GEM/2026/B/6421001` was ingested and matched, **When** `POST /__admin/corrigendum/GEM%2F2026%2FB%2F6421001
   {"days":7}` is applied and a sync runs, **Then** the run reports `tendersUpdated:1, tendersCreated:0`, the tender's
   `endAt` is exactly 7 days later, one `tender_events` row of kind `corrigendum` has `changes = {endAt:{from,to}}`, and the
   match is not duplicated.
2. **Given** scenario 1 and an existing analysis (score 72, Go) for the org, **Then** the analysis has `stale:true`, the feed
   card shows the score ring with a "Re-check" badge (tooltip "A corrigendum changed this bid after it was scored — re-run the
   analysis.") and a "Corrigendum" badge (tooltip "GeM published a corrigendum this week — dates or terms changed.").
3. **Given** scenario 1, **When** the user opens the tender's History tab, **Then** the newest entry is "Corrigendum issued"
   in a highlighted box with a "Re-check eligibility" badge and the change list showing the old and new end date in IST.
4. **Given** scenario 1, **Then** every member of each org that tracks the tender (has a match) with in-app enabled gets one
   in-app notification "Corrigendum: <title>" with body "<bid number> was amended on GeM — now closes <date> IST. Re-check the
   analysis before you bid." and link `/tenders/<id>`; a second identical sync creates no duplicate (dedupe on content hash).
5. **Given** a listing value disappears (e.g. EMD no longer on the listing) but was known before, **Then** the stored value
   is kept and no corrigendum is recorded for it.
6. **Given** an open bid whose end date passes, **Then** the next sync sets `status:"closed"`; **given** GeM marks it
   cancelled, **Then** a `cancelled` event is recorded and the History tab shows "Bid cancelled".
7. *(gap)* **Given** scenario 1 for a user with email (and/or WhatsApp) enabled and **Instant** frequency, **Then** a
   corrigendum email/WhatsApp is queued and sent with the same dedupe semantics, and in-app/email bodies contain a human
   summary of every changed field, e.g. "Bid end date: 19 Nov, 3:00 pm → 26 Nov, 3:00 pm IST · Quantity: 75 → 90".
8. *(gap)* **Given** a corrigendum notification, **Then** its `kind` is `corrigendum` (not `deadline`), it shows a
   "Corrigendum" label and warning icon in the bell and `/notifications`, and can be filtered with `?kind=corrigendum`.
9. *(gap)* **Given** a tracked tender is cancelled on GeM (`b_is_cancelled`), **Then** tracking orgs get an alert "Cancelled on
   GeM: <title>" on their chosen channels, and any bid workspace for it shows a "Cancelled on GeM" banner.

---

### User Story 6 - Bid results, award status and competitor intelligence (Priority: P3) (#67)

After a tracked bid closes, sellers want to know who won and at what price — to learn L1 price levels, spot frequent
competitors and decide whether to bid on similar tenders. TenderPilot periodically checks the public GeM results for closed
tenders that the org tracked (matched, analysed or with a workspace), stores the evaluation status (Not evaluated / Technical
evaluated / Financial evaluated / Awarded) and the public bidder table (rank, seller name, price, L-level), and summarises
winners per category and buyer. The approach is ported from arush15june/gem-search (MIT: `bidrastatus` search with `byStatus`
filter and `getBidResultView` parsing, `b_buyer_status` mapping); reverse-auction schedule links and "winner ≠ lowest
price" anomaly flagging are re-implemented from ideas in IshanMaheshwari-777/GEM-SCRAPER and rounittxx/gem-bid-scraper
(no licence — ideas only, no code copied).

**Why this priority**: Valuable competitive insight and a reason to come back after a bid, but not needed to find and
prepare bids.

**Independent Test**: With mock-gem serving a recorded result page for a closed tracked bid, run the results refresh and
verify the tender page shows "Awarded", the bidder table with L1 highlighted, and the competitor summary lists the winner.

**Acceptance Scenarios**:

1. **Given** a tracked tender that closed within the last 30 days, **When** the scheduled results refresh runs, **Then** the
   tender is looked up via the public submitted-bids search and its status becomes `awarded` when GeM reports
   `b_buyer_status = 3`; status changes are recorded as `tender_events` and the client still makes ≤ 1 request/second.
2. **Given** an awarded tender with a public result page, **Then** `GET /api/tenders/:id/result` returns `200` with
   `{ evaluationStatus:"awarded", bidders:[{rank, seller, price, level:"L1"}, …], fetchedAt }` and the tender page shows a
   **Result** tab with the bidder table (L1 row highlighted, prices in ₹ with Indian grouping) and the source link to GeM.
3. **Given** no result is published yet, **Then** the endpoint returns `200` with `evaluationStatus` (e.g. "Technical
   evaluated") and `bidders:[]`, and the tab reads "GeM hasn’t published the result yet. We check daily for 30 days after
   closing."
4. **Given** a tracked tender becomes awarded, **Then** org members with in-app alerts get "Result published: <title> — L1
   <seller> at ₹<price>" (dedupe per tender per org).
5. **Given** the org's awarded tracked tenders, **When** a Bid Manager opens **Insights → Competitors**, **Then** a table lists
   sellers ranked by wins with win count, total awarded value and categories, filterable by category and buyer state;
   "winner is not the lowest price" cases are flagged.
6. **Given** the results page returns HTML the parser cannot read, **Then** the refresh records the error on the run and
   leaves existing result data untouched.

---

### Edge Cases

- **GeM unreachable / 5xx / 429**: client retries 3 times with exponential back-off (honouring `Retry-After`), then the page
  is recorded as failed; ingestion stops paging (polite) and the run is `failed` (no page fetched) or `partial` (≥ 1 page).
  Data from earlier runs is never deleted.
- **Expired CSRF/session (403/419)**: the client re-bootstraps the session once and retries.
- **GeM "no results"** is a JSON body with `code:404` — treated as an empty page, not an error.
- **HTML instead of JSON** (portal change, block page): run `failed` with "GeM returned HTML instead of JSON (portal changed or
  blocked)".
- **Docs without a bid number** are dropped; *(gap)* > 50 % such docs on a page is treated as format drift.
- **Concurrent runs** (cron + manual): single-flight via a `running` row younger than 15 minutes; a concurrent insert of the
  same bid is absorbed by `ON CONFLICT DO NOTHING` on `(source, bid_number)`.
- **Amounts** "₹ 5 Lakh" → 500000, "1.2 Crore" → 12000000, "12,34,567" → 1234567, "Rs. 25,000/-" → 25000; non-numeric → null.
- **Dates**: GeM times are IST; stored as UTC instants; always displayed in IST with the "IST" suffix.
- **Multi-item bids**: title becomes "<first item> + <n> more items"; every item is kept in `items[]` and searchable.
- **Bid types**: `b_bid_type` 2/5 → reverse auction (document route `showradocumentPdf` / `list-ra-schedules` /
  `showdirectradocumentPdf`), bunch flag → bunch, service categories → service.
- **State unknown**: state derived from ministry name when it is a state government, else from buyer office / organisation;
  otherwise null (state-restricted watchlists then do not match).
- **Unknown estimated value**: value-limited watchlists still match with reason "Value not published"; feed value filters
  exclude unknown values.
- **Closed / cancelled / past-deadline bids** never create matches or alerts.
- **Watchlist with only exclude keywords or only "time to prepare"** is rejected — it would alert on everything.
- **Creating/editing a watchlist** never sends alerts for existing bids (silent back-fill).
- **User without phone but WhatsApp on** (phone removed later): WhatsApp row `skipped` with a reason.
- **Daily digest timing** uses the IST calendar day; rows created before 08:00 IST wait for that day's digest.
- **Notification for a deleted tender**: email falls back to a plain card with title/body.
- **Large feed**: pagination 25 per page (max 100); facets limited to 60 values per dimension.
- **Org isolation**: tenders are global public data; matches, seen/dismissed, analyses, notifications are always scoped to
  the caller's org (and user for notifications).

## Requirements *(mandatory)*

### Functional Requirements

**Ingestion (US1)**

- **FR-001**: The system MUST fetch public GeM BidPlus listing pages via `GET /all-bids` (CSRF bootstrap from
  `csrf_gem_cookie` or the `csrf_bd_gem_nk` token in the HTML) and `POST /all-bids-data` with form body
  `payload=<json>&csrf_bd_gem_nk=<token>`, sorted `Bid-Start-Date-Latest`, on a 30-minute schedule and on demand.
- **FR-002**: The GeM client MUST serialise requests, space them ≥ `GEM_MIN_INTERVAL_MS` (default 1000 ms) apart, send the
  User-Agent `TenderPilot/0.1 (+https://tenderpilot.in/bot; public BidPlus listings only)`, time out after 30 s, retry up to
  3 times on network errors / 429 / 5xx with exponential back-off (or `Retry-After`), and re-bootstrap the session once on
  403/419.
- **FR-003**: The parser MUST normalise each BidPlus doc into: bid number, GeM `b_id`, bid type (bid/ra/bunch/service), title
  (multi-item aware, ≤ 300 chars), items, category, quantity, ministry, department, organisation, buyer office, canonical
  Indian state, city, start/end/opening instants, EMD and estimated value in integer rupees, ePBG %, HSN codes, status
  (open/closed/cancelled/awarded), document URL (route by bid type), source URL, raw doc and a content hash over tracked
  fields only.
- **FR-004**: Ingestion MUST upsert by `(source, bid_number)`: unchanged content hash → only `fetched_at` moves; changed →
  update and record a `tender_events` row (`created`/`updated`/`corrigendum`/`closed`/`cancelled`) with a field diff; values
  that disappear from the listing but were known MUST be kept.
- **FR-005**: Ingestion MUST be single-flight (a `running` run younger than 15 min blocks a new one with `409
  ingestion_running`) and MUST reap runs stuck in `running` for > 15 min as `failed` "Timed out (worker stopped)".
- **FR-006**: Every run MUST be recorded in `ingestion_runs` with trigger (cron/manual/seed), status
  (running/success/partial/failed), pages fetched, tenders seen/created/updated, matches created, the first 5 errors
  (≤ 1000 chars), start and finish time.
- **FR-007**: After each run, open tenders whose end date has passed MUST be set to `closed`.
- **FR-008**: `POST /api/ingestion/run` (at least Bid Manager; body `{pages?: 1–20, search?: ≤100 chars}`) MUST run a sync,
  dispatch instant alerts best-effort and log activity `ingestion.run`; `GET /api/ingestion/runs` (any member) MUST return the
  last 20 runs, `lastSuccessAt`, `lastRun`, `totalTenders` and `openTenders`.
- **FR-009**: The feed MUST show a sync-health pill with states ok (success ≤ 2 h old), stale (> 2 h), error (last run
  failed) and never (no run), refreshing every 60 s, with recent runs and **Sync now** (Bid Manager+) in a popover.
- **FR-010**: `tools/mock-gem` MUST emulate `/all-bids`, `/all-bids-data` (paging, search, 404-no-results), the three document
  routes (generated PDFs) and admin endpoints `publish`, `corrigendum`, `fail`, `reset`, `state`, with fixture dates rebased
  to "now".
- **FR-011** *(gap)*: Ingestion MUST page incrementally: stop early when a full page contains only known, unchanged bids;
  after a gap of > 2 h since the last success, continue up to a catch-up cap of 20 pages.
- **FR-012** *(gap)*: Each scheduled run SHOULD add a targeted search pass: for up to 10 distinct active watchlist keywords
  (rotating across runs), fetch 1 page of GeM `fullText` results, so that matching bids beyond the newest pages are found.
  GeM search is token-OR, so results MUST still go through the exact matcher.
- **FR-013** *(gap)*: Manual sync MUST enforce a 2-minute cooldown per platform after a finished manual run (`429
  sync_cooldown`, message includes the time the next manual sync is allowed).
- **FR-014** *(gap)*: A page where > 50 % of docs lack a bid number, or a response missing `response.response.docs`, MUST fail
  the run with "GeM response format changed: <detail>" and log `ingestion.format_drift` at error level.

**Watchlists & matching (US2)**

- **FR-020**: Users with role ≥ Analyst MUST be able to create, edit (name/criteria), pause/resume and delete watchlists;
  all members can list them. Name 1–80 chars. Criteria: keywords, excludeKeywords, categories, ministries (≤ 50 each, ≤ 120
  chars per value, de-duplicated), HSN codes (2–8 digits, ≤ 50), states (≤ 40), minValue/maxValue (non-negative integer
  rupees, max ≥ min), minDaysToClose (0–365), bidTypes (subset of bid/ra/bunch/service).
- **FR-021**: A watchlist MUST have at least one positive criterion (keyword, category, HSN, state, ministry, value bound or
  bid type); otherwise `400 validation_error`.
- **FR-022**: The matcher MUST be pure and deterministic: AND across configured dimensions, OR within one; keywords are
  case-insensitive, word-boundary, phrase-aware (space/hyphen/underscore/slash interchangeable) with optional plural
  "s"/"es", searched in title, items, category and buyer; any exclude keyword rejects; categories substring-match category,
  items and title; HSN prefix-matches either way; states match exactly (case-insensitive); ministries substring-match
  ministry, department, organisation or buyer office; unknown value passes with reason "Value not published"; time-to-prepare
  requires ≥ N days left; closed/cancelled/past-deadline tenders never match.
- **FR-023**: Each match MUST be stored once per `(org, tender, watchlist)` with human-readable reasons and a relevance in
  0.05–1.00 (keyword hits, title hits and breadth raise it).
- **FR-024**: `POST /api/watchlists/preview` MUST return `{count, sample[≤5]}` of currently open tenders matching a draft,
  sorted by relevance then closing date, each with `previewReasons`, without saving anything.
- **FR-025**: Creating a watchlist, changing its criteria or resuming it MUST back-fill matches for currently open tenders
  without creating notifications, and MUST remove matches that no longer satisfy changed criteria (matches of tenders that
  have since closed are kept).
- **FR-026**: The watchlist list MUST return per watchlist: `matchCount`, `newThisWeek` (last 7 days), `openCount`,
  `lastMatchAt`, `createdBy`.
- **FR-027** *(gap)*: An org MUST NOT exceed 50 watchlists (`409 watchlist_limit`).
- **FR-028** *(gap)*: Preview and back-fill MUST find all matching open tenders regardless of volume (no silent cap at
  5,000 candidates); the SQL pre-filter SHOULD also narrow by categories and ministries.

**Feed (US3)**

- **FR-030**: `GET /api/tenders` MUST support: `q` (≤ 200 chars, each of up to 8 words must appear in title, bid number,
  category, ministry, department, organisation, buyer office, state, city or items), `state`, `ministry`, `category`
  (repeated keys or `|`-separated), `status` (open default / closed / cancelled / awarded / all), `closingWithinDays`,
  `minValue`, `maxValue`, `matched`, `watchlistId`, `verdict` (go/review/no_go/none), `stage`, `bidType`, `unseen`,
  `includeDismissed`, `sort` (endAt, -endAt, -createdAt default, score, -score, value, -value, relevance), `page` (≥ 1),
  `pageSize` (1–100, default 25); invalid values → `400 validation_error`.
- **FR-031**: The response MUST include `total` and facets for states, ministries and categories (≤ 60 each) where each facet
  is computed with every other active filter but not its own.
- **FR-032**: Each list item MUST carry org-scoped `matches[]` (watchlist id/name, reasons, relevance), latest `analysis`
  (score, verdict, stale), `workspace` (id, stage), `seen`, `isNew` (matched, unseen, not dismissed, matched < 7 days ago),
  `dismissed` and `hasCorrigendum` (corrigendum in the last 7 days).
- **FR-033**: `POST /api/tenders/:id/seen` MUST mark the org's matches seen and the caller's related in-app notifications
  read; `POST /api/tenders/:id/dismiss {undo?}` MUST hide/restore a matched tender for the org (`409` if not matched).
  Malformed or unknown ids → `404 Tender not found`.
- **FR-034**: The feed UI MUST keep all filters in the URL, debounce search by ~350 ms, support `/` to focus search, offer the
  built-in views My matches / New / Closing this week / Go verdicts / All open bids, cards and (desktop only) table layouts,
  infinite pagination with a **Load more** fallback, active-filter chips with **Clear all**, and **Save as watchlist**
  (Analyst+) that pre-fills the builder from the current filters.
- **FR-035** *(gap)*: Users MUST be able to save, rename and delete personal saved views (name ≤ 40 chars, ≤ 20 per user per
  org) stored server-side and shown as tabs after the built-in views.
- **FR-036** *(gap)*: The feed MUST offer a status selector (Open / Closed / Awarded / All).
- **FR-037** *(gap)*: Entering an exact bid number and pressing Enter MUST open that tender directly when exactly one exists.

**Alerts (US4)**

- **FR-040**: For each new `(org, tender)` match the system MUST create, per org member and their preferences (defaults:
  in-app on, email on, WhatsApp off, instant): an in-app notification (`sent` immediately), an email row (`pending`) and a
  WhatsApp row (`pending`, or `skipped` with a reason when the user has no phone), with dedupe key
  `tender:<tenderId>:<orgId>` unique per `(user, channel, dedupe key)`.
- **FR-041**: The dispatcher (after every scheduled ingestion and every manual sync) MUST send pending instant email/WhatsApp
  rows one by one and mark each `sent` (with `sentAt`), `skipped` (with reason) or `failed` (with error ≤ 500 chars).
- **FR-042**: For users with **Daily** frequency, pending `tender_match` email/WhatsApp rows MUST be held until 08:00 IST and
  then sent as one digest per user, org and channel per IST day (dedupe `digest:<orgId>:<yyyy-mm-dd>`), recorded as a
  `digest` notification.
- **FR-043**: Emails MUST be responsive HTML + plain-text with bid number, title, buyer · state, closing (IST, urgent colour
  < 3 days, "n days left"), EMD ("Nil" when 0), value, quantity, matched watchlists, a CTA to the tender, a link to the feed,
  a link to notification settings and the human-in-the-loop footer; WhatsApp MUST use the approved template `tender_alert`
  (`tender_alert_digest` for digests) with a text fallback.
- **FR-044**: `GET /api/notifications` MUST return the caller's in-app notifications in the active org (newest first,
  `unread`, `kind`, `page`, `pageSize` ≤ 100) with `unreadCount`, `total` and, per item, the delivery status of its
  email/WhatsApp copies; `POST /api/notifications/:id/read` and `POST /api/notifications/read-all` MUST mark read.
- **FR-045**: `GET/PUT /api/me/notification-prefs` MUST read/write `{inApp, email, whatsapp, frequency: instant|daily,
  expiryReminders}` per user per org; enabling WhatsApp without a phone → `400`.
- **FR-046**: The UI MUST provide a bell with unread badge (polling ≤ 60 s), a popover of the latest items with **Mark all
  read**, the `/notifications` page (All/Unread, day groups, Load older, delivery chips) and **Settings → Notifications**
  (In-app, Email, WhatsApp + Indian mobile number, Instant/Daily, Expiry reminders).
- **FR-047** *(gap)*: Transient send failures MUST be retried up to 3 attempts across dispatches with back-off before the
  row is marked `failed`; attempts MUST be recorded.
- **FR-048** *(gap)*: Alert emails MUST include RFC 8058 one-click unsubscribe headers that disable email match alerts for
  that user and org.
- **FR-049** *(gap)*: The `kind` query parameter MUST be validated against the notification kinds.

**Corrigenda (US5)**

- **FR-050**: Changes to end date, opening date, quantity, items, EMD, estimated value, ePBG, document URL or title MUST be
  recorded as a `corrigendum` event, MUST mark the org's analyses of that tender `stale`, and MUST surface "Corrigendum" on
  the tender for 7 days and "Re-check" on stale scores.
- **FR-051**: Orgs that track a tender MUST get an in-app notification per member when a corrigendum is ingested, deduped per
  tender content hash per org.
- **FR-052** *(gap)*: Corrigendum alerts MUST also go to email/WhatsApp per user preferences (instant; included in the daily
  digest for daily users) and MUST contain a human-readable summary of each changed field with IST dates and ₹ amounts.
- **FR-053** *(gap)*: Corrigendum notifications MUST use a dedicated kind `corrigendum`, rendered with its own label and icon.
- **FR-054** *(gap)*: Cancellation of a tracked tender on GeM MUST alert tracking orgs on their channels.
- **FR-055** *(gap)*: mock-gem MUST support `POST /__admin/cancel/<bidNumber>` and corrigendum changes to quantity and EMD
  for E2E tests.

**Results & intelligence (US6)**

- **FR-060** *(gap)*: The GeM client MUST support searching submitted bids (`bidStatusType: "bidrastatus"`, optional
  `byStatus: bid_awarded | tech_evaluated | fin_evaluated`) and fetching the public result view for a bid id, parsing rank,
  seller, price and L-level.
- **FR-061** *(gap)*: A daily results refresh MUST check up to 50 tracked tenders that closed within the last 30 days, store
  evaluation status and bidders in a `tender_results` table, update tender `status` to `awarded` when applicable and record
  events, within the ≤ 1 request/second budget.
- **FR-062** *(gap)*: `GET /api/tenders/:id/result` MUST return the stored result (or `evaluationStatus` with empty bidders);
  the tender page MUST show a **Result** tab.
- **FR-063** *(gap)*: Org members MUST get an in-app "Result published" alert when a tracked tender is awarded.
- **FR-064** *(gap)*: `GET /api/insights/competitors?category=&state=` MUST aggregate wins, awarded value and categories per
  seller across the org's tracked awarded tenders and flag awards where the winner is not the lowest price.

### Non-Functional Requirements

- **NFR-001**: Ingestion is public-only and polite (Constitution II): ≤ 1 request/second to GeM, honest User-Agent, no login,
  no CAPTCHA solving, back-off on errors, stop paging on failure.
- **NFR-002**: A scheduled run of 5 listing pages MUST finish in < 60 s wall time on Cloudflare Workers (excluding GeM
  latency above 5 s/page) and never exceed 20 pages.
- **NFR-003**: `GET /api/tenders` p95 latency < 400 ms and `POST /api/watchlists/preview` p95 < 800 ms with 50,000 tenders
  and 500 matches per org on Neon.
- **NFR-004**: All org-specific data (matches, seen/dismissed, analyses, notifications, saved views, results insights) is
  scoped by org on every query; notifications additionally by user (Constitution IV).
- **NFR-005**: Every screen in this area has loading, empty and error states, works at 375 px and 1440 px without horizontal
  scrolling, supports keyboard use, light/dark themes and WCAG 2.1 AA contrast (Constitution V).
- **NFR-006**: Missing integrations (`RESEND_API_KEY`, `WHATSAPP_TOKEN`) degrade to `skipped` rows with a reason; never a
  crash or a stuck `pending` row (Constitution VII).
- **NFR-007**: Every ingested tender keeps its `source_url`, `fetched_at` and raw doc (Constitution II).
- **NFR-008**: Core logic (client, parser, normalisers, matcher, change summaries, result parser) has unit tests; every user
  story has a Playwright E2E with evidence in `qa/evidence/003/US<n>/` (Constitution VI).
- **NFR-009**: Reused code is limited to Apache-2.0 / MIT sources and attributed in `NOTICE`; repos without a licence are used
  for ideas only.
- **NFR-010**: Alerts are delivered within one ingestion cycle: a new matching bid produces an in-app alert ≤ 30 min after
  GeM publishes it and an instant email/WhatsApp send attempt in the same tick.

## UX Specification

### Screens

| Screen | Route | Key elements |
|---|---|---|
| Tender feed | `/tenders` | Page header "Tenders" + description; Sync-health pill; **Save as watchlist** (Analyst+); views tab list ("Saved views"); sticky toolbar (search, **Filters (n)**, **Matched only** switch, sort select, cards/table segmented control on desktop); active-filter chips; results; filter rail (desktop ≥ 1024 px, collapsible, remembered in `tp.feed.rail`) / **Filters** sheet (mobile bottom sheet 88 dvh with "Show <n> tenders" button; tablet right sheet). |
| Tender card | — | "New" label + accent bar; bid number (mono); type badge; "Corrigendum" badge; stage badge; title (2-line clamp, whole card clickable); buyer + location; watchlist badge + reason chips; score ring + verdict + "Re-check" or **Score it**; metrics Closes (countdown, rose < 24 h, amber < 3 days) / EMD / Est. value / Quantity; "More actions" menu (Not relevant — hide / Restore to feed, Open on GeM). |
| Watchlists | `/watchlists` | Header + **New watchlist**; stat tiles; cards with switch, menu (Edit criteria, View matches, Delete), criteria chips, counts; empty state + Quick start templates; delete confirm dialog. |
| Watchlist builder | sheet over `/watchlists` (`?new=1`) | Name; Keywords; Exclude keywords; States (multi-select of Indian states, "All of India"); Ministries & buyers (suggestions from facets); GeM categories; HSN codes (validated chips, tooltip explaining 4-digit headings); Estimated value (₹ lakh min/max); Time to prepare (Any / 2 / 5 / 7 / 14 days); Bid types; live preview aside; footer "Alerts follow each member’s notification settings." + **Cancel** / **Create watchlist** or **Save changes**. |
| Notifications bell | top bar | Icon button with unread badge; popover (≤ 70 vh) with "<n> new", **Mark all read**, list, **View all**, **Alert settings**. |
| Notifications page | `/notifications` | Header + **Alert settings** + **Mark all read** (disabled when nothing is unread); All/Unread segmented; day groups; items with kind icon/label, title, body, time, delivery chips; **Load older**. |
| Notification settings | `/settings/notifications` | Rows In-app / Email / WhatsApp (+ mobile number field) / Match alerts Instant–Daily / Expiry reminders; **Save preferences** (disabled until dirty). |
| Tender history | `/tenders/:id` → History tab | Timeline of events (Published on GeM, Listing updated, Corrigendum issued [highlighted, "Re-check eligibility"], Bid closed, Bid cancelled) merged with org activity. |
| *(gap)* Result tab | `/tenders/:id` → Result | Evaluation status, bidder table (Rank, Seller, Price, Level), L1 highlight, source link, "not published yet" state. |
| *(gap)* Competitors | `/insights/competitors` | Filters (category, state), table (Seller, Wins, Awarded value, Categories, Flags), empty state "No awarded results for your tracked tenders yet". |

### States

- **Loading**: feed — 5 card skeletons + count shimmer; watchlists — card skeletons; preview — spinner "Updating preview";
  bell — skeleton list; sync pill — pill skeleton; settings — skeleton list.
- **Empty**: as listed in US2-1, US3-10, US4-8 and the preview zero state (exact copy in the scenarios).
- **Error**: feed/watchlists/notifications page → `ErrorState` with message and **Retry**; bell → "Couldn’t load notifications.
  Retry"; preview → "Preview unavailable — <message>"; sync pill hides itself if the runs endpoint fails; mutations → error
  toast with the API message.

### Responsive behaviour

- **375 px (Pixel 7 / iPhone SE)**: single column; views scroll horizontally inside their strip (page itself never scrolls
  horizontally); filters open in a bottom sheet; table layout unavailable; card metrics in a 2-column grid; "· <n> open bids"
  hidden from the pill; watchlist builder is a full-height sheet with the preview below the form; notification popover width
  `min(92vw, 22rem)`.
- **≥ 1024 px**: sticky filter rail (256 px) beside results; builder shows form and preview side by side; table layout
  available.

### Accessibility

- Every icon-only button has an aria-label ("Open filters", "Hide filters", "Clear search", "More actions", "Notifications, <n>
  unread", "Pause <name>"/"Resume <name>", "Actions for <name>", "Remove filter <label>").
- Views use `role="tablist"`/`role="tab"` with `aria-selected`; filter rail is an `aside` labelled "Filters"; result count and
  preview are `aria-live="polite"`; card titles label their `article`.
- Keyboard: `/` focuses search; all chips, toggles and menus reachable by Tab with visible focus rings; sheets trap focus and
  close on Escape.
- Colour is never the only signal: countdown text, status badges and "New" label accompany colour.
- *(gap)* An automated axe scan of `/tenders`, `/watchlists`, `/notifications` and `/settings/notifications` reports no
  serious/critical violations in both themes.

### Key Entities *(include if feature involves data)*

- **Tender** (`tenders`): one public GeM bid, global across orgs; unique by `(source, bid_number)`; normalised fields, raw doc,
  content hash, `fetched_at`.
- **Tender event** (`tender_events`): history entry (created/updated/corrigendum/closed/cancelled) with `{field:{from,to}}`.
- **Ingestion run** (`ingestion_runs`): one sync with trigger, status, counters, error, timestamps.
- **Watchlist** (`watchlists`): org-owned saved criteria (`WatchlistCriteria` JSON), active flag, creator.
- **Tender match** (`tender_matches`): `(org, tender, watchlist)` with reasons, relevance, seen, dismissed.
- **Notification** (`notifications`): per user, org and channel; kind, title, body, link, dedupe key, status, error, sent/read
  timestamps; doubles as the outbox for email/WhatsApp.
- **Notification preferences** (`notification_prefs`): per `(org, user)` in-app/email/WhatsApp, frequency, expiry reminders.
- *(gap)* **Saved view** (`saved_views`): per `(org, user)` name + feed filter params + position.
- *(gap)* **Tender result** (`tender_results`): per tender evaluation status, bidders `[{rank, seller, price, level}]`, source
  URL, fetched at.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newly published matching bid appears in the feed and as an in-app alert within one ingestion cycle (≤ 30 min);
  in E2E, within one manual sync.
- **SC-002**: Re-running ingestion on unchanged GeM data creates 0 duplicate tenders, events, matches or notifications
  (verified across 3 consecutive runs).
- **SC-003**: ≥ 99 % of scheduled runs in a week end `success` or `partial`; a GeM outage is visible in the UI within 60 s of
  the failed run.
- **SC-004**: A new user creates their first watchlist with a non-zero preview in under 2 minutes from opening `/watchlists`
  (template or manual).
- **SC-005**: Feed filter/search changes render updated results in < 1 s at p95 with 50,000 tenders.
- **SC-006**: 100 % of email/WhatsApp alert rows reach a terminal status (`sent`/`skipped`/`failed`) within 2 dispatch cycles;
  none stay `pending` for instant users.
- **SC-007**: 100 % of end-date corrigenda on tracked tenders produce a history entry, a stale flag on existing analyses and an
  alert naming the new date.
- **SC-008**: Each user story US1–US6 has a passing Playwright E2E with screenshots, video and trace in `qa/evidence/003/US<n>/`
  and a QA verdict.

## Assumptions

- GeM BidPlus keeps the public `/all-bids` + `/all-bids-data` protocol (CSRF form post, Solr docs with single-element arrays);
  ~10 bids per page. If it changes, FR-014 surfaces the drift and the parser is updated against new recorded fixtures.
- 5 pages per 30-minute run (≈ 2,400 newest bids/day) covers most new publications; FR-011/FR-012 close the gap after outages
  and for older-but-relevant bids.
- Email uses Resend and WhatsApp uses the Meta Cloud API with pre-approved templates `tender_alert` and `tender_alert_digest`;
  both are optional per environment.
- Digests go out once per IST day from 08:00 IST (first scheduled tick at or after 08:00).
- The public result view (`/bidding/bid/getBidResultView/<id>`) and `bidrastatus` search remain reachable without login; if
  not, US6 degrades to status-only.
- Seller names in public GeM results are public information; displaying them to the org that tracked the tender is acceptable.
- Reference code: erenmyeager15/india-government-tenders-scraper (Apache-2.0) and arush15june/gem-search (MIT) may be copied
  with attribution in `NOTICE`; the other reference repos have no licence and are used for ideas only (Constitution
  Constraints).
- Roles and org membership come from the existing auth module (spec 001, FR-030).
