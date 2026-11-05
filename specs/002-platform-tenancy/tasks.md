---

description: "Task list for 002 Platform — accounts, organizations, roles, settings & notification preferences"
---

# Tasks: Platform — Accounts, Organizations, Roles, Settings & Notification Preferences

**Input**: Design documents from `/specs/002-platform-tenancy/` (`spec.md`, `plan.md`); contracts in `specs/001-gem-tender-copilot/contracts/api.md § Platform`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: REQUIRED (Constitution VI): API integration tests against real Postgres in `apps/api/test/`, unit tests next to new libs,
and one Playwright E2E per user story with evidence (screenshots, video, trace) in `qa/evidence/002/US<n>/`.

**Organization**: Tasks are grouped by user story. `[x]` = verified as implemented in the code on 2026-11-05 (file paths given);
`[ ]` = remaining work (gaps, hardening, missing tests, QA). Every open task is sized ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US7)
- Each task names exact file paths and the requirement ids it implements

## Path Conventions

- API: `apps/api/src/`, tests `apps/api/test/`
- Web: `apps/web/src/`
- Shared contracts: `packages/core/src/contracts/`; schema: `packages/db/src/schema.ts`, migrations `packages/db/migrations/`
- E2E: `e2e/002-platform/`, evidence `qa/evidence/002/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 pnpm monorepo with `packages/core`, `packages/db`, `apps/api`, `apps/web` (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`)
- [x] T002 Platform tables `users`, `organizations`, `memberships`, `invitations`, `sessions`, `api_tokens`, `notification_prefs`, `activity_log` in `packages/db/src/schema.ts` FR-001 FR-031 FR-042
- [x] T003 Playwright harness with real Postgres, mock-gem and built SPA (`playwright.config.ts`, `e2e/support/global-setup.ts`, `e2e/support/fixtures.ts`) SC-006

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [x] T004 `createApp` with `/api` router, `/api/health`, error handler, request id, `cache-control: no-store` in `apps/api/src/app.ts`, `apps/api/src/middleware/request.ts`, `apps/api/src/middleware/error.ts` FR-049
- [x] T005 [P] Standard error envelope and zod validation → `validation_error` with `details.fields` in `apps/api/src/lib/errors.ts`, `apps/api/src/lib/validate.ts` FR-049
- [x] T006 [P] PBKDF2-SHA256 hashing, `randomToken`, `sha256Hex`, `timingSafeEqual`, dummy hash in `apps/api/src/lib/crypto.ts` FR-003
- [x] T007 Session cookie, `startSession`, `resolveAuth` (cookie or `Bearer tp_…`), sliding expiry, org fallback in `apps/api/src/lib/session.ts` FR-004 FR-036
- [x] T008 `requireAuth`, `requireRole(min)`, `requireSession`, `orgId(c)`, `userId(c)` in `apps/api/src/middleware/auth.ts` FR-022 FR-023
- [x] T009 [P] `logActivity` helper in `apps/api/src/lib/activity.ts` and `buildMe` in `apps/api/src/lib/me.ts` FR-007 FR-042
- [x] T010 [P] Shared contracts (signup/login/invite/me/prefs/tokens/members/activity schemas, ROLES, ROLE_RANK, `roleAtLeast`, `emailSchema`, `phoneE164Schema`) in `packages/core/src/contracts/auth.ts`, `packages/core/src/contracts/common.ts` FR-001 FR-022 FR-030
- [x] T011 [P] Web API client (`ApiError`, `api.*`, `queryClient` retry rules) in `apps/web/src/lib/api.ts` FR-049
- [x] T012 Web `AuthProvider`, `useAuth`, `can`, `useCan`, `RoleGate`, `RequireAuth`, `safeNext`, `ME_KEY` in `apps/web/src/lib/auth.tsx` FR-009 FR-026
- [x] T013 API test harness (`createTestApp`, truncate, helpers) in `apps/api/test/helpers.ts` NFR-008
- [ ] T014 [P] Add `@axe-core/playwright` dev dependency and an `a11y(page, spec, story, name)` helper that runs axe (WCAG 2.1 AA tags), writes the JSON report to `qa/evidence/<spec>/<story>/axe-<name>.json` and fails on serious/critical violations in `e2e/support/fixtures.ts`, `package.json` NFR-004 SC-005 (#10)
- [ ] T015 [P] Add `createOrgWithRoles(request)` helper (owner signup + invite/accept bid_manager, analyst, viewer via API; returns credentials and storage states) in `e2e/support/platform.ts` SC-006 (#11)

**Checkpoint**: Foundation ready — user story work can proceed in parallel

---

## Phase 3: User Story 1 - Sign up, sign in, sign out and stay signed in (Priority: P1) 🎯 MVP

**Goal**: Visitors create an account + organization, sign in/out, sessions last 30 days and slide; brute force is throttled; users can reset passwords and manage sessions.

**Independent Test**: Empty DB → `/signup` → `/onboarding` → sign out → sign in → `GET /api/auth/me` returns the same user/org.

### Implemented

- [x] T016 [US1] `POST /api/auth/signup` (transactional user + org + owner membership + default prefs, unique slug, 409 on duplicate incl. `23505` race, `org.created` activity) in `apps/api/src/routes/auth.ts` FR-001 FR-002
- [x] T017 [US1] `POST /api/auth/login` (dummy-hash timing, last-used org restore, 403 `no_organization`), `POST /api/auth/logout`, `GET /api/auth/me` in `apps/api/src/routes/auth.ts` FR-005 FR-006 FR-007
- [x] T018 [US1] `POST /api/me/password` (current password check, sign out other sessions, session-only) in `apps/api/src/routes/auth.ts` FR-008
- [x] T019 [US1] Route guards `PublicOnly`, `Protected`, `/login?next=` redirect with open-redirect protection in `apps/web/src/app/router.tsx`, `apps/web/src/lib/auth.tsx` FR-009
- [x] T020 [P] [US1] Split-screen `AuthLayout`, `PasswordInput` (show/hide with `aria-pressed`) + `StrengthMeter`, `FormAlert` in `apps/web/src/features/auth/AuthLayout.tsx`, `apps/web/src/features/auth/PasswordInput.tsx`, `apps/web/src/features/auth/FormAlert.tsx` FR-001 NFR-004
- [x] T021 [P] [US1] Login page with inline validation, error alert, `next` handling, welcome toast in `apps/web/src/features/auth/LoginPage.tsx` FR-005 FR-009
- [x] T022 [P] [US1] Signup page with inline validation, 409 → email field error, redirect to `/onboarding` in `apps/web/src/features/auth/SignupPage.tsx` FR-001 FR-002
- [x] T023 [US1] API tests: signup, secure cookie on https, duplicate 409, login/logout lifecycle, 401 format, 30-day expiry + sliding, change password signs out others in `apps/api/test/auth.test.ts` FR-001..FR-008

### Remaining

- [x] T024 [US1] Add `auth_attempts` table (`key`, `kind`, `window_start`, `count`, pk `(key, kind)`) and generate the migration in `packages/db/src/schema.ts`, `packages/db/migrations/` FR-010 (#12)
- [x] T025 [US1] Implement Postgres-backed limiter `check/hit/reset(db, key, kind, {limit, windowMs})` with atomic upsert and client-IP extraction (`cf-connecting-ip` → first `x-forwarded-for` hop) plus unit/API tests in `apps/api/src/lib/rate-limit.ts`, `apps/api/test/rate-limit.test.ts` FR-010 NFR-002 (#13)
- [x] T026 [US1] Wire the limiter into `POST /auth/login`, `POST /auth/accept-invite` (existing-user path) and `POST /me/password` (10/email, 30/IP per 15 min; 429 `rate_limited` + `Retry-After`; reset on success) with tests for the 11th attempt in `apps/api/src/routes/auth.ts`, `apps/api/test/rate-limit.test.ts` FR-010 SC-007 (#14)
- [x] T027 [P] [US1] Show the 429 message ("Too many attempts. Try again in N minutes.") on the login and accept-invite forms instead of the generic credentials error in `apps/web/src/features/auth/LoginPage.tsx`, `apps/web/src/features/auth/AcceptInvitePage.tsx` FR-010 (#15)
- [x] T028 [US1] Add `password_resets` table + migration and `POST /api/auth/forgot-password` (always 200, 60-min single-use token, email via mailer, 3/email/hour) and `POST /api/auth/reset-password` (set password, delete all sessions, mark used, start session; 400 `reset_invalid`) with API tests in `packages/db/src/schema.ts`, `apps/api/src/routes/auth.ts`, `packages/core/src/contracts/auth.ts`, `apps/api/test/password-reset.test.ts` FR-011 NFR-003 (#16)
- [x] T029 [P] [US1] Add `/forgot-password` and `/reset-password/:token` pages (neutral confirmation copy, expired-link state with "Request a new link") and replace "Forgot? Ask your org owner" with a "Forgot password?" link in `apps/web/src/features/auth/ForgotPasswordPage.tsx`, `apps/web/src/features/auth/ResetPasswordPage.tsx`, `apps/web/src/app/router.tsx`, `apps/web/src/features/auth/LoginPage.tsx` FR-011 (#17)
- [x] T030 [US1] Add `sessions.user_agent` and `sessions.last_seen_at` (migration), set them in `startSession` and refresh `last_seen_at` at most every 5 minutes in `resolveAuth` in `packages/db/src/schema.ts`, `apps/api/src/lib/session.ts` FR-012 (#18)
- [x] T031 [US1] Add `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `POST /api/me/sessions/revoke-others` (session-only, own sessions only, 404 otherwise) with API tests in `apps/api/src/routes/auth.ts`, `packages/core/src/contracts/auth.ts`, `apps/api/test/sessions.test.ts` FR-012 FR-036 (#19)
- [x] T032 [P] [US1] "Where you’re signed in" panel (browser/OS summary, "This device" badge, last active, per-row "Sign out", "Sign out of all other devices", confirm dialog) in `apps/web/src/features/settings/sections/SessionsPanel.tsx`, `apps/web/src/features/settings/sections/AccountSection.tsx`, `apps/web/src/features/settings/api.ts` FR-012 (#20)
- [x] T033 [US1] Global session-end handling: `QueryCache`/`MutationCache` `onError` → on 401 while signed in clear cache, set `ME_KEY` null, single toast "Your session ended. Please sign in again." (RequireAuth redirects with `next`) in `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.tsx` FR-013 (#21)
- [x] T034 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in qa/evidence/002/US1/ — scenarios 1–13 (+14–17 once shipped) on desktop and `@mobile`, axe on `/login` and `/signup`, in `e2e/002-platform/US1-auth.e2e.ts`, `qa/evidence/002/US1/VERDICT.md` FR-001..FR-013 SC-001 (#22)

**Checkpoint**: US1 independently functional and verified

---

## Phase 4: User Story 2 - Invite teammates and join an organization (Priority: P1)

**Goal**: Bid Managers/Owners invite by email + role; invitees join from the link as new, existing or signed-in users; multi-org users switch orgs.

**Independent Test**: Owner invites `analyst@x.in` as Analyst → link opened in a fresh context → account created → member listed as Analyst; activity shows invited + joined.

### Implemented

- [x] T035 [US2] `POST /api/org/invitations` (owner-only Owner invites, 409 existing member, replace pending, hashed 7-day token, email via mailer with escaped HTML, failure logged), `DELETE /api/org/invitations/:id`, pending list in `GET /api/org/members` in `apps/api/src/routes/org.ts` FR-014 FR-015 FR-020
- [x] T036 [US2] `GET /api/auth/invite/:token` preview and `POST /api/auth/accept-invite` (signed-in / existing user + password / new user + name + password; membership `ON CONFLICT DO NOTHING`; `member.joined`) in `apps/api/src/routes/auth.ts` FR-016 FR-017
- [x] T037 [US2] `POST /api/auth/switch-org` (session-only, 404 for non-member) and last-used-org restore on login in `apps/api/src/routes/auth.ts` FR-021 FR-005
- [x] T038 [P] [US2] Team section `InviteDialog` (validation, role select without Owner for non-owners, success state with copy link) and "Pending invitations" panel with Revoke in `apps/web/src/features/settings/sections/TeamSection.tsx`, `apps/web/src/features/settings/api.ts` FR-014 FR-020
- [x] T039 [P] [US2] Accept-invite page (signed-in "Accept & join team" / "Not you?", signed-out new-user form, error mapping) in `apps/web/src/features/auth/AcceptInvitePage.tsx` FR-017
- [x] T040 [P] [US2] Org switcher with role per org, cache clear and toast in `apps/web/src/components/layout/OrgSwitcher.tsx`, `apps/web/src/lib/auth.tsx` FR-021
- [x] T041 [US2] API tests: invite → preview → new account joins; existing user accepts with password then switches; signed-in accept; expired/invalid rejected; bid manager revokes in `apps/api/test/auth.test.ts` FR-014..FR-017 FR-020 FR-021

### Remaining

- [ ] T042 [US2] Reject accept-invite when a signed-in user's email differs from the invitation email with 403 `invite_email_mismatch` "This invitation was sent to <email>. Sign out and continue as that account." (no membership created) + API test in `apps/api/src/routes/auth.ts`, `apps/api/test/auth.test.ts` FR-018 (#23)
- [ ] T043 [US2] Load `GET /api/auth/invite/:token` before rendering: skeleton while loading; card "<Inviter> invited you to join <Org> as <Role> · Expires <date>"; `existingUser` + signed out → read-only email + password-only "Sign in & join"; invalid → ErrorState "Ask your admin for a new invitation" + "Go to sign in"; mismatch message with "Sign out" action in `apps/web/src/features/auth/AcceptInvitePage.tsx`, `apps/web/src/features/auth/api.ts` FR-019 FR-018 (#24)
- [ ] T044 [US2] Add `POST /api/org/invitations/:id/resend` (Bid Manager+, new token + 7-day expiry, re-email, `member.invite_resent` activity) with API test, and a "Resend" button with toast "Invitation resent to <email>" in `apps/api/src/routes/org.ts`, `apps/api/test/auth.test.ts`, `apps/web/src/features/settings/sections/TeamSection.tsx`, `apps/web/src/features/settings/api.ts` FR-020 (#25)
- [ ] T045 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in qa/evidence/002/US2/ — scenarios 1–15 incl. two browser contexts (inviter/invitee), mobile accept flow `@mobile`, captured invite email from log mailer, in `e2e/002-platform/US2-invitations.e2e.ts`, `qa/evidence/002/US2/VERDICT.md` FR-014..FR-021 SC-002 (#26)

**Checkpoint**: US1 and US2 work independently

---

## Phase 5: User Story 3 - Roles are enforced and organizations are isolated (Priority: P1)

**Goal**: Server-side role hierarchy and org scoping on every route; UI mirrors permissions; members can leave; CSRF defence in depth.

**Independent Test**: Org A with one user per role + org B; role matrix and cross-org matrix over all endpoints.

### Implemented

- [x] T046 [US3] Role minimums applied per route (viewer reads; analyst writes; bid_manager org/invites/weights/ingestion/demo/overrides/annexure templates; owner role changes & removal) in `apps/api/src/routes/*.ts` via `apps/api/src/middleware/auth.ts` FR-022
- [x] T047 [US3] `PATCH /api/org/members/:userId` and `DELETE /api/org/members/:userId` with last-owner guard (409 `last_owner`), transactional token deletion, `member.role_changed`/`member.removed` activity in `apps/api/src/routes/org.ts` FR-024 FR-025
- [x] T048 [P] [US3] Team table with owner-only role select and remove (confirm dialog), "(you)" marker, "What each role can do" cards in `apps/web/src/features/settings/sections/TeamSection.tsx` FR-025 FR-026
- [x] T049 [P] [US3] Client permission mirroring: `can()`, `<RoleGate>`, nav `min`, palette quick actions by role, "View-only access" card, read-only explanations in `apps/web/src/lib/auth.tsx`, `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/components/layout/CommandPalette.tsx`, `apps/web/src/features/settings/sections/*.tsx` FR-026
- [x] T050 [US3] API tests: role hierarchy, last-owner protection and removal revokes access, two orgs cannot see/touch each other's members, invitations or activity in `apps/api/test/auth.test.ts` FR-022..FR-025

### Remaining

- [x] T051 [P] [US3] Table-driven role-matrix test: every mutating route in `contracts/api.md` × {viewer, analyst, bid_manager, owner} asserting 403 below the minimum and non-403 at/above, plus a guard that fails when a new route is added without a matrix entry, in `apps/api/test/roles-matrix.test.ts` FR-022 NFR-008 SC-003 (#27)
- [x] T052 [P] [US3] Cross-org isolation sweep: create one of each org-scoped resource in org A (tender analysis, watchlist, vault doc, workspace, packet, comment, notification, API token, invitation, member) and assert org B gets 404 on every read/update/delete by id and that A's rows are unchanged, in `apps/api/test/isolation.test.ts` FR-023 NFR-008 SC-003 (#28)
- [x] T053 [US3] Add `DELETE /api/org/members/me` (session-only; deletes own membership + own tokens for the org; 409 `last_owner`; `member.left` activity; returns `nextOrgId` and moves the session's active org) with API tests in `apps/api/src/routes/org.ts`, `apps/api/test/auth.test.ts` FR-027 FR-042 (#29)
- [x] T054 [P] [US3] "Leave organization" danger panel in Team section with confirm dialog; on success switch to `nextOrgId` or sign out to `/login` with toast "You left <Org>." in `apps/web/src/features/settings/sections/TeamSection.tsx`, `apps/web/src/features/settings/api.ts`, `apps/web/src/lib/auth.tsx` FR-027 (#30)
- [x] T055 [US3] Origin check middleware: cookie-authenticated non-GET/HEAD requests with an `Origin` not equal to `config.appUrl` origin → 403 `bad_origin`; bearer requests and missing Origin pass; tests in `apps/api/src/middleware/security.ts`, `apps/api/src/app.ts`, `apps/api/test/security.test.ts` FR-028 (#31)
- [x] T056 [P] [US3] On a mutation 403 `forbidden`, toast the server message and invalidate `ME_KEY` so role-gated UI refreshes in `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.tsx` FR-029 (#32)
- [ ] T057 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in qa/evidence/002/US3/ — viewer/analyst/bid manager/owner walkthroughs showing hidden actions, owner role change taking effect live, member removal, last-owner error, cross-org 404 via `request` context, in `e2e/002-platform/US3-roles-tenancy.e2e.ts`, `qa/evidence/002/US3/VERDICT.md` FR-022..FR-029 (#33)

**Checkpoint**: US1–US3 (the P1 set) complete

---

## Phase 6: User Story 4 - Personal account and notification preferences (Priority: P2)

**Goal**: Users manage name, mobile and password; per-org alert channels, frequency and expiry reminders are stored and honoured.

**Independent Test**: Enable WhatsApp with `98220 12345` + Daily, save, reload; `GET /api/me/notification-prefs` and `me.user.phone = +919822012345`.

### Implemented

- [x] T058 [US4] `PATCH /api/me` (name, E.164 phone or null) in `apps/api/src/routes/auth.ts` FR-030
- [x] T059 [US4] `GET/PUT /api/me/notification-prefs` per (org, user) with defaults and WhatsApp-needs-phone rule in `apps/api/src/routes/auth.ts` FR-031 FR-032
- [x] T060 [P] [US4] Account section (name, read-only email, Indian mobile → E.164, password panel) in `apps/web/src/features/settings/sections/AccountSection.tsx` FR-030 FR-008
- [x] T061 [P] [US4] Notifications section (In-app, Email, WhatsApp + inline number, Instant/Daily, Expiry reminders, dirty-tracking save) in `apps/web/src/features/settings/sections/NotificationsSection.tsx` FR-031 FR-032
- [x] T062 [US4] Alert and reminder services honour `inApp`, `email`, `whatsapp`, `frequency`, `expiryReminders` in `apps/api/src/services/ingest.ts`, `apps/api/src/services/alerts.ts`, `apps/api/src/services/reminders.ts` FR-033
- [x] T063 [US4] API test: PATCH /me validates phone; WhatsApp prefs need a phone in `apps/api/test/auth.test.ts` FR-030 FR-032

### Remaining

- [ ] T064 [P] [US4] API tests: prefs default when no row, full-object PUT round-trip, preferences isolated per org for a two-org user, viewer can edit own prefs in `apps/api/test/prefs.test.ts` FR-031 (#34)
- [ ] T065 [P] [US4] Account section: when clearing the mobile while WhatsApp alerts are on, show the inline warning "WhatsApp alerts will stop until you add a mobile number." before saving in `apps/web/src/features/settings/sections/AccountSection.tsx` FR-032 (#35)
- [ ] T066 [US4] Add `POST /api/me/notifications/test` (1/min per user; in-app row "Test alert from TenderPilot"; email/WhatsApp attempted only when enabled; returns per-channel `sent|skipped|failed|off`) with API test using log adapters in `apps/api/src/routes/notifications.ts`, `apps/api/test/prefs.test.ts` FR-034 NFR-007 (#36)
- [ ] T067 [P] [US4] "Send a test alert" button in Notifications section with per-channel outcome toast in `apps/web/src/features/settings/sections/NotificationsSection.tsx`, `apps/web/src/features/settings/api.ts` FR-034 (#37)
- [ ] T068 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in qa/evidence/002/US4/ — defaults, WhatsApp without number error, save + reload persistence, profile edit and invalid mobile, `@mobile` layout, axe on account + notifications in `e2e/002-platform/US4-account-prefs.e2e.ts`, `qa/evidence/002/US4/VERDICT.md` FR-030..FR-034 (#38)

**Checkpoint**: US4 independently functional

---

## Phase 7: User Story 5 - API tokens for the Chrome extension (Priority: P2)

**Goal**: Users create, use and revoke personal tokens; tokens cannot manage the account; optional expiry and hints.

**Independent Test**: Create token → `GET /api/workspaces` with bearer 200 → `POST /api/me/api-tokens` with bearer 403 → revoke → 401.

### Implemented

- [x] T069 [US5] `GET/POST/DELETE /api/me/api-tokens` (prefix `tp_`, hash-only storage, shown once, scoped to user+org, `api_token.created/revoked` activity) in `apps/api/src/routes/auth.ts` FR-035 FR-042
- [x] T070 [US5] Bearer authentication with membership check and `lastUsedAt` throttled to 60 s in `apps/api/src/lib/session.ts` FR-036
- [x] T071 [US5] `requireSession` on token creation, password change and org switch in `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/auth.ts` FR-036
- [x] T072 [P] [US5] Tokens section: list, empty state, create dialog with one-time secret + copy, revoke confirm, extension setup guide and compliance note in `apps/web/src/features/settings/sections/TokensSection.tsx` FR-035
- [x] T073 [US5] API tests: create → bearer auth → list without secret → revoke; cannot revoke another user's token in `apps/api/test/auth.test.ts` FR-035 FR-036

### Remaining

- [ ] T074 [US5] Add `api_tokens.expires_at` (nullable) and `api_tokens.token_hint` (last 4 chars) + migration in `packages/db/src/schema.ts`, `packages/db/migrations/` FR-037 (#39)
- [ ] T075 [US5] Accept `expiresInDays` (30|90|365|null, default 90), store hint, reject expired tokens in `resolveAuth`, enforce 10 active tokens per user per org (409 `token_limit`), return `expiresAt`/`hint` in summaries, with API tests in `apps/api/src/routes/auth.ts`, `apps/api/src/lib/session.ts`, `packages/core/src/contracts/auth.ts`, `apps/api/test/tokens.test.ts` FR-037 (#40)
- [ ] T076 [P] [US5] Create dialog expiry select (30 days / 90 days / 1 year / Never) and list rows showing `tp_…<hint>` and "Expires in N days" (amber < 7 days, red "Expired") in `apps/web/src/features/settings/sections/TokensSection.tsx`, `apps/web/src/features/settings/api.ts` FR-037 (#41)
- [ ] T077 [P] [US5] API tests: bearer token refused (403 "This action requires signing in on the web app") on `POST /me/api-tokens`, `POST /me/password`, `POST /auth/switch-org`; token stops working after member removal; role change applies to token requests in `apps/api/test/tokens.test.ts` FR-036 (#42)
- [ ] T078 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in qa/evidence/002/US5/ — create/copy/revoke in UI, bearer calls via `request` context before/after revoke, secret not shown after dialog closes, `@mobile` layout, in `e2e/002-platform/US5-api-tokens.e2e.ts`, `qa/evidence/002/US5/VERDICT.md` FR-035..FR-037 (#43)

**Checkpoint**: US5 independently functional

---

## Phase 8: User Story 6 - Organization administration: settings, scoring weights, sync health and activity log (Priority: P3)

**Goal**: Rename org, see plan, tune scoring weights, monitor/trigger sync, browse an org audit trail.

**Independent Test**: Bid Manager renames org, changes Turnover weight, runs Sync now → activity log shows all three.

### Implemented

- [x] T079 [US6] `GET/PATCH /api/org` (Bid Manager+, name + onboarding merge + scoring weights, `org.updated` only for meaningful changes) and Organization section (name, slug, plan panel, demo data) in `apps/api/src/routes/org.ts`, `apps/web/src/features/settings/sections/OrganizationSection.tsx` FR-038
- [x] T080 [P] [US6] Scoring weights section (sliders 0–50, share %, defaults, reset, total-0 guard, role gating) on `GET/PUT /api/scoring-weights` in `apps/web/src/features/settings/sections/ScoringSection.tsx`, `apps/api/src/routes/analysis.ts` FR-040
- [x] T081 [P] [US6] Sync health section (status tiles, runs table, last error, 60 s refresh, Sync now for Bid Manager+) in `apps/web/src/features/settings/sections/SyncSection.tsx`, `apps/api/src/routes/ingestion.ts` FR-041
- [x] T082 [US6] `GET /api/activity` with filters + pagination and activity writes for org/member/token actions; API test "activity supports filters and pagination" in `apps/api/src/routes/org.ts`, `apps/api/test/auth.test.ts` FR-042 FR-043
- [x] T083 [US6] Settings shell with lazy sections, side nav ≥ 1024 px / scrollable tabs below, redirects (`/settings` → organization, `tokens` → `api-tokens`) in `apps/web/src/features/settings/SettingsPage.tsx` FR-039

### Remaining

- [ ] T084 [P] [US6] Add index `activity_org_type_idx (org_id, entity_type, created_at)` + migration in `packages/db/src/schema.ts`, `packages/db/migrations/` FR-043 NFR-001 (#44)
- [ ] T085 [US6] Activity log page at `/settings/activity`: sentences via `describeActivity`, relative time with IST tooltip, Member and Type filters (mapped to `entityType`), 25 per page with "Showing a–b of n", skeleton/empty ("No activity yet")/error states, responsive list on phones; add nav item "Activity log" in `apps/web/src/features/settings/sections/ActivitySection.tsx`, `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/settings/api.ts`, `apps/web/src/features/dashboard/activity.ts` FR-044 FR-039 (#45)
- [ ] T086 [US6] Log `auth.password_changed` and `auth.sessions_revoked` (active org, no secrets in meta) and add verbs for `member.left`, `member.invite_revoked`, `member.invite_resent`, `auth.*` in `apps/api/src/routes/auth.ts`, `apps/web/src/features/dashboard/activity.ts` FR-042 (#46)
- [ ] T087 [US6] API test asserting every FR-042 action produces exactly one activity row with expected `entityType`, actor and safe `meta` in `apps/api/test/activity.test.ts` FR-042 SC-008 (#47)
- [ ] T088 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in qa/evidence/002/US6/ — rename org (and disabled state for Analyst), scoring weights change/reset/zero-total, Sync now against mock-gem, activity log filters and pagination, `@mobile` settings tab strip, in `e2e/002-platform/US6-org-admin.e2e.ts`, `qa/evidence/002/US6/VERDICT.md` FR-038..FR-044 (#48)

**Checkpoint**: US6 independently functional

---

## Phase 9: User Story 7 - App shell, navigation, command palette, theme and design system (Priority: P2)

**Goal**: One accessible, responsive shell with keyboard navigation and themes, built from the documented design system.

**Independent Test**: Desktop + phone: navigate all main pages, Ctrl+K and G+V, dark theme persists across reload, axe clean.

### Implemented

- [x] T089 [US7] AppShell: collapsible persisted sidebar, mobile drawer + bottom tab bar (Home, Tenders, Pipeline, Vault, More), top bar, skip link, focus-to-main on route change, reduced-motion-aware transitions in `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/components/layout/nav.ts` FR-045
- [x] T090 [P] [US7] Command palette (Ctrl/⌘K, "/", role-filtered groups, theme + sign out, tender search, G-then-key navigation) in `apps/web/src/components/layout/CommandPalette.tsx` FR-046
- [x] T091 [P] [US7] Theme provider (light/dark/system, `tp-theme`, OS change listener) and pre-paint script in `apps/web/src/lib/theme.tsx`, `apps/web/index.html`, `apps/web/src/components/layout/ThemeToggle.tsx` FR-047
- [x] T092 [P] [US7] Route error boundary (new-version vs snag), Not Found page, Splash in `apps/web/src/components/layout/RouteErrorBoundary.tsx`, `apps/web/src/app/NotFoundPage.tsx`, `apps/web/src/app/router.tsx` FR-045
- [x] T093 [P] [US7] Design system components, tokens and README; dev gallery at `/dev/ui` in `apps/web/src/components/ui/*`, `apps/web/src/components/ui/README.md`, `apps/web/src/app/UiGallery.tsx` FR-048
- [x] T094 [P] [US7] User menu (profile, company profile, settings, theme submenu, palette, sign out) in `apps/web/src/components/layout/UserMenu.tsx` FR-045 FR-047

### Remaining

- [ ] T095 [P] [US7] Add a "Settings" group to the palette listing all settings sub-pages (Organization, Your account, Team & roles, Notifications, Scoring weights, API tokens & extension, Sync health, Activity log) with keywords, sourced from a shared `SETTINGS_ITEMS` export in `apps/web/src/components/layout/CommandPalette.tsx`, `apps/web/src/features/settings/items.ts`, `apps/web/src/features/settings/SettingsPage.tsx` FR-046 (#49)
- [ ] T096 [P] [US7] "?" opens a "Keyboard shortcuts" dialog (⌘K, /, G+D/T/W/P/V/C/S/N, Esc), also reachable from the user menu in `apps/web/src/components/layout/ShortcutsDialog.tsx`, `apps/web/src/components/layout/CommandPalette.tsx`, `apps/web/src/components/layout/UserMenu.tsx` FR-046 NFR-004 (#50)
- [ ] T097 [US7] Fix every serious/critical axe finding and contrast issue reported by T034/T045/T057/T068/T078/T088/T098 across shell, auth and settings in light and dark at 375/1440 px in `apps/web/src/components/**`, `apps/web/src/features/auth/**`, `apps/web/src/features/settings/**`, `apps/web/src/index.css` NFR-004 NFR-005 SC-005 (#51)
- [ ] T098 [US7] QA: Playwright E2E for US7 with evidence (screenshots, video, trace) in qa/evidence/002/US7/ — sidebar collapse persistence, mobile tab bar + drawer `@mobile`, palette open/filter/quick actions per role, G-shortcuts, theme persistence without flash, skip link + focus, 404 page, axe scans light/dark at 375/1440 in `e2e/002-platform/US7-shell.e2e.ts`, `qa/evidence/002/US7/VERDICT.md` FR-045..FR-048 NFR-004 NFR-005 (#52)

**Checkpoint**: All user stories independently functional

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T099 [P] Security headers middleware (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS on https, CSP for SPA responses with the theme-script hash) for Node and Worker static responses, with tests in `apps/api/src/middleware/security.ts`, `apps/api/src/app.ts`, `apps/api/src/node.ts`, `apps/api/test/security.test.ts` FR-050 (#53)
- [ ] T100 [P] Secret-leak scanner test: run auth/org/token/invite/reset flows with a capturing logger and assert no password, `tp_` token, invite/reset token or hash appears in logs, list responses or activity `meta` in `apps/api/test/secrets-leak.test.ts` NFR-003 SC-004 (#54)
- [ ] T101 [P] Query-count/perf test for `GET /api/auth/me` (≤ 4 queries via instrumented Drizzle logger) and p95 timing smoke for login/me in `apps/api/test/perf-auth.test.ts` NFR-001 (#55)
- [ ] T102 [P] Record in `NOTICE` (or confirm no change) that spec 002 ports no third-party code from `/home/user/refs` FR-048 (#56)
- [ ] T103 Update `specs/001-gem-tender-copilot/contracts/api.md § Platform` with the new endpoints and error codes (`rate_limited`, `invite_email_mismatch`, `bad_origin`, `reset_invalid`, `token_limit`) FR-010 FR-011 FR-012 FR-018 FR-027 FR-028 FR-037 (#57)
- [ ] T104 Run `/cairn-taskstoissues` to create GitHub issues for the 7 stories and every open task (labels `spec:002`, `area:platform`, `type`, `priority`, `role`) per `CONVENTIONS.md` (#58)
- [ ] T105 `cairn-reviewer` review of each 002 PR, findings recorded on the issue, no blocking findings open (review only via cairn; no Codex) per `CONVENTIONS.md` (#59)
- [ ] T106 Run `/cairn-analyze` on `specs/002-platform-tenancy/` and resolve any spec/plan/tasks inconsistencies (#60)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** and **Foundational (Phase 2)**: done except T014/T015 (E2E helpers), which block every QA task.
- **User Stories (Phase 3+)**: independent of each other; ship P1 (US1, US2, US3) first.
- **Polish (Phase 10)**: T099/T100/T101 can start any time; T103 after the endpoints it documents; T104 first (tickets), T105 per PR.

### User Story Dependencies

- **US1**: T024 → T025 → T026 → T027; T028 → T029; T030 → T031 → T032; T033 independent; T034 last.
- **US2**: T042 → T043 (mismatch message); T044 independent; T045 last. Uses T015.
- **US3**: T051, T052, T055, T056 independent; T053 → T054; T057 last.
- **US4**: T066 → T067; others independent; T068 last.
- **US5**: T074 → T075 → T076; T077 independent; T078 last.
- **US6**: T084 → T085; T086 → T087 (and after T053 for `member.left`); T088 last.
- **US7**: T095 after T085 (Activity entry); T097 after the QA scans; T098 last.

### Parallel Opportunities

- API test suites T051, T052, T064, T077, T087, T100, T101 touch different files and can run in parallel.
- Web tasks marked [P] in different sections (T027, T029, T032, T054, T056, T065, T067, T076, T095, T096) can run in parallel.

---

## Parallel Example: User Story 3

```bash
Task: "Role-matrix test in apps/api/test/roles-matrix.test.ts"
Task: "Cross-org isolation sweep in apps/api/test/isolation.test.ts"
Task: "Origin check middleware in apps/api/src/middleware/security.ts"
Task: "403 → refetch me in apps/web/src/lib/api.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories)

1. T014, T015 (QA helpers).
2. US1 security gaps (T024–T027, T033) + QA T034.
3. US2 gaps (T042–T044) + QA T045.
4. US3 verification + gaps (T051–T056) + QA T057.
5. **STOP and VALIDATE**: P1 QA verdicts `qa:approved`.

### Incremental Delivery

6. US7 (T095–T098), US4 (T064–T068), US5 (T074–T078) — P2.
7. US6 (T084–T088) — P3.
8. Polish T099–T106.

### Notes

- [P] tasks = different files, no dependencies.
- Every task references FR/NFR/SC ids for traceability (Constitution VIII); commit trailers per `CONVENTIONS.md`.
- A story is done only when its QA task has evidence in `qa/evidence/002/US<n>/` and a `qa:approved` verdict.
