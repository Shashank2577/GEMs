## QA verdict — APPROVED

**Work item:** none (cross-cutting; epic #173) · **PR:** #536 · **Branch/HEAD under test:** story/GEM-173-hardening @ d5cb2b2 · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

**Playwright (full 006 regression):** `pnpm exec playwright test e2e/006-apply-packet-assist` → **132 passed, 0 failed** (desktop + mobile, includes the 6 HARDEN tests; no flaky rerun needed).
**HARDEN spec alone:** `pnpm exec playwright test e2e/006-apply-packet-assist/HARDEN` → **6 passed, 0 failed** (4 desktop, 2 mobile 375px).

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1a | Migration 0020 applies from scratch; indexes `annexure_templates_org_key_uq` UNIQUE(org_id,key), `comments_ws_idx` are created by 0020; `bid_workspaces_org_stage_idx` already existed (migration 0008) and is present | met | psql `\d` on a fresh DB; e2e test T010 checks `pg_indexes` |
| 1b | Applies on a DB seeded with duplicate annexure_templates rows: dedupe keeps newest, index builds | met | org A key k1 3 rows → 1 ("newest" by updated_at kept); k2, other org's k1 and NULL-org system rows untouched |
| 1c | Second `drizzle-kit generate` | met | "No schema changes, nothing to migrate" |
| 1d | Concurrent PUT /annexure-templates/:key → 200s, one row | met | 12 parallel PUTs → [200 ×12], 1 row (T010 test, `concurrent-put-annexure-desktop.png`, webm) |
| 2 | Packet reorder announcements (keyboard drag) with screenshot, axe 0 serious/critical, desktop + @mobile | met | `live-region-sequence-*.txt`, `announce-1..4-*.png`, `axe-packet-step-*.png`, `*.axe.json`, webms |
| 3 | contracts/api.md codes exist against live calls | met | `contract-spot-check.txt`: invalid_transition 409, nothing_to_override 409, unknown_placeholder 400, forbidden_field 400, DELETE comment 204/404/403, read_only_token 403; packet_too_large covered by US5 S14 in the regression |
| 4 | NOTICE entries present and honest | met | run-budget.ts entry states "the idea only; no code copied" |
| 5 | Full 006 regression | met | 132 passed, 0 failed |

Announcement sequence observed (desktop): "Picked up PAN card of the firm. Position 6 of 8." → "PAN card of the firm moved to position 6 of 8." → "… moved to position 5 of 8." → "Dropped PAN card of the firm. Position 5 of 8."; cancel path: "Reordering cancelled. PAN card of the firm returned to position 5 of 8."

### Findings (non-blocking observations)
1. **minor** — dnd-kit emits a redundant "moved to position <same> of 8" straight after "Picked up", so a screen reader hears two messages on pick-up.
2. **observation** — full-page axe (not just the Packet step) reports one serious `label-content-name-mismatch` on the shared workspace header buttons `Owner and assignees` and `Internal due date` (outside the HARDEN diff; Packet step scope is clean, same scope as US5). Evidence: `packet-full-page-observation-*.axe.json`.
3. **observation** — `fullPage` screenshots cancel an in-progress dnd-kit drag (viewport resize); the HARDEN test uses viewport-only shots mid-drag.

### Not checked
- Migration number CI guard (follow-up noted by cairn); NFR-003 memory (#500); running the migration against a production-sized table (lock time).

### Verdict
`qa:approved` — every criterion met, evidence above.
