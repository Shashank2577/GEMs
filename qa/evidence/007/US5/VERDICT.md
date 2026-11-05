## QA verdict — APPROVED

**Work item:** #296 · **PR:** #525 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc

Branch `story/GEM-296-persona-widgets`, tested at head 1afe2e5 (no later commit landed before the QA commit). Spec: `specs/007-experience-growth/spec.md` US5 (US5-1 … US5-6), FR-070 … FR-073.

**Playwright:** `pnpm exec playwright test e2e/007-experience-growth/US5*` -> **17 passed, 0 failed** (desktop 13, mobile/Pixel 7 4 @mobile). **API:** `pnpm --filter @tp/api test` -> 562 passed, 2 skipped (pre-existing perf skips), 0 failed; `apps/api/test/dashboard.test.ts` 20 passed. **Web:** `pnpm --filter @tp/web test` -> 209 passed.

Base URL for links: https://github.com/Shashank2577/GEMs/blob/story/GEM-296-persona-widgets/qa/evidence/007/US5/

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| US5-1 | Fresh org + Viewer: no "Explore with demo data", no "Create a watchlist"; text "Ask an Owner or Bid Manager to set up watchlists." shown | met | [viewer](US5-1-viewer-fresh-org-ask-text-no-create-watchlist.png), [owner contrast](US5-1-owner-same-org-has-the-ctas.png), [375px](US5-1-viewer-fresh-org-mobile-375.png), [json](US5-1-viewer.json), [role CTAs](FR-073-gated-ctas.json) |
| US5-2 | Analyst owns A (due tomorrow, Preparing), assignee on B (due in 3 days, Go): `myWork` = A then B with id/title/bidNumber/stage/dueAt/endAt/readiness.percent+blockers, <= 5, no submitted/won/lost/dropped | met | [json](US5-2-mywork-analyst.json): exact order A,B; after assigning 12 more workspaces (incl. excluded stages) list is capped at 5, sorted by due, no excluded stage |
| US5-3 | Analyst `/dashboard`: "My bids" directly after KPI tiles with A and B, stage badge, "Due <date>" (red when overdue), readiness; no assignments -> "Nothing assigned to you — bids you own or are assigned to will appear here." | met | [after KPI tiles](US5-3-analyst-my-bids-after-kpi-tiles.png), [overdue red](US5-3-overdue-red-due-date.png), [empty](US5-3-empty-state-nothing-assigned.png), [mobile](US5-3-analyst-my-bids-mobile-375.png), [placement](US5-3-placement.json), [overdue json](US5-3-overdue-and-empty.json) |
| US5-4 | Owner API: `awaitingDecision` lists both analysing+done workspaces (<= 5, oldest first) with score and verdict | met | [json](US5-4-awaiting-decision-owner.json): order equals the DB ground-truth order; other org's member gets empty lists |
| US5-5 | Owner at 375 px taps Go: one `PATCH {stage:"go"}`, row disappears, toast "Moved to Go", funnel updates; Drop asks "Drop this bid?" and moves to `dropped` | met | [before](US5-5-mobile-awaiting-decision-375.png), [after Go](US5-5-mobile-after-go-toast-row-gone-funnel.png), [Drop dialog](US5-5-mobile-drop-confirmation-dialog.png), [after Drop](US5-5-mobile-after-drop-card-empty.png), [json](US5-5-go-and-drop.json) (exactly 1 PATCH, no dialog for Go, funnel Go +1 / Analysing -1, nothing sent before Drop confirmed); desktop [confirm](US5-5-desktop-drop-confirmation.png), [after Go](US5-5-desktop-after-go.png); [video](us5-5-mobile-owner-at-375-px-one-tap-on-go-one-patch-toast-m-desktop.webm), [video desktop](us5-5-desktop-owner-go-is-one-click-no-dialog-drop-cancel-ke-desktop.webm); real touch tap in the Pixel 7 run |
| US5-6 | Analyst/Viewer, incomplete setup: no "Finish setting up", Go / No-Go card shown; "Awaiting your decision" read-only for Analyst (no Go/Drop), hidden for Viewer | met | [analyst](US5-6-analyst-go-nogo-card-awaiting-read-only.png), [viewer](US5-6-viewer-go-nogo-card-no-widgets.png), [mobile](US5-6-analyst-awaiting-read-only-mobile-375.png), [json](US5-6-setup-incomplete.json) (Owner and Bid Manager on the same org still see "Finish setting up"); [video](us5-6-org-with-incomplete-setup-analyst-and-viewer-get-go-no-desktop.webm) |
| FR-070 | `myWork` / `awaitingDecision` in `GET /api/dashboard` | met | US5-2, US5-4 above; `dashboard.test.ts` 20 passed |
| FR-071 | "My bids" after KPI tiles for analyst and bid_manager; below the first row for owner; hidden for Viewer | met | [owner](FR-071-owner-my-bids-below-first-row.png), [bid manager](FR-071-bid-manager-both-cards.png), [viewer](FR-072-viewer-neither-widget.png), [matrix json](FR-071-072-role-matrix.json) (pixel positions); [video](fr-071-072-role-matrix-on-a-demo-org-placement-of-my-bids-an-desktop.webm) |
| FR-072 | Awaiting card with Go / Drop for bid_manager+, read-only for analyst, hidden for viewer | met | matrix json: Owner and Bid Manager 2 Go + 2 Drop buttons, Analyst 0, Viewer card absent |
| FR-073 | Role-gated CTAs hidden for roles that would get 403 | met | [json](FR-073-gated-ctas.json): Viewer has 0 "Create a watchlist" and `POST /api/watchlists` -> 403; Analyst/Bid Manager/Owner keep it; "Finish setting up" per US5-6 |

### Findings

1. **observation** — "read-only for Analysts" is a UI rule only: an Analyst `PATCH /api/workspaces/:id {stage:"go"}` returns 200 (the pipeline lets analysts move cards, [json](FR-071-072-role-matrix.json) `analystPatchStatus`). Not a criterion failure (Viewer gets 403); flagging in case Go / No-Go is meant to be bid_manager+ at the API level.
2. **observation** — the setup-incomplete case for US5-6 was produced by deleting the org's vault documents in the e2e DB (a demo org otherwise has complete setup); the card logic is data-driven so this is equivalent.
3. **observation** — a brand-new Owner/Bid Manager is redirected to `/onboarding` on the first dashboard visit (existing US3 behaviour, accounted for in the tests).

### Not checked

- Videos exist only for tests driven on the Playwright `page`; tests whose UI runs in an invited-user context have screenshots + JSON instead (those videos were near-empty and dropped). Mobile (Pixel 7) videos dropped for the evidence budget; mobile runs passed and mobile screenshots are kept.
- Screenshots were palette-reduced (128 colours) to fit the evidence budget; the old `dev-*.png` were deleted (replaced by QA screenshots).
- Concurrent double-tap on Go (code uses an in-flight guard; not exercised by e2e).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
