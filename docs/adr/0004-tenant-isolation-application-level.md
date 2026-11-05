# ADR-0004: Tenant isolation is application-level (org_id scoping + sweep test); demo data must be tenant-safe

**Status**: Accepted (scoping model) · Proposed (demo-data fix, sweep test; RLS LATER)
**Date**: 2026-11-05
**Priority**: MUST (demo-data fix, sweep test) · LATER (RLS)

## Context

Every org-owned table carries `org_id` (`packages/db/src/schema.ts`), routes resolve the active org from the
session (`middleware/auth.ts#orgId`), and services take `org` explicitly (`services/packet.ts`, `services/analyse.ts`,
`routes/vault.ts`, …). Foreign ids return 404. Public GeM data (`tenders`, `tender_events`,
`tender_documents.org_id IS NULL`) is intentionally shared, and org uploads of tender documents are visible only
to the uploading org (`org_id IS NULL OR org_id = $org`). Review of all 14 routers found no query that reads an
org-owned table without the org predicate.

Two real gaps:

1. **Demo data leaks across tenants.** `POST /demo/seed` (`routes/demo.ts` → `packages/db/src/demo.ts`) upserts
   ~dozens of fabricated tenders with `source: 'gem'` and realistic bid numbers (`GEM/2026/B/64xxxxx`) into the
   global `tenders` table. Every other organization sees them in `GET /tenders`, their watchlists match them
   (`candidateTenders`, and `matchAndNotify` if a demo seed ever runs during ingestion), and their dashboards count
   them. For a paying customer this is fake government tenders in the product.
2. **No automated proof of isolation.** Spec 002 lists an isolation sweep (T052) as a gap; nothing executes it today.

Postgres RLS would add defence in depth but requires a per-request `SET LOCAL app.org_id`, a DB role without
`BYPASSRLS`, and policies on ~18 tables; with Hyperdrive/PgBouncer transaction pooling the `SET LOCAL` must be
inside every transaction. Reasonable later, not the smallest fix now.

## Decision

1. **Demo tenders get `source = 'demo'` (MUST)**. `packages/db/src/demo.ts` writes `source: 'demo'` (the unique
   index is `(source, bid_number)`, so nothing else changes). Readers filter:
   - `routes/tenders.ts#buildFilters`, `routes/watchlists.ts#candidateTenders`, `routes/ingestion.ts` counts,
     `routes/dashboard.ts` relevant-tender SQL: add `tenders.source = 'gem' OR (tenders.source = 'demo' AND <org has demo>)`,
     where "org has demo" is `c.var.org.onboardingState.demo === true` evaluated in the handler (no join).
   - `services/ingest.ts#matchAndNotify` selects only `source = 'gem'` tenders (ingestion never touches demo rows).
   - Demo matches/analyses/workspaces are already org-scoped; unchanged.
   - Provide `POST /demo/reset` (bid_manager+) later if needed; out of scope here.
2. **Isolation sweep test (MUST)**. `apps/api/test/isolation.test.ts`: create org A and org B with full fixtures
   (watchlist, vault doc, tender doc upload, analysis, workspace, packet, comment, template override, API token,
   notification); as B, call every org-scoped `GET`/`PATCH`/`DELETE` with A's ids and assert 404 (or 409/403 where
   the contract says so) and that A's rows are unchanged. Keep the list of endpoints in one table in the test so
   new routes fail the test until added.
3. **RLS (LATER)** — revisit when there is a second code path to the database (reporting, admin tools) or on a
   customer security questionnaire requiring it.

## Consequences

- Demo mode keeps working for the org that opted in; other orgs never see fabricated data. Existing demo rows in
  production need a one-off `UPDATE tenders SET source='demo' WHERE content_hash LIKE 'demo-%'` in the migration.
- The sweep test turns Constitution IV from a convention into a CI gate.
- RLS remains an explicit, scheduled debt rather than an implicit assumption.

## Acceptance

- API test: org B's `GET /tenders` after org A seeds demo returns zero rows with `source='demo'`; org A's feed shows
  them; org B's watchlist preview never counts them.
- `isolation.test.ts` covers every org-scoped route listed in `contracts/api.md` and passes.
