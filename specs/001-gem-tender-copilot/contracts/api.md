# API Contract — TenderPilot

All endpoints are under `/api`, JSON in/out (multipart for uploads), errors as
`{ "error": { "code": string, "message": string, "details"?: unknown } }` with proper HTTP status.
Auth: httpOnly cookie `tp_session` (web) or `Authorization: Bearer tp_…` API token (extension).
The active organization comes from the session (`sessions.active_org_id`). Roles:
`owner > bid_manager > analyst > viewer`. "W" = requires at least analyst (write), "M" = bid_manager+, "O" = owner.
List endpoints return `{ items, total }` and accept `page` (1-based) and `pageSize` (default 25, max 100).
Money is integer rupees. Dates are ISO-8601 strings; the UI renders IST.

Shared DTO zod schemas live in `packages/core/src/contracts/<area>.ts` (owned by the area's module).

## Platform — owner: API foundation (`apps/api/src/routes/auth.ts`, `routes/org.ts`, `routes/sessions.ts`)

"S" = session (cookie) only; an `Authorization: Bearer tp_…` token gets 403 `forbidden`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /auth/signup | `{name,email,password(≥8),orgName}` | `Me` (sets cookie), 201 |
| POST | /auth/login | `{email,password}` | `Me`; 401 `invalid_credentials`; 429 `rate_limited` (FR-010) |
| POST | /auth/logout | – | `{ok:true}` |
| GET | /auth/me | – | `Me = {user:{id,name,email,phone}, org:{id,name,slug,plan,onboardingState}, role, orgs:[{id,name,role}]}` (401 if none) |
| POST (S) | /auth/switch-org | `{orgId}` | `Me`; 404 `not_found` for an org the user is not in |
| POST | /auth/forgot-password | `{email}` | `{ok:true}` always (no account enumeration); 429 `rate_limited` per email (3/h) and per IP (20/h) (FR-011) |
| POST | /auth/reset-password | `{token,password(≥8)}` | `{ok:true}`, signs out every session of the user; 400 `reset_invalid` (unknown, used or expired link, 1 h); 429 `rate_limited` (FR-011) |
| GET | /auth/invite/:token | – (no auth) | `InvitePreview = {orgName,email,role,invitedBy,expiresAt,existingUser}`; 404 `invite_invalid` (FR-019) |
| POST | /auth/accept-invite | `{token,name?,password?}` (signed in: neither; existing account: `password`; new account: `name`+`password`) | `Me`; 404 `invite_invalid`; 401 `invalid_credentials` (wrong password for an existing account); 403 `invite_email_mismatch` when the signed-in user's email is not the invited one (FR-018); 429 `rate_limited` |
| PATCH | /me | `{name?,phone?}` | `Me` |
| POST (S) | /me/password | `{currentPassword,newPassword}` | `{ok:true}`, other sessions are signed out; 400 `invalid_credentials`; 429 `rate_limited` |
| GET | /me/sessions | – | `{items:[{id,current,userAgent,device,createdAt,lastSeenAt}], total}` (S) |
| POST (S) | /me/sessions/revoke-others | – | `{revoked}` (count) |
| DELETE (S) | /me/sessions/:id | – | `{ok:true}`; 404 for another user's session |
| GET/PUT | /me/notification-prefs | `{inApp,email,whatsapp,frequency,expiryReminders}` (PUT needs the full object, per org) | prefs |
| POST (S) | /me/notifications/test | – (1/min per user → 429 `rate_limited` + `Retry-After`) | `{inApp:'sent',email,whatsapp,skipReasons?}`, email/whatsapp each `sent\|skipped\|failed\|off`; `skipReasons` (only when something was skipped) maps a channel to `not_configured\|no_phone` (002/FR-034) |
| GET/POST/DELETE | /me/api-tokens[/:id] | POST (S) `{name, expiresInDays?: 30\|90\|365\|null}` (default 90, null = never) | list `{id,name,createdAt,lastUsedAt,expiresAt,hint}` / `{…, token}` shown once; 409 `token_limit` at 10 active tokens per org (002/FR-037) |
| GET | /org | – | org |
| GET | /org/members | – | `{items:[{userId,name,email,phone,role,joinedAt}], total, invitations:[{id,email,role,createdAt,expiresAt,invitedBy}]}` (pending = unexpired, unaccepted) |
| POST (M) | /org/invitations | `{email,role}` | `{id,email,role,inviteUrl,expiresAt}`, 201; replaces a pending invite for the same email; 409 `conflict` if already a member; 403 `forbidden` when a non-owner invites an owner |
| POST (M) | /org/invitations/:id/resend | – | as above, 201: new token and 7-day expiry, also revives an expired invite; `invitedBy` becomes the resender; 404 for other orgs' or accepted invites |
| DELETE (M) | /org/invitations/:id | – | `{ok:true}`; 404 as above |
| PATCH/DELETE (O) | /org/members/:userId | `{role}` | member; 409 `last_owner` when it would leave no owner (FR-021) |
| DELETE (S) | /org/members/me | – | `{ok:true,nextOrgId}`: leave the active org (FR-027); 409 `last_owner` |
| PATCH (M) | /org | `{name?, onboardingState?, scoringWeights?}` | org |
| GET | /activity | `entityType?, entityId?, userId?, page?, pageSize?` | `{items:[{id,user:{id,name}\|null,action,entityType,entityId,meta,createdAt}], total}`; `user` is null when the actor no longer exists; newest first, paginated by `page`/`pageSize` |
| GET | /health | – | `{ok, db, version}` (no auth) |

### Platform error codes

Besides the generic `validation_error` (400, `details.fields`), `unauthorized` (401), `forbidden` (403), `not_found` (404)
and `conflict` (409):

| Code | Status | When |
|---|---|---|
| `rate_limited` | 429 | Too many credential attempts (login, accept-invite, change password: 10 failures per email and 30 per IP per 15 min), password-reset requests (3 per email, 20 per IP per hour), or a second test alert within a minute. Sends `Retry-After` (seconds); `details.retryAfter` repeats it. The per-IP limits apply only when the client IP is known (`TRUST_PROXY`). |
| `invalid_credentials` | 401 / 400 | 401 for a wrong email/password at login and a wrong password on accept-invite (existing account); 400 for a wrong current password on `/me/password` (field error). |
| `invite_invalid` | 404 | Invitation link unknown, already used or expired. |
| `invite_email_mismatch` | 403 | A signed-in user accepts an invitation addressed to another email. |
| `reset_invalid` | 400 | Password-reset link unknown, already used or expired. Counted against the IP's `login_ip` budget. |
| `bad_origin` | 403 | A cookie-authenticated write whose `Origin` differs from `APP_URL` (or `Sec-Fetch-Site: cross-site` without `Origin`). Bearer-token requests are exempt (FR-028). |
| `token_limit` | 409 | The user already has 10 active API tokens in this org (FR-037). |
| `last_owner` | 409 | Demoting, removing or leaving as the only Owner (FR-021, FR-027). |
| `no_organization` | 403 | The user is not (or no longer) a member of the organization the request acts on, e.g. creating a token after being removed. |

Security headers on every response (FR-050): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (`SAMEORIGIN`
for inline document previews), `Referrer-Policy: no-referrer`, `Strict-Transport-Security` on https, and a CSP for the SPA.

## Identify — owner: Identify module (`routes/tenders.ts`, `routes/watchlists.ts`, `routes/ingestion.ts`, `routes/notifications.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | /tenders | `q,state,ministry,category,status,closingWithinDays,minValue,maxValue,matched(0/1),watchlistId,verdict,stage,sort(endAt|-createdAt|score|value),page,pageSize` → `{items: TenderListItem[], total, facets:{states,ministries,categories}}`. `TenderListItem` = tender core fields + `{matches:[{watchlistId,watchlistName,reasons}], analysis?:{score,verdict}, workspace?:{id,stage}, seen, isNew}` |
| GET | /tenders/:id | `TenderDetail` = tender + `events` + `documents` + `matches` + `analysis` (latest for org) + `workspace` |
| POST | /tenders/:id/seen, /tenders/:id/dismiss | – |
| GET/POST | /watchlists | criteria per `WatchlistCriteria` |
| PATCH/DELETE (W) | /watchlists/:id | – |
| POST | /watchlists/preview | `{criteria}` → `{count, sample: TenderListItem[]}` |
| POST (M) | /ingestion/run | `{pages?}` → `IngestionRun` (runs inline, matches, queues alerts) |
| GET | /ingestion/runs | latest runs + `lastSuccessAt` |
| GET | /notifications | `unread?` → `{items, unreadCount}` |
| POST | /notifications/:id/read, /notifications/read-all | – |

## Analyse — owner: Analyse module (`routes/analysis.ts`)

| Method | Path | Notes |
|---|---|---|
| POST (W) | /tenders/:id/documents | multipart `file`, `kind` → `TenderDocument` (text extracted) |
| POST (W) | /tenders/:id/fetch-documents | downloads GeM bid document(s) via GemClient |
| GET | /tenders/:id/documents/:docId/download | streams file |
| POST (W) | /tenders/:id/analyse | runs rules (+LLM if key) → `Analysis` |
| GET | /tenders/:id/analysis | latest `Analysis` or 404 |
| POST (M) | /analyses/:id/override | `{factorKey,status,reason}` → re-scored `Analysis` |
| GET/PUT (M) | /scoring-weights | `Record<factorKey, number>` |

## Profile & Vault — owner: Vault module (`routes/profile.ts`, `routes/vault.ts`)

| Method | Path | Notes |
|---|---|---|
| GET/PUT(W) | /profile | `CompanyProfile`; validates GSTIN/PAN/Udyam; returns `{profile, completeness:0..100, issues[]}` |
| GET/POST(W) | /past-contracts | – |
| PATCH/DELETE (W) | /past-contracts/:id | – |
| GET | /vault | `type,status(valid|expiring|expired),q` → `VaultDocument & {status, daysToExpiry}` |
| POST (W) | /vault | multipart `file` + fields `type,title,number,issuer,issueDate,expiryDate,financialYear,tags(json)` |
| PATCH/DELETE (W) | /vault/:id | – |
| GET | /vault/:id/download | streams file (`?inline=1`) |
| GET | /vault/summary | `{total, valid, expiring, expired, byType:{[type]:n}, nextExpiries:[...]}` |

## Apply — owner: Apply module (`routes/workspaces.ts`, `routes/packets.ts`, `routes/assist.ts`)

| Method | Path | Notes |
|---|---|---|
| POST (W) | /tenders/:id/workspace | create-or-get workspace (stage `identified`, or `go/no_go` hint from analysis) |
| GET | /workspaces | `stage?` → cards for Kanban: tender summary, score, owner, due, readiness % |
| GET | /workspaces/:id | workspace + tender + analysis + `readiness` + packets + comments |
| PATCH (W) | /workspaces/:id | `{stage?,ownerId?,assigneeIds?,dueAt?,position?,outcome?}`; moving to `ready` blocked (409) if mandatory items missing/expired and not overridden |
| PUT (W) | /workspaces/:id/mapping | `{[itemId]: vaultDocId|null}` |
| POST (M) | /workspaces/:id/overrides | `{itemId, reason}` |
| GET/POST (W) | /workspaces/:id/comments | POST is Analyst+ (002/FR-022) |
| GET | /annexure-templates | system + org templates |
| PUT (M) | /annexure-templates/:key | `{title, body}` org override |
| GET | /workspaces/:id/annexures/:key.pdf | rendered annexure PDF |
| POST (W) | /workspaces/:id/packets | `{items: PacketItem[]}` (optional, default order) → `Packet` (merged PDF built) |
| GET | /packets/:id/download | merged PDF |
| GET | /assist/:workspaceId | session or Bearer token → `{tender:{bidNumber,title}, fields:[{key,label,value,selectorHints[]}], documents:[{title, fileName, url}], humanSteps:[...]}` — never includes price |
| PUT (W) | /workspaces/:id/assist-values | `{[key]: value}` (price-like keys rejected) |
| POST (W) | /workspaces/:id/submitted | marks stage `submitted`, records time |

## Dashboard & demo — owner: Experience module (`routes/dashboard.ts`, `routes/demo.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | /dashboard | `{tiles:{newMatchesToday, closingThisWeek, activeBids, emdAtStake, winRate, expiringDocs}, closingSoon[], pipeline:{[stage]:n}, verdicts:{go,review,no_go}, matchesByDay:[{date,count}], recentMatches[], activity[], setup:[{key,label,done,href}]}` |
| POST (M) | /demo/seed | seeds demo company profile, vault docs, watchlists, matches, analyses and workspaces into the current org (idempotent) |

## Scheduled (Worker `scheduled`, also `POST /ingestion/run`)

1. `runIngestion()` — fetch N pages, upsert tenders, record events, match watchlists, create notifications.
2. `dispatchNotifications()` — send pending email/WhatsApp (skipped when not configured), daily digests.
3. `runExpiryReminders()` — 30/7/1-day vault reminders.

## Error codes for limits and capacity (spec 008, FR-018, FR-021, FR-040)

Built with the helpers in `apps/api/src/lib/errors.ts`. Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts`.

| Status | Code | When | `details` |
|---|---|---|---|
| 402 | `plan_limit_reached` | a plan limit (seats, watchlists, analyses, vault bytes, packets) is reached | `{limit, used, max}` |
| 402 | `plan_expired` | the trial or plan has ended (writes only) | – |
| 413 | `payload_too_large` | body over its cap: JSON 1 MB, vault 20 MB, tender documents 25 MB (+64 KB multipart); rejected before the body is read | `{maxBytes}` |
| 413 | `packet_too_large` | packet would exceed 40 MB or 40 items | – |
| 422 | `document_too_long` | tender document over 300 pages | – |
| 422 | `scanned_document` | tender document has no extractable text | – |
| 429 | `rate_limited` | a rate-limit rule is over its limit; header `Retry-After: <s>` | `{rule, retryAfter}` |
| 429 | `sync_cooldown` | manual "Sync now" within the cooldown | `{retryAt}` |
| 503 | `gem_busy` | the cluster-wide GeM slot could not be had in time | – |
| 503 | `service_unavailable` | an auth rate limiter could not be checked (auth rules fail closed) | `{reason}` |
