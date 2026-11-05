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
A read-only token (`scope:"read"`, 006/FR-074) may only `GET`/`HEAD`: every other method on every `/api` route gets 403 `read_only_token`.

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
| GET/POST/DELETE | /me/api-tokens[/:id] | POST (S) `{name, expiresInDays?: 30\|90\|365\|null, scope?: "full"\|"read"}` (default 90, null = never; scope default `full`, fixed at creation) | list `{id,name,createdAt,lastUsedAt,expiresAt,hint,scope}` / `{…, token}` shown once; 409 `token_limit` at 10 active tokens per org (002/FR-037); `scope:"read"` = "Extension (read-only)" (006/FR-074) |
| GET | /org | – | org (incl. `trialEndsAt`, 008/FR-035) |
| GET | /org/usage | – | any member (008/FR-039): `{plan, trialEndsAt, period:{start,end}, usage:{seats, watchlists, analysesThisMonth, llmAnalysesThisMonth, vaultBytes, packetsThisMonth, llmTokensThisMonth:{input,output}}, limits}`; months are IST calendar months; `limits.watchlists: null` = no plan limit (the 003/FR-027 cap of 50 still applies); demo-seeded analyses are not counted, and deleted analyses keep their AI count |
| GET | /org/members | – | `{items:[{userId,name,email,phone,role,joinedAt}], total, invitations:[{id,email,role,createdAt,expiresAt,invitedBy}]}` (pending = unexpired, unaccepted) |
| POST (M) | /org/invitations | `{email,role}` | `{id,email,role,inviteUrl,expiresAt}`, 201; replaces a pending invite for the same email; 409 `conflict` if already a member; 403 `forbidden` when a non-owner invites an owner |
| POST (M) | /org/invitations/:id/resend | – | as above, 201: new token and 7-day expiry, also revives an expired invite (then counts one seat: 402 `plan_limit_reached` when the plan's seats are full, 008/FR-036); `invitedBy` becomes the resender; 404 for other orgs' or accepted invites |
| DELETE (M) | /org/invitations/:id | – | `{ok:true}`; 404 as above |
| PATCH/DELETE (O) | /org/members/:userId | `{role}` | member; 409 `last_owner` when it would leave no owner (FR-021) |
| DELETE (S) | /org/members/me | – | `{ok:true,nextOrgId}`: leave the active org (FR-027); 409 `last_owner` |
| PATCH (M) | /org | `{name?, onboardingState?, scoringWeights?}` | org |
| GET | /activity | `entityType?` (one or a comma-separated list, max 12), `entityId?, userId?, page?, pageSize?` | `{items:[{id,user:{id,name}\|null,action,entityType,entityId,meta,createdAt,target?:{label,href}\|null}], total}` (`target` = the entity's display name and link, resolved server-side); `user` is null when the actor no longer exists; newest first, paginated by `page`/`pageSize`. Includes `auth.password_changed` (`POST /me/password`, meta `{otherSessionsRevoked}`) and `auth.sessions_revoked` (`POST /me/sessions/revoke-others` when ≥1 revoked, `DELETE /me/sessions/:id`; meta `{scope:'others'\|'one'\|'current',count}`), both `entityType:'user'` in the active org (002/FR-042) |
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
| `read_only_token` | 403 | "This API token is read-only": a non-GET request authenticated with a read-only API token (006/FR-074). |
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

## Analyse — owner: Analyse module (`routes/analysis.ts`, `services/analyse.ts`, `services/staleness.ts`)

Types: `packages/core/src/contracts/analyse.ts` (004). Every route is scoped to the session's organization and uses the standard error envelope. Role gates: `viewer+` = any signed-in member, `analyst+`, `bid_manager+`. Tender documents fetched from GeM (`orgId = null`) are shared by all orgs; uploads belong to the uploading org (another org's upload is 404).

| Method | Path | Notes |
|---|---|---|
| GET | /tenders/:id/documents | viewer+. `{items: TenderDocumentDto[], total}` — the shared GeM copies plus this org's uploads (text omitted) |
| POST (W) | /tenders/:id/documents | analyst+, multipart `file` (PDF sniffed from bytes, ≤ 25 MB) + `kind` (`bid`\|`atc`\|`corrigendum`\|`boq`\|`other`, default `bid`) → 201 `UploadTenderDocumentResponse` = `TenderDocumentDto` + `warnings: TenderDocumentWarning[]`. Text is extracted (first 150 pages) on upload; a scanned PDF is accepted with `hasText:false`; a PDF over 300 pages → 422 `document_too_long`. Marks this org's analyses of the tender stale (`document_added`). Rate limited (`upload.org`) |
| POST (W) | /tenders/:id/fetch-documents | analyst+. Downloads the GeM bid document once → `{items, total, fetched}`: **201** when a copy was stored, **200** (`fetched:0`) when the stored copy is returned ("already here"). A corrigendum that changed the tender's `documentUrl` after the stored copy was fetched triggers a re-download as kind `corrigendum` (the earlier copy is kept) and marks every org's analyses of the tender stale (`corrigendum`). `?refresh=1` forces a re-download even when the URL is unchanged; a forced copy whose text hashes the same as a stored one stores nothing (200), while one that stores a new copy also marks every org's analyses of the tender stale (`corrigendum`). Rate limited (`gem.fetch.org`) |
| DELETE (W) | /tenders/:id/documents/:docId | analyst+. Removes one of this org's uploads → 204; the delete, the `tender.document_removed` activity row and the stale flag (`document_removed`) commit together. A GeM-fetched document → 403 `forbidden`; unknown/other-org id → 404 |
| GET | /tenders/:id/documents/:docId/download | viewer+. Streams the PDF; `?inline=1` for in-browser preview. `cache-control: private, no-store`, `x-content-type-options: nosniff` |
| POST (W) | /tenders/:id/analyse | analyst+. Reads every bid document (auto-fetches from GeM when there are none and the tender has a GeM link), extracts requirements by rules (+ LLM when a key is configured and the budget/quota allow), scores and builds the checklist → 201 `AnalysisDto` (`method:'rules'\|'rules+llm'`); the response `documents` lists only the documents that were read (skipped scanned PDFs are not listed, unlike `GET …/analysis`). The auto-fetch swallows its errors except 503 `gem_busy` and 422 `document_too_long`, which analyse surfaces; with no documents and no GeM link it returns 422 `no_documents`. Rate limited (`analyse.user`). A running analysis for the tender → 409 `analysis_running`; one that exceeded the run timeout and was replaced while this request was finishing → 409 `analysis_superseded` |
| GET | /tenders/:id/analysis | viewer+. The latest **done** `AnalysisDto` (with `documents` — including skipped scanned PDFs — and the manual overrides applied), or 404 `not_found` when the tender was never analysed. A newer attempt that is still running or failed is reported in `lastAttempt`; a first-ever run that failed or timed out returns that attempt as the DTO itself (`status:'failed'`) with `lastAttempt`, and a first-ever run that is still running is likewise returned as the DTO itself (`status:'running'`) |
| POST (M) | /analyses/:id/override | bid_manager+. `{factorKey, status, reason}` (`reason` 3–500 chars) → the re-scored analysis in the same shape as `GET …/analysis`. `status` equal to the computed one removes the override. 409 `conflict` unless the analysis is `done`; 409 `analysis_replaced` when a newer analysis exists; an unknown `factorKey` → 400 `validation_error` (a 404 for a key outside the analysis is practically unreachable) |
| POST (W) | /analyses/:id/rescore | analyst+. Recomputes factors, score, verdict and checklist from the **stored** requirements with the current profile, vault, past contracts and weights; keeps overrides and clears `stale`/`staleReason`/`staleAt`. Same body as `GET …/analysis`. 409 `conflict` unless `done`; 409 `analysis_running` while an analysis is running for the tender; 409 `analysis_replaced` when a newer analysis exists; 409 `reanalysis_required` when the stale reason is a document change (`corrigendum`, `document_added`, `document_removed`) or unknown — use `POST …/analyse` instead |
| GET/PUT (M) | /scoring-weights | GET viewer+: `ScoringWeights` = `{weights, defaults, custom}`. PUT bid_manager+: partial map factor → 0–100 (`{}` resets to defaults), at least one weight > 0 else 400 `validation_error`; marks the org's analyses of open tenders stale (`weights_changed`) → `ScoringWeights` |

### DTOs

- `TenderDocumentDto` = `{id, tenderId, orgId (null = GeM), kind, fileName, sizeBytes, pageCount, totalPages, sourceUrl, hasText, source:'gem'\|'upload', textSource:'pdf'\|'ocr', bidNumberFound, createdAt}`.
  - `pageCount` = pages read (capped at 150, 004/NFR-005); `totalPages` = the PDF's real page count (`totalPages > pageCount` means it was truncated; `null` for rows that predate the column).
  - `hasText:false` = no text layer (scanned). `textSource` is `'pdf'` for every document today; `'ocr'` is reserved for US7.
  - `bidNumberFound` = the bid number printed on page 1 when it differs from the tender's, else `null`.
- `TenderDocumentWarning` (upload response only, non-blocking, FR-010): `{code:'bid_number_mismatch', found}` and `{code:'pages_truncated', analysed, total}`.
- `AnalysisDto` = `{id, orgId, tenderId, status:'pending'\|'running'\|'done'\|'failed', method, requirements[], factors[], checklist[], score, confidence, verdict:'go'\|'review'\|'no_go'\|null, summary, error, stale, staleReason, staleAt, notes[], warnings[], createdBy, createdAt, updatedAt, documents?, lastAttempt?}`.
  - `stale` + `staleReason` (`corrigendum`\|`document_added`\|`document_removed`\|`profile_changed`\|`vault_changed`\|`weights_changed`) + `staleAt` (ISO) say why and since when the result is outdated (FR-043). Re-score fixes the company-side reasons (`profile_changed`, `vault_changed`, `weights_changed`); the others need a re-analysis.
  - `notes` = human-readable caveats of the run, e.g. pages that AI review did not cover (FR-051).
  - `warnings` = machine-readable caveats: `{code:'llm_budget_exhausted', covered, total}` and `{code:'llm_quota_reached'}` (008/FR-031, FR-037).
  - `lastAttempt` (GET/override/rescore only) = `{status:'running'\|'failed', error, at}` for a newer attempt than the shown result (FR-029).
  - `documents` = the documents the analysis read: `{id, fileName, kind, pageCount, totalPages?}`.

### Analyse error codes

| Code | Status | When |
|---|---|---|
| `analysis_running` | 409 | `POST …/analyse` or `…/rescore` while an analysis of the tender is running (a run older than the timeout is treated as dead and does not block) |
| `analysis_superseded` | 409 | The run exceeded its timeout and a newer one replaced it before it could store its result. "Reload to see the latest result." |
| `analysis_replaced` | 409 | Override or re-score of an analysis that a newer analysis has replaced |
| `reanalysis_required` | 409 | Re-score of an analysis whose stale reason needs the documents re-read |
| `conflict` | 409 | Override or re-score of an analysis that is not `done` |
| `no_documents` | 422 | Analyse with no bid document and nothing to auto-fetch, including a tender with no GeM link ("Add the bid document first") |
| `no_gem_document` | 422 | Fetch for a tender without a GeM document link (never returned by analyse) |
| `document_too_long` | 422 | A PDF over 300 pages, on upload, fetch or the auto-fetch inside analyse |
| `scanned_document` | 422 | Every document of the tender is a scan without a text layer (008/FR-030); `details.documents` lists the file names. A mix analyses the readable ones and adds a `notes` entry per skipped scan |
| `unreadable_pdf` | 422 | Upload or GeM download that cannot be parsed (damaged or password-protected) |
| `unsupported_media_type` | 415 | Upload is not a PDF |
| `payload_too_large` | 413 | Upload larger than 25 MB (checked before the body is read, 008/FR-021) |
| `bad_request` | 400 | Empty file |
| `validation_error` | 400 | Missing `file`, unknown `kind`, invalid override or weights body |
| `gem_unavailable` | 502 | GeM could not be reached, no longer serves the document (404), or the document exceeds 25 MB |
| `gem_busy` | 503 | The cluster-wide GeM request slot (1 request/s) was not free within 25 s (008/FR-024); also surfaced by analyse's auto-fetch |
| `rate_limited` | 429 | `upload.org`, `gem.fetch.org` or `analyse.user` limit reached |
| `forbidden` | 403 | Role too low, or removing a GeM-fetched document |
| `analysis_failed` | 500 | The run failed unexpectedly; the previous result (if any) stays and is reported with `lastAttempt` |

### US7 (pending): AI enrichment and OCR

> Not built yet. The US7 PR completes this section (and ticks T095 in `specs/004-analyse-scoring/tasks.md`); nothing below exists on `main` today.

- `POST /tenders/:id/documents/:docId/ocr` (analyst+) — read a scanned document with AI → the updated `TenderDocumentDto` (`textSource:'ocr'`). Planned: 409 when the document already has text. TODO(US7): request/response details.
- `GET /analysis/capabilities` (viewer+) — `{ai, ocr, models}`. TODO(US7): shape and caching.
- Error codes `ocr_unavailable` (503, no OCR model configured) and `ocr_failed` (502, the model could not transcribe the document). TODO(US7): messages and `details`.

## Profile & Vault — owner: Vault module (`routes/profile.ts`, `routes/vault.ts`)

Every route is scoped to the session's organization: an id belonging to another org returns 404 (never 403).

| Method | Path | Notes |
|---|---|---|
| GET | /profile | `{profile: CompanyProfile, completeness: 0..100, issues[], averageTurnover}`; `profile.updatedAt` is the version token (null before the first save) |
| PUT (W) | /profile | partial upsert (omitted keys keep their value); validates GSTIN/PAN/Udyam and GSTIN↔PAN. Optional `expectedUpdatedAt` (ISO timestamp, or `null` = "no profile saved yet"): on mismatch → 409 `conflict` `details:{updatedAt}` and nothing is written; omitted = last write wins. Each `oemAuthorizations[i].documentId` that is new or changed must be an `oem_authorization` document of this org's vault, else 400 `validation_error` with `details.fields["oemAuthorizations.<i>.documentId"]` (ids already stored are accepted unchanged). Returns the same body as GET |
| GET/POST(W) | /past-contracts | `{items: PastContract[], total}` (end date desc); POST → 201. `cracDocumentId` must be a document in this org's vault (400 otherwise) |
| PATCH/DELETE (W) | /past-contracts/:id | – (404 for another org's or unknown id) |
| GET | /vault | `type,category,status(valid|expiring|expired),q,sort(recent|expiry|title|type; default recent)` → `{items: VaultDocument[], total}` |
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
- `VaultDocument` = public fields (internal storage fields are not exposed) + `status`, `daysToExpiry`, `uploadedBy:{id,name}|null`, `downloadUrl` and
  `nextReminder: {days: 30|7|1|0, date: YYYY-MM-DD} | null` (the next 30/7/1-day or on-expiry reminder still to be sent; null without an expiry date or when none is left).
- `VaultVersion` = `{id, fileName, mimeType, sizeBytes, pageCount, expiryDate (expiry while this file was current), replacedBy:{id,name}|null, replacedAt, downloadUrl}`.

## Apply — owner: Apply module (`routes/workspaces.ts`, `routes/packets.ts`, `routes/assist.ts`)

| Method | Path | Notes |
|---|---|---|
| POST (W) | /tenders/:id/workspace | create-or-get workspace (stage `identified`, or `go/no_go` hint from analysis; a Go verdict starts it in `go` only for bid_manager+, an Analyst's starts in `analysing` — #527) |
| GET | /workspaces | `stage?` → cards for Kanban: tender summary, score, owner, due, readiness % |
| GET | /workspaces/:id | workspace + tender + analysis + `readiness` + packets + comments |
| PATCH (W) | /workspaces/:id | `{stage?,ownerId?,assigneeIds?,dueAt?,position?,outcome?: {result:'won'\|'lost', l1Price?, ourPrice?, notes?}\|null}`; moving to `ready` is blocked (409 `not_ready`, or `conflict` with `reason:'not_analysed'`) if mandatory items are missing/expired and not overridden; reaching `won`/`lost` (by `stage` or by `outcome`) from any stage other than `submitted`/`won`/`lost` is 409 `invalid_transition` (`details:{from,to}`); moving a bid **into `go` or `dropped`** (the Go/No-Go call) is bid_manager+, otherwise 403 `forbidden` (#527). A position move renumbers the column in one transaction under a per-(org, stage) advisory lock |
| PUT (W) | /workspaces/:id/mapping | `{[itemId]: vaultDocId|null}` |
| POST (M) | /workspaces/:id/overrides | `{itemId, reason}` → 201 `{workspace, readiness}`; only a missing or expired item can be overridden, otherwise 409 `nothing_to_override` (`details:{itemId,state}`); an item not in the checklist is 400 `validation_error` |
| DELETE (M) | /workspaces/:id/overrides/:itemId | removes an override → `{workspace, readiness}`; 404 when there is none |
| GET/POST (W) | /workspaces/:id/comments | POST `{body}` is Analyst+ (002/FR-022), 201 `{id, body, user, createdAt}`; `@mentions` notify the mentioned members |
| DELETE | /workspaces/:id/comments/:commentId | 204; the comment's author or a Bid Manager+ (anyone else 403 `forbidden`); unknown id or another workspace/org's comment is 404 |
| GET | /annexure-templates | system + org templates |
| PUT (M) | /annexure-templates/:key | `{title, body}` org override (atomic upsert on the unique `(org_id, key)` index); a body with a `{{placeholder}}` outside the supported context paths is 400 `unknown_placeholder` (`details:{unknown:[…]}`, message "Unknown placeholder {{x}} — use one from the list."); an unknown key is 404 |
| DELETE (M) | /annexure-templates/:key | resets the org override to the system template |
| POST (W) | /workspaces/:id/annexures/:key/preview | `{title, body}` → rendered PDF of an unsaved draft (same `unknown_placeholder` check) |
| GET | /workspaces/:id/annexures/:key.pdf | rendered annexure PDF |
| GET | /workspaces/:id/packets | newest first (max 50) |
| POST (W) | /workspaces/:id/packets | `{items: PacketItem[]}` (optional, default order) → 201 `Packet` (merged PDF built). If the stored sizes of the selected documents exceed `PACKET_MAX_INPUT_BYTES` nothing is loaded or created: 413 `packet_too_large` (`details:{totalBytes,limitBytes,items:[{title,sizeBytes}]}` — the 10 largest). A failed build is 500 `packet_build_failed` (`details.packet`). Rate limited (`rate_limited`, per org) |
| GET | /packets/:id/download | merged PDF |
| GET | /assist/:workspaceId | session or Bearer token → `{tender:{bidNumber,title}, fields:[{key,label,value,selectorHints[]}], documents:[{title, fileName, url}], humanSteps:[...]}` — never includes price |
| PUT (W) | /workspaces/:id/assist-values | `{[key]: value}` (an empty value removes the key) → `{assistValues}`; price-like keys are 400 `forbidden_field` (`details:{fields,forbidden}`), other invalid values 400 `validation_error` |
| POST (W) | /workspaces/:id/submitted | `{submittedAt?: ISO datetime, note?}` → the workspace in stage `submitted` with `submittedAt` (default now). Informational only: open checklist blockers are logged (`openBlockers`), not refused. 409 `conflict` when the bid already has an outcome (`won`/`lost`) or was `dropped` |
| GET (W) | /tenders/:id/result-hint | optional L1 price hint from GeM's public result page → `BidResultHint` (`{available:false, reason}` when GeM has none, e.g. `no_gem_id`). Requires a workspace for the tender (404 otherwise); cached 15 min per GeM bid, 20 lookups/org/hour then 429 `rate_limited`. Refused for read-only tokens (`read_only_token`) because it has side effects |

Apply error codes (all use the standard error envelope):

| Code | Status | When |
|---|---|---|
| `invalid_transition` | 409 | PATCH `/workspaces/:id` to `won`/`lost` (stage or outcome) before the bid was submitted. "Record the submission on GeM first — a bid can only be won or lost after it was submitted." (006/FR-008) |
| `not_ready` | 409 | Moving to `ready` while mandatory checklist items are missing/expired and not overridden; `details.blockers` lists them (006/FR-005) |
| `nothing_to_override` | 409 | Override of an item that is not missing or expired (e.g. present and valid, or any other state) (006/FR-027) |
| `unknown_placeholder` | 400 | Annexure template or preview body contains a `{{placeholder}}` that is not supported (006/FR-041) |
| `forbidden_field` | 400 | Assist values containing a price-like key (never entered on GeM) |
| `packet_too_large` | 413 | Selected packet documents exceed the input budget (006/FR-056) |
| `packet_build_failed` | 500 | The merged PDF could not be built |
| `read_only_token` | 403 | A non-GET/HEAD request, or a GET with side effects, with a `scope:"read"` API token; message "This API token is read-only" (006/FR-074) |

Token scope (006/FR-074): `POST /me/api-tokens` accepts `scope: "full" | "read"` (default `full`; fixed at creation, session-only so a token can never mint a broader one). `GET`/`HEAD` work with either scope; every other method needs `full`. An unknown or missing stored scope is treated as read-only (fails closed). Cookie sessions are never affected.

## Dashboard & demo — owner: Experience module (`routes/dashboard.ts`, `routes/demo.ts`)

Types: `packages/core/src/contracts/experience.ts` (007). All Experience endpoints use the standard error envelope.

| Method | Path | Notes |
|---|---|---|
| GET | /dashboard | viewer+. `DashboardResponse`: `{generatedAt, tiles:{newMatchesToday, closingThisWeek, activeBids, emdAtStake, winRate, expiringDocs}, stats, closingSoon[], pipeline:{[stage]:n}, pipelineValue:{[stage]:₹}, verdicts:{go,review,no_go}, matchesByDay:[{date,count}], recentMatches[], expiringDocuments[], activity[], setup:[{key,label,description,done,href}], setupComplete, demo, myWork?, awaitingDecision?}`. See the two persona lists below |
| POST (M) | /demo/seed | bid_manager+. Seeds the demo company profile (never over a non-empty profile), vault docs (real one-page PDFs), watchlists, matches, analyses, workspaces and past contracts into the current org. Idempotent. `DemoSeedResponse` `{ok:true, created, tenders, watchlists, matches, analyses, workspaces, vaultDocuments, pastContracts}`: **201** when it created data, **200** with `created:false` on a repeat. Sets `onboardingState.demo = true` (via `jsonb_set` inside the seed transaction, so a concurrent onboarding save is not lost). Logs `demo.seeded` with `meta.watchlistIds` (the ids of the three demo watchlists — the removal's provenance record) |
| DELETE (M) | /demo | bid_manager+ (viewer/analyst 403). Removes the demo rows of the current org in one transaction (comments, packets/annexures of demo workspaces, workspaces, analyses, matches, demo watchlists, demo notifications, activity with `meta.demo`, seeded past contracts and vault documents; blobs are deleted after commit and a blob failure is logged, not fatal). User-created rows are kept, including a user-created workspace on a real (non-demo) tender. Demo **tenders** are global and stay. Resets the company profile only while it still holds the demo company. Sets `onboardingState.demo = false` and logs `demo.removed` (not marked `meta.demo`, so it survives later removals) — both inside the transaction. Idempotent: a repeat answers all zeros and logs nothing. Seed and removal lock the same org row so they never interleave. Response `DemoRemoveResponse` `{ok:true, removed:{workspaces, analyses, matches, comments, notifications, activity, pastContracts, vaultDocuments, watchlists, profileReset}}` — `profileReset` is a boolean **inside** `removed` |

### `GET /dashboard` — persona lists (007/FR-070)

Both arrays hold at most 5 items (`MY_WORK_LIMIT`), are computed for the signed-in user, and are scoped to the active org (Constitution IV). They are optional in the type; the API always sends them (possibly `[]`). Role gating is a UI concern (viewers do not see the widgets); the API returns the lists to any role.

- `myWork: MyWorkItem[]` — workspaces the caller **owns or is assigned to** (`owner_id = me` or `assignee_ids @> [me]`) whose stage is **not** `won`, `lost`, `dropped` **or `submitted`** (a submitted bid is no longer "to do"). Order: `dueAt` ascending, nulls last, then tender `endAt` ascending, then workspace id.
  `MyWorkItem` = `{workspaceId, tenderId, bidNumber, title, stage, dueAt, endAt, readiness:{percent, blockers, analysed}}`. `readiness` comes from the same helper as the pipeline cards (`readinessFor`), so the percentage matches the card: `percent` 0–100, `blockers` = number of open blockers (mandatory checklist items missing/expired and not overridden), `analysed:false` (percent 0) while the tender has no finished analysis.
- `awaitingDecision: DecisionItem[]` — workspaces in stage `analysing` whose **latest** analysis for the tender is `done`; oldest-waiting first (analysis `updated_at`, then workspace `created_at`, then id).
  `DecisionItem` is **flat**: `{tenderId, workspaceId, bidNumber, title, score, verdict, endAt}` (`score` 0–100 or null, `verdict` `go|review|no_go` or null). There is no nested `analysis` object. `workspaceId` is typed `string | null`; the current query always sets it.
  The web turns a decision into `PATCH /workspaces/:id {stage:'go'}` (one tap, no dialog) or `{stage:'dropped'}` (after a confirmation dialog). The API enforces it (#527): a move into `go`/`dropped` is bid_manager+, an Analyst gets 403 `forbidden`; every other move stays analyst+ per the workspace contract.

### `PATCH /org` — onboarding state (007/FR-048, FR-052)

`updateOrgInputSchema.onboardingState` is `Record<string, boolean>` with a refinement (not a closed object), so unknown keys reach the refinement and are reported on the field:

- Allowed keys (`ONBOARDING_KEYS`): `company`, `categories`, `watchlist`, `documents`, `skipped`, `completed`, `demo`. At most 16 keys per request. Values must be booleans.
- Violations answer **400 `validation_error`** with `details.fields.onboardingState` = `"Unknown onboarding key: <first bad key>"` or `"At most 16 onboarding keys"`; nothing is written.
- Valid keys are **merged** in SQL (`coalesce(onboarding_state,'{}') || patch`), never replaced, so concurrent PATCHes of different keys do not overwrite each other. Ticks are not written to the activity feed.
- **`onboarding.completed` activity** (entityType `organization`, `meta:{durationSec}` = seconds from organisation creation to the flip): written exactly once, by the request whose conditional `UPDATE … WHERE completed is not true` flips `completed` to true (concurrent or repeat requests do not log again). This is how SC-001 is measured from data.
- Other changes (`name`, `scoringWeights`) still log `org.updated` with `meta.fields`.

### Tender DTOs — `isDemo` (007/FR-067)

`TenderCore.isDemo: boolean` (in `packages/core/src/contracts/identify.ts`) is on every tender DTO (list items and detail). It is true when `tenders.source = 'demo'` or the stored payload carries `raw.demo === true` (the list query does not select `raw`, so `source` decides there). The web shows a "Sample" badge in the feed (card and table) and on the tender page. Demo tenders are visible only to orgs that loaded the demo (008/FR-016).

## Operator — owner: Ops (`routes/admin.ts`, spec 008 FR-042)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /admin/orgs/:id/plan | `{plan:'trial'\|'starter'\|'pro'\|'enterprise', note, trialEndsAt?}` | `Authorization: Bearer <ADMIN_TOKEN>` only (never a member session). `{org:{id,plan,trialEndsAt}, subscriptionId}`; a paid plan clears `trialEndsAt`; writes a `subscriptions` row and the `org.plan_changed` activity. Without `ADMIN_TOKEN` configured, with a wrong token or an unknown org → the generic 404 |

## Scheduled (Worker `scheduled`, also `POST /ingestion/run`)

1. `runIngestion()` — fetch N pages, upsert tenders, record events, match watchlists, create notifications.
2. `dispatchNotifications()` — send pending email/WhatsApp (skipped when not configured), daily digests.
3. `runExpiryReminders()` — 30/7/1-day and on-expiry vault reminders (deduped per document, expiry date and threshold; also `POST /vault/reminders/run` per org).

## Error codes for limits and capacity (spec 008, FR-018, FR-021, FR-040)

Built with the helpers in `apps/api/src/lib/errors.ts`. Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts`.

| Status | Code | When | `details` |
|---|---|---|---|
| 402 | `plan_limit_reached` | a plan limit (seats, watchlists, analyses, vault bytes, packets) is reached; `enterprise` is never limited (`PLAN_LIMITS`, `packages/core/src/contracts/plans.ts`) | `{limit, used, max, plan, resetsAt?}` (`resetsAt` = next IST month start, monthly limits only) |
| 402 | `plan_expired` | the free trial has ended: every write except the FR-038 allow-list (auth, own account/sessions, revoking an API token, marking notifications read, notification prefs, `DELETE /demo`, `POST /tenders/:id/seen`, leaving the org `DELETE /org/members/me`, revoking an invitation `DELETE /org/invitations/:id`, and the operator-only `/admin/*`); reads keep working | `{plan:'trial', trialEndsAt}` |
| 413 | `payload_too_large` | body over its cap: JSON 1 MB, vault 20 MB, tender documents 25 MB (+64 KB multipart); rejected before the body is read | `{maxBytes}` |
| 413 | `packet_too_large` | packet would exceed 40 MB or 40 items | – |
| 422 | `document_too_long` | tender document over 300 pages (refused before any text is read; 151–300 pages are accepted, first 150 read, `pages_truncated` warning) | – |
| 422 | `scanned_document` | tender document has no extractable text | – |
| 429 | `rate_limited` | a rate-limit rule is over its limit; header `Retry-After: <s>` | `{rule, retryAfter}` |
| 429 | `sync_cooldown` | manual "Sync now" within the cooldown | `{retryAt}` |
| 503 | `gem_busy` | the cluster-wide GeM slot could not be had in time | – |
| 503 | `service_unavailable` | an auth rate limiter could not be checked (auth rules fail closed) | `{reason}` |
