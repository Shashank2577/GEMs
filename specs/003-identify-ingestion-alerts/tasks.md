---

description: "Task list for 003 Identify — GeM ingestion, watchlists, matching & alerts"
---

# Tasks: Identify — GeM Ingestion, Watchlists, Matching & Alerts

**Input**: Design documents from `/specs/003-identify-ingestion-alerts/`

**Prerequisites**: plan.md (required), spec.md (required for user stories); contracts/data model of the built parts live in
`specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`

**Tests**: Requested. Core logic gets Vitest unit tests; routes get API integration tests on real Postgres
(`apps/api/test/`); every user story gets a Playwright E2E with evidence (screenshots, video, trace) in
`qa/evidence/003/US<n>/` plus a QA `VERDICT.md`. Review is done with the cairn review workflow (ai-sdlc conventions in
`CONVENTIONS.md` for review/QA only).

**Organization**: Tasks are grouped by user story. `- [x]` = already implemented and verified by reading the code on
2026-11-05 (mostly delivered as 001 tasks T030–T038); `- [ ]` = remaining work (gaps, hardening, missing tests, QA).
Each open task is sized at ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US6)
- File paths are repo-relative to `/home/user/GEMs`

## Path Conventions

- Core logic: `packages/core/src/`, tests `packages/core/test/`
- Schema/migrations: `packages/db/src/schema.ts`, `packages/db/migrations/`
- API: `apps/api/src/`, tests `apps/api/test/`
- Web: `apps/web/src/features/`
- Mock GeM: `tools/mock-gem/src/`
- E2E: `e2e/003-identify-ingestion-alerts/`, evidence `qa/evidence/003/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Fixtures, mock GeM, attribution and E2E scaffolding

- [x] T001 [P] Recorded BidPlus fixtures (4 listing pages, 6 extra bids, no-results, meta with reference date) and builder in `packages/core/test/fixtures/gem/` FR-003, FR-010
- [x] T002 [P] mock-gem server with `/all-bids`, `/all-bids-data` (paging, search, 404 no-results), document routes with generated PDFs, admin `publish`/`corrigendum`/`fail`/`reset`/`state`, date rebasing in `tools/mock-gem/src/app.ts`, `tools/mock-gem/src/pdf.ts`, `tools/mock-gem/src/server.ts` FR-010
- [x] T003 [P] Create root `NOTICE` (referenced by `packages/core/src/gem/client.ts`, `parse.ts`, `normalize.ts` but missing): attribute erenmyeager15/india-government-tenders-scraper (Apache-2.0, copyright line + licence pointer) and arush15june/gem-search (MIT, full permission notice) listing the adapted files; add a section "Referenced for ideas only (no licence, no code copied)" for Giridar33, PranavTamada, IshanMaheshwari-777, Mujahid-Alam, Giri-Aayush, rounittxx in `NOTICE` NFR-009 (#68)
- [x] T004 [P] E2E scaffold for this spec: create `e2e/003-identify-ingestion-alerts/` and add helpers `resetGem()`, `publishOnGem(count)`, `gemCorrigendum(bidNumber, body)`, `gemFail(mode)`, `syncNow(request)` (wrapping `mockGem()` and `POST /api/ingestion/run`) and an `evidence003(page, story, name)` wrapper writing to `qa/evidence/003/<story>/` in `e2e/support/fixtures.ts` NFR-008 (#69)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, contracts, scheduling and configuration every story relies on

- [x] T005 Tables `tenders` (uq `source,bid_number`, idx `end_at`, `state`), `tender_events`, `ingestion_runs`, `watchlists`, `tender_matches` (uq `org_id,tender_id,watchlist_id`), `notifications` (uq `user_id,channel,dedupe_key`), `notification_prefs` in `packages/db/src/schema.ts` and `packages/db/migrations/0000_last_shocker.sql` FR-004, FR-006, FR-023, FR-040
- [x] T006 [P] Zod contracts for watchlist criteria/create/update/preview, tender query/list/detail, ingestion run DTOs, notifications query/DTO in `packages/core/src/contracts/identify.ts` FR-020, FR-030, FR-044
- [x] T007 [P] Scheduled pipeline ingestion → alerts → reminders with per-step isolation in `apps/api/src/lib/scheduled.ts`, Worker `scheduled()` in `apps/api/src/worker.ts`, in-process 30-min cron in `apps/api/src/node.ts`, Cron Trigger `*/30 * * * *` in `wrangler.toml` FR-001
- [x] T008 [P] GeM config (`GEM_BASE_URL`, `GEM_USER_AGENT`, `GEM_MIN_INTERVAL_MS` default 1000, `GEM_MAX_PAGES` default 5) in `apps/api/src/env.ts` and `apps/api/src/deps.ts` FR-002

**Checkpoint**: Foundation ready — user stories can proceed in parallel

---

## Phase 3: User Story 1 - Polite, reliable GeM BidPlus ingestion with visible sync health (Priority: P1) 🎯 MVP

**Goal**: Tenders flow in every 30 minutes (and on demand) politely, idempotently, with visible health and safe failure.

**Independent Test**: On an empty DB with mock-gem, **Sync now** creates 36 tenders and a `success` run; a second sync
creates nothing; `fail down` produces a `failed` run without data loss.

### Tests for User Story 1

- [x] T009 [P] [US1] Unit tests: normalisers (lakh/crore/Indian grouping, IST dates), parser (36 fixtures, multi-item titles, bid types incl. direct RA/bunch/service, closed status, content hash), client (CSRF bootstrap, session reuse, throttle, 5xx back-off, Retry-After, network give-up, 403 re-bootstrap, HTML/no-token, PDF magic) in `packages/core/test/gem/normalize.test.ts`, `packages/core/test/gem/parse.test.ts`, `packages/core/test/gem/client.test.ts` FR-002, FR-003
- [x] T010 [US1] API tests: full ingest + events, idempotent second run, outage (`down`/`html`) → failed with nothing lost, single-flight 409 + stale-lock reaping, role checks on `/ingestion/run`, health for viewers in `apps/api/test/ingest.test.ts`, `apps/api/test/identify.test.ts` FR-004, FR-005, FR-006, FR-008

### Implementation for User Story 1

- [x] T011 [P] [US1] Normalisers (`unwrap`, `cleanText`, `firstText`, `firstNumber`, `firstBool`, `parseAmount`, `parseGemDate`, `splitItems`, `tidyTitle`) in `packages/core/src/gem/normalize.ts` FR-003
- [x] T012 [P] [US1] Canonical states and location derivation in `packages/core/src/gem/states.ts`, stable hash in `packages/core/src/gem/hash.ts` FR-003
- [x] T013 [P] [US1] BidPlus response/doc parser with `TRACKED_FIELDS`, document routes by bid type, status, HSN extraction in `packages/core/src/gem/parse.ts` FR-003
- [x] T014 [P] [US1] `GemClient` (CSRF bootstrap, form POST, serialised ≥ minInterval throttle, timeout, retry/back-off, Retry-After, 403/419 re-bootstrap, `fetchBidDocument`) in `packages/core/src/gem/client.ts` FR-001, FR-002
- [x] T015 [US1] `runIngestion()` with single-flight + reaping, paged fetch with stop-on-failure, 200-bid chunked upsert by bid number, events, known-value retention, close past-deadline bids, run bookkeeping in `apps/api/src/services/ingest.ts` FR-004, FR-005, FR-006, FR-007
- [x] T016 [US1] `POST /ingestion/run` (≥ Bid Manager, 409 busy, dispatch after sync, activity log) and `GET /ingestion/runs` in `apps/api/src/routes/ingestion.ts` FR-008
- [x] T017 [US1] Sync-health pill + popover (ok/stale/error/never, recent runs, **Sync now** for Bid Manager+, 60 s refresh) in `apps/web/src/features/feed/SyncHealth.tsx` and `apps/web/src/features/feed/api.ts` FR-009
- [x] T018 [P] [US1] Format-drift guard: add `assertPageShape(page)` (fail when > 50 % of docs lack `b_bid_number`) in `packages/core/src/gem/parse.ts`, prefix errors with "GeM response format changed:" and log `ingestion.format_drift` at error level in `apps/api/src/services/ingest.ts`; unit tests in `packages/core/test/gem/parse.test.ts` FR-014 (#70)
- [x] T019 [US1] Incremental paging: in `apps/api/src/services/ingest.ts` stop after a page whose bids are all known with unchanged hash; when `lastSuccessAt` is > 2 h old (or null) allow up to 20 pages (catch-up); record pages fetched; API test using mock-gem `publish` of 3 bids after a 3 h clock advance in `apps/api/test/ingest.test.ts` FR-011 (#71)
- [x] T020 [US1] Targeted keyword search pass: after listing pages, for up to 10 distinct active watchlist keywords (rotating cursor persisted in the run's error-free metadata or a small `ingestion_cursor` setting) fetch 1 page with `search` and process through the same upsert/match path, counting against the 1 req/s budget, in `apps/api/src/services/ingest.ts`; API test asserting mock-gem received the search payloads in `apps/api/test/ingest.test.ts` FR-012, NFR-001 (#72)
- [x] T021 [US1] Manual sync cooldown: reject `POST /ingestion/run` with `429 sync_cooldown` (`details.retryAt`) within the cooldown of a finished manual run (2 min as built; 10 min since 008/FR-026, `MANUAL_SYNC_COOLDOWN_MIN`) in `apps/api/src/routes/ingestion.ts`; show "Next manual sync at <time> IST" tooltip/disabled state in `apps/web/src/features/feed/SyncHealth.tsx`; API test in `apps/api/test/identify.test.ts` FR-013 (#73)
- [x] T022 [US1] QA: Playwright E2E for US1 in `e2e/003-identify-ingestion-alerts/US1-ingestion.e2e.ts` covering spec US1 scenarios 1–9 (Sync now as Bid Manager → "36 tenders" + run "36 new · 0 updated"; second sync no change; `gemFail('down')` → red dot + "Last sync failed"; `html` mode; 409 busy via API; Analyst sees no **Sync now** and gets 403; pill states; `@mobile` pill at 375 px) with evidence (screenshots, video, trace) in `qa/evidence/003/US1/` and `qa/evidence/003/US1/VERDICT.md` FR-001, FR-004, FR-005, FR-006, FR-008, FR-009 (#74)

**Checkpoint**: Ingestion is reliable and observable on its own

---

## Phase 4: User Story 2 - Build, preview and manage watchlists (Priority: P1)

**Goal**: Sellers describe what they sell, see live matches before saving, and manage watchlists safely.

**Independent Test**: Create "Laptops — Maharashtra" (laptop + Maharashtra): preview shows 2, saving yields
`matchCount:2` and no notifications; pause/edit/delete behave as specified.

### Tests for User Story 2

- [x] T023 [P] [US2] Matcher unit tests: word boundary + plurals, reasons, OR within / AND across, title-hit ranking, exclude veto, states/ministries/categories, HSN prefix both ways, value range + unknown value flag, minDaysToClose + bid types, closed/expired/empty criteria, fixture expectations in `packages/core/test/match/matcher.test.ts` FR-022, FR-023
- [x] T024 [US2] API tests: preview without saving, roles (viewer 403; analyst create/edit/pause/delete; edit drops matches), criteria validation, org isolation in `apps/api/test/identify.test.ts` FR-020, FR-021, FR-024, FR-025
- [x] T025 [P] [US2] API test: creating, editing criteria and resuming a watchlist create **zero** `notifications` rows (silent back-fill) and a paused watchlist gets no matches from a subsequent ingestion in `apps/api/test/identify.test.ts` FR-025 (#75)

### Implementation for User Story 2

- [x] T026 [P] [US2] Pure matcher `matchTender`/`matchWatchlists`/`keywordRegex`/`hasPositiveCriteria` with reasons and relevance in `packages/core/src/match/matcher.ts` FR-022, FR-023
- [x] T027 [US2] Watchlist routes: list with stats (`matchCount`, `newThisWeek`, `openCount`, `lastMatchAt`, `createdBy`), preview (`candidateTenders` SQL pre-filter + matcher, top 5 with `previewReasons`), create (201), patch (name/criteria/active, refresh on criteria/resume), delete, activity log in `apps/api/src/routes/watchlists.ts` FR-020, FR-021, FR-024, FR-025, FR-026
- [x] T028 [US2] Watchlist builder sheet with chip inputs (keywords, exclude, ministries/categories with facet suggestions, validated HSN), states multi-select, value in lakh, time to prepare, bid types, client validation, server field errors, debounced live preview in `apps/web/src/features/watchlists/WatchlistBuilder.tsx`, `apps/web/src/features/watchlists/ChipInput.tsx`, `apps/web/src/features/watchlists/api.ts` FR-020, FR-024
- [x] T029 [US2] Watchlists page: stat tiles, cards with criteria chips and counts, pause switch with optimistic update, edit, view matches, delete confirm, empty state + 6 Quick start templates, `?new=1` deep link in `apps/web/src/features/watchlists/WatchlistsPage.tsx` FR-026
- [x] T030 [US2] Watchlist limit: count org watchlists before insert and return `409 watchlist_limit` "You can have up to 50 watchlists — delete one first." (paused ones count) in `apps/api/src/routes/watchlists.ts`; surface the message in `apps/web/src/features/watchlists/WatchlistBuilder.tsx`; API test in `apps/api/test/identify.test.ts` FR-027 (#76)
- [x] T031 [US2] Remove the silent 5,000-candidate cap in `candidateTenders()`: iterate keyset pages of 2,000 ordered by `id` until exhausted, and add ILIKE pre-filters for categories and ministries (escaped) in `apps/api/src/routes/watchlists.ts`; API test seeding 6,000 open tenders that all match in `apps/api/test/identify.test.ts` FR-028, NFR-003 (#77)
- [x] T032 [US2] QA: Playwright E2E for US2 in `e2e/003-identify-ingestion-alerts/US2-watchlists.e2e.ts` covering spec US2 scenarios 1–13 (empty state + templates; preview "Add a keyword…" → 2 matches with reason badges; zero-match note; create toast "“Laptops — Maharashtra” is live" + "2 open bids already match…"; inline validation messages; HSN chip rejection; pause/resume toasts + "Paused" badge; edit → "Watchlist updated"; delete dialog; Viewer cannot create; stat tiles + View matches link; `@mobile` builder at 375 px) with evidence (screenshots, video, trace) in `qa/evidence/003/US2/` and `qa/evidence/003/US2/VERDICT.md` FR-020, FR-021, FR-022, FR-024, FR-025, FR-026 (#78)

**Checkpoint**: Watchlists work independently against ingested tenders

---

## Phase 5: User Story 3 - Triage the tender feed: search, filters, sort, views (Priority: P1)

**Goal**: The Bid Manager finds, triages and shares relevant bids quickly on desktop and phone.

**Independent Test**: Filter State = Maharashtra + search `laptop`, open **My matches**, open a card (clears "New"),
dismiss + undo, save the search as a watchlist.

### Tests for User Story 3

- [x] T033 [P] [US3] Feed filter state ⇄ URL ⇄ API query ⇄ criteria unit tests in `apps/web/src/features/feed/filters.test.ts` FR-034
- [x] T034 [US3] API tests: list + facets + default order, pagination without overlap, every filter (state multi, ministry, category, q, value, closing window, bid type), 400 on bad query, matches/isNew/matched/watchlist/unseen, verdict/stage join + sort, detail with events/documents, seen clears new + reads notification, dismiss/undo/409, auth required in `apps/api/test/identify.test.ts` FR-030, FR-031, FR-032, FR-033

### Implementation for User Story 3

- [x] T035 [US3] `GET /tenders` with `buildFilters` (q words across 10 fields, facets excluding own filter, matched/unseen/dismissed/verdict/stage subqueries), `orderBy` (8 sorts), `decorateTenders` (org-scoped matches, latest analysis, workspace, seen/isNew/dismissed, 7-day corrigendum flag), `GET /tenders/:id`, `POST /tenders/:id/seen`, `POST /tenders/:id/dismiss` in `apps/api/src/routes/tenders.ts` FR-030, FR-031, FR-032, FR-033
- [x] T036 [P] [US3] Filter model, URL mapping, sort options, built-in views (My matches, New, Closing this week, Go verdicts, All open bids), value/closing/bid-type/verdict options, `filtersToCriteria` in `apps/web/src/features/feed/filters.ts` FR-034
- [x] T037 [US3] Feed page (debounced search, `/` shortcut, views tablist, Matched only, sort, cards/table, active chips, infinite scroll + Load more, three empty states, error state, mobile/tablet filter sheet, Save as watchlist) in `apps/web/src/features/feed/FeedPage.tsx`, filter rail with facet search in `apps/web/src/features/feed/FilterRail.tsx`, cards in `apps/web/src/features/feed/TenderCard.tsx`, table in `apps/web/src/features/feed/TenderTable.tsx`, hooks in `apps/web/src/features/feed/api.ts`; seen-on-open in `apps/web/src/features/tender/TenderPage.tsx` FR-034
- [x] T038 [US3] Saved views storage: add `saved_views` (`id, org_id, user_id, name, params, position, created_at, updated_at`, uq `org_id,user_id,name`) to `packages/db/src/schema.ts` and generate a migration in `packages/db/migrations/` FR-035 (#79)
- [x] T039 [US3] Saved views API: `savedViewCreateSchema`/`savedViewUpdateSchema`/`SavedViewDto` in `packages/core/src/contracts/identify.ts`; `GET/POST/PATCH/DELETE /views` scoped to `(org,user)`, max 20 (`409 view_limit`), name ≤ 40 in `apps/api/src/routes/views.ts` mounted in `apps/api/src/app.ts`; tests in `apps/api/test/views.test.ts` FR-035, NFR-004 (#80)
- [x] T040 [US3] Saved views UI: **Save view** button (name dialog), personal tabs after built-in views, tab menu Rename/Delete, active-tab detection by params equality in `apps/web/src/features/feed/FeedPage.tsx` and hooks in `apps/web/src/features/feed/api.ts` FR-035 (#81)
- [x] T041 [P] [US3] Status selector Open / Closed / Awarded / All: extend `FeedFilters.status` and URL mapping in `apps/web/src/features/feed/filters.ts` (+ test in `apps/web/src/features/feed/filters.test.ts`) and add a "Status" group in `apps/web/src/features/feed/FilterRail.tsx` FR-036 (#82)
- [x] T042 [P] [US3] Bid-number jump: on Enter, when the search matches `^GEM/\d{4}/[A-Z]/\d+$` and exactly one tender is returned, navigate to `/tenders/<id>` in `apps/web/src/features/feed/FeedPage.tsx` FR-037 (#83)
- [x] T043 [P] [US3] Accessibility checks: add `@axe-core/playwright` helper `checkA11y(page)` in `e2e/support/fixtures.ts` failing on serious/critical violations, used by the US2–US4 E2Es for `/tenders`, `/watchlists`, `/notifications`, `/settings/notifications` in light and dark themes NFR-005 (#84)
- [x] T044 [US3] QA: Playwright E2E for US3 in `e2e/003-identify-ingestion-alerts/US3-feed.e2e.ts` covering spec US3 scenarios 1–13 (skeletons → "36 tenders" → Load more / "That’s all 36 tenders."; search + `/` shortcut + URL `q=`; state facet + chip + Filters badge; combined filters + Clear all; sort Closing soonest; My matches with watchlist badge + reasons; New → open → caught up; dismiss toast + Undo; Save as watchlist pre-fill; 3 empty states; error state via route interception; table toggle desktop; `@mobile` 375 px bottom sheet and no horizontal scroll) with evidence (screenshots, video, trace) in `qa/evidence/003/US3/` and `qa/evidence/003/US3/VERDICT.md` FR-030, FR-031, FR-032, FR-033, FR-034 (#85)

**Checkpoint**: Feed fully usable on its own over ingested tenders

---

## Phase 6: User Story 4 - Get alerted in-app, by email and on WhatsApp — instantly or as a daily digest (Priority: P1)

**Goal**: Every org member hears about each new match once, on their channels, with visible delivery status.

**Independent Test**: Publish `GEM/2026/B/6421101`, sync, see bell "1", the "New match: Laptop - Notebook" item linking to
the tender with email delivery status; a second sync adds nothing.

### Tests for User Story 4

- [x] T045 [US4] API tests: match notifies every member in-app + email pending; no duplicates on re-run; email sent with template content and status, WhatsApp pending/skipped by phone; provider failure → failed; daily digest held before 08:00 IST, one digest after, never twice; notifications list/unread/read/read-all per user in `apps/api/test/ingest.test.ts`, `apps/api/test/identify.test.ts` FR-040, FR-041, FR-042, FR-043, FR-044

### Implementation for User Story 4

- [x] T046 [US4] `matchAndNotify` (new `(org,tender)` pairs only, per-member prefs with defaults, in-app sent / email pending / WhatsApp pending or skipped, dedupe `tender:<id>:<org>`), `orgRecipients`, `tenderAlertBody` in `apps/api/src/services/ingest.ts` FR-040
- [x] T047 [US4] Dispatcher (instant per row; daily digest per user/org/channel after 08:00 IST with `digest:<org>:<day>`; sent/skipped/failed with reasons), responsive email + text version, WhatsApp `tender_alert` / `tender_alert_digest` in `apps/api/src/services/alerts.ts`; adapters `apps/api/src/adapters/mailer.ts`, `apps/api/src/adapters/whatsapp.ts` FR-041, FR-042, FR-043, NFR-006
- [x] T048 [US4] Notifications API (in-app list with deliveries by dedupe key, unread count, read, read-all; user + org scoped) in `apps/api/src/routes/notifications.ts`; prefs `GET/PUT /me/notification-prefs` (WhatsApp requires phone) in `apps/api/src/routes/auth.ts` FR-044, FR-045
- [x] T049 [US4] Bell with unread badge + popover, notifications page (All/Unread, day groups, Load older, Mark all read), item with kind icon and delivery chips, settings section (channels, Indian mobile → E.164, Instant/Daily, expiry reminders) in `apps/web/src/features/notifications/Bell.tsx`, `apps/web/src/features/notifications/NotificationsPage.tsx`, `apps/web/src/features/notifications/NotificationItem.tsx`, `apps/web/src/features/notifications/api.ts`, `apps/web/src/features/settings/sections/NotificationsSection.tsx` FR-046
- [x] T050 [US4] Retry bookkeeping: add `attempts integer not null default 0` and `next_attempt_at timestamptz` to `notifications` in `packages/db/src/schema.ts` + migration in `packages/db/migrations/` FR-047 (#86)
- [x] T051 [US4] Retries: classify provider errors (network/429/5xx transient vs 4xx permanent) in `apps/api/src/adapters/mailer.ts` and `apps/api/src/adapters/whatsapp.ts`; in `apps/api/src/services/alerts.ts` keep transient failures `pending` with `next_attempt_at` +5 min then +25 min (inside the 30-min cron) and mark `failed` after 3 attempts; tests in `apps/api/test/ingest.test.ts` FR-047, SC-006 (#87)
- [x] T052 [US4] One-click unsubscribe: HMAC-signed token `(userId, orgId, 'email_matches')` helper in `apps/api/src/lib/unsubscribe.ts`; `List-Unsubscribe` + `List-Unsubscribe-Post` headers passed through `apps/api/src/adapters/mailer.ts` from `apps/api/src/services/alerts.ts`; public `GET` (confirmation page, no side effect) / `POST /notifications/unsubscribe` setting `notification_prefs.email=false` in `apps/api/src/routes/notifications.ts`; tests (valid, tampered → 400 `invalid_token`) in `apps/api/test/identify.test.ts` FR-048 (#88)
- [x] T053 [P] [US4] Validate `kind` with `z.enum([...notification kinds])` in `notificationsQuerySchema` in `packages/core/src/contracts/identify.ts`; API test for `?kind=bogus` → 400 in `apps/api/test/identify.test.ts` FR-049 (#89)
- [x] T054 [US4] E2E mail capture: expose the log mailer's `sent` list via a test-only `GET /api/__test/mail` registered **only** when `E2E_TEST_HOOKS=1` (never in Worker production) in `apps/api/src/app.ts`/`apps/api/src/node.ts`, and enable it in `playwright.config.ts` webServer env, so QA can assert email content without Resend NFR-008 (#90)
- [x] T055 [US4] QA: Playwright E2E for US4 in `e2e/003-identify-ingestion-alerts/US4-alerts.e2e.ts` covering spec US4 scenarios 1–10 (publish 6421101 + sync → bell badge "1", aria-label "Notifications, 1 unread", popover item text/body, View all/Alert settings; email captured via T054 with bid number, "Review & score this bid", IST, footer; delivery chip "Email not sent" + reason when unconfigured; WhatsApp phone validation copy + saved toast; Daily digest via API clock-independent assertion of held rows; no duplicate after second sync; All/Unread + Mark all read toast; cross-user 404; `@mobile` bell popover at 375 px) with evidence (screenshots, video, trace) in `qa/evidence/003/US4/` and `qa/evidence/003/US4/VERDICT.md` FR-040, FR-041, FR-042, FR-043, FR-044, FR-045, FR-046 (#91)

**Checkpoint**: Alerts verified end to end; P1 MVP (US1–US4) complete

---

## Phase 7: User Story 5 - Corrigendum & change tracking with clear change summaries (Priority: P2)

**Goal**: Amendments on GeM are never missed; analyses are flagged stale and users are told exactly what changed.

**Independent Test**: Analyse 6421001, extend its end date by 7 days on mock-gem, sync: History shows "Corrigendum issued"
with old/new date, card shows "Corrigendum" + "Re-check", and an alert names the change.

### Tests for User Story 5

- [x] T056 [US5] API test: corrigendum updates end date by exactly 7 days, one `corrigendum` event with `{endAt:{from,to}}`, analysis stale, 4 in-app heads-ups, match not duplicated, detail shows history + `hasCorrigendum` in `apps/api/test/ingest.test.ts` FR-050, FR-051

### Implementation for User Story 5

- [x] T057 [P] [US5] `CORRIGENDUM_FIELDS`, `diffTenders`, `isCorrigendum` in `packages/core/src/gem/parse.ts` FR-050
- [x] T058 [US5] Corrigendum/closed/cancelled event kinds, stale analyses, known-value retention in `upsertTender()`; in-app `notifyCorrigenda()` deduped by content hash in `apps/api/src/services/ingest.ts` FR-050, FR-051
- [x] T059 [US5] "Corrigendum" badge (7 days) and "Re-check" on stale scores in `apps/web/src/features/feed/TenderCard.tsx`; "Corrigendum issued" timeline entry with "Re-check eligibility" in `apps/web/src/features/tender/HistoryTab.tsx` and change labels in `apps/web/src/features/tender/labels.ts` FR-050
- [ ] T060 [P] [US5] `summariseChanges(changes)` → "Bid end date: 19 Nov, 3:00 pm → 26 Nov, 3:00 pm IST · Quantity: 75 → 90 · EMD: ₹2.4 L → ₹3 L" with field labels, IST formatting and case-insensitive string equality (ported from erenmyeager15 `src/monitoring.ts` material-field compare, Apache-2.0, attributed in header + `NOTICE`) in `packages/core/src/gem/changes.ts`; unit tests in `packages/core/test/gem/changes.test.ts` FR-052 (#92)
- [ ] T061 [US5] Notification kind `corrigendum` (and `result` for US6): extend the `notifications.kind` union in `packages/db/src/schema.ts`, `NotificationDto['kind']` in `packages/core/src/contracts/identify.ts`, and the `KIND` map (label "Corrigendum", warning icon) in `apps/web/src/features/notifications/NotificationItem.tsx` FR-053 (#93)
- [ ] T062 [US5] Corrigendum alerts on all channels: in `notifyCorrigenda()` create in-app (`sent`) + email/WhatsApp (`pending`/`skipped`) rows per prefs with kind `corrigendum` and body from `summariseChanges` in `apps/api/src/services/ingest.ts`; email heading "A tracked GeM bid was amended" and a "Changed" section in digests in `apps/api/src/services/alerts.ts`; update `apps/api/test/ingest.test.ts` expectations (kind `corrigendum`, email rows) FR-052, FR-053 (#94)
- [ ] T063 [P] [US5] mock-gem: `POST /__admin/cancel/<bidNumber>` (sets `b_is_cancelled`) and `emd` support in `POST /__admin/corrigendum/*` in `tools/mock-gem/src/app.ts` FR-055 (#95)
- [ ] T064 [US5] Cancellation alerts: on a `cancelled` event notify tracking orgs "Cancelled on GeM: <title>" on their channels in `apps/api/src/services/ingest.ts`; "Cancelled on GeM" banner when `tender.status === 'cancelled'` in `apps/web/src/features/tender/TenderHero.tsx`; API test in `apps/api/test/ingest.test.ts` FR-054 (#96)
- [ ] T065 [US5] QA: Playwright E2E for US5 in `e2e/003-identify-ingestion-alerts/US5-corrigendum.e2e.ts` covering spec US5 scenarios 1–6 (+7–9 once T060–T064 land): seed analysis via demo/API, `gemCorrigendum('GEM/2026/B/6421001', {days:7})`, sync → card "Corrigendum" + "Re-check" tooltips, History "Corrigendum issued" with old/new IST dates, bell "Corrigendum: …" with "now closes …" body, no duplicate on second sync, cancellation banner; `@mobile` history at 375 px; evidence (screenshots, video, trace) in `qa/evidence/003/US5/` and `qa/evidence/003/US5/VERDICT.md` FR-050, FR-051, FR-052, FR-053, FR-054 (#97)

**Checkpoint**: Changes to tracked bids are captured and communicated

---

## Phase 8: User Story 6 - Bid results, award status and competitor intelligence (Priority: P3)

**Goal**: After closing, sellers see who won at what price and learn about competitors.

**Independent Test**: mock-gem awards a closed tracked bid with a recorded result page; the results refresh shows
"Awarded", the bidder table with L1, and the competitor summary lists the winner.

### Tests for User Story 6

- [ ] T066 [P] [US6] Record result fixtures: one awarded result HTML (≥ 3 bidders, L1–L3) and one "not yet published" page, plus 2 `bidrastatus` JSON pages (awarded, tech evaluated) in `packages/core/test/fixtures/gem/results/` FR-060 (#98)

### Implementation for User Story 6

- [ ] T067 [P] [US6] `GemClient.fetchSubmittedPage({search, byStatus, page})` using `bidStatusType:"bidrastatus"` + `filter.byStatus` and `fetchBidResult(gemBidId)` for `/bidding/bid/getBidResultView/<id>` (ported from arush15june/gem-search `search_bids`/`get_bid_result`, MIT, attributed) in `packages/core/src/gem/client.ts`; unit tests in `packages/core/test/gem/client.test.ts` FR-060, NFR-001 (#99)
- [ ] T068 [P] [US6] `parseBidResultHtml(html)` → `{categories, bidders:[{rank, seller, price, level}]}` and `BUYER_STATUS` (0 Not evaluated, 1 Technical evaluated, 2 Financial evaluated, 3 Awarded), anomaly flag "winner is not the lowest price" (idea from IshanMaheshwari-777, re-implemented) in `packages/core/src/gem/result.ts`; unit tests in `packages/core/test/gem/result.test.ts` FR-060, FR-064 (#100)
- [ ] T069 [US6] Schema: `tender_results` (`tender_id` pk/fk, `evaluation_status`, `bidders` jsonb, `source_url`, `fetched_at`, `error`) and `ingestion_runs.kind text not null default 'listing'` in `packages/db/src/schema.ts` + migration in `packages/db/migrations/` FR-061 (#101)
- [ ] T070 [US6] mock-gem: `bidrastatus` + `byStatus` handling in `POST /all-bids-data`, `GET /bidding/bid/getBidResultView/:id` serving the T066 fixture, `POST /__admin/award/<bidNumber>` in `tools/mock-gem/src/app.ts` FR-060 (#102)
- [ ] T071 [US6] `refreshResults(deps)`: select ≤ 50 tracked tenders (matches ∪ analyses ∪ workspaces of any org) closed within 30 days and not fetched in 24 h; status lookup, result fetch when awarded, upsert `tender_results`, set `tenders.status='awarded'`, event `awarded`, in-app "Result published: <title> — L1 <seller> at ₹<price>" (kind `result`, dedupe per tender/org); record a `results` run in `apps/api/src/services/results.ts`; run once per IST day from 10:00 in `apps/api/src/lib/scheduled.ts`; tests in `apps/api/test/results.test.ts` FR-061, FR-063 (#103)
- [ ] T072 [US6] `GET /tenders/:id/result` (+ `TenderResultDto` in `packages/core/src/contracts/identify.ts`) in `apps/api/src/routes/tenders.ts`; test in `apps/api/test/results.test.ts` FR-062 (#104)
- [ ] T073 [US6] Result tab (evaluation status badge, bidder table with L1 highlight and ₹ Indian grouping, GeM source link, "GeM hasn’t published the result yet. We check daily for 30 days after closing." state, loading/error states, 375 px stacked rows) in `apps/web/src/features/tender/ResultTab.tsx` wired into `apps/web/src/features/tender/TenderPage.tsx` FR-062, NFR-005 (#105)
- [ ] T074 [US6] `GET /insights/competitors?category=&state=` aggregating sellers by wins, awarded value, categories and anomaly count over the org's tracked awarded tenders in `apps/api/src/routes/insights.ts` mounted in `apps/api/src/app.ts`; test in `apps/api/test/results.test.ts` FR-064, NFR-004 (#106)
- [ ] T075 [US6] Competitors page (filters, table, empty state "No awarded results for your tracked tenders yet", nav entry) in `apps/web/src/features/insights/CompetitorsPage.tsx`, route in `apps/web/src/app/router.tsx` FR-064 (#107)
- [ ] T076 [US6] QA: Playwright E2E for US6 in `e2e/003-identify-ingestion-alerts/US6-results.e2e.ts` covering spec US6 scenarios 1–6 (award via mock-gem admin, trigger results refresh, Result tab with L1 row, not-yet-published state, "Result published" notification, Competitors table + filter, parser-failure leaves data untouched; `@mobile` Result tab at 375 px) with evidence (screenshots, video, trace) in `qa/evidence/003/US6/` and `qa/evidence/003/US6/VERDICT.md` FR-060, FR-061, FR-062, FR-063, FR-064 (#108)

**Checkpoint**: All six stories independently functional

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T077 [P] Fold this spec's additions (cooldown 429, watchlist limit 409, saved views, unsubscribe, result & insights endpoints, `saved_views`, `tender_results`, `notifications.attempts/next_attempt_at`, kinds `corrigendum`/`result`) into `specs/001-gem-tender-copilot/contracts/api.md` and `specs/001-gem-tender-copilot/data-model.md` FR-013, FR-027, FR-035, FR-048, FR-062, FR-064 (#109)
- [x] T078 [P] Performance check: script seeding 50,000 tenders and 500 matches/org, measuring p95 of `GET /tenders` (several filter combos) and `POST /watchlists/preview` against local Postgres in `scripts/perf/identify.ts`; record results in `qa/evidence/003/perf.md` NFR-003, SC-005 (#110)
- [x] T079 Run `/cairn-analyze` on `specs/003-identify-ingestion-alerts/` and fix spec/plan/tasks inconsistencies; update the US1 reference in `specs/001-gem-tender-copilot/tasks.md` (T081) to point to T022/T032/T044/T055 NFR-008 (#111)
- [ ] T080 Cairn review of the 003 change set per `CONVENTIONS.md` (review checklist: Constitution I/II/IV first, licences + `NOTICE`, org scoping of new tables/routes) and address findings before closing the story PRs NFR-004, NFR-009 (#112)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T003/T004 independent; T004 blocks all QA tasks.
- **Foundational (Phase 2)**: done.
- **US1 (P1)** → feeds data for US2–US6 E2Es (each E2E syncs mock-gem itself).
- **US2, US3, US4 (P1)**: independent of each other at code level; US3/US4 E2Es create a watchlist via API.
- **US5 (P2)**: T061 before T062; T060 before T062; T063 before T064/T065.
- **US6 (P3)**: T066 → T067/T068 → T069 → T070 → T071 → T072 → T073/T074 → T075 → T076.
- **Polish**: after the stories it documents.

### Parallel Opportunities

- T003, T004, T018, T025, T041, T042, T043, T053, T060, T063, T066, T067, T068 touch disjoint files.
- QA tasks T022, T032, T044, T055 can be written in parallel once T004 exists (run serially: `workers: 1`).

## Implementation Strategy

1. Close P1 gaps that affect trust first: T003 (NOTICE), T018 (drift), T025, T053, then QA T022/T032/T044/T055 → P1 MVP verified.
2. Hardening: T019–T021, T030–T031, T050–T052, T054.
3. P2 corrigendum completion T060–T065.
4. P3 results/insights T066–T076.
5. Polish T077–T080.
