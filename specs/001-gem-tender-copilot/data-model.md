# Data Model — TenderPilot

The executable source of truth is `packages/db/src/schema.ts` (Drizzle). Migrations are generated into
`packages/db/migrations/` with `pnpm --filter @tp/db generate` and applied with `pnpm db:migrate`.

| Entity | Table | Scope | Notes |
|---|---|---|---|
| User | `users` | global | email unique, PBKDF2 hash, phone for WhatsApp |
| Organization | `organizations` | tenant | plan, onboarding state, scoring weights. `onboarding_state` is jsonb of booleans, keys limited to `company, categories, watchlist, documents, skipped, completed, demo` (≤ 16; enforced by `PATCH /org`, 007/FR-048) and merged with `||`; `demo` marks an org that loaded the demo dataset |
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
| Tender document | `tender_documents` | global (org_id null) or org upload | extracted text, pages split by `\f` |
| Ingestion run | `ingestion_runs` | global | health metrics |
| Watchlist | `watchlists` | org | `WatchlistCriteria` JSON |
| Tender match | `tender_matches` | org | unique (org, tender, watchlist); reasons |
| Analysis | `analyses` | org | requirements, factors, checklist, score, verdict, stale flag |
| Bid workspace | `bid_workspaces` | org | stage, assignees, doc mapping, overrides, assist values, outcome; unique `(org_id, tender_id)`; idx `bid_workspaces_org_stage_idx` on `(org_id, stage)` serves the dashboard/pipeline stage aggregates (007/NFR-001) |
| Comment | `comments` | org | per workspace |
| Annexure template | `annexure_templates` | system (org null) or org | `{{placeholder}}` body |
| Packet | `packets` | org | ordered items, warnings, merged blob |
| Notification | `notifications` | org+user | outbox for in-app/email/WhatsApp, dedupe key |
| Activity log | `activity_log` | org | audit trail. Demo entries carry `meta.demo = true`; `demo.seeded` records `meta.watchlistIds` (provenance for removal); `demo.removed` is not marked demo; `onboarding.completed` carries `meta.durationSec` (007) |

## State machines

- Bid stage: `identified → analysing → go → preparing → ready → submitted → won | lost`, any → `dropped`.
  `ready` requires every mandatory checklist item mapped to a non-expired document or overridden (M role, reason).
- Analysis: `pending → running → done | failed`; `stale=true` when a tender event changes requirements after analysis.
- Vault status (derived): `expired` (expiry < today), `expiring` (≤ 30 days), `valid`.
- Vault reminders: 30 → 7 → 1 → on expiry (0); `last_reminder_days` records the last threshold sent and resets when the expiry date changes (edit or renewal).
