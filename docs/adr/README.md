# Architecture Decision Records

Format: Context / Decision / Consequences / Acceptance. **Status** is `Accepted` for decisions already embodied in
the code and `Proposed` for recommended changes; **Priority** uses MUST-before-paying-customers / SHOULD / LATER.
The assessment that produced these is in [`../architecture.md`](../architecture.md); the tasks derived from the
Proposed items live in spec 008.

| ADR | Title | Status | Priority |
|---|---|---|---|
| [0001](./0001-single-worker-monolith.md) | One Worker serves API, SPA and cron; Workers Paid + `cpu_ms` | Accepted + amendment | MUST |
| [0002](./0002-neon-connection-handling.md) | Pooled Neon endpoint now; Hyperdrive + single `pg` driver next | Proposed | MUST / SHOULD |
| [0003](./0003-shared-global-ingestion-and-gem-politeness.md) | Shared global ingestion, cluster-wide GeM throttle, cooldown, atomic lock | Accepted + Proposed | MUST / SHOULD |
| [0004](./0004-tenant-isolation-application-level.md) | Application-level tenancy; demo data isolation; sweep test; RLS later | Accepted + Proposed | MUST / LATER |
| [0005](./0005-auth-and-session-security.md) | Hashed opaque sessions + PBKDF2; spec 002 hardening; headers; custom domain | Accepted + Proposed | MUST / SHOULD |
| [0006](./0006-notifications-outbox.md) | Notifications outbox + cron dispatcher; pending index; retries; batch | Accepted + Proposed | MUST / SHOULD |
| [0007](./0007-synchronous-analysis-and-packet-with-caps.md) | Synchronous analysis/packet with explicit caps; Queues on trigger | Proposed | MUST / LATER |
| [0008](./0008-llm-cost-control.md) | LLM metering, per-org quota, shared extraction cache | Proposed | MUST / SHOULD |
| [0009](./0009-feed-query-performance.md) | Partial open-tender indexes, column projection, tsvector search | Proposed | MUST / SHOULD |
| [0010](./0010-plan-limits-and-billing-readiness.md) | Plan limits, trial expiry, 402 contract, usage, subscriptions | Accepted | MUST / SHOULD / LATER |
| [0011](./0011-observability.md) | Health with ingestion staleness, monitor, structured logs, Sentry | Proposed | MUST / SHOULD |
| [0012](./0012-data-retention-and-housekeeping.md) | Retention table, housekeeping step, packet retention, R2 lifecycle | Proposed | SHOULD |
| [0013](./0013-deployment-migrations-backups-secrets.md) | CI deploy with migrations, Neon retention, staging, domain, secrets | Proposed | MUST / SHOULD |
| [0014](./0014-rate-limiting-and-abuse-controls.md) | Postgres-backed rate limiter behind `AppDeps`; rule table | Proposed | MUST |
