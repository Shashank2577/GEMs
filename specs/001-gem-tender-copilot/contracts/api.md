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
| GET/POST/DELETE | /me/api-tokens[/:id] | POST `{name}` | list / `{token}` shown once |
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
| POST (W) | /analyses/:id/override | `{factorKey,status,reason}` → re-scored `Analysis` |
| GET/PUT (M) | /scoring-weights | `Record<factorKey, number>` |

## Profile & Vault — owner: Vault module (`routes/profile.ts`, `routes/vault.ts`)

Every route is scoped to the session's organization: an id belonging to another org returns 404 (never 403).

| Method | Path | Notes |
|---|---|---|
| GET | /profile | `{profile: CompanyProfile, completeness: 0..100, issues[], averageTurnover}`; `profile.updatedAt` is the version token (null before the first save) |
| PUT (W) | /profile | partial upsert (omitted keys keep their value); validates GSTIN/PAN/Udyam and GSTIN↔PAN. Optional `expectedUpdatedAt` (ISO timestamp, or `null` = "no profile saved yet"): on mismatch → 409 `conflict` `details:{updatedAt}` and nothing is written; omitted = last write wins. Each `oemAuthorizations[i].documentId` that is new or changed must be an `oem_authorization` document of this org's vault, else 400 `validation_error` with `details.fields["oemAuthorizations.<i>.documentId"]` (ids already stored are accepted unchanged). Returns the same body as GET |
| GET/POST(W) | /past-contracts | `{items: PastContract[], total}` (end date desc); POST → 201. `cracDocumentId` must be a document in this org's vault (400 otherwise) |
| PATCH/DELETE (W) | /past-contracts/:id | – (404 for another org's or unknown id) |
| GET | /vault | `type,category,status(valid|expiring|expired),q,sort(expiry|title|type)` → `{items: VaultDocument[], total}` |
| POST (W) | /vault | multipart `file` (PDF/PNG/JPG sniffed from bytes, ≤ 20 MB) + fields `type,title,number,issuer,issueDate,expiryDate,financialYear,tags(json)`, optional `allowDuplicate=1` → 201 `VaultDocument`. A file whose SHA-256 matches another document of the org → 409 `duplicate_document` `details:{existingId,title}` unless `allowDuplicate=1`. 413 `payload_too_large`, 415 `unsupported_media_type`, 422 `unreadable_pdf` |
| GET | /vault/:id | `VaultDocument` |
| PATCH/DELETE (W) | /vault/:id | PATCH metadata (a changed `expiryDate` restarts the 30/7/1 reminder cycle); DELETE removes the row, its versions and all blobs and unlinks CRAC / OEM references |
| PUT (W) | /vault/:id/file | replace / renew: multipart `file` + optional renewal fields `issueDate,expiryDate,number` (only the ones sent are applied; `''` clears) and `allowDuplicate=1`. The previous file becomes a version (at most 5 kept, oldest pruned). A new non-empty `expiryDate` restarts reminders and logs `vault.renewed`. 409 `duplicate_document` (as POST, excluding this document); 409 `conflict` if another replace committed first → `VaultDocument` |
| GET | /vault/:id/download | streams the current file (`?inline=1` for preview; `cache-control: private, no-store`, `nosniff`) |
| GET | /vault/:id/versions | `{items: VaultVersion[]}` newest first |
| GET | /vault/:id/versions/:versionId/download | streams a previous file (`?inline=1`); 404 if the version is not of this document/org |
| GET | /vault/summary | `{total, valid, expiring, expired, byType:{[type]:n}, nextExpiries:[...], missingCommon:[type]}` |
| POST (M) | /vault/reminders/run | runs the expiry-reminder job for this org now (same as the scheduler step; idempotent) → `{documents, notifications}` |

DTOs (`packages/core/src/contracts/vault.ts`):
- `VaultDocument` = stored fields + `status`, `daysToExpiry`, `uploadedBy:{id,name}|null`, `downloadUrl` and
  `nextReminder: {days: 30|7|1|0, date: YYYY-MM-DD} | null` (the next 30/7/1-day or on-expiry reminder still to be sent; null without an expiry date or when none is left).
- `VaultVersion` = `{id, fileName, mimeType, sizeBytes, pageCount, expiryDate (expiry while this file was current), replacedBy:{id,name}|null, replacedAt, downloadUrl}`.

## Apply — owner: Apply module (`routes/workspaces.ts`, `routes/packets.ts`, `routes/assist.ts`)

| Method | Path | Notes |
|---|---|---|
| POST (W) | /tenders/:id/workspace | create-or-get workspace (stage `identified`, or `go/no_go` hint from analysis) |
| GET | /workspaces | `stage?` → cards for Kanban: tender summary, score, owner, due, readiness % |
| GET | /workspaces/:id | workspace + tender + analysis + `readiness` + packets + comments |
| PATCH (W) | /workspaces/:id | `{stage?,ownerId?,assigneeIds?,dueAt?,position?,outcome?}`; moving to `ready` blocked (409) if mandatory items missing/expired and not overridden |
| PUT (W) | /workspaces/:id/mapping | `{[itemId]: vaultDocId|null}` |
| POST (M) | /workspaces/:id/overrides | `{itemId, reason}` |
| GET/POST | /workspaces/:id/comments | – |
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
3. `runExpiryReminders()` — 30/7/1-day and on-expiry vault reminders (deduped per document, expiry date and threshold; also `POST /vault/reminders/run` per org).
