# Data Model — TenderPilot

The executable source of truth is `packages/db/src/schema.ts` (Drizzle). Migrations are generated into
`packages/db/migrations/` with `pnpm --filter @tp/db generate` and applied with `pnpm db:migrate`.

| Entity | Table | Scope | Notes |
|---|---|---|---|
| User | `users` | global | email unique, PBKDF2 hash, phone for WhatsApp |
| Organization | `organizations` | tenant | plan, onboarding state, scoring weights |
| Membership | `memberships` | org | role: owner, bid_manager, analyst, viewer |
| Invitation | `invitations` | org | hashed token, expiry |
| Session / API token | `sessions`, `api_tokens` | user | hashed opaque tokens |
| Notification prefs | `notification_prefs` | org+user | channels, instant/daily, expiry reminders |
| Company profile | `company_profiles` | org (1:1) | GSTIN, PAN, Udyam/MSE, Startup, MII class, financial years, categories, OEM auths |
| Past contract | `past_contracts` | org | value, buyer, CRAC doc link |
| Vault document | `vault_documents` | org | type, number, issue/expiry, FY, blob key; status derived |
| Tender | `tenders` | global (public) | unique (source, bid_number); content hash for change detection |
| Tender event | `tender_events` | global | created/updated/corrigendum/closed |
| Tender document | `tender_documents` | global (org_id null) or org upload | extracted text, pages split by `\f` |
| Ingestion run | `ingestion_runs` | global | health metrics |
| Watchlist | `watchlists` | org | `WatchlistCriteria` JSON |
| Tender match | `tender_matches` | org | unique (org, tender, watchlist); reasons |
| Analysis | `analyses` | org | requirements, factors, checklist, score, verdict, stale flag |
| Bid workspace | `bid_workspaces` | org | stage, assignees, doc mapping, overrides, assist values, outcome |
| Comment | `comments` | org | per workspace |
| Annexure template | `annexure_templates` | system (org null) or org | `{{placeholder}}` body |
| Packet | `packets` | org | ordered items, warnings, merged blob |
| Notification | `notifications` | org+user | outbox for in-app/email/WhatsApp, dedupe key |
| Activity log | `activity_log` | org | audit trail |

## State machines

- Bid stage: `identified → analysing → go → preparing → ready → submitted → won | lost`, any → `dropped`.
  `ready` requires every mandatory checklist item mapped to a non-expired document or overridden (M role, reason).
- Analysis: `pending → running → done | failed`; `stale=true` when a tender event changes requirements after analysis.
- Vault status (derived): `expired` (expiry < today), `expiring` (≤ 30 days), `valid`.
