# Data Model — TenderPilot

The executable source of truth is `packages/db/src/schema.ts` (Drizzle). Migrations are generated into
`packages/db/migrations/` with `pnpm --filter @tp/db generate` and applied with `pnpm db:migrate`.

| Entity | Table | Scope | Notes |
|---|---|---|---|
| User | `users` | global | email unique, PBKDF2 hash, phone for WhatsApp |
| Organization | `organizations` | tenant | plan (`trial\|starter\|pro\|enterprise`), `trial_ends_at` (008/FR-035: created + 14 days at sign-up; trial orgs that existed before migration 0022 got max(created + 14 d, migration + 7 d); null on paid plans; set or kept by `POST /admin/orgs/:id/plan` when moved to trial), onboarding state, scoring weights. `onboarding_state` is jsonb of booleans, keys limited to `company, categories, watchlist, documents, skipped, completed, demo` (≤ 16; enforced by `PATCH /org`, 007/FR-048) and merged with `||`; `demo` marks an org that loaded the demo dataset |
| Membership | `memberships` | org | role: owner, bid_manager, analyst, viewer |
| Invitation | `invitations` | org | hashed token, expiry |
| Session / API token | `sessions`, `api_tokens` | user | hashed opaque tokens |
| Notification prefs | `notification_prefs` | org+user | channels, instant/daily, expiry reminders |
| Company profile | `company_profiles` | org (1:1) | GSTIN, PAN, Udyam/MSE, Startup, MII class, financial years, categories, OEM auths (`documentId` → an `oem_authorization` vault doc); `updated_at` is the optimistic-concurrency token (`expectedUpdatedAt`) |
| Past contract | `past_contracts` | org | value, buyer, CRAC doc link |
| Vault document | `vault_documents` | org | type, number, issue/expiry, FY, blob key, `content_sha256` (hex SHA-256 of the current file for duplicate detection; null = unknown, hashed lazily; the sentinel `'missing'` marks a row whose blob is gone so it is not re-read), `last_reminder_days`; status derived; idx `org_id`, `(org_id,type)`, `(org_id,content_sha256)`, `expiry_date` (reminder scan) |
| Vault document version | `vault_document_versions` | org | previous files of a vault document kept on replace/renew (max 5): `document_id` (cascade), blob key, file name, mime, size, pages, expiry while current, `replaced_by`, `replaced_at`; idx `org_id`, `(document_id, replaced_at desc)` |
| Tender | `tenders` | global (public) | unique (source, bid_number); content hash for change detection. Demo tenders: `source = 'demo'`, `raw.demo = true`; exposed to clients as `isDemo` (007/FR-067); global, so removing demo data leaves them |
| Tender event | `tender_events` | global | created/updated/corrigendum/closed |
| Tender document | `tender_documents` | global (org_id null) or org upload | extracted text, pages split by `\f`; `page_count` = pages read (capped at 150), `total_pages` = the PDF's real count (008/FR-030, null on older rows); shared extraction cache (008/FR-072) `requirements jsonb`, `extractor_version`, `extracted_at`, `extracted_method`, written and read **only** for GeM-fetched rows (`org_id` null) so no tenant's upload can feed another's analysis |
| Ingestion run | `ingestion_runs` | global | health metrics, `listing_stop`; unique partial index `ingestion_runs_one_running_uq` on `((true)) WHERE status = 'running'` allows one running run cluster-wide (008/FR-025) |
| GeM request lease | `gem_throttle` | global | one row `id='gem'`; `next_slot_at` moves forward by the minimum interval per request so all isolates share 1 request/s (008/FR-024) |
| Rate-limit counter | `rate_limits` | global | PK `(key, window_start)`, `count`; `key` = `<rule>:<subject>`; one upsert per applied rule, dead windows pruned by the scheduler; idx `rate_limits_window_idx` (008/FR-017). Credential limits use `auth_attempts` (002) |
| Daily job claim | `job_runs` | global | PK `(job, day)` (IST day), `started_at`, `finished_at`, `summary`; the first scheduled tick of the day claims the housekeeping job, a failed run deletes its claim (008/FR-070) |
| Watchlist | `watchlists` | org | `WatchlistCriteria` JSON |
| Tender match | `tender_matches` | org | unique (org, tender, watchlist); reasons |
| Analysis | `analyses` | org | requirements, factors, checklist, score, verdict, stale flag; `warnings jsonb` machine-readable caveats (`llm_budget_exhausted`, `llm_quota_reached`; 008/FR-031); `seeded` = written by the demo seeder, the only rows outside the monthly quota (008/FR-036); idx `(org_id, tender_id, created_at desc)` for latest-analysis lookups |
| Bid workspace | `bid_workspaces` | org | stage, assignees, doc mapping, overrides, assist values, outcome; unique `(org_id, tender_id)`; idx `bid_workspaces_org_stage_idx` on `(org_id, stage)` serves the dashboard/pipeline stage aggregates (007/NFR-001) |
| Comment | `comments` | org | per workspace |
| Annexure template | `annexure_templates` | system (org null) or org | `{{placeholder}}` body |
| Packet | `packets` | org | ordered items, warnings, merged blob |
| Packet ledger | `packet_ledger` | org | one row per packet a user built; `packet_id` has no foreign key, so the monthly packet quota survives deleting the packet (removed only when the build fails); idx `(org_id, created_at)` (008/FR-036) |
| Notification | `notifications` | org+user | outbox for in-app/email/WhatsApp, dedupe key; `attempts`, `next_attempt_at` for delivery retries (003); partial idx `notifications_pending_idx` on `(created_at) WHERE status = 'pending' AND channel IN ('email','whatsapp')` serves the dispatcher and the health backlog count (008/FR-029) |
| Subscription | `subscriptions` | org | plan changes made by the operator via `POST /admin/orgs/:id/plan`: `plan`, `status` (`active\|cancelled`), `started_at`, `ends_at`, `note`, `created_by`; idx `(org_id, created_at desc)`; the org's current plan stays on `organizations.plan` (008/FR-042) |
| LLM usage | `llm_usage` | org | one row per metered LLM call (`kind` `extract\|assist`, `model`, input/output tokens); `analysis_ref` has no foreign key so the monthly AI quota (count of distinct refs) survives deleting the analysis, `analysis_id` is set null; `reserved` marks a 0-token reservation of an analysis's AI slot; idx `(org_id, created_at)` (008/FR-037, FR-039) |
| Activity log | `activity_log` | org | audit trail. Demo entries carry `meta.demo = true`; `demo.seeded` records `meta.watchlistIds` (provenance for removal); `demo.removed` is not marked demo; `onboarding.completed` carries `meta.durationSec` (007) |

## State machines

- Bid stage: `identified → analysing → go → preparing → ready → submitted → won | lost`, any → `dropped`.
  `ready` requires every mandatory checklist item mapped to a non-expired document or overridden (M role, reason).
- Analysis: `pending → running → done | failed`; `stale=true` when a tender event changes requirements after analysis.
- Vault status (derived): `expired` (expiry < today), `expiring` (≤ 30 days), `valid`.
- Vault reminders: 30 → 7 → 1 → on expiry (0); `last_reminder_days` records the last threshold sent and resets when the expiry date changes (edit or renewal).

## Indexes added since 001 (002, 006, 008)

Open-feed indexes are partial on `status = 'open'`; the bid-number prefix and GIN indexes cover all rows. The tender indexes are built `CONCURRENTLY` (migrations marked `-- tp:non-transactional`,
run statement by statement by `packages/db/src/migrate.ts`):

| Index | Definition | Serves |
|---|---|---|
| `tenders_open_created_idx` | `(created_at desc nulls first) WHERE status='open'` | default feed order |
| `tenders_open_closing_idx` | `(coalesce(end_at,'infinity')) WHERE status='open'` | closing-date sort (replaced `tenders_open_end_idx`) |
| `tenders_open_value_idx` | `(estimated_value desc nulls last) WHERE status='open'` | value sort |
| `tenders_open_state_idx` | `(state, created_at desc nulls first, coalesce(end_at,'infinity')) WHERE status='open'` | `?state=` |
| `tenders_open_ministry_idx`, `tenders_open_category_idx` | `(ministry)` / `(category)` `WHERE status='open'` | facet filters |
| `tenders_search_gin` | GIN on generated `tenders.search tsvector` (`simple` config over bid number, title, category, ministry, department, organisation, buyer office, state, city, item names) | `GET /tenders?q=` and watchlist keyword pre-filter (008/FR-073). The column and index are intentionally **not** in `schema.ts` (a declared column would be read by every `select().from(tenders)`); adding the stored column rewrites `tenders` under an ACCESS EXCLUSIVE lock, so run it off-peak (runbook § Full-text search migration) |
| `tenders_bid_number_prefix_idx` | `(lower(bid_number) text_pattern_ops)` | bid-number prefix search |
| `analyses_org_tender_created_idx` | `(org_id, tender_id, created_at desc)` | latest analysis per tender |
| `notifications_pending_idx` | partial, see Notification | alert dispatcher, health backlog |
| `ingestion_runs_one_running_uq` | partial unique, see Ingestion run | single running ingestion |
| `rate_limits_window_idx`, `llm_usage_org_idx`, `packet_ledger_org_idx`, `subscriptions_org_idx` | see the tables above | pruning and per-org metering |
| `activity_org_type_idx` | `(org_id, entity_type, created_at)` | activity feed filtered by entity type |
| `annexure_templates_org_key_uq`, `comments_ws_idx` | unique `(org_id, key)`; `(workspace_id)` | 006 overrides, comment threads |
