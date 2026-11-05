# Implementation Plan: Platform — Accounts, Organizations, Roles, Settings & Notification Preferences

**Branch**: `002-platform-tenancy` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-platform-tenancy/spec.md`

**Note**: This template is filled in by the `/cairn-plan` command; its definition describes the execution workflow.

## Summary

The platform layer of TenderPilot (accounts, sessions, organizations, roles, invitations, API tokens, notification
preferences, activity log, settings UI and the app shell) is **already built** as part of spec 001 (tasks T010–T025,
T073) and covered by `apps/api/test/auth.test.ts` (27 tests). This plan documents the as-built design precisely, then
closes the gaps that matter for a multi-tenant SaaS handling MSME financial and identity documents:

1. **Security hardening** — auth rate limiting (FR-010), invite email binding (FR-018), Origin check (FR-028), security headers (FR-050).
2. **Account self-service** — password reset (FR-011), session list/revoke (FR-012), session-ended handling (FR-013), leave org (FR-027).
3. **UX completeness** — invite preview page (FR-019), resend invite (FR-020), token expiry/hint/limit (FR-037), activity log page (FR-044), palette settings entries + shortcuts dialog (FR-046), test alert (FR-034), 403 → refetch me (FR-029).
4. **Verification** — role matrix + isolation sweeps (NFR-008), secret-leak scanner (SC-004), axe pass (NFR-004), and one Playwright E2E per story with evidence in `qa/evidence/002/US<n>/` (SC-006).

## Technical Context

**Language/Version**: TypeScript 5.x end to end (ES2022 target), Node 20+ for local/CI, Cloudflare Workers runtime in production.

**Primary Dependencies**: API — Hono 4 (`hono/cookie`, `hono/factory`), Drizzle ORM, zod; Web — React 18, React Router 6 (data router), TanStack Query 5, Tailwind CSS + Radix primitives, cmdk, sonner, framer-motion, lucide-react.

**Storage**: Postgres (Neon in production, local `scripts/local-pg.sh` for dev/test/E2E). Schema source of truth: `packages/db/src/schema.ts`.

**Testing**: Vitest (core unit, API integration against real Postgres `tenderpilot_test` via `apps/api/test/helpers.ts`), Playwright (`playwright.config.ts`, projects `desktop` 1440×900 and `mobile` Pixel 7 tagged `@mobile`, video/trace/screenshots always on), axe-core via `@axe-core/playwright` (to add).

**Target Platform**: Cloudflare Worker (`apps/api/src/worker.ts`) + static assets; Node server (`apps/api/src/node.ts`) serving the built SPA for local and E2E.

**Project Type**: Web service + SPA in a pnpm monorepo.

**Performance Goals**: NFR-001 (auth < 300 ms p95 excl. PBKDF2 on Node; `/auth/me` ≤ 4 queries).

**Constraints**: WebCrypto only (PBKDF2 capped at 100k iterations on Workers); no in-memory shared state (rate limiting must be in Postgres); same-origin SPA + API; no secrets in logs.

**Scale/Scope**: ≤ 5,000 orgs, ≤ 50 members per org, ≤ 10 tokens per user per org, activity log ≤ 1M rows (indexed by `(org_id, created_at)`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Human-in-the-loop submission | PASS | Platform never stores GeM credentials; API tokens are TenderPilot-only and the token page restates the extension's limits. |
| II. Polite, public-only ingestion | PASS (n/a) | Sync health only displays runs; "Sync now" is Bid Manager+ and uses the same rate-limited ingestion. |
| III. Deterministic first | PASS (n/a) | No LLM use in this area. |
| IV. Tenant isolation & data protection | PASS with gaps | `orgId(c)` scoping + `requireRole` everywhere; gaps FR-018 (invite email binding), FR-028 (Origin check), FR-010 (rate limiting), isolation sweep test (T052). These are P1 tasks. |
| V. Delightful, accessible UX | PASS with gaps | Loading/empty/error states present on every settings section; gaps: invite preview states, activity page, axe evidence. |
| VI. Test-first, E2E verified | GAP | API tests exist; Playwright E2E for 002 stories not yet written (T-QA tasks). |
| VII. Edge-native | PASS | WebCrypto, Postgres-backed state, adapters degrade to log no-ops. |
| VIII. Simplicity & traceability | PASS | Contracts in `packages/core/src/contracts/auth.ts` shared by API and web; every task references FR ids. |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-platform-tenancy/
├── spec.md              # Feature spec (this feature)
├── plan.md              # This file
└── tasks.md             # /cairn-tasks output
```

API contracts for this area live in `specs/001-gem-tender-copilot/contracts/api.md § Platform` and are restated (with
gaps) in the endpoint table below; data model touch-points are listed below rather than in a separate data-model.md.

### Source Code (repository root)

```text
packages/
├── core/src/contracts/
│   ├── auth.ts          # zod inputs + DTOs: signup/login/invite/me/prefs/tokens/members/activity
│   └── common.ts        # ROLES, ROLE_RANK, ROLE_LABELS, roleAtLeast, emailSchema, phoneE164Schema, pagination
└── db/src/
    ├── schema.ts        # users, organizations, memberships, invitations, sessions, api_tokens,
    │                    # notification_prefs, activity_log (+ gap: auth_attempts, password_resets, columns)
    └── migrations/      # drizzle-kit output

apps/api/src/
├── app.ts               # createApp: /api router, health, error handler, request id, no-store
├── middleware/
│   ├── auth.ts          # requireAuth, requireRole(min), requireSession, orgId(c), userId(c)
│   ├── request.ts       # injectDeps (x-request-id, request log), noStore
│   ├── error.ts         # errorHandler, notFoundHandler
│   └── security.ts      # (gap) security headers + Origin check
├── lib/
│   ├── session.ts       # cookie, startSession, resolveAuth (cookie | Bearer tp_), sliding expiry
│   ├── crypto.ts        # PBKDF2, randomToken, sha256Hex, timingSafeEqual, dummy hash
│   ├── activity.ts      # logActivity
│   ├── me.ts            # buildMe
│   ├── errors.ts        # HttpError + helpers
│   ├── validate.ts      # parseJson/parseQuery → validation_error with details.fields
│   └── rate-limit.ts    # (gap) Postgres-backed attempt counter
├── adapters/mailer.ts   # Resend | log mailer (invites, resets)
└── routes/
    ├── auth.ts          # /auth/*, /me, /me/password, /me/notification-prefs, /me/api-tokens (+ gap /me/sessions, reset)
    └── org.ts           # /org, /org/members, /org/invitations, /activity (+ gap leave, resend)

apps/api/test/
├── auth.test.ts         # existing 27 tests
├── roles-matrix.test.ts # (gap)
├── isolation.test.ts    # (gap)
└── secrets-leak.test.ts # (gap)

apps/web/src/
├── app/                 # App.tsx (providers), router.tsx (PublicOnly, Protected, AppShell), NotFoundPage, UiGallery (/dev/ui)
├── lib/                 # api.ts (ApiError, queryClient), auth.tsx (AuthProvider, can, RoleGate, safeNext), theme.tsx, hooks.ts, format.ts, types.ts
├── components/
│   ├── ui/              # design system (README.md documents tokens and components)
│   └── layout/          # AppShell, nav.ts, CommandPalette, OrgSwitcher, UserMenu, ThemeToggle, RouteErrorBoundary, Logo
└── features/
    ├── auth/            # AuthLayout, LoginPage, SignupPage, AcceptInvitePage, PasswordInput(+StrengthMeter), FormAlert
    │                    # (gap) ForgotPasswordPage, ResetPasswordPage
    └── settings/        # SettingsPage, api.ts, sections/{Organization,Account,Team,Notifications,Scoring,Tokens,Sync}Section, Panel
                         # (gap) sections/ActivitySection, sections/SessionsPanel

e2e/002-platform/        # (gap) US1..US7 Playwright specs
qa/evidence/002/US<n>/   # QA evidence (screenshots, video, trace, VERDICT.md)
```

**Structure Decision**: Keep the existing monorepo layout. Platform API code stays in `routes/auth.ts` + `routes/org.ts`
(split a new `routes/sessions.ts` only if `auth.ts` exceeds ~400 lines). Web settings sections remain one lazy chunk
each under `features/settings/sections/`.

## API endpoints (as built + gaps)

Auth column: `—` public, `S` session cookie only, `A` any member (cookie or bearer), `M` bid_manager+, `O` owner.

| Method & path | Auth | Body / query | 2xx response | Errors |
|---|---|---|---|---|
| POST `/api/auth/signup` | — | `{name,email,password,orgName}` | 201 `Me` + cookie | 400 validation_error; 409 conflict (`fields.email`); (gap) 429 |
| POST `/api/auth/login` | — | `{email,password}` | 200 `Me` + cookie | 400; 401 invalid_credentials; 403 no_organization; (gap) 429 rate_limited |
| POST `/api/auth/logout` | — | – | 200 `{ok:true}`, cookie cleared | – |
| GET `/api/auth/me` | A | – | 200 `Me` | 401; 403 no_organization |
| POST `/api/auth/switch-org` | S | `{orgId}` | 200 `Me` | 403 (token); 404 not_found |
| GET `/api/auth/invite/:token` | — | – | 200 `InvitePreview` | 404 invite_invalid |
| POST `/api/auth/accept-invite` | — / S | `{token,name?,password?}` | 200 `Me` (+cookie when signed out) | 400 (name/password); 401 invalid_credentials; 404 invite_invalid; (gap) 403 invite_email_mismatch; (gap) 429 |
| PATCH `/api/me` | A | `{name?,phone?:string|null}` | 200 `Me` | 400 |
| POST `/api/me/password` | S | `{currentPassword,newPassword}` | 200 `{ok}`; other sessions deleted | 400 invalid_credentials / validation; 403 (token); (gap) 429 |
| GET `/api/me/notification-prefs` | A | – | 200 `NotificationPrefs` (defaults if none) | 401 |
| PUT `/api/me/notification-prefs` | A | `NotificationPrefs` | 200 `NotificationPrefs` | 400 (`fields.whatsapp`) |
| GET `/api/me/api-tokens` | A | – | 200 `{items:ApiTokenSummary[],total}` | 401 |
| POST `/api/me/api-tokens` | S | `{name}` (gap: `expiresInDays?: 30|90|365|null`) | 201 `CreatedApiToken` | 400; 403 (token); (gap) 409 token_limit |
| DELETE `/api/me/api-tokens/:id` | A | – | 200 `{ok}` | 404 |
| GET `/api/org` | A | – | 200 org | – |
| PATCH `/api/org` | M | `{name?,onboardingState?,scoringWeights?}` | 200 org | 400; 403 |
| GET `/api/org/members` | A | – | 200 `{items:Member[],total,invitations:PendingInvitation[]}` | – |
| POST `/api/org/invitations` | M | `{email,role}` | 201 `CreatedInvitation` | 400; 403 (owner role by non-owner); 409 already member |
| DELETE `/api/org/invitations/:id` | M | – | 200 `{ok}` | 404 |
| PATCH `/api/org/members/:userId` | O | `{role}` | 200 `Member` | 403; 404; 409 last_owner |
| DELETE `/api/org/members/:userId` | O | – | 200 `{ok}` | 403; 404; 409 last_owner |
| GET `/api/activity` | A | `page,pageSize,entityType,entityId,userId` | 200 `{items:ActivityItem[],total}` | 400 |
| GET/PUT `/api/scoring-weights` | A / M | PUT: partial weights, `{}` resets | 200 `{weights,defaults,custom}` | 400; 403 |
| GET `/api/ingestion/runs`, POST `/api/ingestion/run` | A / M | – | runs summary / run result | 403 |
| (gap) POST `/api/auth/forgot-password` | — | `{email}` | 200 `{ok:true}` always | 400; 429 |
| (gap) POST `/api/auth/reset-password` | — | `{token,newPassword}` | 200 `Me` + cookie | 400 reset_invalid / validation; 429 |
| (gap) GET `/api/me/sessions` | S | – | 200 `{items:[{id,current,userAgent,createdAt,lastSeenAt}]}` | 403 (token) |
| (gap) DELETE `/api/me/sessions/:id` | S | – | 200 `{ok}` | 404 |
| (gap) POST `/api/me/sessions/revoke-others` | S | – | 200 `{revoked:n}` | – |
| (gap) DELETE `/api/org/members/me` | S | – | 200 `{ok, nextOrgId:string|null}` | 409 last_owner |
| (gap) POST `/api/org/invitations/:id/resend` | M | – | 201 `CreatedInvitation` | 404 |
| (gap) POST `/api/me/notifications/test` | A | – | 200 `{inApp:'sent', email:'sent'|'skipped'|'failed'|'off', whatsapp:…}` | 429 (1/min) |

## Data model touch-points (`packages/db/src/schema.ts`)

| Table | Columns used | Change (gap) |
|---|---|---|
| `users` | id, email (uq `users_email_uq`), name, password_hash, phone, created_at | – |
| `organizations` | id, name, slug (uq `org_slug_uq`), plan, onboarding_state, scoring_weights | – |
| `memberships` | (org_id, user_id) pk, role, created_at | – |
| `invitations` | id, org_id, email, role, token_hash, invited_by, accepted_at, expires_at, created_at | add index `(org_id, email)`; add index on `token_hash` |
| `sessions` | id, user_id, token_hash (uq), active_org_id (set null), expires_at, created_at | add `user_agent text`, `last_seen_at timestamptz` (FR-012) |
| `api_tokens` | id, org_id, user_id, name, token_hash (uq), last_used_at, created_at | add `expires_at timestamptz null`, `token_hint text` (FR-037) |
| `notification_prefs` | (org_id, user_id) pk, in_app, email, whatsapp, frequency, expiry_reminders | – |
| `activity_log` | id, org_id, user_id (set null), action, entity_type, entity_id, meta, created_at; idx `(org_id, created_at)` | add idx `(org_id, entity_type, created_at)` for the filtered Activity page |
| `auth_attempts` (new) | – | `key text`, `kind text ('login_email'|'login_ip'|'reset_email')`, `window_start timestamptz`, `count int`, pk `(key, kind)` (FR-010) |
| `password_resets` (new) | – | `id`, `user_id` (cascade), `token_hash` (uq), `expires_at`, `used_at`, `created_at` (FR-011) |

Migrations are generated with drizzle-kit into `packages/db/migrations/` and applied by `AUTO_MIGRATE=1` in E2E.

## Key flows

**Signup** (FR-001): `SignupPage` → `useAuth().signup` → `POST /auth/signup` → zod `signupInputSchema` → email exists? 409 →
`hashPassword` → `uniqueSlug` → tx {users, organizations, memberships(owner), notification_prefs(defaults)} →
`logActivity(org.created)` → `startSession` (random token → sha256 → `sessions` row, `tp_session` cookie) → `buildMe` →
client `qc.clear()`, `setQueryData(ME_KEY)` → navigate `/onboarding`.

**Request authentication** (FR-004, FR-036): `requireAuth` → `resolveAuth`: `Authorization: Bearer tp_…` ? hash → `api_tokens`
→ user → membership(token org) (null → 401) → bump `last_used_at` (> 60 s) : cookie → hash → `sessions` (unexpired) → user →
membership(active org) or fall back to first membership (persist) → slide expiry if < 15 days left → set
`c.var.{user,org,role,authKind,sessionId,apiTokenId}` → `requireRole(min)` compares `ROLE_RANK`.

**Invite → accept** (FR-014..017): `InviteDialog` → `POST /org/invitations` (M) → owner-role check → member check (409) →
delete pending same-email invites → random token → insert hash, expires +7 d → `logActivity(member.invited)` →
`mailer.send` (errors logged) → 201 with `inviteUrl`. Invitee → `/invite/:token` → (gap) `GET /auth/invite/:token`
preview → `POST /auth/accept-invite` → find unexpired, unaccepted invite by hash → resolve user (session | existing+password |
new+name+password) → (gap) email-mismatch 403 → tx {membership ON CONFLICT DO NOTHING, prefs, accepted_at} →
`logActivity(member.joined)` → start session or switch active org → `Me`.

**Rate limiting (gap, FR-010)**: `lib/rate-limit.ts` `hit(db, key, kind, {limit, windowMs})` does an
`INSERT … ON CONFLICT (key,kind) DO UPDATE SET count = CASE WHEN window_start < now()-window THEN 1 ELSE count+1 END,
window_start = CASE … END RETURNING count, window_start` → if over limit throw 429 with `Retry-After`. Login calls
`check` before password verification and `hit` only on failure; success calls `reset(email)`. Client IP from
`cf-connecting-ip` → `x-forwarded-for` first hop → `'unknown'`.

**Session end in the client (gap, FR-013)**: `queryClient` gets a `QueryCache`/`MutationCache` `onError`: if
`ApiError.status === 401` and `ME_KEY` currently has a user → `qc.clear()`, `setQueryData(ME_KEY, null)` (RequireAuth
redirects with `next`) and toast once (debounced). On 403 `forbidden` from a mutation → `invalidateQueries(ME_KEY)` (FR-029).

## Reference repositories — what to port

The user approved copying from `/home/user/refs/*`. They were reviewed for this area:

| Repo | Relevant content | Decision |
|---|---|---|
| `Giri-Aayush_gem` (no licence file) | `config.py` / `my_profile.yaml`: per-user email report settings (Gmail address + app password, `send_report_to`) | **Do not port** code (no licence; stores SMTP password in YAML, which violates NFR-003). Idea only: the "send report to" concept validates our per-user email channel and the "Send a test alert" button (FR-034). |
| `Giridar33_gem-tender-tracker` (no licence file) | `src/scheduler.py`: cron vs daemon run modes, run logging | **Do not port**. Our `lib/scheduled.ts` + `ingestion_runs` + Sync health already cover this better (per-step isolation, persisted runs). |
| `arush15june_gem-search` (MIT) | CLI search over GeM | Nothing for platform; command-palette tender search already delegates to `/tenders?q=`. |
| `erenmyeager15_india-government-tenders-scraper` (Apache-2.0) | Apify actor input schema, scraping | Nothing for platform. |
| `PranavTamada_Tender_Scraper`, `IshanMaheshwari-777_GEM-SCRAPER`, `Mujahid-Alam_gem-tender-pdf-extractor`, `rounittxx_gem-bid-scraper` | Scrapers / PDF extraction / dashboards | Nothing for platform. |

Result: **no third-party code is copied for spec 002**, so no new `NOTICE` entries are needed; T102 records this
explicitly. If a later task copies code, it must be from the MIT/Apache-2.0 repos only and be added to `NOTICE`.

## QA, review and ticketing

- Each user story and each open task becomes a GitHub issue via `/cairn-taskstoissues` (labels `spec:002`, `area:platform`, `type:story|task`, `priority:P1..P3`, `role:developer|qa`), per `CONVENTIONS.md`.
- Code review: `cairn-reviewer` agent on every PR (ai-sdlc conventions used for review/QA only; no Codex).
- QA: Playwright specs in `e2e/002-platform/US<n>-*.e2e.ts` using `e2e/support/fixtures.ts` (`uniqueUser`, `signupViaApi`, `loginViaUi`, `evidence`, `collectRunArtifacts`); evidence and `VERDICT.md` in `qa/evidence/002/US<n>/`; `@mobile` tag for 375 px checks; axe scans attached as JSON.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None.
