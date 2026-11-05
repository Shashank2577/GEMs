# API Contract — TenderPilot

All endpoints are under `/api`, JSON in/out (multipart for uploads), errors as
`{ "error": { "code": string, "message": string, "details"?: unknown } }` with proper HTTP status.
Auth: httpOnly cookie `tp_session` (web) or `Authorization: Bearer tp_…` API token (extension).
The active organization comes from the session (`sessions.active_org_id`). Roles:
`owner > bid_manager > analyst > viewer`. "W" = requires at least analyst (write), "M" = bid_manager+, "O" = owner.
List endpoints return `{ items, total }` and accept `page` (1-based) and `pageSize` (default 25, max 100).
Money is integer rupees. Dates are ISO-8601 strings; the UI renders IST.

Shared DTO zod schemas live in `packages/core/src/contracts/<area>.ts` (owned by the area's module).

## Platform — owner: API foundation (`apps/api/src/routes/auth.ts`, `routes/org.ts`)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | /auth/signup | `{name,email,password(≥8),orgName}` | `Me` (sets cookie) |
| POST | /auth/login | `{email,password}` | `Me` |
| POST | /auth/logout | – | `{ok:true}` |
| GET | /auth/me | – | `Me = {user:{id,name,email,phone}, org:{id,name,slug,plan,onboardingState}, role, orgs:[{id,name,role}]}` (401 if none) |
| POST | /auth/switch-org | `{orgId}` | `Me` |
| POST | /auth/accept-invite | `{token,name?,password?}` | `Me` |
| PATCH | /me | `{name?,phone?}` | `Me` |
| GET/PUT | /me/notification-prefs | `{inApp,email,whatsapp,frequency,expiryReminders}` | prefs |
| POST | /me/notifications/test | – (session only; 1/min per user → 429 `rate_limited` + Retry-After) | `{inApp:'sent',email,whatsapp}`, email/whatsapp each `sent\|skipped\|failed\|off` (002/FR-034) |
| GET/POST/DELETE | /me/api-tokens[/:id] | POST `{name, expiresInDays?: 30\|90\|365\|null}` (default 90, null = never) | list `{id,name,createdAt,lastUsedAt,expiresAt,hint}` / `{…, token}` shown once; 409 `token_limit` at 10 active tokens (002/FR-037) |
| GET | /org/members | – | `[{userId,name,email,role,joinedAt}]` + pending invites |
| POST (M) | /org/invitations | `{email,role}` | `{id, inviteUrl}` |
| PATCH/DELETE (O) | /org/members/:userId | `{role}` | member |
| PATCH (M) | /org | `{name?, onboardingState?, scoringWeights?}` | org |
| GET | /activity | `entityType?, entityId?` | `{items:[{id,user:{id,name},action,entityType,entityId,meta,createdAt}]}` |
| GET | /health | – | `{ok, db, version}` (no auth) |

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
