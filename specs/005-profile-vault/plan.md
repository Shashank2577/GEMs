# Implementation Plan: Company Profile & Document Vault

**Branch**: `005-profile-vault` | **Date**: 2026-11-05 | **Spec**: [`specs/005-profile-vault/spec.md`](./spec.md)

**Input**: Feature specification from `/specs/005-profile-vault/spec.md`

**Note**: This template is filled in by the `/cairn-plan` command; its definition describes the execution workflow.

## Summary

The company profile and document vault are **built** (001 tasks T050–T055): shared validators and completeness logic in
`@tp/core/vault`, Zod contracts in `@tp/core/contracts/vault.ts`, Hono routes `apps/api/src/routes/{profile,vault}.ts`, the
reminder job `apps/api/src/services/reminders.ts` wired into the scheduler, and the React pages
`apps/web/src/features/{profile,vault}/`. This plan documents the built design precisely (so QA and reviewers can trace
every FR to code) and plans the remaining work:

1. **Correctness/security gaps (P1)** — valid example GSTIN (FR-004), OEM `documentId` ownership check (FR-061), unlink
   OEM documents on vault delete (FR-041), client-side size check on all upload paths (FR-033), visible "document not
   found" for `?doc=` (FR-040), Udyam state code + deterministic CIN year (FR-015).
2. **QA enablement (P1)** — `POST /api/vault/reminders/run` (FR-052) so E2E can trigger reminders without waiting for cron;
   E2E scaffold + one Playwright suite per story with evidence in `qa/evidence/005/US<n>/`; axe scans (NFR-005).
3. **UX hardening (P2)** — unsaved-changes guard on in-app navigation (FR-013), next-reminder line (FR-053), OEM info
   issues (FR-020), inline CRAC upload (FR-062), "Use document expiry" (FR-063), optimistic concurrency (FR-014).
4. **Renewal & history (P3)** — renew-in-one-step, `vault_document_versions`, SHA-256 duplicate detection (FR-064…FR-068).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 20+ / Cloudflare Workers runtime

**Primary Dependencies**: Hono (API), Drizzle ORM (`postgres` / Neon driver), Zod (shared contracts), `pdf-lib` (page count),
React 18 + React Router 6 + TanStack Query 5 + Tailwind + Radix-based UI kit (`apps/web/src/components/ui`), Vitest,
Playwright (+ `@axe-core/playwright` to add)

**Storage**: Postgres — tables `company_profiles`, `past_contracts`, `vault_documents` (+ new `vault_document_versions`) in
`packages/db/src/schema.ts`; blobs in R2 (Worker) or the filesystem (Node) behind `BlobStore` (`apps/api/src/deps.ts`)

**Testing**: Vitest unit tests `packages/core/test/vault/{validators,status,completeness}.test.ts` (44 cases); API integration
tests against real Postgres `apps/api/test/vault.test.ts` (20 cases: profile, past contracts, vault, reminders); Playwright
E2E in `e2e/005-profile-vault/` (to be written)

**Target Platform**: Cloudflare Worker (API + SPA, Cron `*/30 * * * *`) and Node (`apps/api/src/node.ts`, in-process cron)

**Project Type**: Web application (pnpm monorepo)

**Performance Goals**: NFR-003 — profile p95 < 300 ms, vault list/summary p95 < 400 ms at 500 docs/org, 20 MB upload < 5 s;
NFR-004 — reminder job < 10 s for 10k due documents

**Constraints**: 20 MB per file, PDF/PNG/JPEG only (magic-byte sniffing), org-scoped everything (Constitution IV), pure
deterministic logic with injected clock (III), same code on Worker and Node (VII)

**Scale/Scope**: ≤ 500 vault documents and ≤ 200 past contracts per org; hundreds of orgs; ≤ 20 members per org

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence / design decision |
|---|---|---|
| I. Human-in-the-loop | PASS | Profile/vault only feed scoring, packets and allow-listed extension pre-fill; nothing is submitted to GeM; no GSTN/MCA/Udyam scraping or login. |
| II. Polite, public-only ingestion | N/A | No external fetches in this area. |
| III. Deterministic first | PASS | `validators.ts`, `status.ts`, `completeness.ts` are pure with injected `now` (gap: `validateCin` reads `new Date()` → FR-015 fixes). No LLM. |
| IV. Tenant isolation & data protection | PASS (gap) | All routes filter by `org_id`; blobs under `org/<orgId>/…`; downloads `private, no-store`; cross-org 404 tested. **Gap**: profile `oemAuthorizations[].documentId` is not ownership-checked (FR-061) — it is only an id, but it must not reference another tenant's document. |
| V. Delightful, accessible UX | PASS (gap) | Loading/empty/error states, 375 px layouts, labelled inputs, radiogroup cards. Gaps: axe scan in E2E, unsaved-changes navigation guard, invisible "not found" for `?doc=`. |
| VI. Test-first, E2E verified | PARTIAL | Unit + API tests green; **no E2E for this area** → QA task per story (T0xx) with evidence. |
| VII. Edge-native | PASS | `BlobStore` abstraction; `pdf-lib` works on Workers; SHA-256 (FR-067) via Web Crypto `crypto.subtle.digest`. |
| VIII. Simplicity & traceability | PASS (gap: NOTICE) | Shared contracts; comments cite FR/T ids. Root `NOTICE` does not exist yet (created by 003 T003); this feature appends its own attribution only if it ports code. |
| Constraints: licences | PASS with rule | Copy only from erenmyeager15 (Apache-2.0) and arush15june (MIT); others are ideas only. |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/005-profile-vault/
├── plan.md              # This file
├── spec.md              # Feature specification (6 user stories)
└── tasks.md             # Task list ([x] built, [ ] remaining)
```

Contracts and the data model of the built parts live in `specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`;
this plan's "API Endpoints" and "Data Model Touch-points" sections are the authoritative detail for 005.

### Source Code (repository root)

```text
packages/core/src/
├── vault/
│   ├── validators.ts        # GSTIN (mod-36 check), PAN, Udyam, CIN, IFSC, PIN, DPIIT, mobile→E.164, FY helpers, avg turnover
│   ├── status.ts            # docStatus, daysUntilExpiry (IST), reminderDue (30/7/1/0), reminderCopy, DOC_TYPES catalog,
│   │                        #   guessDocType, guessFinancialYear, suggestExpiry
│   └── completeness.ts      # profileCompleteness(profile, pastContracts, docs, now) → {percent, issues}
├── contracts/vault.ts       # profileInputSchema, pastContract*Schema, vaultUpload/Update/QuerySchema, DTOs, limits
└── gem/states.ts            # INDIAN_STATES (used by the profile state picker)
packages/core/test/vault/    # validators.test.ts, status.test.ts, completeness.test.ts

packages/db/src/
├── schema.ts                # company_profiles, past_contracts, vault_documents, notification_prefs.expiry_reminders
├── demo.ts                  # demo org: profile, 5 past contracts, 15 vault docs (ISO +10 d, CA +25 d, Dell −5 d)
└── migrations/ (packages/db/migrations/)   # new: vault_document_versions, vault_documents.content_sha256

apps/api/src/
├── routes/profile.ts        # GET/PUT /profile, /past-contracts CRUD
├── routes/vault.ts          # /vault list/summary/upload/get/patch/replace/delete/download; sniffMime, safeFileName
├── services/reminders.ts    # runExpiryReminders(deps, {orgId?})
├── lib/scheduled.ts         # ingestion → alerts → reminders (per-step isolation)
├── routes/dashboard.ts      # expiringDocs tile / expiringDocuments (consumer)
└── services/packet.ts       # vaultRows() consumer (006)
apps/api/test/vault.test.ts  # profile, past contracts, vault, reminders

apps/web/src/features/
├── profile/ ProfilePage.tsx, CompletenessCard.tsx, FinancialsEditor.tsx, PastContracts.tsx, OemEditor.tsx, RupeeInput.tsx, api.ts
└── vault/   VaultPage.tsx, UploadDialog.tsx, DocumentForm.tsx, DocumentDrawer.tsx, ExpiryTimeline.tsx, TypePicker.tsx, doc-ui.tsx, api.ts

e2e/005-profile-vault/       # new: US1…US6 Playwright suites; helpers in e2e/support/fixtures.ts
qa/evidence/005/US<n>/       # new: screenshots, video, trace, VERDICT.md
```

**Structure Decision**: Keep the existing monorepo split — pure logic in `packages/core/src/vault`, contracts in
`packages/core/src/contracts/vault.ts`, persistence in `packages/db`, HTTP in `apps/api/src/routes`, UI in
`apps/web/src/features/{profile,vault}`. New behaviour follows the same split; no new packages.

## API Endpoints

All paths are under `/api`. Errors: `{ error: { code, message, details? } }`; validation errors are **400**
`validation_error` with `details.fields` (path → message) and `details.issues`. Auth: session cookie or API token;
unauthenticated → **401** `unauthorized`; below min role → **403** `forbidden`; other org / malformed id → **404**
`not_found`.

| Method & path | Min role | Request | Response | Errors |
|---|---|---|---|---|
| `GET /profile` | viewer | — | **200** `ProfileResponse {profile: CompanyProfileDto, completeness: 0–100, issues: CompletenessIssue[], averageTurnover: {avg, years} \| null}` | 401 |
| `PUT /profile` | analyst | JSON `ProfileInput` (any subset; omitted = keep); *(gap FR-014)* `expectedUpdatedAt?: ISO` | **200** `ProfileResponse` | 400 `validation_error` (field paths incl. `financials.<i>.fy`, `localContentPct`, `gstin`/`pan` cross-check); *(gap)* 400 `oemAuthorizations.<i>.documentId`; *(gap)* 409 `conflict`; 403 |
| `GET /past-contracts` | viewer | — | **200** `{items: PastContractDto[], total}` (end date desc, created desc) | 401 |
| `POST /past-contracts` | analyst | JSON `{buyer, buyerType?, title, category?, value, startDate?, endDate?, gemContractNo?, cracDocumentId?}` | **201** `PastContractDto` | 400 (fields; `cracDocumentId` "That document is not in your vault"); 403 |
| `PATCH /past-contracts/:id` | analyst | JSON partial | **200** `PastContractDto` | 400 (incl. end < stored start); 404 "Past contract not found"; 403 |
| `DELETE /past-contracts/:id` | analyst | — | **200** `{ok:true}` | 404; 403 |
| `GET /vault` | viewer | query `type?, status?, category?, q? (≤100), sort? = recent\|expiry\|title\|type` | **200** `{items: VaultDocumentDto[], total}` (≤ 2000) | 400 bad enum; 401 |
| `GET /vault/summary` | viewer | — | **200** `VaultSummary {total, valid, expiring, expired, byType, nextExpiries[≤20], missingCommon}` | 401 |
| `POST /vault` | analyst | multipart `file` + `type?, title?, number?, issuer?, issueDate?, expiryDate?, financialYear?, tags?`; *(gap)* `allowDuplicate?` | **201** `VaultDocumentDto` | 400 (no file / empty / fields / bad multipart); 413 `payload_too_large`; 415 `unsupported_media_type`; 422 `unreadable_pdf`; *(gap)* 409 `duplicate_document {existingId,title}`; 403 |
| `GET /vault/:id` | viewer | — | **200** `VaultDocumentDto` (*(gap FR-053)* `+ nextReminder: {days, date} \| null`) | 404 "Document not found" |
| `PATCH /vault/:id` | analyst | JSON partial metadata | **200** `VaultDocumentDto` (resets `last_reminder_days` if expiry changed) | 400 (fields; expiry < stored issue); 404; 403 |
| `PUT /vault/:id/file` | analyst | multipart `file`; *(gap FR-064)* `issueDate?, expiryDate?, number?` | **200** `VaultDocumentDto` | as upload; 404; 403 |
| `DELETE /vault/:id` | analyst | — | **200** `{ok:true}` (unlinks CRACs; *(gap)* unlinks OEM `documentId`) | 404; 403 |
| `GET /vault/:id/download` | viewer | `?inline=1` | **200** file stream; headers `content-type`, `content-length`, `content-disposition` (`attachment`/`inline`; `filename` + `filename*`), `cache-control: private, no-store`, `x-content-type-options: nosniff` | 404 "Document not found" / "Document file not found" |
| *(gap)* `POST /vault/reminders/run` | bid_manager | — | **200** `{documents, notifications}` | 403 |
| *(gap)* `GET /vault/:id/versions` | viewer | — | **200** `{items: {id, fileName, mimeType, sizeBytes, pageCount, expiryDate, replacedBy:{id,name}\|null, replacedAt}[]}` | 404 |
| *(gap)* `GET /vault/:id/versions/:versionId/download` | viewer | `?inline=1` | **200** file stream (same headers) | 404 |

Consumers (not owned here): `GET /dashboard` (`tiles.expiringDocs`, `expiringDocuments`), packet builder `vaultRows()`,
analysis scoring reads `company_profiles` + `past_contracts`, annexure templates and extension allow-list read the profile.

## Data Model Touch-points

| Table / column | Use | Change |
|---|---|---|
| `company_profiles` (PK `org_id` → organizations, cascade) — `legal_name` (not null, default ''), `trade_name`, `gstin`, `pan`, `cin`, `udyam_number`, `mse_category`, `mse_social_category`, `is_startup`, `dpiit_number`, `mii_class`, `local_content_pct` (real), `incorporation_date`, `address`, `state`, `pincode`, `contact_name/email/phone`, `signatory_name/designation`, `financials` jsonb, `categories` jsonb, `hsn_codes` jsonb, `operating_states` jsonb, `oem_authorizations` jsonb `{oem, products, validTill?, documentId?}[]`, `certifications` jsonb, `max_emd_capacity` bigint, `updated_at` | Profile CRUD, completeness, scoring, annexures | None. FR-014 uses existing `updated_at`. FR-041 updates `oem_authorizations` jsonb on vault delete (`jsonb_path`/app-side rewrite in the same request). |
| `past_contracts` — `id`, `org_id` (idx), `buyer`, `buyer_type`, `title`, `category`, `value` bigint ₹, `start_date`, `end_date`, `gem_contract_no`, `crac_document_id` uuid, `created_at` | Experience | None (no FK on `crac_document_id`; integrity kept by route checks + delete unlink). |
| `vault_documents` — `id`, `org_id` (idx; idx `org_id,type`), `type`, `title`, `number`, `issuer`, `issue_date`, `expiry_date`, `financial_year`, `tags` jsonb, `blob_key`, `file_name`, `mime_type`, `size_bytes`, `page_count`, `uploaded_by` → users, `last_reminder_days`, `created_at`, `updated_at` | Vault, reminders, summary, dashboard, packets | *(gap FR-067)* add `content_sha256 text` + index `(org_id, content_sha256)`; *(NFR-004)* add index `(expiry_date)` for the reminder scan. |
| *(new)* `vault_document_versions` — `id` uuid PK, `org_id` → organizations cascade, `document_id` → vault_documents cascade, `blob_key`, `file_name`, `mime_type`, `size_bytes`, `page_count`, `expiry_date` date, `replaced_by` → users, `replaced_at` timestamptz; idx `(document_id, replaced_at desc)` | Renewal history | New migration `packages/db/migrations/00xx_vault_versions.sql` generated by drizzle-kit. |
| `notifications` (kind `expiry`, uq `user_id,channel,dedupe_key`), `notification_prefs.expiry_reminders/in_app/email`, `memberships`, `organizations.name` | Reminder output and recipients | None. |
| `activity_log` actions | `profile.updated`, `profile.past_contract_added/updated/deleted`, `vault.uploaded/updated/file_replaced/deleted` | *(gap)* `vault.renewed`, `vault.reminders_run`. |

## Key Flows

### 1. Profile save (built; gaps FR-014, FR-061)

```text
ProfilePage draft ──validate(profileInputSchema) in browser──► errors? → toast "Please fix…", jump+focus first field
        │ ok
        ▼
PUT /api/profile {draft [+ expectedUpdatedAt (gap)]}
  requireRole('analyst') → parseJson(profileInputSchema) (normalise ids, phone→E.164, FY→YYYY-YY, superRefine)
  → load existing row → patch = keys !== undefined → merged = EMPTY ∪ existing ∪ patch
  → (gap) 409 if expectedUpdatedAt ≠ existing.updatedAt
  → GSTIN↔PAN cross-check on merged values (field = the one sent) → 400
  → (gap) verify each oemAuthorizations[i].documentId ∈ org vault and type oem_authorization → 400
  → upsert (onConflict org_id) → logActivity(profile.updated, fields)
  → buildProfileResponse: [profile row, past contract ids, vault {type, expiry, title}] → profileCompleteness(now) + averageTurnoverLastN
◄─ 200 ProfileResponse → setDraft(saved), toast "Profile saved" "<n>% complete · next: …"
```

### 2. Vault upload (built; gaps FR-033, FR-067)

```text
UploadDialog: pick/drop file → (gap) size ≤ 20 MB check on every path → draftForFile: guessDocType, titleFrom, guessFinancialYear
  → validateDraft (title, issue ≤ expiry) → api.upload multipart
POST /api/vault: requireRole('analyst')
  → content-length > 20 MB+64 KB → 413
  → parseBody → file? (400) → bytes>0 (400) → ≤ 20 MB (413) → sniffMime (415) → PDF? pdf-lib load → pageCount (422 on failure)
  → (gap) sha256 → existing in org? and !allowDuplicate → 409 duplicate_document
  → parseWith(vaultUploadFieldsSchema, {type || guess, title, …, FY || guess}) (400)
  → id = randomUUID; key = org/<org>/vault/<id>/<safeFileName>; blobs.put
  → insert row (on failure: blobs.delete, rethrow) → logActivity(vault.uploaded) → 201 DTO (status derived with clock.now())
◄─ invalidate ['vault'], ['profile'], ['dashboard'] → toast → open drawer ?doc=<id>
```

### 3. Expiry reminders (built; gap FR-052 manual trigger)

```text
scheduled() / node cron every 30 min ─► runScheduled: ingestion → alerts → reminders (each step isolated)
   (gap) POST /api/vault/reminders/run (bid_manager) ─► runExpiryReminders(deps, {orgId})
runExpiryReminders:
  docs = vault_documents where expiry_date not null and ≤ istDate(now+30d) [and org]
  due = docs.map(reminderDue(d, now)) non-null      // smallest crossed of 30/7/1; 0 if expired ≤ 30 d ago; skip if last ≤ threshold
  load memberships, notification_prefs, organizations for due orgs
  for each due doc: title/body via reminderCopy; dedupeKey expiry:<id>:<expiry>:<threshold>; link /vault?doc=<id>
     per member: skip if prefs.expiryReminders=false; in_app (sent) if inApp; email (pending, "[Org] title") if email
     insert … onConflictDoNothing → set last_reminder_days = threshold
alerts dispatcher (003) delivers pending emails (Resend; skipped without key)
```

### 4. Replace / renew (built replace; gap renew + versions FR-064/065)

```text
Drawer "Replace file" (today) → PUT /vault/:id/file {file} → readFile checks → new key → blobs.put → update row (file fields,
  uploadedBy, updatedAt) → delete old blob if key changed → log vault.file_replaced
(gap) "Renew" dialog → PUT /vault/:id/file {file, issueDate?, expiryDate?, number?}
  → insert vault_document_versions(previous file fields) instead of deleting old blob → prune > 5 (delete blobs)
  → update row incl. dates; if expiry changed → last_reminder_days = null → log vault.renewed {fromExpiry,toExpiry}
```

### 5. Delete (built; gap FR-041)

```text
DELETE /vault/:id → getDoc (404) → update past_contracts set crac_document_id = null where = id
  → (gap) rewrite company_profiles.oem_authorizations removing documentId = id
  → delete row → (gap) delete versions + blobs → blobs.delete(key) (warn on failure) → log vault.deleted
```

## What to Port from the Reference Repos

The reference repositories are GeM/CPPP scrapers; none implements a company profile or a document vault, so most of this
area is TenderPilot's own code. Candidates reviewed (in `/home/user/refs/`):

| Source file | Licence | Target | Why / decision |
|---|---|---|---|
| `erenmyeager15_india-government-tenders-scraper/src/routes.ts` — `buildEligibilitySummary` / "Document required from seller" label list (`Experience Criteria`, `Bidder Turnover`, `Certificate (Requested in ATC)`, `OEM Authorization Certificate`, `Additional Doc N (Requested in ATC)`, `MSE Relaxation`, `Startup Relaxation`) | Apache-2.0 → **may copy** with attribution | `packages/core/src/vault/status.ts` `DOC_TYPES[].keywords` (add `bidder turnover`, `experience criteria`, `oem authorization certificate`, `maf`) and a new exported `GEM_SELLER_DOC_LABELS` map label → `DocType` used by `guessDocType` | Users often save GeM uploads with the GeM label as the file name; matching those labels raises type-guess accuracy (SC-007). Small, data-only port; add `NOTICE` entry + header comment. |
| `Giri-Aayush_gem/my_profile.yaml` + `filters/tender_filter.py` (profile of locations, work types, budget range used for scoring) | No licence → **ideas only** | — | Confirms that operating states + categories + a value band are what sellers expect in a profile; we already have states/categories; a "comfortable bid value range" belongs to watchlists (003), not here. Not ported. |
| `Mujahid-Alam_gem-tender-pdf-extractor/gem3.py` (MSE/startup relaxation flags from bid PDFs) | No licence → ideas only | — | Belongs to analysis (004); already covered by `packages/core/src/analyse/rules.ts`. Not ported. |
| `arush15june_gem-search` | MIT | — | Search client only; nothing relevant to profile/vault. |
| Others (Giridar33, PranavTamada, IshanMaheshwari-777, rounittxx) | No licence | — | Scrapers only; nothing relevant. |

Attribution: append to the root `NOTICE` (created by 003 T003) a line for the erenmyeager15 label vocabulary used in
`packages/core/src/vault/status.ts`.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Users rely on "Replace file" for renewals and keep stale expiry dates | Toast already reminds; FR-064 renew dialog pre-fills a new expiry; FR-053 shows next reminder. |
| OEM `documentId` pointing at a deleted or foreign document breaks packets | FR-041 unlink on delete; FR-061 ownership check on save. |
| Reminder storms after downtime | `reminderDue` sends only the smallest crossed threshold; dedupe key + `last_reminder_days`. |
| Large PDFs exhaust Worker CPU while counting pages | `updateMetadata:false`, `throwOnInvalidObject:false`; 20 MB cap; measure in NFR-003 perf test. |
| Version history grows storage | Cap 5 versions/document; delete cascades blobs. |
| E2E cannot reach reminder thresholds without time travel | Upload docs with expiry today+10/+5/−1 and trigger FR-052 endpoint; no clock mocking needed. |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations.
