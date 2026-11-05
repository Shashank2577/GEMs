# API Contract — TenderPilot

All endpoints are under `/api`, JSON in/out (multipart for uploads), errors as
`{ "error": { "code": string, "message": string, "details"?: unknown } }` with proper HTTP status.
Auth: httpOnly cookie `tp_session` (web) or `Authorization: Bearer tp_…` API token (extension).
The active organization comes from the session (`sessions.active_org_id`). Roles:
`owner > bid_manager > analyst > viewer`. "W" = requires at least analyst (write), "M" = bid_manager+, "O" = owner.
List endpoints return `{ items, total }` and accept `page` (1-based) and `pageSize` (default 25, max 100).
Money is integer rupees. Dates are ISO-8601 strings; the UI renders IST.
`Me` (`packages/core/src/contracts/auth.ts`; returned by sign-up, login, accept-invite and `GET /auth/me`) carries
`{user, org:{id,name,slug,plan,onboardingState,scoringWeights,trialEndsAt}, role, orgs}`. `org.trialEndsAt` (ISO string,
008/FR-035) is set at sign-up to created + 14 days and is `null` for paid plans; `GET /org` returns the same field.

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
| GET | /health | – | Health v2 (008/FR-044; no auth, platform-wide aggregates only, never org data): `{ok, db, version, ingestion:{lastSuccessAt, ageMinutes, lastStatus, state:'ok'\|'stale'\|'never'}, alerts:{pendingOlderThan30m}, reasons:HealthReason[]}`. `reasons` ⊆ `db_unreachable`, `ingestion_stale` (last successful sync, success or partial runs, older than `HEALTH_INGESTION_MAX_AGE_MIN`, default 120), `alerts_backlog` (email/WhatsApp rows pending > 30 min; held daily-digest rows count only once their slot is overdue). **200** when `reasons` is empty, **503** with the same body otherwise, so an external uptime monitor needs no body parsing. `ingestion_stale` is also raised when runs exist but none succeeded and the first run is older than the threshold. Each query has a 3 s budget; if any query is slow or fails, the whole body is the unreachable report (`db:false`, `reasons:["db_unreachable"]`, `ingestion.state:'never'`, `alerts.pendingOlderThan30m` 0), not just `db:false`. A fresh stack with no ingestion run yet is `state:'never'` and healthy. Exempt from the `api.ip` rate limit |

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

## Identify — owner: Identify module (`routes/tenders.ts`, `routes/watchlists.ts`, `routes/views.ts`, `routes/ingestion.ts`, `routes/notifications.ts`, `routes/insights.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | /tenders | `q` is full-text over bid number, title, category, ministry, department, organisation, buyer office, state, city and item names (008/FR-073; `websearch_to_tsquery` syntax: `"phrase"`, `or`, leading `-word`; every word is a prefix match; ASCII punctuation separates words, so `2062` finds `IS-2062`; bid numbers also match by prefix, and a query shaped like a bid number, e.g. `GEM/2026/B/12`, uses only the prefix match). Other params: `q,state,ministry,category` (comma-separated or repeated),`status(open\|closed\|cancelled\|awarded\|all),closingWithinDays,minValue,maxValue,matched(0/1),watchlistId,verdict(go\|review\|no_go\|none),stage,bidType,unseen(0/1),includeDismissed(0/1),sort(endAt\|-endAt\|-createdAt\|score\|-score\|value\|-value\|relevance),page,pageSize(≤100, default 25)` → `{items: TenderListItem[], total, facets:{states,ministries,categories}}`; a facet ignores its own filter. `TenderListItem` = tender core fields (never `raw` or `content_hash`) + `{isDemo, matches:[{watchlistId,watchlistName,reasons,relevance,createdAt}], analysis?:{score,verdict}, workspace?:{id,stage}, seen, isNew}`. Tenders are global; matches, analysis, workspace and seen/dismissed are the caller's org only |
| GET | /tenders/:id | `TenderDetail` = tender + `events` + `documents` + `matches` + `analysis` (latest for org) + `workspace`; 404 for an unknown id (and for demo tenders in an org that never loaded the demo) |
| POST | /tenders/:id/seen, /tenders/:id/dismiss | seen marks this org's matches seen and clears the user's related in-app alerts; dismiss takes `{undo?: boolean}` and hides the tender from the org's feed (`includeDismissed=1` shows it) |
| GET | /tenders/:id/result | any member of an org that can see the tender (404 otherwise, incl. another org's demo tender). Public GeM result data (003/FR-062, built in US6) → `TenderResultDto` `{tenderId, tenderStatus, evaluationStatus:'not_evaluated'\|'technical_evaluated'\|'financial_evaluated'\|'awarded', evaluationLabel, bidders:[{rank, seller, price (₹), level:'L1'…, awarded}] (by rank), winner, lowestPrice, anomalies:[{code:'winner_not_lowest_price', message}], categories, sourceUrl, fetchedAt, checkedAt, lastCheck:'ok'\|'not_listed'\|'unreadable'\|'unreachable', lastCheckFailed (= lastCheck≠'ok', kept for compatibility), checkUntil}`. Always 200: before GeM publishes, `bidders:[]` with the last known `evaluationStatus` (never checked → `not_evaluated`, `checkedAt:null`) |
| GET | /insights/competitors | any member. `category?, state?, page, pageSize≤100` → `CompetitorsResponse` `{items:[{seller, wins, awardedValue, bids, categories[≤5], anomalies, lastWinAt}], total, tenders, flaggedAwards, facets:{categories, states}}` (003/FR-064, built in US6). Org-scoped: only the caller's org's tracked tenders (non-dismissed match, analysis or workspace) that GeM awarded with a published bidder table; sellers ranked by wins, then awarded value. 400 `validation_error` on bad paging |
| GET/POST | /watchlists | criteria per `WatchlistCriteria`; POST (Analyst+) → 201. At most 50 watchlists per org, paused ones included, and fewer on a plan with a lower limit (`starter`: 5, `PLAN_LIMITS` in `packages/core/src/contracts/plans.ts`; over a plan limit POST answers 402 `plan_limit_reached`): 409 `watchlist_limit` "You can have up to 50 watchlists — delete one first." (`details:{limit}`) (003/FR-027) |
| PATCH/DELETE (W) | /watchlists/:id | – |
| POST | /watchlists/preview | `{criteria}` → `{count, sample: TenderListItem[] + previewReasons}`; every candidate is scanned (no silent cap, 003/FR-028); 30 requests/min/user then 429 `rate_limited` |
| GET | /views | Saved feed views of the caller (personal: scoped to org + user) → `{items: SavedView[], total, limit}` (`limit` = 20), ordered by `position` (003/FR-035) |
| POST | /views | `{name (1–40 chars), params: Record<string,string[]>}` → 201 `SavedView = {id,name,params,position,createdAt,updatedAt}`. 409 `view_exists` for a duplicate name (per user), 409 `view_limit` (`details:{limit:20}`) at 20 views |
| PATCH/DELETE | /views/:id | PATCH `{name?, params?}` → `SavedView` (409 `view_exists`); DELETE → `{ok:true}`. Another user's or org's view is 404, never 403 |
| POST (M) | /ingestion/run | `{pages?, search?}` → `IngestionRun` (runs inline, matches, queues alerts, then dispatches instant alerts). 429 `sync_cooldown` (`details:{retryAt}`, message "GeM was synced moments ago. Next manual sync at <time> IST.") for `MANUAL_SYNC_COOLDOWN_MIN` minutes (default 10; 008/FR-026 raised the 2 minutes of 003/FR-013) after a finished manual run of any org, with no request to GeM. 409 `ingestion_running` (`details.run`) when a sync is already running (also a run held by cron or another isolate: single running slot, 008/FR-025). |
| GET | /ingestion/runs | `{items: IngestionRun[] (latest 20), lastSuccessAt, lastRun, totalTenders, openTenders (both real tenders only, no demo rows; 008/FR-016), nextManualSyncAt \| null, manualSyncCooldownMin}` |
| GET | /notifications | `unread?(0/1), kind?, page?, pageSize?` → `{items, unreadCount, total}`; `kind` is one of `tender_match, expiry, deadline, assignment, mention, digest, system, corrigendum, result` (`NOTIFICATION_KINDS`; `?kind=corrigendum` is accepted), anything else is 400 `validation_error` (003/FR-049). Each in-app row carries its email/WhatsApp `deliveries` |
| POST | /notifications/:id/read, /notifications/read-all | – |
| GET | /notifications/unsubscribe?token= | Public, no side effect: confirmation page whose button POSTs back (RFC 8058, 003/FR-048) |
| POST | /notifications/unsubscribe?token= | Public; the signed `token` (HMAC of user, org, `email_matches`; does not expire) is the credential. Sets that user's `notification_prefs.email = false` for the org and marks their queued email rows `skipped` ("unsubscribed"). Idempotent. One-click mail clients (`List-Unsubscribe=One-Click`) get `{ok:true,email:false}`, the page's form gets HTML. Tampered token, or the user left the org: 400 `invalid_token`. Alert emails carry `List-Unsubscribe` and `List-Unsubscribe-Post` headers |

Delivered: 003 US5 (corrigendum and cancellation alerts, FR-052..055, T060–T065). Planned, not built yet (003 US6, tasks T066–T076; no route, table or column exists on `main`: `tender_results`, `ingestion_runs.kind`):

- `GET /tenders/:id/result` *(planned, US6, FR-062)*: the stored GeM result for the tender, or `evaluationStatus` with an empty bidder list; reads `tender_results`.
- `GET /insights/competitors?category=&state=` *(planned, US6, FR-064)*: wins, awarded value and categories per competitor aggregated from `tender_results`.

### Identify error codes

| Code | Status | When |
|---|---|---|
| `sync_cooldown` | 429 | A manual sync was requested within the cooldown after a finished manual run; `details.retryAt` is the ISO time the next one is allowed (003/FR-013, 008/FR-026) |
| `ingestion_running` | 409 | A sync is already running (cluster-wide single flight) |
| `watchlist_limit` | 409 | The org already has 50 watchlists (003/FR-027) |
| `view_limit` | 409 | The user already has 20 saved views (003/FR-035) |
| `view_exists` | 409 | The user already has a saved view with that name |
| `invalid_token` | 400 | Unsubscribe token tampered, unknown, or the user is no longer in the org (003/FR-048) |

Notification kinds (`NOTIFICATION_KINDS`, all 9): `tender_match, expiry, deadline, assignment, mention, digest, system, corrigendum, result`.
`corrigendum` is delivered (003/FR-053, US5): amendment and cancellation alerts. `result` is accepted by the filter and the enum but nothing
emits it until US6 (planned).

## Analyse — owner: Analyse module (`routes/analysis.ts`, `services/analyse.ts`, `services/staleness.ts`)

Types: `packages/core/src/contracts/analyse.ts` (004). Every route is scoped to the session's organization and uses the standard error envelope. Role gates: `viewer+` = any signed-in member, `analyst+`, `bid_manager+`. Tender documents fetched from GeM (`orgId = null`) are shared by all orgs; uploads belong to the uploading org (another org's upload is 404).

| Method | Path | Notes |
|---|---|---|
| GET | /tenders/:id/documents | viewer+. `{items: TenderDocumentDto[], total}` — the shared GeM copies plus this org's uploads (text omitted) |
| POST (W) | /tenders/:id/documents | analyst+, multipart `file` (PDF sniffed from bytes, ≤ 25 MB) + `kind` (`bid`\|`atc`\|`corrigendum`\|`boq`\|`other`, default `bid`) → 201 `UploadTenderDocumentResponse` = `TenderDocumentDto` + `warnings: TenderDocumentWarning[]`. Text is extracted (first 150 pages) on upload; a scanned PDF is accepted with `hasText:false`; a PDF over 300 pages → 422 `document_too_long`. Marks this org's analyses of the tender stale (`document_added`). Rate limited (`upload.org`) |
| POST (W) | /tenders/:id/fetch-documents | analyst+. Downloads the GeM bid document once → `{items, total, fetched}`: **201** when a copy was stored, **200** (`fetched:0`) when the stored copy is returned ("already here"). A corrigendum that changed the tender's `documentUrl` after the stored copy was fetched triggers a re-download as kind `corrigendum` (the earlier copy is kept) and marks every org's analyses of the tender stale (`corrigendum`). `?refresh=1` forces a re-download even when the URL is unchanged; a forced copy whose text hashes the same as a stored one stores nothing (200), while one that stores a new copy also marks every org's analyses of the tender stale (`corrigendum`). Rate limited (`gem.fetch.org`) |
| DELETE (W) | /tenders/:id/documents/:docId | analyst+. Removes one of this org's uploads → 204; the delete, the `tender.document_removed` activity row and the stale flag (`document_removed`) commit together. A GeM-fetched document → 403 `forbidden`; unknown/other-org id → 404 |
| POST (W) | /tenders/:id/documents/:docId/ocr | analyst+ (004/FR-052). Transcribes a document with `needsOcr:true` (a scan by 008/FR-030) with the OCR model: the PDF is split lazily into parts of ≤ 5 pages (≤ 30 calls of ≤ 90 s and ≤ 16,000 output tokens each, 10-minute budget, first 150 pages; `pageCount`/`totalPages` unchanged), the text is stored with `textSource:'ocr'` → 200 `TenderDocumentDto`. The update, the `tender.document_ocr` activity row and the stale flag (`document_added`; every org's analyses when the document is a shared GeM copy) commit together. Requirements read from OCR text carry `source.ocr:true` and confidence ≤ 0.8. Each run takes **one monthly AI slot** (`llmAnalysesPerMonth`, its own `analysis_ref`, ADR-0008 amendment); a run that reached the model keeps it even when it fails, a run that never reached it gives it back. `?force=1` re-reads an **org-owned upload** whose text already came from OCR and replaces it (same locks, stale flag, metering; activity `meta.force:true`): bid_manager+ (analyst → 403); on a shared GeM copy (`orgId:null`) → 403 `forbidden` "Shared GeM documents are read once for all organisations and cannot be re-read with AI OCR. Upload your own copy of the PDF to read it again." (its first OCR is allowed). On a document that still needs OCR the flag is ignored (any analyst+ may send it). One OCR run per document at a time: a second run — manual or analyse's automatic one, from any org — while one is reading it → 409 `conflict` "This document is already being read with AI OCR. Wait a minute and reload." before any AI slot is reserved or any model call made. Unknown/other-org document, or one removed while it was being read → 404; already has text (or OCR text without `force`) or changed by a concurrent run → 409 `conflict`; no OCR model → 503 `ocr_unavailable`; AI slots used up → 402 `plan_limit_reached` (`details.limit:'llmAnalysesPerMonth'`); provider/parse failure, a reply that leaves out any page (an explicitly blank page is fine) or no text at all → 502 `ocr_failed` and nothing is stored. Rate limited (`ocr.org`) |
| GET | /tenders/:id/documents/:docId/download | viewer+. Streams the PDF; `?inline=1` for in-browser preview. `cache-control: private, no-store`, `x-content-type-options: nosniff` |
| POST (W) | /tenders/:id/analyse | analyst+. Reads every bid document (auto-fetches from GeM when there are none and the tender has a GeM link), extracts requirements by rules (+ LLM when a key is configured and the budget/quota allow), scores and builds the checklist → 201 `AnalysisDto` (`method:'rules'\|'rules+llm'`); the response `documents` lists only the documents that were read (skipped scanned PDFs are not listed, unlike `GET …/analysis`). The auto-fetch swallows its errors except 503 `gem_busy` and 422 `document_too_long`, which analyse surfaces; with no documents and no GeM link it returns 422 `no_documents`. Rate limited (`analyse.user`). A running analysis for the tender → 409 `analysis_running`; one that exceeded the run timeout and was replaced while this request was finishing → 409 `analysis_superseded` |
| GET | /tenders/:id/analysis | viewer+. The latest **done** `AnalysisDto` (with `documents` — including skipped scanned PDFs — and the manual overrides applied), or 404 `not_found` when the tender was never analysed. A newer attempt that is still running or failed is reported in `lastAttempt`; a first-ever run that failed or timed out returns that attempt as the DTO itself (`status:'failed'`) with `lastAttempt`, and a first-ever run that is still running is likewise returned as the DTO itself (`status:'running'`) |
| POST (M) | /analyses/:id/override | bid_manager+. `{factorKey, status, reason}` (`reason` 3–500 chars) → the re-scored analysis in the same shape as `GET …/analysis`. `status` equal to the computed one removes the override. 409 `conflict` unless the analysis is `done`; 409 `analysis_replaced` when a newer analysis exists; an unknown `factorKey` → 400 `validation_error` (a 404 for a key outside the analysis is practically unreachable) |
| POST (W) | /analyses/:id/rescore | analyst+. Recomputes factors, score, verdict and checklist from the **stored** requirements with the current profile, vault, past contracts and weights; keeps overrides and clears `stale`/`staleReason`/`staleAt`. Same body as `GET …/analysis`. 409 `conflict` unless `done`; 409 `analysis_running` while an analysis is running for the tender; 409 `analysis_replaced` when a newer analysis exists; 409 `reanalysis_required` when the stale reason is a document change (`corrigendum`, `document_added`, `document_removed`) or unknown — use `POST …/analyse` instead |
| GET/PUT (M) | /scoring-weights | GET viewer+: `ScoringWeights` = `{weights, defaults, custom}`. PUT bid_manager+: partial map factor → 0–100 (`{}` resets to defaults), at least one weight > 0 else 400 `validation_error`; marks the org's analyses of open tenders stale (`weights_changed`) → `ScoringWeights` |

### DTOs

- `TenderDocumentDto` = `{id, tenderId, orgId (null = GeM), kind, fileName, sizeBytes, pageCount, totalPages, sourceUrl, hasText, needsOcr, source:'gem'\|'upload', textSource:'pdf'\|'ocr', bidNumberFound, createdAt}`.
  - `pageCount` = pages read (capped at 150, 004/NFR-005); `totalPages` = the PDF's real page count (`totalPages > pageCount` means it was truncated; `null` for rows that predate the column).
  - `hasText:false` = no text layer (scanned). `textSource` is `'pdf'` for a text layer and `'ocr'` once the text was transcribed by AI OCR (004/FR-052).
  - `needsOcr:true` = analysis cannot read it as it is: ≥ 80% of its pages have no text (008/FR-030) and it was not transcribed yet. The web offers "Read with AI (OCR)" and the unreadable notice on this flag, not on `hasText`.
  - `bidNumberFound` = the bid number printed on page 1 when it differs from the tender's, else `null`.
- `TenderDocumentWarning` (upload response only, non-blocking, FR-010): `{code:'bid_number_mismatch', found}` and `{code:'pages_truncated', analysed, total}`.
- `Requirement.needsReview?` (string) = the escalation model (004/FR-050) disagreed with a rule-read requirement but could not displace it (its quote was not found on the cited page, or it was less confident than the rule): what it read instead, shown as "Check this" in the requirements table. Never scored.
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
| `conflict` | 409 | Override or re-score of an analysis that is not `done`; OCR of a document that already has text (004/FR-052) |
| `no_documents` | 422 | Analyse with no bid document and nothing to auto-fetch, including a tender with no GeM link ("Add the bid document first") |
| `no_gem_document` | 422 | Fetch for a tender without a GeM document link (never returned by analyse) |
| `document_too_long` | 422 | A PDF over 300 pages, on upload, fetch or the auto-fetch inside analyse |
| `scanned_document` | 422 | Every document of the tender is a scan without a text layer (008/FR-030); `details.documents` lists the file names. A mix analyses the readable ones and adds a `notes` entry per skipped scan. With an OCR model, analyse first transcribes scans itself (≤ 4 OCR calls = 20 pages, whole documents, inside the analysis budget and counted in its 8-call cap, 004/FR-052); a scan whose OCR failed stays skipped (`details.ocrFailed` lists it when nothing else was readable), is recorded as `tender.document_ocr_failed` and is not OCR'd by analyse again (only `POST …/ocr` retries it) |
| `unreadable_pdf` | 422 | Upload or GeM download that cannot be parsed (damaged or password-protected) |
| `unsupported_media_type` | 415 | Upload is not a PDF |
| `payload_too_large` | 413 | Upload larger than 25 MB (checked before the body is read, 008/FR-021) |
| `bad_request` | 400 | Empty file |
| `validation_error` | 400 | Missing `file`, unknown `kind`, invalid override or weights body |
| `ocr_failed` | 502 | `POST …/documents/:docId/ocr`: the OCR model failed, refused, was cut off, timed out or returned no text (004/FR-052) |
| `ocr_unavailable` | 503 | `POST …/documents/:docId/ocr` without an OCR model (`GET /analysis/capabilities` → `ocr:false`) |
| `gem_unavailable` | 502 | GeM could not be reached, no longer serves the document (404), or the document exceeds 25 MB |
| `gem_busy` | 503 | The cluster-wide GeM request slot (1 request/s) was not free within 25 s (008/FR-024); also surfaced by analyse's auto-fetch |
| `rate_limited` | 429 | `upload.org`, `gem.fetch.org` or `analyse.user` limit reached |
| `forbidden` | 403 | Role too low, or removing a GeM-fetched document |
| `analysis_failed` | 500 | The run failed unexpectedly; the previous result (if any) stays and is reported with `lastAttempt` |

### US7: AI enrichment and OCR (004/FR-052, FR-053)

- `POST /tenders/:id/documents/:docId/ocr` — see the route table above. No body. Success → 200 `TenderDocumentDto` with `textSource:'ocr'`. Calls are metered as `extract` usage under the run's own `analysis_ref` without an analysis (008/FR-039), so one run = one monthly AI slot; OCR run inside `POST …/analyse` is metered under the coming analysis's id (`analysis_ref`, no foreign key, so deleting an analysis does not give its AI slot back) and shares that analysis's slot, which is reserved under the org row lock before the first OCR call (no OCR when the slots are used up); if the analysis then never starts (409/422/402), OCR rows whose text was stored keep one slot under a fresh `analysis_ref` (like a manual run), and otherwise they keep their tokens but lose the `analysis_ref`, so they hold no slot. A scan whose automatic OCR failed — including running out of the analysis's time — is recorded as `tender.document_ocr_failed` and not OCR'd by analyse again; one another OCR run is reading is skipped with a note. Messages: `ocr_unavailable` "AI OCR is not set up. Upload the text PDF from GeM, or ask your admin to enable AI OCR."; `ocr_failed` "AI OCR could not read this document. Try again in a few minutes, or upload the text PDF from GeM."
- `GET /analysis/capabilities` (viewer+, any signed-in user) → `{ai:boolean, ocr:boolean, models:{enrichment?, ocr?, escalation?}}`. `ai` = an LLM key is configured; `ocr` = an OCR model is available; `models` holds model ids only (never keys) and omits tiers that are not configured. Not cached server-side; the web client caches it for 5 minutes.
- Error codes `ocr_unavailable` (503) and `ocr_failed` (502): see the table above. Neither carries `details`.

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
2. `runDailyResults()` (003/US6, FR-061) — first tick at/after 10:00 IST, once per IST day (`job_runs` claim): checks ≤ 50 tracked tenders closed within 30 days and not checked in 24 h on GeM's submitted-bids search and result view, stores `tender_results`, marks awarded tenders (`awarded` event) and sends in-app `result` alerts; recorded as an `ingestion_runs` row of `kind = 'results'` (not listed by `GET /ingestion/runs`).
3. `dispatchNotifications()` — send pending email/WhatsApp (skipped when not configured), daily digests.
4. `runExpiryReminders()` — 30/7/1-day and on-expiry vault reminders (deduped per document, expiry date and threshold; also `POST /vault/reminders/run` per org).

## Error codes for limits and capacity (spec 008, FR-018, FR-021, FR-040)

Built with the helpers in `apps/api/src/lib/errors.ts`. Rate-limit rules: `apps/api/src/lib/rate-limit-rules.ts`.

| Status | Code | When | `details` |
|---|---|---|---|
| 402 | `plan_limit_reached` | a plan limit (seats, watchlists, analyses, vault bytes, packets) is reached; `enterprise` is never limited (`PLAN_LIMITS`, `packages/core/src/contracts/plans.ts`) | `{limit, used, max, plan, resetsAt?}` (`resetsAt` = next IST month start, monthly limits only) |
| 402 | `plan_expired` | the free trial has ended: every write except the FR-038 allow-list (auth, own account/sessions, revoking an API token, marking notifications read, notification prefs, `DELETE /demo`, `POST /tenders/:id/seen`, leaving the org `DELETE /org/members/me`, revoking an invitation `DELETE /org/invitations/:id`, and the operator-only `/admin/*`); reads keep working | `{plan:'trial', trialEndsAt}` |
| 409 | `ingestion_running` | `POST /ingestion/run` while another listing ingestion run is `running` (unique partial index `ingestion_runs_one_running_uq`, one running run per `kind`) | `{run}` |
| 413 | `payload_too_large` | body over its cap: JSON 1 MB, vault 20 MB, tender documents 25 MB (+64 KB multipart); rejected before the body is read | `{maxBytes}` |
| 413 | `packet_too_large` | the packet has more than 40 items (`PACKET_MAX_ITEMS`), or the stored sizes of the selected documents exceed `PACKET_MAX_INPUT_BYTES` (40 MB on the Worker; 006/FR-056's 60 MB code default on Node). Checked before any document is loaded | item count: `{items, maxItems}`; size: `{totalBytes, limitBytes, items:[{title,sizeBytes}]}` (10 largest) |
| 422 | `document_too_long` | tender document over 300 pages (`MAX_TENDER_DOC_PAGES`; refused before any text is read; 151–300 pages are accepted, first 150 read, `pages_truncated` warning); on upload, GeM fetch and analyse's auto-fetch | `{pages, maxPages}` |
| 422 | `scanned_document` | every document of the tender is a scan without a text layer (analyse only; an upload of one is accepted with `hasText:false`) | `{documents}` (file names) |
| 429 | `rate_limited` | a rate-limit rule is over its limit; header `Retry-After: <s>`. Rules live in one table, `apps/api/src/lib/rate-limit-rules.ts` (exception: `POST /me/notifications/test`, 1/min per user, spec 002 limiter `lib/rate-limit.ts`; its 429 currently reports `details.rule: "auth.fail.email"`, issue #559): `auth.fail.email` 10/15 min, `auth.fail.ip` 30/15 min, `auth.signup.ip` 20/h, `auth.reset.email` 3/h, `auth.reset.ip` 20/h, `watchlist.preview.user` 30/min, `upload.org` 120/h, `gem.fetch.org` 30/h, `analyse.user` 30/h, `packet.org` 30/h, `api.user` 600/min (token or user), `api.ip` 300/min (unauthenticated). Aligned fixed windows (a client can burst up to twice a limit across a boundary); per-IP rules apply only when the client IP is known (`TRUST_PROXY`). When several counters are over, the binding one (longest `Retry-After`) is named | `{rule, retryAfter}` |
| 429 | `sync_cooldown` | manual "Sync now" within the cooldown (`MANUAL_SYNC_COOLDOWN_MIN`, default 10 min, cluster-wide); no GeM request is made | `{retryAt}` |
| 503 | `gem_busy` | the cluster-wide GeM request slot (`gem_throttle`, 1 request/s across all isolates) was not free within 25 s; also surfaced by analyse's auto-fetch | `{maxWaitMs}` |
| 503 | `service_unavailable` | an auth rate limiter could not be checked (auth rules fail closed) | `{reason}` |

### Plan limits (`PLAN_LIMITS`, `packages/core/src/contracts/plans.ts`; 008/FR-034)

Returned as `limits` by `GET /org/usage`; `null` = no plan limit. Monthly counters reset at 00:00 IST on the 1st.

| Plan | seats¹ | watchlists² | analyses / month | AI analyses / month | vault | packets / month | WhatsApp |
|---|---|---|---|---|---|---|---|
| `trial` (14 days) | 10 | no plan limit | 10 | 10 | 1 GB | 10 | yes |
| `starter` | 3 | 5 | 100 | 50 | 2 GB | 30 | no |
| `pro` | 10 | no plan limit | 500 | 250 | 10 GB | 200 | yes |
| `enterprise` | – | – | – | – | – | – | yes |

¹ Members plus pending invitations. ² Every org is still capped at 50 watchlists (003/FR-027, 409 `watchlist_limit`).
Beyond the AI quota analyses run rules-only and carry the `llm_quota_reached` warning (`analyses.warnings`); an exhausted
LLM budget adds `llm_budget_exhausted`. An expired trial answers every write outside the FR-038 allow-list with 402
`plan_expired` while reads keep working; the operator moves an org with `POST /admin/orgs/:id/plan`.
