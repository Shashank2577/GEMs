# Feature Specification: Platform — Accounts, Organizations, Roles, Settings & Notification Preferences

**Feature Branch**: `002-platform-tenancy`

**Created**: 2026-11-05

**Status**: In Progress

**Input**: User description: "Platform area of TenderPilot: auth (signup/login/logout/sessions/API tokens/invites), org tenancy & roles enforcement, settings pages (account, team, notifications, API tokens, scoring weights UI hosting, sync health), activity log, app shell/navigation/command palette/theme, design system standards. Describe what is built, ground it in the code, and add requirements for gaps that matter."

**Parent spec**: `specs/001-gem-tender-copilot/spec.md` (FR-030 … FR-034). This spec refines those umbrella requirements into
testable detail. Where this spec and 001 disagree, this spec wins for the platform area.

**Grounding**: every "built" statement below was verified against `apps/api/src/routes/{auth,org}.ts`,
`apps/api/src/middleware/auth.ts`, `apps/api/src/lib/{session,crypto,activity,me,errors,validate}.ts`,
`packages/core/src/contracts/{auth,common}.ts`, `packages/db/src/schema.ts`, `apps/web/src/{app,lib,components,features/auth,features/settings}`
and `apps/api/test/auth.test.ts` on 2026-11-05. Requirements marked **(gap)** are not yet implemented.

## Personas affected

| Persona | Typical role | What the platform must do for them |
|---|---|---|
| **Owner / promoter** of an MSME or OEM reseller (often on a phone) | Owner | Create the organization, invite people, decide who can do what, never lose control of the account. |
| **Bid manager** | Bid Manager | Invite analysts, tune scoring weights, trigger a GeM sync, see who did what. |
| **Bid analyst / executive** | Analyst | Sign in daily, set personal alert preferences, create an API token for the Chrome extension. |
| **Compliance reviewer / CA / promoter's family member** | Viewer | Read everything, change nothing, with no confusing disabled-button dead ends. |
| **Invitee** (not yet a user, or a user of another org) | — | Accept an invitation link in under a minute, on any device. |
| **Support / ops** (internal) | — | Diagnose "I can't sign in" and "alerts stopped" using request ids, activity log and sync health. |

## User Scenarios & Testing *(mandatory)*

Conventions used in the scenarios: the web app runs at `APP_URL` (E2E: `http://localhost:8788`), the API at `/api`.
Error responses always have the shape `{ "error": { "code", "message", "details?" } }`; validation errors carry
`details.fields` (map of field → message). "Toast" means a sonner toast: bottom-right at >=768px, top-center below the top bar on smaller screens. "Phone" = 375×812 viewport
(Playwright project `mobile` / Pixel 7), "desktop" = 1440×900.

### User Story 1 - Sign up, sign in, sign out and stay signed in (Priority: P1) (#3)

A seller visits TenderPilot, creates an account together with their company's organization, lands in onboarding, and
can later sign in and out from any device. Sessions last 30 days and slide while used; changing a password signs out
every other device.

**Why this priority**: Nothing else in TenderPilot is reachable without an account and an organization. It is the
entry point of every persona and the first thing QA, sales demos and real users touch.

**Independent Test**: With an empty database, open `/signup`, create an account, verify onboarding loads, sign out,
sign back in, and verify `/api/auth/me` returns the same user and org. Can be fully tested without any tender data.

**Acceptance Scenarios**:

1. **Given** a signed-out visitor on `/signup`, **When** they submit name "Priya Sharma", company "Sharma Infotech Pvt Ltd", email `priya@sharma.in`, password `Bid@2026!`, **Then** `POST /api/auth/signup` returns **201** with `{user, org, role:"owner", orgs:[1 item]}`, a `tp_session` cookie is set (HttpOnly, SameSite=Lax, Path=/, 30-day expiry), a toast "Welcome to TenderPilot, Priya!" appears and the browser is on `/onboarding`.
2. **Given** the signup form, **When** the visitor submits with name empty, email `priya@`, password `short` and company `S`, **Then** no request is sent and inline errors read "Tell us your name", "Enter a valid work email", "Use at least 8 characters" and "Enter your company name".
3. **Given** `priya@sharma.in` already exists, **When** someone signs up with the same email (any case, e.g. `Priya@Sharma.IN`), **Then** the API returns **409** `conflict` with `details.fields.email = "Already registered"` and the form shows "An account with this email already exists. Try signing in." under the email field.
4. **Given** a password is being typed on signup or invite acceptance, **When** it is 0–7 characters / weak / strong, **Then** the strength meter shows "Too short", "Weak", "Fair", "Good" or "Strong", and the eye button toggles visibility with `aria-label` "Show password"/"Hide password" and `aria-pressed`.
5. **Given** a registered user on `/login`, **When** they enter the correct email and password, **Then** `POST /api/auth/login` returns **200** with `Me`, a toast "Welcome back, Priya" appears and they land on `/dashboard` (or on the `?next=` path if it is a relative in-app path).
6. **Given** `/login?next=https://evil.example` or `?next=//evil.example`, **When** login succeeds, **Then** the user lands on `/dashboard` (open-redirect protection).
7. **Given** a wrong password or an unknown email, **When** they submit, **Then** the API returns **401** `invalid_credentials` "Incorrect email or password" in the same response time band for both cases, and the form shows "That email and password don’t match. Please try again." in an alert above the fields.
8. **Given** a signed-in user, **When** they open the account menu (avatar, top right) and choose "Sign out", **Then** `POST /api/auth/logout` returns `{ok:true}`, the session row is deleted, the cookie is cleared, a toast "Signed out" appears and they are on `/login`; pressing Back does not show app data.
9. **Given** a signed-out visitor, **When** they open `/pipeline?stage=prepare`, **Then** they are redirected to `/login?next=%2Fpipeline%3Fstage%3Dprepare` and after signing in land on `/pipeline?stage=prepare`.
10. **Given** a signed-in user, **When** they open `/`, `/login` or `/signup`, **Then** they are redirected to `/dashboard`.
11. **Given** a session created 16 days ago and used today, **When** any authenticated request is made, **Then** the session expiry is extended to now + 30 days and the cookie is re-issued; a session unused for 30 days returns **401** `unauthorized` "Please sign in to continue".
12. **Given** a user signed in on two browsers A and B, **When** they change their password in A (Settings → Your account → Password) with the correct current password, **Then** **200** `{ok:true}`, toast "Password changed — Other devices have been signed out.", B's next request returns 401, A stays signed in.
13. **Given** the change-password form, **When** the current password is wrong, **Then** **400** `invalid_credentials` with `details.fields.currentPassword = "Incorrect password"` shown under the field.
14. **(gap)** **Given** 10 failed logins for the same email within 15 minutes, **When** an 11th attempt is made (even with the right password), **Then** the API returns **429** `rate_limited` "Too many attempts. Try again in N minutes." with a `Retry-After` header, and the login form shows that message.
15. **(gap)** **Given** a user who forgot their password, **When** they click "Forgot password?" on `/login`, enter their email and submit, **Then** the page always says "If an account exists for that email, we’ve sent a reset link. It expires in 1 hour." (no account enumeration); the emailed link `/reset-password/<token>` lets them set a new password once, signs out all sessions and signs them in.
16. **(gap)** **Given** a user signed in on 3 devices, **When** they open Settings → Your account, **Then** a "Where you’re signed in" panel lists 3 sessions (browser/OS from user agent, "This device" badge, last active relative time) and "Sign out" per row plus "Sign out of all other devices"; revoking a row makes that device's next request return 401.
17. **(gap)** **Given** a signed-in user whose session expires or is revoked while a page is open, **When** the next API call returns 401, **Then** the app clears cached data, shows the toast "Your session ended. Please sign in again." and redirects to `/login?next=<current path>`.

---

### User Story 2 - Invite teammates and join an organization (Priority: P1) (#4)

A Bid Manager or Owner invites a colleague by email with a role. The invitee opens the link, sees which organization
invited them and with which role, and joins — creating an account, signing in with an existing one, or accepting with
the account they are already signed in with. Users who belong to several organizations switch between them.

**Why this priority**: GeM bidding is a team sport (owner + bid manager + analysts). Without invitations the product is
single-player and roles are meaningless.

**Independent Test**: As an Owner, invite `analyst@x.in` as Analyst, copy the link from the dialog, open it in a fresh
browser context, create the account and verify the member appears in Team with role Analyst and the activity log shows
"invited" and "joined the team".

**Acceptance Scenarios**:

1. **Given** an Owner on `/settings/team`, **When** they click "Invite teammate", enter `asha@sharma.in`, choose role "Analyst" and click "Send invitation", **Then** `POST /api/org/invitations` returns **201** `{id,email,role,inviteUrl,expiresAt}` with `expiresAt` = now + 7 days, the dialog switches to "Invitation sent to asha@sharma.in" with a read-only invite link and a "Copy" button (→ "Copied", toast "Invite link copied"), and an email with subject "<Inviter> invited you to <Org> on TenderPilot" is sent (or logged when `RESEND_API_KEY` is absent).
2. **Given** the invite dialog, **When** the email is `asha@` , **Then** the inline error "Enter a valid email address" is shown and no request is sent.
3. **Given** `asha@sharma.in` is already a member, **When** she is invited again, **Then** **409** `conflict` "asha@sharma.in is already a member of this organization" is shown under the email field.
4. **Given** a pending invitation for `asha@sharma.in`, **When** she is invited again (same or different role), **Then** the old invitation is deleted (its link stops working with 404 `invite_invalid`) and a new one is created; the Team page shows exactly one pending row for her.
5. **Given** a Bid Manager (not Owner) opens the invite dialog, **When** they open the Role select, **Then** "Owner" is not offered; a direct API call with `role:"owner"` returns **403** `forbidden` "Only an Owner can invite another Owner".
6. **Given** a pending invitation, **When** a Bid Manager+ clicks "Revoke" on the "Pending invitations" panel, **Then** `DELETE /api/org/invitations/:id` returns `{ok:true}`, toast "Invitation revoked", the row disappears and the link returns 404.
7. **Given** a brand-new invitee opens `/invite/<token>` signed out, **When** they enter name and a password ≥ 8 characters and click "Join team", **Then** `POST /api/auth/accept-invite` returns **200** `Me` with the invited role, a session cookie is set, toast "You’ve joined <Org> as Analyst" appears and they land on `/dashboard`.
8. **Given** an existing TenderPilot user (member of another org) opens the link signed out, **When** they provide their existing password, **Then** they join with the invited role, `orgs` contains both organizations and the active org is the inviting org; a wrong password returns **401** with `details.fields.password = "Incorrect password"`.
9. **Given** a signed-in user opens the link, **When** they click "Accept & join team", **Then** they are joined with their current account and the active org switches to the inviting org; "Not you? Use a different account" signs them out and shows the signed-out form.
10. **Given** an invitation that has expired, been revoked or already accepted, **When** the link is opened or accepted, **Then** **404** `invite_invalid` "This invitation link is invalid, already used or has expired. Ask your admin for a new one." and the page shows an error alert, not a form that can never succeed.
11. **(gap)** **Given** a valid link, **When** `/invite/<token>` loads, **Then** the page first calls `GET /api/auth/invite/:token` and shows "<Inviter> invited you to join **<Org>** as **Analyst**" and "Expires <date>"; when `existingUser` is true and the visitor is signed out, it shows only a password field with the email pre-filled read-only and the button "Sign in & join"; while loading, a skeleton; on 404, an error state with "Ask your admin for a new invitation" and a "Go to sign in" link.
12. **(gap)** **Given** an invitation for `asha@sharma.in` and a visitor signed in as `ravi@sharma.in`, **When** they accept, **Then** the API returns **403** `invite_email_mismatch` "This invitation was sent to asha@sharma.in. Sign out and continue as that account." and no membership is created.
13. **Given** a user who belongs to two organizations, **When** they open the org switcher (top of the sidebar) and choose the other org, **Then** `POST /api/auth/switch-org` returns `Me` for that org, all cached queries are cleared, toast "Switched to <Org>" appears and they are on `/dashboard` showing the new org's data. Switching to an org they are not a member of returns **404**.
14. **Given** a user signs in again later, **When** login succeeds, **Then** the active org is the one used in their most recent session (if still a member), otherwise their oldest membership.
15. **(gap)** **Given** a pending invitation, **When** a Bid Manager+ clicks "Resend", **Then** a fresh link with a new 7-day expiry is created and emailed, toast "Invitation resent to <email>".

---

### User Story 3 - Roles are enforced and organizations are isolated (Priority: P1) (#5)

Every action is allowed or denied on the server according to the role hierarchy Owner > Bid Manager > Analyst > Viewer,
and every row of org data is visible only to members of that org. The UI hides what a role cannot do and explains why
when it is visible but read-only.

**Why this priority**: Constitution IV (NON-NEGOTIABLE in reviews). A single leak of one MSME's turnover, GST or
vault documents to another tenant is a business-ending incident.

**Independent Test**: Create org A (owner + one user of each role) and org B. Run the role matrix against every
mutating endpoint and the cross-org matrix (A's ids requested with B's session) and verify only allowed calls succeed.

**Acceptance Scenarios**:

1. **Given** a Viewer, **When** they call any endpoint that requires Analyst+ (e.g. `POST /api/watchlists`, `POST /api/vault`, `PUT /api/profile`), **Then** **403** `forbidden` "You need to be at least an Analyst to do that".
2. **Given** an Analyst, **When** they call a Bid Manager+ endpoint (`PATCH /api/org`, `POST /api/org/invitations`, `PUT /api/scoring-weights`, `POST /api/ingestion/run`, `POST /api/demo/seed`, overrides), **Then** **403** "You need to be at least a Bid Manager to do that".
3. **Given** a Bid Manager, **When** they call an Owner endpoint (`PATCH /api/org/members/:userId`, `DELETE /api/org/members/:userId`), **Then** **403** "Only an Owner can do that".
4. **Given** an org with exactly one Owner, **When** that Owner is demoted or removed (by themselves or another owner request), **Then** **409** `last_owner` with "An organization needs at least one Owner. Make someone else an Owner first." (demote) or "You cannot remove the last Owner of the organization." (remove).
5. **Given** an Owner on `/settings/team`, **When** they change Asha's role from Analyst to Bid Manager in the row's role select, **Then** `PATCH /api/org/members/:userId` returns the updated member, toast "Asha is now Bid Manager", and Asha's very next request is evaluated with the new role (no re-login needed).
6. **Given** an Owner, **When** they click the trash icon on a member and confirm "Remove member" in the dialog "Remove Asha?", **Then** the membership and all of Asha's API tokens for this org are deleted, toast "Asha was removed", her next request in that org returns 403 `no_organization` (if she has no other org) or falls back to her next org; her past activity stays in the log.
7. **Given** org A and org B, **When** a member of B requests A's members, invitations, activity, tenders analyses, vault documents, workspaces, packets, notifications or API tokens by id, **Then** the response is **404** `not_found` (never 403, never data) and nothing in A is modified.
8. **Given** a Viewer signed in, **When** they browse the app, **Then** the sidebar card shows "View-only access", write actions (Invite teammate, Create watchlist, Upload, Save weights, Sync now, role selects, trash icons) are not rendered, and read-only forms show an explanation, e.g. "Only Bid Managers and Owners can rename the organization."
9. **(gap)** **Given** a user whose role was lowered while their page is open, **When** a mutation returns 403, **Then** a toast shows the server message and the app refetches `/api/auth/me` so the UI immediately hides actions the new role cannot perform.
10. **(gap)** **Given** a non-last Owner or any other member, **When** they choose "Leave organization" in Settings → Team and confirm, **Then** `DELETE /api/org/members/me` removes their own membership and tokens for that org, they are switched to their next org (or signed out to `/login` with "You left <Org>." when none is left); the last Owner gets **409** `last_owner`.
11. **(gap)** **Given** a cookie-authenticated mutating request whose `Origin` header is present and differs from `APP_URL`, **When** it reaches the API, **Then** it is rejected with **403** `bad_origin` before any handler runs (CSRF defence in depth on top of SameSite=Lax).

---

### User Story 4 - Personal account and notification preferences (Priority: P2) (#6)

Each user manages their own name, mobile number and password, and decides — per organization — how TenderPilot alerts
them: in-app, email, WhatsApp, instant or daily digest, and vault expiry reminders.

**Why this priority**: Alerts are the main reason users come back (US1/US3 of spec 001 depend on these preferences),
and WhatsApp is the channel owners actually read. It is P2 because sensible defaults work without any change.

**Independent Test**: As any role, open `/settings/notifications`, switch on WhatsApp with mobile `98220 12345`, choose
Daily, save, reload and verify the values persisted (`GET /api/me/notification-prefs`) and that `me.user.phone` is `+919822012345`.

**Acceptance Scenarios**:

1. **Given** a new member, **When** they open `/settings/notifications`, **Then** defaults are shown: In-app **on**, Email **on** (to their email), WhatsApp **off**, Match alerts **Instant**, Expiry reminders **on**; "Save preferences" is disabled until something changes.
2. **Given** the notifications page, **When** they switch WhatsApp on without a mobile number and click Save, **Then** no request is sent and the field shows "Add a valid 10-digit mobile number to get WhatsApp alerts".
3. **Given** WhatsApp on and mobile `98220 12345`, **When** they save, **Then** `PATCH /api/me` stores `+919822012345`, `PUT /api/me/notification-prefs` stores the prefs, toast "Notification preferences saved"; the hint reads "We’ll message +919822012345".
4. **Given** a user with no phone, **When** a client calls `PUT /api/me/notification-prefs` with `whatsapp:true`, **Then** **400** with `details.fields.whatsapp = "Phone number required"`.
5. **Given** a user in two orgs, **When** they set Daily in org A, **Then** org B's preferences are unchanged (preferences are per org + user).
6. **Given** Settings → Your account, **When** they change the name to "Priya S." and the mobile to `9822012345` and click Save, **Then** **200** `Me`, toast "Profile saved", the avatar initials and user menu update without reload; an invalid mobile `12345` shows "Enter a 10-digit Indian mobile number starting with 6–9"; the Email field is read-only with hint "Contact your org owner to change it."
7. **Given** Daily frequency, **When** new tender matches are found, **Then** in-app notifications appear immediately but email/WhatsApp are held and sent as one digest per org per IST day from 08:00 IST (behaviour owned by `apps/api/src/services/alerts.ts`); with Expiry reminders off, no vault expiry reminders are created for that user.
8. **(gap)** **Given** the notifications page, **When** the user clicks "Send a test alert", **Then** a test in-app notification titled "Test alert from TenderPilot" is created and, for each enabled external channel, a test email/WhatsApp is attempted; the toast lists the outcome per channel ("Email sent", "WhatsApp not configured on this server").

---

### User Story 5 - API tokens for the Chrome extension (Priority: P2) (#7)

A user creates a personal API token, pastes it into the TenderPilot Chrome extension, and can revoke it at any time.
Tokens act as that user in that organization but cannot manage the account.

**Why this priority**: The extension (spec 001 US5 "assist") is unusable without a token. It is P2 because the web app
works without it.

**Independent Test**: Create a token in `/settings/api-tokens`, call `GET /api/workspaces` with
`Authorization: Bearer <token>` (200), call `POST /api/me/api-tokens` with the same bearer (403), revoke it, and call
`GET /api/workspaces` again (401).

**Acceptance Scenarios**:

1. **Given** `/settings/api-tokens` with no tokens, **When** it loads, **Then** the empty state "No tokens yet — Create one to connect the browser extension." is shown together with the 4-step extension setup guide and the "You stay in control" compliance note.
2. **Given** the user clicks "Create token" and keeps the default name "Chrome extension", **When** they click "Create token", **Then** **201** returns `{id,name,createdAt,lastUsedAt:null,token}` where `token` starts with `tp_`; the dialog shows "Copy your new token — This is the only time it’s shown." with a Copy button and "I’ve saved it"; after closing, the list shows "Chrome extension · Created <date> · never used" and the secret is never shown again (list response contains no `token` field).
3. **Given** a valid token, **When** a request is sent with `Authorization: Bearer tp_…`, **Then** it is authenticated as the token's user in the token's org with the user's current role, and `lastUsedAt` is updated at most once per minute.
4. **Given** a token-authenticated request, **When** it calls an account endpoint (`POST /api/me/api-tokens`, `POST /api/me/password`, `POST /api/auth/switch-org`), **Then** **403** "This action requires signing in on the web app".
5. **Given** a listed token, **When** the user clicks "Revoke" and confirms "Revoke token" in "Revoke “Chrome extension”?", **Then** `DELETE /api/me/api-tokens/:id` returns `{ok:true}`, toast "Token revoked", and the token immediately returns **401**.
6. **Given** user A, **When** they try to revoke user B's token id, **Then** **404** "API token not found".
7. **Given** a member is removed from the org, **When** their token is used, **Then** it returns 401 (tokens are deleted on removal).
8. **(gap)** **Given** the create dialog, **When** the user picks an expiry (30 days / 90 days (default) / 1 year / Never), **Then** the token stores `expiresAt`, the list shows "Expires in N days" (amber under 7 days, red "Expired"), and an expired token returns 401.
9. **(gap)** **Given** a token list, **When** it renders, **Then** each row shows the last 4 characters of the token (`tp_…a1B2`) so users can match it to the extension; a user may hold at most 10 active tokens per org (11th → **409** "You already have 10 tokens. Revoke one first.").

---

### User Story 6 - Organization administration: settings, scoring weights, sync health and activity log (Priority: P3) (#8)

Owners and Bid Managers rename the organization, see the plan, tune Go/No-Go scoring weights, check that GeM sync is
healthy (and trigger one), and review an audit trail of who did what.

**Why this priority**: Valuable for trust and support, but defaults work and the core bid flow does not depend on it.

**Independent Test**: As a Bid Manager, rename the org, change the "Turnover" weight from its default, run "Sync now",
then open the activity log and see the three corresponding entries with actor and time.

**Acceptance Scenarios**:

1. **Given** `/settings` with no sub-path, **When** it loads, **Then** it redirects to `/settings/organization`; unknown sub-paths redirect there too and `/settings/tokens` redirects to `/settings/api-tokens`.
2. **Given** a Bid Manager+ on Organization, **When** they change the name to "Sharma Infotech" and click "Save changes", **Then** `PATCH /api/org` returns the org, toast "Organization renamed", the sidebar org switcher shows the new name, and an `org.updated` activity entry with `meta.fields=["name"]` is written. A name shorter than 2 characters shows "Use at least 2 characters". For an Analyst/Viewer the field is disabled and the footer reads "Only Bid Managers and Owners can rename the organization."
3. **Given** the Organization page, **When** it renders, **Then** "Workspace URL" shows the slug read-only, and the Plan panel shows the plan badge ("Free trial", "Starter", "Pro", "Enterprise"), its blurb, "You are signed in as <Role>." and a "Talk to sales" mailto link; Bid Manager+ see a "Demo data" panel with "Load demo data"/"Refresh demo data".
4. **Given** `/settings/scoring`, **When** a Bid Manager+ drags the "Turnover" slider (0–50) and clicks "Save weights", **Then** `PUT /api/scoring-weights` persists the weights, the badge changes to "Custom weights", toast "Scoring weights saved — New analyses use them; re-run an analysis to rescore it."; "Reset to default" restores defaults and saving sends `{}`; when the total weight is 0 the total turns red and Save is disabled. Analysts/Viewers see disabled sliders and "Only Bid Managers and Owners can change scoring weights."
5. **Given** `/settings/sync`, **When** it loads, **Then** three tiles show Sync status ("Healthy" if the last success was < 2 h ago, "Delayed", "Last run failed" or "Not synced yet"), "Open GeM bids" and "Last run"; the runs table lists Started (IST + relative), Status badge, Trigger, Pages, New / updated, Matches and Duration (Duration hidden on phones); data refreshes every 60 s; a failed last run shows "Last error: …". Bid Manager+ see "Sync now" (toast "Sync finished" or the error).
6. **Given** org actions (org created/updated, member invited/joined/role changed/removed/invite revoked, API token created/revoked), **When** they happen, **Then** an `activity_log` row is written with actor, action, entity type/id and meta, and `GET /api/activity?page=&pageSize=&entityType=&entityId=&userId=` returns them newest first with `total` (pageSize max 100, default 25), scoped to the active org.
7. **(gap)** **Given** any member opens `/settings/activity`, **When** it loads, **Then** a table/list shows "<Actor> <verb> <object>" sentences (reusing `features/dashboard/activity.ts`), relative time with IST timestamp tooltip, filters "Member" and "Type" (Team, Organization, Tenders, Vault, Workspaces, API tokens), 25 rows per page with "Previous"/"Next" and "Showing 26–50 of 132"; empty state "No activity yet"; error state with Retry.
8. **(gap)** **Given** a user changes their password, revokes sessions, or leaves the org, **When** it happens, **Then** activity entries `auth.password_changed`, `auth.sessions_revoked`, `member.left` are written (no passwords, tokens or IPs in `meta`).

---

### User Story 7 - App shell, navigation, command palette, theme and design system (Priority: P2) (#9)

Every signed-in page lives in one shell: a collapsible sidebar on desktop, a bottom tab bar and drawer on phones, a top
bar with search (⌘K), notifications bell, theme toggle and account menu. Users can navigate entirely by keyboard and
choose light, dark or system theme. All pages are built from one design system.

**Why this priority**: Constitution V — the product is sold on its experience; every other story renders inside this
shell. P2 because it is already built and mainly needs verification and a few gaps closed.

**Independent Test**: On desktop and phone, sign in, navigate to every main page via sidebar/tab bar, open the
palette with Ctrl+K and "G then V", switch to dark theme, reload, and run axe on the shell with zero serious violations.

**Acceptance Scenarios**:

1. **Given** desktop (≥ 768 px), **When** the shell renders, **Then** the sidebar (248 px) shows the logo, org switcher ("<Org> · <plan> plan · <Role>"), a "Search… Ctrl K" button, main nav (Dashboard, Tenders, Watchlists, Pipeline, Document vault), an "Organization" group (Company profile, Notifications, Settings) and the "Co-pilot mode" card; the active item has a highlighted background and a left indicator bar.
2. **Given** desktop, **When** the user clicks "Collapse sidebar", **Then** the sidebar becomes 64 px icons-only with tooltips, the content shifts left, and the choice persists across reloads (`localStorage` key `tp-sidebar-collapsed`).
3. **Given** a phone (375 px), **When** the shell renders, **Then** there is no horizontal scroll, the top bar shows a menu button, the logo, search, bell and avatar, and a bottom tab bar shows Home, Tenders, Pipeline, Vault and More; "More" and the menu button open the full navigation drawer, which closes on navigation.
4. **Given** any app page, **When** the user presses Ctrl/⌘+K or "/", **Then** the command palette opens with groups "Go to", "Quick actions" (role-filtered: Analyst+ "Create a watchlist", "Upload to document vault"; Bid Manager+ "Invite a teammate"), "Preferences" (Light/Dark/System theme, Sign out); typing ≥ 2 characters adds "Search tenders for “<q>”" which opens `/tenders?q=<q>`; Esc closes it.
5. **Given** focus is not in a text field, **When** the user types "G" then within 1.2 s "D/T/W/P/V/C/S/N", **Then** the app navigates to Dashboard/Tenders/Watchlists/Pipeline/Vault/Company profile/Settings/Notifications.
6. **Given** the theme is "System" and the OS is dark, **When** the page loads, **Then** it renders dark with no light flash (inline script in `index.html` applies the class before paint); choosing Light/Dark in the account menu or palette persists in `localStorage` key `tp-theme`.
7. **Given** keyboard-only use, **When** the user presses Tab on any app page, **Then** the first stop is "Skip to content", focus rings are visible on every interactive element, and after each route change focus moves to `<main id="main">`.
8. **Given** a lazy route chunk fails to load after a deploy, **When** the user navigates, **Then** the error boundary shows "A new version of TenderPilot is available — Reload to get the latest version."; other render errors show "This page hit a snag"; unknown URLs show "This page went off the map" with "Open dashboard".
9. **Given** `prefers-reduced-motion: reduce`, **When** routes change, **Then** page transitions are not animated.
10. **(gap)** **Given** the command palette, **When** the user types "team", "api token", "activity" or "notification settings", **Then** the matching Settings sub-pages (Team & roles, API tokens & extension, Activity log, Notifications) appear under "Settings" and open the right sub-route.
11. **(gap)** **Given** any app page, **When** the user presses "?", **Then** a "Keyboard shortcuts" dialog lists ⌘K, /, G+letter shortcuts and Esc.
12. **(gap)** **Given** every shell and settings screen in light and dark at 375 and 1440 px, **When** axe-core runs, **Then** there are 0 serious/critical violations and text contrast meets WCAG 2.1 AA.

---

### Edge Cases

- **Email case & whitespace**: `emailSchema` trims and lowercases; `Priya@Sharma.IN ` and `priya@sharma.in` are the same account (signup 409, login works, invites match).
- **Signup race**: two concurrent signups with the same email → one 201, one 409 (unique index `users_email_uq` + `23505` mapping).
- **Slug collision**: two orgs named "Sharma Infotech" → second gets `sharma-infotech-xxxx` (random suffix, up to 6 tries, then UUID fragment).
- **User with zero memberships** (last org removed them): login → **403** `no_organization` "You are not a member of any organization. Ask an owner to invite you."; existing session → same 403 on authenticated routes.
- **Active org removed** while signed in: the next request falls back to the oldest remaining membership and updates `sessions.active_org_id`.
- **Invite to an email that already has a pending invite**: replaced (one valid link at a time).
- **Invite accepted twice** (double click): second call → 404 `invite_invalid`; membership insert is `ON CONFLICT DO NOTHING`.
- **Invitee is already a member** via a different invite: membership unchanged (role is NOT changed by accepting).
- **Owner demotes themselves** while another Owner exists: allowed (UI hides own role select; API permits).
- **Token used after its user's role changes**: the token picks up the new role on the next request.
- **Malformed ids** (`/api/org/members/abc`, `/api/me/api-tokens/abc`): 404, never 500.
- **Bearer header with a non-`tp_` token**: ignored (falls through to cookie auth).
- **Cookies over HTTP vs HTTPS**: `Secure` flag set only when the request (or `x-forwarded-proto`) is https.
- **WhatsApp on, then phone removed** in Account: prefs keep `whatsapp=true` but delivery is skipped by alerts (no phone) — (gap) the Account form should warn "WhatsApp alerts will stop until you add a mobile number."
- **Email provider down** during invite: the invitation is still created and the link is shown; failure is logged (`invitation email failed`).
- **Local storage blocked** (private mode): theme and sidebar fall back to defaults without crashing.
- **Very long names** (120-char user name, 160-char org name): truncated with ellipsis in sidebar, menus and tables; full value in `title`/tooltip.
- **Clock skew/IST**: all dates render in IST (`formatDateIST`); invitation expiry compares server time.

## Requirements *(mandatory)*

### Functional Requirements

**Accounts & sessions**

- **FR-001**: System MUST let a visitor sign up with name (1–120 chars), email (valid, ≤ 254, normalised to lowercase), password (8–200 chars) and company name (2–160 chars), atomically creating the user, an organization (plan `trial`, unique slug), an Owner membership and default notification preferences, and signing them in (201).
- **FR-002**: System MUST reject a duplicate email on signup with 409 `conflict` and `details.fields.email`.
- **FR-003**: System MUST hash passwords with PBKDF2-SHA256 (100,000 iterations, 16-byte salt, format `pbkdf2_sha256$iter$salt$hash`), NFKC-normalise before hashing, compare in constant time, and verify against a dummy hash for unknown emails so login timing does not reveal account existence.
- **FR-004**: System MUST authenticate browsers with an opaque 256-bit session token in cookie `tp_session` (HttpOnly, SameSite=Lax, Path=/, Secure on https), storing only its SHA-256 hash; sessions expire 30 days after last refresh and slide when less than 15 days remain.
- **FR-005**: Login MUST return 401 `invalid_credentials` for wrong email or password, 403 `no_organization` for users with no memberships, and otherwise restore the most recently used org the user is still a member of (else the oldest membership).
- **FR-006**: Logout MUST delete the session row and clear the cookie, and MUST succeed (200) even when already signed out.
- **FR-007**: `GET /api/auth/me` MUST return `{user{id,name,email,phone}, org{id,name,slug,plan,onboardingState,scoringWeights}, role, orgs[{id,name,slug,role}] (sorted by name)}`; 401 when signed out.
- **FR-008**: Changing a password MUST require the current password (400 with `fields.currentPassword` when wrong), enforce the 8-character minimum, and delete all of the user's other sessions.
- **FR-009**: The web app MUST guard protected routes (redirect to `/login?next=<path+query>`), redirect signed-in users away from `/`, `/login`, `/signup`, and only honour `next` values that start with a single `/`.
- **FR-010** (gap): System MUST rate-limit failed authentication attempts: max 10 attempts per normalised email and max 30 per client IP within a fixed 15-minute window across login, accept-invite (existing-user path) and change-password (attempts are counted before the password is checked; a success clears the email counter and does not consume the IP budget); exceeding returns 429 `rate_limited` with `Retry-After` seconds. The client IP is read only from a trusted proxy header (`cf-connecting-ip` on Workers, `x-forwarded-for` behind a proxy when `TRUST_PROXY` is set); when unknown, only the per-email limit applies. Works on Workers (state in Postgres, not memory).
- **FR-011** (gap): System MUST support self-service password reset: `POST /api/auth/forgot-password {email}` always returns 200 `{ok:true}`; for existing users it emails a single-use link valid 60 minutes (only the token hash stored); `POST /api/auth/reset-password {token,newPassword}` sets the password, invalidates all sessions and the token, starts a new session; invalid/expired token → 400 `reset_invalid`. Requests are rate-limited (3 per email and 20 per client IP per fixed one-hour window); the account lookup, token write and email run after the response so timing does not reveal whether the account exists.
- **FR-012** (gap): Users MUST be able to list their active sessions (`GET /api/me/sessions`: id, current flag, user-agent summary, created, last seen) and revoke one (`DELETE /api/me/sessions/:id`) or all others (`POST /api/me/sessions/revoke-others`); session-only (not API tokens).
- **FR-013** (gap): The web app MUST treat any 401 from an authenticated query/mutation (other than the initial `/auth/me` probe and auth forms) as session end: clear the query cache, toast "Your session ended. Please sign in again.", redirect to `/login?next=<current>`.

**Invitations & multi-org**

- **FR-014**: Bid Managers and Owners MUST be able to invite by email with a role; only Owners may invite Owners (403 otherwise); inviting an existing member returns 409; re-inviting replaces any pending invitation for that email in that org.
- **FR-015**: Invitations MUST use a 256-bit random token (only its SHA-256 hash stored), expire after 7 days, be single-use, and be emailed with the org name, inviter name, role and link `<APP_URL>/invite/<token>`; email failure MUST NOT fail the request.
- **FR-016**: `GET /api/auth/invite/:token` (public) MUST return `{orgName,email,role,invitedBy,expiresAt,existingUser}` for a valid invitation and 404 `invite_invalid` otherwise.
- **FR-017**: `POST /api/auth/accept-invite` MUST: (a) for a signed-in session, add that user; (b) signed-out with an existing account for the invited email, require that account's password; (c) signed-out new email, require name + valid password and create the account. It MUST create the membership with the invited role and default prefs, mark the invitation accepted, log `member.joined`, and make the inviting org active.
- **FR-018** (gap): When a signed-in user's email differs from the invitation email, accept MUST fail with 403 `invite_email_mismatch` and the invited email in the message.
- **FR-019** (gap): The accept-invite page MUST load the invitation preview before rendering a form and adapt to `existingUser` and sign-in state as described in US2 scenario 11.
- **FR-020**: Bid Managers+ MUST be able to list pending (unexpired, unaccepted) invitations with inviter and expiry, and revoke them (404 for other orgs' or accepted invitations); (gap) and resend them (new token, new 7-day expiry).
- **FR-021**: Users with several memberships MUST be able to switch the active org (session-only); switching to a non-member org returns 404; the client MUST clear all cached queries on switch, login, signup, accept and logout.

**Roles & tenancy**

- **FR-022**: System MUST enforce roles server-side with the hierarchy owner(40) > bid_manager(30) > analyst(20) > viewer(10) via `requireAuth`, `requireRole(min)` and `requireSession`, using the minimums in `contracts/api.md` (viewer: reads; analyst: create/edit tender work, vault, profile, watchlists; bid_manager: org settings, invites, scoring weights, ingestion run, demo seed, overrides, annexure templates; owner: change roles, remove members). Error messages: "You need to be at least an Analyst/a Bid Manager to do that", "Only an Owner can do that".
- **FR-023**: Every org-scoped query MUST filter by the active org id (`orgId(c)`); requests for another org's resources MUST return 404.
- **FR-024**: An organization MUST always have at least one Owner: demoting or removing the last Owner returns 409 `last_owner`.
- **FR-025**: Removing a member MUST delete their membership and their API tokens for that org in one transaction and log `member.removed`; role changes take effect on the member's next request and log `member.role_changed` with `{from,to}`.
- **FR-026**: The web app MUST hide actions the role cannot perform (`can()`, `<RoleGate>`, nav `min`) and show a one-line explanation where a read-only form is visible.
- **FR-027** (gap): Members MUST be able to leave an organization (`DELETE /api/org/members/me`), subject to FR-024, with the client switching to another org or signing out.
- **FR-028** (gap): Cookie-authenticated non-GET/HEAD requests with an `Origin` header not equal to the `APP_URL` origin MUST be rejected with 403 `bad_origin`; bearer-token requests are exempt.
- **FR-029** (gap): The client MUST refetch `/auth/me` after any 403 `forbidden` from a mutation so role-gated UI reflects the current role.

**Account & notification preferences**

- **FR-030**: Users MUST be able to update their name and mobile (E.164 `+[1-9]\d{7,14}`; the UI accepts Indian 10-digit mobiles starting 6–9 and converts to `+91…`, and `null` clears it); email is read-only.
- **FR-031**: Notification preferences MUST be stored per (org, user) with fields `inApp`, `email`, `whatsapp`, `frequency` (`instant`|`daily`) and `expiryReminders`, defaulting to `true,true,false,instant,true`; `GET` returns defaults when no row exists; `PUT` upserts the full object.
- **FR-032**: Enabling WhatsApp MUST require a phone on the user (400 `fields.whatsapp`), and the UI MUST let the user enter the number on the same screen.
- **FR-033**: Alert and reminder services MUST honour the preferences: no in-app row when `inApp=false`, email/WhatsApp only when enabled and configured, daily digest for `tender_match` when `frequency=daily`, no expiry reminders when `expiryReminders=false`.
- **FR-034** (gap): Users MUST be able to send themselves a test alert across their enabled channels with a per-channel result.

**API tokens**

- **FR-035**: Users MUST be able to create named (1–80 chars) personal tokens with prefix `tp_` and 256-bit entropy, shown exactly once; only the SHA-256 hash is stored; list returns `{id,name,createdAt,lastUsedAt}` for the current user in the current org only.
- **FR-036**: Bearer tokens MUST authenticate as the owning user in the token's org with the user's current role, update `lastUsedAt` at most once per 60 s, stop working when revoked or when the membership is removed, and be refused (403) on session-only endpoints (create token, change password, switch org, session management).
- **FR-037** (gap): Tokens MUST support an optional expiry (30, 90 (default), 365 days or never), store and display a 4-character hint, and be limited to 10 active tokens per user per org.

**Organization administration & activity**

- **FR-038**: Bid Managers+ MUST be able to rename the organization (2–160 chars) and merge `onboardingState` flags; `GET /api/org` returns the active org to any member.
- **FR-039**: The Settings area MUST host sub-pages Organization, Your account, Team & roles, Notifications, Scoring weights, API tokens & extension, Sync health — and (gap) Activity log — under `/settings/<section>` with a vertical nav on ≥ 1024 px and a horizontally scrollable tab strip below that.
- **FR-040**: Scoring-weights UI MUST read `GET /api/scoring-weights` (`{weights,defaults,custom}`), allow Bid Managers+ to edit weights 0–50 per factor, show each factor's share of the total, reset to defaults (saves `{}`), and block saving when the total is 0.
- **FR-041**: Sync-health UI MUST show status (healthy < 2 h since last success), open/total tenders, last run, a runs table and the last error, auto-refresh every 60 s, and let Bid Managers+ trigger a sync.
- **FR-042**: System MUST write an activity entry for: `org.created`, `org.updated` (name/scoring changes only, not onboarding ticks), `member.invited`, `member.invite_revoked`, `member.joined`, `member.role_changed`, `member.removed`, `api_token.created`, `api_token.revoked`; (gap) `member.left`, `auth.password_changed`, `auth.sessions_revoked`. `meta` MUST NOT contain secrets, password hashes, tokens or IP addresses.
- **FR-042 decided gaps**: (1) Password *reset* (`/api/auth/reset-password`) logs nothing: the request is unauthenticated and has no active org; follow-up `auth.password_reset` / a per-user security log. (2) `auth.*` events are written to the user's *active org* only, so they appear in that org's team feed (dashboard and Activity log) and not in their other orgs.
- **FR-043**: `GET /api/activity` MUST return org-scoped entries newest first with filters `entityType`, `entityId`, `userId`, pagination `page` (≥ 1) and `pageSize` (1–100, default 25) and `total`.
- **FR-044** (gap): The web app MUST provide an Activity log page at `/settings/activity` as described in US6 scenario 7. Decided deviations: (a) `GET /api/activity` also returns a server-resolved `target` per item (same enrichment as the dashboard) so every sentence has an object, and `entityType` accepts a comma-separated list; (b) the Type filter groups differ from the six in scenario 7 so every entity type the API writes is reachable: All activity, Tenders & bids (`tender,workspace` — `workspace.created` is logged against the tender), Vault documents, Watchlists, Company profile (`profile,past_contract,annexure_template`), Team (`user,invitation`), API tokens, Organization & sync (`organization,ingestion_run`); (c) the Member filter lists current members only — actors who have since left or been removed cannot be selected (their entries still show under "Everyone"); follow-up: an actors endpoint.

**Shell, navigation, theme & design system**

- **FR-045**: Every authenticated page MUST render inside `AppShell` with sidebar (collapsible, persisted), phone bottom tab bar + drawer, top bar (search, bell, theme toggle ≥ 640 px, account menu), skip link, route-level error boundary and a skeleton while a lazy page loads.
- **FR-046**: The command palette MUST open with Ctrl/⌘+K, "/" or the search buttons; list role-filtered navigation, quick actions and preferences; offer tender search for queries ≥ 2 chars; and support "G then key" navigation outside text fields. (gap) It MUST also list Settings sub-pages and offer a "?" shortcuts dialog.
- **FR-047**: Theme MUST support Light, Dark and System, persisted in `localStorage` (`tp-theme`), applied before first paint, and follow OS changes in System mode.
- **FR-048**: All UI MUST be built from `apps/web/src/components/ui` (documented in its `README.md`): HSL design tokens (no raw hex in features), 8 px spacing grid, `PageHeader` first, `SkeletonList/SkeletonPage` while loading, `ErrorState` with Retry on error, `EmptyState` with a next action when empty, `ResponsiveTable` for lists (stacked cards < 768 px), `toast` for outcomes, `Field` for labelled inputs with errors wired via `aria-describedby`.
- **FR-049**: The API MUST return all errors as `{error:{code,message,details?}}`, attach an `x-request-id` to every response (honouring a safe incoming one), never cache API responses (`cache-control: no-store`), and map unexpected errors to 500 `internal_error` with `details.requestId`.
- **FR-050** (gap): The API MUST send security headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (stricter than the first draft's `strict-origin-when-cross-origin`: invite and reset links carry secrets in the URL path and the app needs no referrer, so none is sent), `Strict-Transport-Security` on https, and a Content-Security-Policy for the SPA (`default-src 'self'`; scripts self + the inline theme script hash; images self data: blob:). Implemented exceptions: `X-Frame-Options` is `SAMEORIGIN` (not `DENY`) on `content-disposition: inline` file responses so the SPA can preview them in an `<iframe>`; the CSP allows `style-src 'unsafe-inline'` (Radix UI and sonner inject inline styles) and `frame-src`/`object-src`/`worker-src 'self' blob:` for PDF previews.

### Non-Functional Requirements

- **NFR-001**: Auth endpoints (`/auth/login`, `/auth/signup`, `/auth/me`) respond in < 300 ms p95 excluding PBKDF2 time on Node and < 600 ms p95 including it on Workers; `/auth/me` makes ≤ 4 DB queries.
- **NFR-002**: All auth logic MUST run unchanged on Cloudflare Workers and Node (WebCrypto only, no Node-only crypto, no in-memory shared state).
- **NFR-003**: No secret (password, session token, API token, invite/reset token) is ever stored in plain text, logged, or returned after creation; logs carry request ids instead.
- **NFR-004**: Every settings and auth screen meets WCAG 2.1 AA (contrast, labels, focus order, `aria-*` on toggles and dialogs) in light and dark themes; axe-core: 0 serious/critical violations.
- **NFR-005**: Every screen works at 375 px without horizontal scrolling and at 1440 px without stretched line lengths (content max width 1400 px); touch targets ≥ 40 px on phones.
- **NFR-006**: Initial JS for signed-out routes (landing/login/signup) ≤ 250 KB gzip; each settings section is a separate lazy chunk.
- **NFR-007**: Missing optional integrations (Resend, WhatsApp) MUST degrade to logged no-ops; invitation and reset flows still show the link/outcome.
- **NFR-008**: Tenant isolation and role matrices are covered by automated API tests that fail the build on any regression.

### UX Specification

**Screens and routes**

| Route | Screen | Who | Key states |
|---|---|---|---|
| `/login` | Split-screen auth layout: form left, dark product preview right (hidden < 1024 px). Title "Welcome back". | Signed out | Inline field errors; error alert above form; button spinner "Sign in"; (gap) 429 message; (gap) "Forgot password?" link replacing "Forgot? Ask your org owner". |
| `/signup` | "Start winning more GeM bids" / "Free 14-day trial. No card needed." Name + Company side by side ≥ 640 px, stacked on phone. | Signed out | Strength meter; 409 under email; legal note. |
| `/invite/:token` | "You’re invited". | Anyone | (gap) skeleton while preview loads; org/role/inviter card; signed-in card with avatar + "Accept & join team" + "Not you?"; signed-out new user form; (gap) existing-user password form; invalid-link error state. |
| `/forgot-password`, `/reset-password/:token` (gap) | Same auth layout. | Signed out | Neutral confirmation; expired-link state with "Request a new link". |
| `/settings/organization` | Organization panel, Plan panel, Demo data panel (BM+). | All | Disabled field + explanation for < BM. |
| `/settings/account` | Your account panel (name, read-only email, mobile), Password panel, (gap) "Where you’re signed in" panel. | All | Save button loading; field errors from `details.fields`. |
| `/settings/team` | Team & roles table (avatar, name, "(you)", email, role select/badge, joined, remove), Pending invitations, "What each role can do" cards; Invite dialog (form → success with copy link); Remove confirm dialog. | All (actions by role) | Skeleton rows; ErrorState compact with Retry; EmptyState "Just you so far". On phones the table becomes stacked cards (Joined hidden). |
| `/settings/notifications` | Rows: In-app, Email, WhatsApp (+ number field), Match alerts (Instant/Daily segmented), Expiry reminders; "Save preferences" disabled until dirty. | All | SkeletonList while loading; ErrorState. |
| `/settings/scoring` | Total weight bar; 10 factor sliders with help text, share %, "Default N." hint; Custom/Default badge. | All (edit BM+) | Skeleton; ErrorState; red total at 0. |
| `/settings/api-tokens` | Token list, Create dialog (name → one-time secret with Copy), Revoke confirm, extension setup guide and compliance note. | All | EmptyState "No tokens yet". |
| `/settings/sync` | 3 stat tiles + runs table. | All (Sync now BM+) | EmptyState "No sync runs yet"; error banner for last failure. |
| `/settings/activity` (gap) | Filter bar + activity list + pagination. | All | Skeleton; EmptyState "No activity yet"; ErrorState. |

**Responsive behaviour**: Settings nav is a sticky vertical list (220 px column) at ≥ 1024 px and a horizontally
scrollable pill strip with edge-to-edge scroll below; panels stack; dialog footers stack buttons full-width on phones;
the shell bottom tab bar adds safe-area padding (`safe-bottom`) and page content gets 7 rem bottom padding so nothing
hides under it.

**Accessibility**: one `<h1>` per page from `PageHeader` (also sets `document.title` "<Page> · TenderPilot");
settings panels use `<h2>`; nav landmarks "Sidebar", "Main", "Primary", "Settings sections"; switches are labelled via
`<label htmlFor>`; sliders are `<input type=range>` with `aria-describedby` help; dialogs trap focus and return it;
toasts are announced politely; icons are `aria-hidden`; colour is never the only signal (badges carry text).

**Copy rules**: plain English, sentence case, Indian terms explained inline; error messages say what to do next.

### Key Entities *(include if feature involves data)*

- **User** (`users`): id, email (unique, lowercase), name, password hash, phone (E.164, optional), created at. Belongs to many organizations via memberships.
- **Organization** (`organizations`): id, name, slug (unique), plan (`trial|starter|pro|enterprise`), onboarding state (flag map), scoring weights (factor → 0–100, null = defaults), created at. Tenant boundary for all business data.
- **Membership** (`memberships`): (org, user) primary key, role (`owner|bid_manager|analyst|viewer`), created at (= joined at).
- **Invitation** (`invitations`): id, org, email, role, token hash, invited by, accepted at, expires at, created at.
- **Session** (`sessions`): id, user, token hash (unique), active org, expires at, created at; (gap) user agent, last seen at.
- **API token** (`api_tokens`): id, org, user, name, token hash (unique), last used at, created at; (gap) expires at, hint.
- **Notification preferences** (`notification_prefs`): (org, user) primary key, in-app, email, WhatsApp, frequency, expiry reminders.
- **Activity entry** (`activity_log`): id, org, actor (nullable, set null on user delete), action (dotted), entity type, entity id, meta (JSON), created at.
- **Auth attempt** (gap, `auth_attempts`): key (email or IP), kind, window start, count — for FR-010.
- **Password reset** (gap, `password_resets`): id, user, token hash, expires at, used at, created at — for FR-011.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new visitor completes signup and reaches `/onboarding` in under 60 seconds (median, E2E-timed) on a 375 px phone.
- **SC-002**: An invitee goes from opening the invite link to seeing the inviting org's dashboard in under 45 seconds, in 100% of E2E runs for new, existing and signed-in users.
- **SC-003**: The role matrix test covers 100% of mutating API routes × 4 roles and the isolation test covers every org-scoped resource type; both pass in CI with 0 leaks.
- **SC-004**: 0 secrets (passwords, tokens) appear in logs, API list responses or activity `meta` across the full API test suite (asserted by a log/response scanner test).
- **SC-005**: axe-core reports 0 serious/critical violations on all 7 (8 with Activity) settings screens, the auth screens and the shell, at 375 and 1440 px, light and dark.
- **SC-006**: All 7 user stories have a passing Playwright E2E with screenshots, video and trace stored in `qa/evidence/002/US<n>/` and a QA verdict of `qa:approved`.
- **SC-007**: After 10 failed logins, 100% of further attempts within 15 minutes are rejected with 429 (once FR-010 ships).
- **SC-008**: Support can resolve "who changed this?" questions for org/team/token changes from the activity log alone (every FR-042 action is logged — asserted by API tests).

## Assumptions

- Email + password is the only sign-in method for v1; Google/Microsoft SSO and SAML are out of scope (Enterprise plan later).
- Email address changes are out of scope; users ask support. Account deletion and organization deletion are out of scope for this spec (handled manually by support under DPDP requests).
- Billing/plan changes are manual ("Talk to sales"); `plan` is set by ops. Plan limits (users, watchlists) are not enforced in this spec.
- Two-factor authentication is out of scope for v1; rate limiting (FR-010) and session management (FR-012) are the compensating controls.
- The SPA and API are served from the same origin (Node server or Worker static assets), so no CORS configuration is needed; the extension uses bearer tokens.
- Notification delivery mechanics (digest timing, WhatsApp templates, email rendering) are owned by spec 001 US1/US3; this spec owns the preferences and their enforcement contract only.
- Reference repositories under `/home/user/refs` contain no authentication, tenancy or settings code; nothing is ported for this area (see plan.md).
