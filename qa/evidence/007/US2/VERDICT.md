## QA verdict - REJECTED

**Work item:** #293 (T037 / #319) - **PR:** #491 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mGCHY2BZng3gMKswFn

Test file: `e2e/007-experience-growth/US2-pipeline.e2e.ts`. Run twice with `pnpm exec playwright test e2e/007-experience-growth/US2*` (desktop + mobile): **23 passed, 2 failed** both times (the 2 failures are the not-met criteria below, kept as spec-literal tests). API: `vitest run test/workspace.test.ts` 44 passed, 0 failed.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| US2-1 | Viewer GET /api/workspaces: 200, total 16, 16 items, byStage matches; ?stage=won,lost total 3; ?stage=archived 400 validation_error with details.fields.stage | met | [US2-01-viewer-lists-16-bids.png](US2-01-viewer-lists-16-bids.png); US2-01-api-responses.json |
| US2-2 | /pipeline: 8 columns in order, counts 3,2,2,2,1,3,2,1, hints, "16 bids · EMD ₹… at stake" | met | [US2-02-board-eight-columns.png](US2-02-board-eight-columns.png) |
| US2-3 | Analyst drags first Identified card to Analysing: toast "Moved to Analysing", PATCH {stage:"analysing",position}, persists on reload (Identified 2 / Analysing 3); pointer-drag smoke also passes | met | [US2-03-moved-to-analysing-toast.png](US2-03-moved-to-analysing-toast.png); US2-03-patch.json; US2-03b-pointer-drag-smoke.png |
| US2-4 | Dashboard latest activity workspace.stage_changed meta {from:identified,to:analysing}, actor name, href /workspaces/<id> | met | [US2-04-dashboard-activity-stage-changed.png](US2-04-dashboard-activity-stage-changed.png); US2-04-dashboard-latest-activity.json |
| US2-5 | Blocked Preparing card to Ready: 409 not_ready with blockers >= 1, card returns, toast "Can’t move to Ready to submit yet" + Missing + Open workspace -> /workspaces/<id> | met | [US2-05-blocker-toast-card-snapped-back.png](US2-05-blocker-toast-card-snapped-back.png); US2-05-409-response.json; US2-05-open-workspace-navigated.png |
| US2-6 | No completed analysis -> Ready: 409 conflict, exact message, details.reason not_analysed (API and UI toast) | met | [US2-06-not-analysed-toast.png](US2-06-not-analysed-toast.png); US2-06-not-analysed-409.json |
| US2-7 | Submitted -> Won: 200, outcome {won, at}, toast "Marked as won" suggesting L1, Win rate 75% (3 won, 1 lost) | met | [US2-07-marked-as-won-toast.png](US2-07-marked-as-won-toast.png); US2-07-patch-response.json; US2-07-dashboard-win-rate-75.png |
| US2-8 | Viewer: no drag handles / Move-to menus, empty columns read "No bids", view-only note text, direct PATCH 403 | met | [US2-08-viewer-read-only-board.png](US2-08-viewer-read-only-board.png); US2-08-viewer-patch-403.json |
| US2-9 | PATCH foreign-org workspace id as Analyst -> 404, owning org unchanged | met | [US2-09-owning-org-unchanged-after-foreign-patch.png](US2-09-owning-org-unchanged-after-foreign-patch.png); US2-09-cross-org-404.json |
| US2-10 | Search filters cards (case-insensitive; title, bid number, buyer), "Clear filters" appears; closing=3 in URL and only endAt within 72 h remain; Clear filters returns 16 cards and an empty query string. NOTE: demo data contains no "dell" (literal term matches 0 bids; verified with DESKTOP, buyer "indian army", bid number 6401337) - see observation 3 | met | [US2-10-search-desktop-case-insensitive.png](US2-10-search-desktop-case-insensitive.png); US2-10-search-dell-no-match.png; US2-10-closing-in-3-days.png; US2-10-filters-cleared-16-cards.png |
| US2-11 | Table: columns Tender/Stage/Score/Closes/EMD/Readiness/Owner, 16 rows by stage then closing, reload keeps Table (localStorage tp:pipeline-view, stored JSON-encoded as "table"), row click opens /workspaces/<id> | met | [US2-11-table-view.png](US2-11-table-view.png); US2-11-table-view-after-reload.png |
| US2-12 | /pipeline?stage=won: Won column scrolled into view and outlined; Table shows only Won rows | met | [US2-12-won-column-focused.png](US2-12-won-column-focused.png); US2-12-table-only-won-rows.png |
| US2-13 | Keyboard: Space, ArrowRight x2, Space lands two columns right; announcements Picked up / Over / Dropped in; Escape -> "Drag cancelled." and card returns | **not met** | [US2-13-literal-two-presses-result.png](US2-13-literal-two-presses-result.png); US2-13-literal-two-arrow-presses.json (two presses -> stage analysing, one column); with three presses it lands in Go: US2-13-keyboard-drop-two-columns-right.png, US2-13-announcements.json; Escape ok: US2-13-escape-cancels-card-returns.png |
| US2-14 | 375 px: Jump to stage chips with counts, columns 84vw (max 320) with snap scrolling, Won chip scrolls Won into view, no page-level horizontal overflow (desktop + mobile projects) | met | [US2-14-mobile-chips-board.png](US2-14-mobile-chips-board.png); US2-14-mobile-won-chip-scrolled.png |
| US2-15 | Empty org: "Your pipeline is empty" + Browse matched tenders -> /tenders?matched=1; filters matching nothing in Table view: "No bids match these filters" | **not met** | [US2-15-table-search-no-match.png](US2-15-table-search-no-match.png); Empty org and owner filter (Unassigned) OK: US2-15-empty-pipeline.png, US2-15-table-no-bids-match-filters.png. A search matching nothing shows "Your pipeline is empty" + Browse matched tenders instead (board and table) |
| US2-16 | Move to… menu (keyboard-openable) -> Go: same PATCH, toast and activity; all other stages listed incl. Dropped, Won/Lost disabled until Submitted | met | [US2-16-moved-to-go-via-menu.png](US2-16-moved-to-go-via-menu.png); US2-16-move-to-menu-open.png |
| US2-17 | Won via menu: "Record the result" dialog with GeM L1 hint (mock-gem); Save sends outcome and workspace header shows "Won · L1 ₹29.5 L"; Skip keeps stage-only outcome | met | [US2-17-record-result-dialog-with-l1-hint.png](US2-17-record-result-dialog-with-l1-hint.png); US2-17-workspace-header-won-l1.png; US2-17-skip-keeps-stage-only-outcome.png; US2-17-result-hint.json |
| US2-18 | Drop confirmation "Drop this bid?" / "It leaves the active pipeline but keeps its history."; "Show dropped (1)" toggle adds a ninth Dropped column (persisted) | met | [US2-18-dropped-column-shown.png](US2-18-dropped-column-shown.png); US2-18-drop-confirmation.png |
| US2-19 | Typing "dell" quickly: exactly one GET /api/workspaces?q=dell about 300 ms after the last key, no partial requests, ?q= in URL, survives reload | met | [US2-19-search-q-in-url.png](US2-19-search-q-in-url.png); US2-19-requests.json; US2-19-search-survives-reload.png |

FR-020..FR-033 are covered by the scenarios above (FR-020 US2-1, FR-021 US2-2, FR-022 US2-3/3b/13, FR-023 US2-3/4/7, FR-024 US2-5/6, FR-025 US2-10, FR-026 US2-11/12, FR-027 US2-15, FR-028 US2-14, FR-029 US2-16, FR-030 US2-17, FR-031 US2-18, FR-032 US2-19/8 note, FR-033 API test "position renumbering": 44 passed). FR-022 keyboard and FR-027 filtered-empty are the two partially unmet.

### Findings

1. **blocking** - US2-13 "presses → twice and Space again, Then the card lands two columns to the right".
   - Observed: `US2-13 (literal)` test: Space, ArrowRight, ArrowRight, Space on the first Identified card -> PATCH `{"stage":"analysing","position":1.5}` (one column). Live region: "Over Identified." then "Over Analysing."; the first ArrowRight is a no-op in the card's own column. Three presses are needed to reach Go (`US2-13-announcements.json`).
   - Expected: two presses -> Go.
   - Where: `apps/web/src/features/pipeline/PipelinePage.tsx` (KeyboardSensor with `sortableKeyboardCoordinates`, `closestCorners`, own column is also a droppable).
2. **blocking** - US2-15 "filters that match nothing in Table view, Then 'No bids match these filters' is shown".
   - Observed: in Table view type `zzz-no-such-bid` in the search box -> "Your pipeline is empty ... Browse matched tenders" (also on the Board, and for the literal "dell" of US2-10). Cause: `all = query.data.items` is already filtered server-side by `q`, so `all.length === 0` selects the empty-pipeline state. Owner/closing filters do show "No bids match these filters".
   - Expected: "No bids match these filters" (with Clear filters), not a message claiming the pipeline is empty.
   - Where: `PipelinePage.tsx` (`all.length === 0` branch).

### Observations (non-blocking)

1. Keyboard drag cannot reach a column that is off-screen at 1440 px (Preparing -> Ready: three ArrowRight all announce "Over Preparing."; works once the Ready column is scrolled into view). "Move to…" is the available alternative. Evidence: `obs-keyboard-drag-offscreen-column.png`, `obs-keyboard-offscreen-column.json`.
2. axe (WCAG 2.1 AA) on /pipeline: serious `color-contrast` (4 nodes board, 24 table) and `label-content-name-mismatch` (Owner/Closing comboboxes: aria-label "Owner"/"Closing" vs visible "All owners"/"Any closing date", 2 nodes); Table view also `aria-progressbar-name` (16 nodes). See `pipeline-board-desktop.axe.json`, `pipeline-table-desktop.axe.json`. Not part of US2 criteria; consider a separate issue.
3. Spec/data mismatch: the scenario text uses "dell" and "Dell desktops" but the demo data has no Dell title/buyer/bid number (the card is "Desktop Computers (Q2) ..."). US2-10 was verified with real terms.
4. `localStorage["tp:pipeline-view"]` holds the JSON string `"table"` (with quotes), not the bare `table` the spec writes; behaviour is correct.
5. US2-19 measured the single request about 286 ms after the last keystroke finished (the test waits >= 250 ms).
6. Result hint is cached per bid in `gem_result_hints` (15 min) so repeated runs do not hit mock-gem again; each test uses a fresh org.

### Not checked

- Touch long-press drag (220 ms) - not automated; US2-3b covers the mouse sensor only.
- Loading skeleton (`aria-busy`) and error-state retry (FR-027), and the owner filter beyond "Unassigned".
- Renumbering at difference < 1e-9 (FR-033) was taken from the passing API test, not re-exercised through the UI.

### Verdict

`qa:rejected` - criteria US2-13 and US2-15 not met (rejection 1 of 3 on this item). Videos: see `*.webm` in this folder (US2-3, US2-5, US2-13, US2-14 desktop + mobile, US2-17).
