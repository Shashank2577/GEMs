---

description: "Task list for 005 Company Profile & Document Vault"
---

# Tasks: Company Profile & Document Vault

**Input**: Design documents from `/specs/005-profile-vault/`

**Prerequisites**: plan.md (required), spec.md (required for user stories); contracts/data model of the built parts live in
`specs/001-gem-tender-copilot/{contracts/api.md,data-model.md}`

**Tests**: Requested. Core logic gets Vitest unit tests (`packages/core/test/vault/`); routes get API integration tests on
real Postgres (`apps/api/test/vault.test.ts`); every user story gets a Playwright E2E with evidence (screenshots, video,
trace) in `qa/evidence/005/US<n>/` plus a QA `VERDICT.md`. Review is done with the cairn review workflow (ai-sdlc
conventions in `CONVENTIONS.md` for review/QA only).

**Organization**: Tasks are grouped by user story. `- [x]` = already implemented and verified by reading the code on
2026-11-05 (delivered as 001 tasks T050–T055); `- [ ]` = remaining work (gaps, hardening, missing tests, QA). Each open
task is sized at ≤ 1 day.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1…US6)
- File paths are repo-relative to `/home/user/GEMs`

## Path Conventions

- Core logic: `packages/core/src/vault/`, contracts `packages/core/src/contracts/vault.ts`, tests `packages/core/test/vault/`
- Schema/migrations: `packages/db/src/schema.ts`, `packages/db/migrations/`
- API: `apps/api/src/routes/{profile,vault}.ts`, `apps/api/src/services/reminders.ts`, tests `apps/api/test/vault.test.ts`
- Web: `apps/web/src/features/profile/`, `apps/web/src/features/vault/`
- E2E: `e2e/005-profile-vault/US<n>-*.e2e.ts`, evidence `qa/evidence/005/US<n>/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Demo data, E2E scaffolding, accessibility tooling and attribution

- [x] T001 [P] Demo org seed with profile (Aarav Technologies), 5 past contracts and 15 vault documents with generated one-page PDFs (ISO +10 d, CA certificate +25 d, Dell OEM −5 d) in `packages/db/src/demo.ts` FR-001, FR-021
- [ ] T002 [P] E2E scaffold for this spec: create `e2e/005-profile-vault/` and add helpers `makePdf(pages)`, `makePng()`, `uploadVaultDoc(request, {name, bytes, fields})`, `putProfile(request, body)`, `addPastContract(request, body)`, `inviteAs(request, role)` (returns a logged-in context for analyst/viewer) and `evidence005(page, story, name)` writing to `qa/evidence/005/<story>/` in `e2e/support/fixtures.ts` NFR-008 (#120)
- [ ] T003 [P] Add `@axe-core/playwright` (exact version) to root `package.json` devDependencies and an `a11y(page, name)` helper in `e2e/support/fixtures.ts` that fails on serious/critical violations and saves the JSON report next to the evidence NFR-005 (#121)
- [x] T004 [P] Append to root `NOTICE` (create the file if 003 T003 has not landed yet, with the same header) the attribution for the erenmyeager15/india-government-tenders-scraper (Apache-2.0) GeM seller-document label vocabulary used in `packages/core/src/vault/status.ts` NFR-009 (#122)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, contracts, catalog and scheduling every story relies on

- [x] T005 Tables `company_profiles` (PK `org_id`), `past_contracts` (idx `org_id`), `vault_documents` (idx `org_id`, `org_id,type`; `last_reminder_days`), `notification_prefs.expiry_reminders` in `packages/db/src/schema.ts` and `packages/db/migrations/0000_last_shocker.sql` FR-001, FR-021, FR-045
- [x] T006 [P] Zod contracts and DTOs (`profileInputSchema`, `pastContractCreateSchema`/`UpdateSchema`, `vaultUploadFieldsSchema`, `vaultUpdateSchema`, `vaultQuerySchema`, `VAULT_MAX_BYTES` 20 MB, `VAULT_ALLOWED_MIME`, `CompanyProfileDto`, `PastContractDto`, `VaultDocumentDto`, `VaultSummary`) in `packages/core/src/contracts/vault.ts` FR-003, FR-008, FR-022, FR-024, FR-027
- [x] T007 [P] Document-type catalog `DOC_TYPES` (20 types, categories, expiry flags, typical validity, per-FY, common-in-bids, keywords), `docTypeInfo`, `guessDocType`, `guessFinancialYear`, `suggestExpiry` in `packages/core/src/vault/status.ts` FR-025, FR-026
- [x] T008 [P] Reminder job wired into the scheduled pipeline (ingestion → alerts → reminders, per-step isolation) in `apps/api/src/lib/scheduled.ts`, Worker `scheduled()` in `apps/api/src/worker.ts`, Node cron in `apps/api/src/node.ts` FR-043
- [ ] T009 [P] Add index `vault_expiry_idx` on `vault_documents(expiry_date)` in `packages/db/src/schema.ts` and generate the migration in `packages/db/migrations/` (drizzle-kit) for the reminder scan NFR-004 (#123)

**Checkpoint**: Foundation ready — user stories can proceed in parallel

---

## Phase 3: User Story 1 - Maintain a validated company profile (Priority: P1) 🎯 MVP

**Goal**: Owner/Analyst can enter and save a profile whose identifiers are normalised and validated identically in browser and API; Viewers see it read-only.

**Independent Test**: Fresh org → `/profile` → GSTIN `27AAPFU0939F1ZV` → **Fill from GSTIN** → legal name → **Save profile** → reload → values persisted.

### Tests for User Story 1

- [x] T010 [P] [US1] Unit tests for GSTIN (checksum, state code, embedded PAN), PAN holder types, Udyam, CIN, IFSC, PIN, DPIIT, mobile → E.164 and FY helpers in `packages/core/test/vault/validators.test.ts` FR-004, FR-006
- [x] T011 [P] [US1] Unit tests for `profileInputSchema` normalisation, per-path errors, GSTIN/PAN consistency and MII local content in `packages/core/test/vault/completeness.test.ts` FR-005, FR-007
- [x] T012 [P] [US1] API tests: empty profile, invalid GSTIN/PAN/PIN → 400 field errors, upsert + normalise + partial merge, PAN-vs-stored-GSTIN 400, viewer 403 in `apps/api/test/vault.test.ts` FR-002, FR-003, FR-005, FR-012
- [ ] T013 [P] [US1] API tests for remaining profile rules: phone variants (`+91 98123-45678`, `09812345678`, `919812345678` → `+919812345678`), `hsnCodes: ["847"]` → 400 "HSN/SAC codes have 4, 6 or 8 digits", Class-II with 55% → 400, `contactEmail: "bids@"` → 400, unauthenticated `GET /profile` → 401, `activity_log.meta.fields` lists only sent keys, in `apps/api/test/vault.test.ts` FR-003, FR-006, FR-007, FR-008 (#124)

### Implementation for User Story 1

- [x] T014 [P] [US1] Validators and FY helpers in `packages/core/src/vault/validators.ts` FR-004, FR-006, FR-019
- [x] T015 [US1] `GET /profile` and `PUT /profile` (partial merge, cross-check against stored GSTIN/PAN, upsert, `profile.updated` activity) in `apps/api/src/routes/profile.ts` FR-002, FR-003, FR-005, FR-012
- [x] T016 [US1] Profile page: 7 sections, sticky section nav / mobile pills, inline validation with the shared schema, Fill from GSTIN, MSE/Startup switches, MII radio cards, unsaved-changes bar, `beforeunload` guard, view-only banner in `apps/web/src/features/profile/ProfilePage.tsx` and `apps/web/src/features/profile/api.ts` FR-009, FR-010, FR-011, FR-012
- [ ] T017 [P] [US1] Make every quoted example identifier valid: change "e.g. 27AAPCS1234K1Z5" to "e.g. 27AAPCS1234K1Z2" in `packages/core/src/vault/validators.ts` and the GSTIN hint/placeholder in `apps/web/src/features/profile/ProfilePage.tsx`; add a unit test that runs each validator on the example it quotes (GSTIN, PAN, Udyam, CIN, IFSC, DPIIT, PIN) and expects `null` in `packages/core/test/vault/validators.test.ts` FR-004 (#125)
- [ ] T018 [P] [US1] Udyam state-code check ("\"XX\" is not a valid state code in a Udyam number", list of 36 state/UT codes) and `validateCin(raw, now = new Date())` with injectable year bound; update `profileInputSchema` call sites; unit tests in `packages/core/src/vault/validators.ts`, `packages/core/test/vault/validators.test.ts` FR-015 (#126)
- [ ] T019 [US1] In-app navigation guard: `useBlocker(dirty)` + `ConfirmDialog` "Discard unsaved changes?" with **Stay** / **Discard and leave** in `apps/web/src/features/profile/ProfilePage.tsx` FR-013 (#127)
- [ ] T020 [US1] Optimistic concurrency: accept optional `expectedUpdatedAt` in `profileInputSchema` (`packages/core/src/contracts/vault.ts`), return 409 `conflict` "Someone else saved the profile at <time IST>. Reload to see their changes." when it differs from the stored `updated_at` in `apps/api/src/routes/profile.ts`; API test for both match and mismatch in `apps/api/test/vault.test.ts` FR-014 (#128)
- [ ] T021 [US1] Web: send `expectedUpdatedAt` from `profile.data.profile.updatedAt` on save and show the 409 message with a **Reload** action (keeps the draft until reload) in `apps/web/src/features/profile/ProfilePage.tsx`, `apps/web/src/features/profile/api.ts` FR-014 (#129)
- [ ] T022 [US1] QA: Playwright E2E for US1 with evidence (screenshots, video, trace) in `qa/evidence/005/US1/` — scenarios 1–14 (desktop + `@mobile` 375 px: pill nav, save bar above tab bar, no horizontal scroll), viewer read-only, axe scan; spec `e2e/005-profile-vault/US1-profile.e2e.ts`; `VERDICT.md` FR-001…FR-015, NFR-005, NFR-006 (#130)

**Checkpoint**: Profile editing is fully functional and testable independently

---

## Phase 4: User Story 2 - See profile completeness and keep 3 years of financials (Priority: P1)

**Goal**: Live, weighted completeness with actionable suggestions; FY financials with a correct 3-year average.

**Independent Test**: Fresh org → legal name + GSTIN + PAN → 27%; upload GST certificate → 32%; three FY turnovers → average ₹4,50,00,000.

### Tests for User Story 2

- [x] T023 [P] [US2] Unit tests: empty profile < 10% errors first, complete profile 100% no issues, missing FYs named, expired docs flagged, startup needs DPIIT in `packages/core/test/vault/completeness.test.ts` FR-016, FR-017
- [ ] T024 [P] [US2] Pin the exact weights with golden tests at `NOW = 2026-11-05T04:30Z`: empty → 0% with 17 issues (first four errors in spec order), legal name + GSTIN + PAN → 27%, + `gst` doc → 32%, demo-like profile with 5 contracts → 96% with the 3 warnings of US2 scenario 10; and `averageTurnoverLastN` de-dup / ≤ 3 years / ignores negatives in `packages/core/test/vault/completeness.test.ts`, `packages/core/test/vault/validators.test.ts` FR-016, FR-017, FR-019 (#131)

### Implementation for User Story 2

- [x] T025 [P] [US2] `profileCompleteness()` weighted checklist with issues sorted error → warning → info in `packages/core/src/vault/completeness.ts` FR-016, FR-017
- [x] T026 [P] [US2] FY helpers (`fyLabelForDate`, `fyStartYear`, `normalizeFy`, `lastCompletedFys`, `averageTurnoverLastN`) in `packages/core/src/vault/validators.ts` and `averageTurnover` in `buildProfileResponse` in `apps/api/src/routes/profile.ts` FR-019
- [x] T027 [P] [US2] Completeness card (ring, band headings, 6 issues + "+N more", jump to field / vault upload preset) in `apps/web/src/features/profile/CompletenessCard.tsx` and `jump()` in `apps/web/src/features/profile/ProfilePage.tsx` FR-018
- [x] T028 [P] [US2] Financials editor (FY picker without duplicates, turnover/net worth/audited, bar chart with average line, "Add FY <next missing>") in `apps/web/src/features/profile/FinancialsEditor.tsx`, `apps/web/src/features/profile/RupeeInput.tsx` FR-019
- [ ] T029 [US2] OEM info issues without weight change: "OEM authorisation from <OEM> expires in N days — ask for a renewed MAF." (0–30 days) and "Link the <OEM> authorisation letter from the vault so packets can attach it." (no `documentId`) in `packages/core/src/vault/completeness.ts` (extend `CompletenessProfile.oemAuthorizations` with `documentId`); unit tests in `packages/core/test/vault/completeness.test.ts` FR-020 (#132)
- [ ] T030 [US2] QA: Playwright E2E for US2 with evidence (screenshots, video, trace) in `qa/evidence/005/US2/` — scenarios 1–11: percentages 0 → 27 → 32, suggestion click focuses GSTIN / opens upload dialog preset "GST registration", FY editor and average, demo org 96%; desktop + `@mobile`; spec `e2e/005-profile-vault/US2-completeness.e2e.ts`; `VERDICT.md` FR-016…FR-020 (#133)

**Checkpoint**: Completeness and financials work independently on top of US1

---

## Phase 5: User Story 3 - Store, find, preview and manage bid documents in a private vault (Priority: P1)

**Goal**: Private, typed, searchable vault with upload, preview, download, edit, replace and delete.

**Independent Test**: Drop `GST_REG06_2023.pdf` on `/vault` → type "GST registration" guessed → upload → card "No expiry" + "PDF · 2p" → download bytes match.

### Tests for User Story 3

- [x] T031 [P] [US3] Unit tests for catalog, `guessDocType`, `guessFinancialYear`, `suggestExpiry` in `packages/core/test/vault/status.test.ts` FR-025, FR-026
- [x] T032 [P] [US3] API tests: PDF upload with guessed type and page count, download round-trip, PNG + expiring status, 415/422/413/400 rejections, list filters/search/sort, summary, PATCH resets reminders, replace, viewer 403, org isolation, 401, delete removes row + blob + activity in `apps/api/test/vault.test.ts` FR-021…FR-034
- [x] T033 [P] [US3] Missing API tests: download headers (`attachment` vs `inline` with `?inline=1`, ASCII `filename` + UTF-8 `filename*` for `प्रमाणपत्र.pdf`, `cache-control: private, no-store`, `nosniff`); replace PDF → PNG deletes old blob and sets `pageCount: 1`, `mimeType: image/png`; cross-org 404 for `/download`, `PATCH`, `PUT …/file`, `DELETE`; tags as comma list and JSON; `q` containing `%` matches literally; 0-byte file → 400 "The file is empty"; DB insert failure leaves no blob (stub `deps.db`) in `apps/api/test/vault.test.ts` FR-023, FR-024, FR-030, FR-032, FR-034 (#134)

### Implementation for User Story 3

- [x] T034 [US3] Vault routes: list (filters, search, sort), summary, upload (content-length + size cap, magic-byte sniffing, pdf-lib page count, guessed metadata, blob rollback), get, patch (reminder reset), replace file, delete (CRAC unlink), download (secure headers) in `apps/api/src/routes/vault.ts` FR-021…FR-034
- [x] T035 [P] [US3] Vault page: onboarding, status tiles, 90-day timeline, missing-common chips, search/type/sort/category filters in URL, grid/list with persisted view, page drag & drop, `?upload=1&uploadType=`, `?doc=` drawer in `apps/web/src/features/vault/VaultPage.tsx`, `apps/web/src/features/vault/ExpiryTimeline.tsx`, `apps/web/src/features/vault/doc-ui.tsx`, `apps/web/src/features/vault/api.ts` FR-035, FR-036, FR-039
- [x] T036 [P] [US3] Upload dialog and shared metadata form (type picker, guessed title/FY, validity suggestion, client validation, server field errors) in `apps/web/src/features/vault/UploadDialog.tsx`, `apps/web/src/features/vault/DocumentForm.tsx`, `apps/web/src/features/vault/TypePicker.tsx` FR-037
- [x] T037 [P] [US3] Document drawer (inline preview, metadata, expired banner, Download/Open, Edit details, Replace file, Delete with confirmation) in `apps/web/src/features/vault/DocumentDrawer.tsx` FR-038
- [x] T038 [US3] Unlink profile OEM authorisations on vault delete: in `DELETE /vault/:id` rewrite `company_profiles.oem_authorizations` setting `documentId` to null where it equals the deleted id (same request) in `apps/api/src/routes/vault.ts`; API test in `apps/api/test/vault.test.ts` FR-041 (#135)
- [x] T039 [P] [US3] Visible not-found for `?doc=<id>`: when `useVaultDoc` errors with 404, toast "That document could not be found. It may have been deleted." and remove `doc` from the URL in `apps/web/src/features/vault/VaultPage.tsx` FR-040 (#136)
- [x] T040 [P] [US3] Client-side 20 MB / type check on every file-selection path via a shared `checkVaultFile(file)` returning the dropzone message ("<name> is larger than 20 MB.") in new `apps/web/src/features/vault/file-check.ts`, used by `apps/web/src/features/vault/UploadDialog.tsx` (Change), `apps/web/src/features/vault/VaultPage.tsx` (page drop) and `apps/web/src/features/vault/DocumentDrawer.tsx` (Replace file) FR-033 (#137)
- [x] T041 [P] [US3] Port GeM seller-document label vocabulary from `/home/user/refs/erenmyeager15_india-government-tenders-scraper/src/routes.ts` (`buildEligibilitySummary` labels) into `DOC_TYPES[].keywords` and an exported `GEM_SELLER_DOC_LABELS` map used by `guessDocType` in `packages/core/src/vault/status.ts` (header comment citing `NOTICE`); add a 50-name corpus test asserting ≥ 80% correct guesses in `packages/core/test/vault/status.test.ts` FR-026, SC-007, NFR-009 (#138)
- [x] T042 [P] [US3] Performance check: seed 500 vault documents for one org and assert `GET /vault`, `GET /vault/summary` < 400 ms and `GET /profile` < 300 ms (median of 5, local Postgres) in new `apps/api/test/vault.perf.test.ts` NFR-003 (#139)
- [ ] T043 [US3] QA: Playwright E2E for US3 with evidence (screenshots, video, trace) in `qa/evidence/005/US3/` — scenarios 1–16: onboarding tiles, guessed metadata, validity suggestion, 415/422/413 messages, demo tiles 15/12/2/1, search "dell", filters in URL, empty states, drawer preview/download bytes, edit, replace, delete, viewer controls hidden, cross-org 404 via API; desktop + `@mobile` (2×2 tiles, full-width drawer, no horizontal scroll) + axe; spec `e2e/005-profile-vault/US3-vault.e2e.ts`; `VERDICT.md` FR-021…FR-041, NFR-001, NFR-002, NFR-005, NFR-006 (#140)

**Checkpoint**: Vault is fully functional and testable independently

---

## Phase 6: User Story 4 - Know what is expiring and get reminded 30, 7 and 1 day before (Priority: P1)

**Goal**: Correct IST-based status everywhere and exactly-once reminders per threshold, respecting preferences.

**Independent Test**: Upload ISO expiring today + 10 → trigger reminders → bell shows "<title> expires in 10 days" → trigger again → no duplicate.

### Tests for User Story 4

- [x] T044 [P] [US4] Unit tests for `docStatus` boundaries (expiry day still valid, IST day), `reminderDue` (smallest crossed threshold, uploaded with 5 days → 7 only, expired within 30 days → 0, older → none) and `reminderCopy` in `packages/core/test/vault/status.test.ts` FR-042, FR-044, FR-046
- [x] T045 [P] [US4] API test: reminders per member respect `expiryReminders`/`email` prefs, 5 rows, idempotent re-run, 7-day then expired thresholds, link `/vault?doc=<id>` in `apps/api/test/vault.test.ts` FR-045, FR-049
- [x] T046 [P] [US4] API tests: reminders are org-isolated (member only of org B gets none for org A docs); IST boundary (clock 2026-11-05T20:00Z treats a doc expiring 2026-11-05 as expired); editing expiry after a sent reminder creates a new dedupe key on the next crossing; email title prefixed "[<Org name>]" in `apps/api/test/vault.test.ts` FR-042, FR-045, FR-049, FR-051 (#141)

### Implementation for User Story 4

- [x] T047 [US4] `docStatus`, `daysUntilExpiry` (IST), `reminderDue`, `reminderCopy`, `REMINDER_THRESHOLDS` [30, 7, 1] in `packages/core/src/vault/status.ts` FR-042, FR-044, FR-046
- [x] T048 [US4] `runExpiryReminders(deps, {orgId?})` with prefs, in-app + pending email rows, dedupe key, `last_reminder_days` update in `apps/api/src/services/reminders.ts` FR-043, FR-045, FR-049, FR-051
- [x] T049 [P] [US4] Expiry badges, status tiles, 90-day timeline, drawer expired banner, reminder deep-link `?doc=` in `apps/web/src/features/vault/doc-ui.tsx`, `apps/web/src/features/vault/ExpiryTimeline.tsx`, `apps/web/src/features/vault/VaultPage.tsx`; dashboard `tiles.expiringDocs` / `expiringDocuments` in `apps/api/src/routes/dashboard.ts` FR-048, FR-050
- [x] T050 [US4] `POST /api/vault/reminders/run` (bid_manager+) calling `runExpiryReminders(deps, {orgId})`, logging `vault.reminders_run` `{documents, notifications}`; API tests for 200/403/idempotency in `apps/api/src/routes/vault.ts`, `apps/api/test/vault.test.ts` FR-052 (#142)
- [x] T051 [US4] Web: **Send reminders now** in the vault header overflow menu (bid_manager+, `RoleGate`) with toasts "Reminders sent for <n> document(s)" / "No reminders due" in `apps/web/src/features/vault/VaultPage.tsx`, `apps/web/src/features/vault/api.ts` FR-052 (#143)
- [x] T052 [P] [US4] `nextReminder(expiryDate, lastReminderDays, now)` → `{days, date} | null` in `packages/core/src/vault/status.ts` with unit tests in `packages/core/test/vault/status.test.ts`; expose `nextReminder` on `VaultDocumentDto` in `packages/core/src/contracts/vault.ts` and `toVaultDto` in `apps/api/src/routes/vault.ts` FR-053 (#144)
- [x] T053 [US4] Drawer line "Next reminder: <N> days before expiry (<date>)" / "All reminders sent" under Expiry date in `apps/web/src/features/vault/DocumentDrawer.tsx` (depends on T052) FR-053 (#145)
- [ ] T054 [US4] QA: Playwright E2E for US4 with evidence (screenshots, video, trace) in `qa/evidence/005/US4/` — upload docs expiring +45/+30/+10/0/−1 and check badges; trigger reminders via T050 endpoint; bell titles/links; idempotent re-run; expiry edit restarts cycle; viewer with reminders off receives none; dashboard tile count; desktop + `@mobile`; spec `e2e/005-profile-vault/US4-expiry-reminders.e2e.ts`; `VERDICT.md` FR-042…FR-053 (#146)

**Checkpoint**: Expiry tracking and reminders verified end to end

---

## Phase 7: User Story 5 - Record past contracts with CRACs and OEM authorisations (Priority: P2)

**Goal**: Experience and OEM data linked to vault proofs, with ownership checks.

**Independent Test**: Upload a CRAC, add "Supply of 85 desktop computers" (₹58,20,000) linked to it → table shows "Linked" and API returns the `cracDocumentId`.

### Tests for User Story 5

- [x] T055 [P] [US5] API test: past contracts CRUD in `apps/api/test/vault.test.ts` FR-054
- [ ] T056 [P] [US5] API tests: `cracDocumentId` of another org / random UUID → 400 "That document is not in your vault"; PATCH only `endDate` < stored `startDate` → 400; cross-org PATCH/DELETE → 404 "Past contract not found"; malformed id → 404; list ordering end date desc then created desc; viewer POST → 403; activity rows for add/update/delete in `apps/api/test/vault.test.ts` FR-054…FR-057 (#147)

### Implementation for User Story 5

- [x] T057 [US5] Past-contract routes with CRAC ownership check and activity in `apps/api/src/routes/profile.ts` FR-054, FR-055, FR-056, FR-057
- [x] T058 [P] [US5] Experience UI: empty state, summary (count/total/largest), responsive table with Proof badge, contract dialog with client validation and Experience-only CRAC picker, delete confirmation in `apps/web/src/features/profile/PastContracts.tsx` FR-058, FR-059
- [x] T059 [P] [US5] OEM editor rows (OEM, products, valid till + badge, `oem_authorization`-only vault picker) saved with the profile in `apps/web/src/features/profile/OemEditor.tsx` FR-060
- [ ] T060 [US5] Validate OEM `documentId` ownership and type in `PUT /profile` (one query for all ids) → 400 `details.fields["oemAuthorizations.<i>.documentId"]` "Pick an OEM authorisation from your vault" in `apps/api/src/routes/profile.ts`; API tests (own doc OK, other org 400, wrong type 400) in `apps/api/test/vault.test.ts` FR-061 (#148)
- [ ] T061 [US5] Inline CRAC upload: "Upload a new CRAC…" option in the picker opens `UploadDialog` (preset `crac`) above the contract dialog and selects the new document via `onUploaded(id)` without losing the draft in `apps/web/src/features/profile/PastContracts.tsx` FR-062 (#149)
- [ ] T062 [P] [US5] "Use document expiry" in OEM rows when the linked document has an expiry and Valid till is empty/different in `apps/web/src/features/profile/OemEditor.tsx` FR-063 (#150)
- [ ] T063 [US5] QA: Playwright E2E for US5 with evidence (screenshots, video, trace) in `qa/evidence/005/US5/` — scenarios 1–11: empty state, client errors, add/edit/delete contract with toasts and summary "1 contract · total ₹58.2 L · largest ₹58.2 L", CRAC linking ("Linked"/"No CRAC"), OEM rows + save, completeness change, cross-org CRAC via API; desktop + `@mobile` (table collapses to cards); spec `e2e/005-profile-vault/US5-experience-oem.e2e.ts`; `VERDICT.md` FR-054…FR-063 (#151)

**Checkpoint**: Experience and OEM data verified

---

## Phase 8: User Story 6 - Renew a document in one step and keep its history (Priority: P3)

**Goal**: One-step renewal with restarted reminders, version history and duplicate detection.

**Independent Test**: ISO expiring in 10 days → **Renew** with new PDF and suggested expiry → badge "Valid", Versions list shows the old file, reminder cycle reset.

### Tests for User Story 6

- [ ] T064 [P] [US6] API tests: renew with new expiry resets `last_reminder_days` and logs `vault.renewed`; previous file listed in versions and downloadable; 6th renewal prunes the oldest version and its blob; delete removes versions + blobs; cross-org version ids → 404; duplicate upload → 409 `duplicate_document` and `allowDuplicate=1` → 201, in `apps/api/test/vault.test.ts` FR-064…FR-067 (#152)

### Implementation for User Story 6

- [ ] T065 [US6] Schema: table `vault_document_versions` (`id, org_id, document_id, blob_key, file_name, mime_type, size_bytes, page_count, expiry_date, replaced_by, replaced_at`, idx `document_id, replaced_at`) and column `vault_documents.content_sha256` + idx `(org_id, content_sha256)` in `packages/db/src/schema.ts`; generated migration in `packages/db/migrations/` FR-065, FR-067 (#153)
- [ ] T066 [US6] `PUT /vault/:id/file` accepts `issueDate`, `expiryDate`, `number` (validated with `vaultUpdateSchema` + issue ≤ expiry), resets `last_reminder_days` on expiry change, logs `vault.renewed {fromExpiry,toExpiry}` in `apps/api/src/routes/vault.ts` FR-064 (#154)
- [ ] T067 [US6] Record the previous file into `vault_document_versions` instead of deleting its blob, prune to 5 (delete pruned blobs), delete versions + blobs on document delete in `apps/api/src/routes/vault.ts` FR-065 (#155)
- [ ] T068 [P] [US6] `GET /vault/:id/versions` and `GET /vault/:id/versions/:versionId/download` (org-scoped, same secure headers) in `apps/api/src/routes/vault.ts`; DTO `VaultVersionDto` in `packages/core/src/contracts/vault.ts` FR-066 (#156)
- [ ] T069 [P] [US6] SHA-256 via `crypto.subtle.digest` on upload/replace, 409 `duplicate_document {existingId,title}` unless `allowDuplicate=1`, backfill `content_sha256` lazily (null = unknown) in `apps/api/src/routes/vault.ts` FR-067, NFR-010 (#157)
- [ ] T070 [US6] Web: **Renew** dialog (file, issue date default today, expiry pre-filled by `suggestExpiry`, number) calling `useReplaceVaultFile` with fields; toast "“<title>” renewed — valid till <date>" in new `apps/web/src/features/vault/RenewDialog.tsx`, `apps/web/src/features/vault/DocumentDrawer.tsx`, `apps/web/src/features/vault/api.ts` FR-064, FR-068 (#158)
- [ ] T071 [P] [US6] Web: "Versions" list in the drawer with Download per version (`useVaultVersions`) in `apps/web/src/features/vault/DocumentDrawer.tsx`, `apps/web/src/features/vault/api.ts` FR-066, FR-068 (#159)
- [ ] T072 [P] [US6] Web: duplicate prompt "This file is already in your vault as “<title>”." with **Open existing** / **Upload anyway** in `apps/web/src/features/vault/UploadDialog.tsx` FR-067 (#160)
- [ ] T073 [US6] QA: Playwright E2E for US6 with evidence (screenshots, video, trace) in `qa/evidence/005/US6/` — renew flow, versions download, duplicate prompt both branches, viewer sees versions but no Renew; desktop + `@mobile`; spec `e2e/005-profile-vault/US6-renew-history.e2e.ts`; `VERDICT.md` FR-064…FR-068 (#161)

**Checkpoint**: All user stories independently functional

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, accessibility fixes and review

- [ ] T074 [P] Update `specs/001-gem-tender-copilot/contracts/api.md` (Profile & Vault section) and `specs/001-gem-tender-copilot/data-model.md` with the new endpoints (`/vault/reminders/run`, versions), `expectedUpdatedAt`, `nextReminder`, `content_sha256` and `vault_document_versions` FR-014, FR-052, FR-053, FR-064…FR-067 (#162)
- [ ] T075 Fix any serious/critical axe violations reported by T022/T030/T043 on `/profile` and `/vault` (labels, contrast, focus order) in `apps/web/src/features/profile/` and `apps/web/src/features/vault/` NFR-005 (#163)
- [ ] T076 Tenant-isolation sweep: grep every query in `apps/api/src/routes/profile.ts`, `apps/api/src/routes/vault.ts`, `apps/api/src/services/reminders.ts` for an `org_id` predicate and add a table-driven cross-org 404 test covering every vault/version/past-contract route in `apps/api/test/vault.test.ts` NFR-001, SC-005 (#164)
- [ ] T077 Cairn review of all 005 changes (CONVENTIONS.md review checklist: correctness, security, tenancy, a11y, tests), resolve findings, then roll up the six `VERDICT.md` files into `qa/evidence/005/SUMMARY.md` NFR-008, SC-006 (#165)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T002/T003 before any QA task; T004 before merging T041.
- **Foundational (Phase 2)**: T009 independent; built items already in place.
- **US1 → US2**: US2 uses the profile page; US2 tasks can start once US1 implementation (built) exists.
- **US3 and US4**: independent of US1/US2; T050 (manual reminders endpoint) blocks QA T054.
- **US5**: T061 depends on `UploadDialog` (built). T060 is independent of T038.
- **US6**: T065 blocks T066–T072; T064 written first (should fail) then implemented.
- **Polish**: after the stories it covers.

### Parallel Opportunities

- T013, T017, T018, T024, T033, T041, T046, T056 (tests/core-only) can all run in parallel.
- Web tasks in different files (T039, T040, T062, T071, T072) can run in parallel.

## Implementation Strategy

1. Close P1 correctness gaps first (T017, T018, T038, T039, T040, T060) — small, high-value.
2. Enable QA (T002, T003, T050) and run US1–US4 E2E with evidence (T022, T030, T043, T054).
3. P2 UX (T019–T021, T029, T051–T053, T061–T063) and US5 QA (T063).
4. P3 renewal & history (T064–T073) behind the same API routes.
5. Polish, cairn review and QA roll-up (T074–T077).
