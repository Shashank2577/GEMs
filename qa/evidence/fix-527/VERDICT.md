## QA verdict — APPROVED

**Work item:** #527 (item 5) · **PR:** #556 · **Reviewer:** qa (claude-code / Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mFf2769n2HrbTB4UYT

Tested at developer head `388f848` (evidence commit `570adda9cef7d3de248068074cf2b47ffab632e7`). There is no story issue; the criteria are the owner decision on #527 item 5 as given to QA.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Analyst gets 403 on PATCH stage go/dropped (cookie + API token); nothing is written | met | cookie and token PATCH go and dropped → 403 `forbidden` "Only a Bid Manager or Owner can make the Go/No-Go call."; stage unchanged; Viewer 403 (route gate); other-org user 404 — [ac1-api-403-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac1-api-403-desktop.png); apps/api `workspace.test.ts` + `roles-matrix.test.ts` pass |
| 2 | Analyst cannot create a workspace directly into go; Bid Manager/Owner can | met | Go verdict: Analyst cookie and token → 201 `analysing`; Bid Manager and Owner → 201 `go` — [ac2-api-create-path-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac2-api-create-path-desktop.png); the Analyst's bid is in the Bid Manager's "Awaiting your decision" ([ac2-bm-dashboard-awaiting-analyst-created-bid-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac2-bm-dashboard-awaiting-analyst-created-bid-desktop.png)) |
| 3 | Bid Manager / Owner can decide Go and Drop (no regression) | met | API Bid Manager→go 200, Owner→dropped 200, Bid Manager→dropped/go 200; the Analyst's attempts to do the same are recorded as 403 only in AC1 — [ac3-ac4-api-moves-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac3-ac4-api-moves-desktop.png) |
| 4 | Analyst keeps every other move (incl. skipping Go, out of go and out of dropped) | met | analysing→preparing, →analysing, →identified, go→preparing, dropped→analysing, re-sending current stage all 200 — [ac3-ac4-api-moves-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac3-ac4-api-moves-desktop.png) |
| 5a | UI: Go/Dropped disabled with tooltip in the card Move-to menu | met | `aria-disabled`, hint "Bid Manager only", tooltip appears on keyboard focus (no hover); clicking sends no PATCH — [ac5-move-to-menu-go-disabled-focus-tooltip-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac5-move-to-menu-go-disabled-focus-tooltip-desktop.png) |
| 5b | UI: Go/Dropped disabled with tooltip in the workspace stage dropdown | met | same, plus another stage still works (PATCH 200) — [ac5-workspace-stage-menu-dropped-disabled-focus-tooltip-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac5-workspace-stage-menu-dropped-disabled-focus-tooltip-desktop.png) |
| 6a | Kanban lock + refusal for keyboard, no PATCH | met | lock on Go only; keyboard drop on Go → toast with the refusal text, card returns, Go column count unchanged, 0 PATCH; a non-decision drop still works — [ac6-kanban-go-column-lock-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac6-kanban-go-column-lock-desktop.png), [ac7-keyboard-drop-refused-toast-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac7-keyboard-drop-refused-toast-desktop.png) |
| 6b | Kanban lock + refusal for pointer, no PATCH | met | during the drag the card is not placed in Go, on release toast + 0 PATCH — [ac6-pointer-drop-on-go-refused-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac6-pointer-drop-on-go-refused-desktop.png) |
| 6c | Kanban/menu refusal for touch (mobile project) | met | Pixel 7 `tap` on disabled Go sends no PATCH — [ac8-move-to-menu-disabled-375-mobile.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac8-move-to-menu-disabled-375-mobile.png). Not checked: a real touch-drag gesture (Playwright mouse is used for pointer; the board uses the same PointerSensor path) |
| 7 | a11y: refused drop announced as locked, never "Dropped in Go." | met | live region contains "Go is locked: only a Bid Manager can make the Go/No-Go call." and not "Dropped in Go" (assertion in AC6+AC7 test); screen-reader output itself was not listened to |
| 8 | 375px: no horizontal overflow | met | `noHorizontalOverflow` on the pipeline and with the menu open — [ac8-pipeline-375-mobile.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac8-pipeline-375-mobile.png), [ac8-move-to-menu-disabled-375-mobile.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac8-move-to-menu-disabled-375-mobile.png) |
| 9 | Specs 006/007/001 consistent | met | reviewed in the diff: 006 FR-002/FR-004/US1 #1/story note, 007 FR-022/023/029/072 and scenarios 13/16/18, 001 contracts/api.md create + PATCH rows and decision sentence all state go/dropped = Bid Manager+ (403) and the Analyst-create path; no remaining "UI-only" wording found with `grep` |
| 10 | No regression for Bid Manager flows | met | Bid Manager: no lock, Move to Go 200 + toast, Drop asks for confirmation, keyboard drop and pointer drop on Go 200 — [ac9-bid-manager-moved-to-go-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac9-bid-manager-moved-to-go-desktop.png), [ac9-bid-manager-drop-confirmation-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac9-bid-manager-drop-confirmation-desktop.png), [ac9-bid-manager-keyboard-drop-on-go-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac9-bid-manager-keyboard-drop-on-go-desktop.png), [ac9-bid-manager-pointer-drop-on-go-desktop.png](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac9-bid-manager-pointer-drop-on-go-desktop.png) |

Videos (one per test): `qa/evidence/fix-527/*.webm`, e.g. [keyboard refusal](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac6-ac7-analyst-keyboard-drop-on-go-locked-column-refusal-to-desktop.webm), [pointer refusal](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac6-analyst-pointer-drag-onto-go-the-card-is-not-shown-in-th-desktop.webm), [375px mobile](https://github.com/Shashank2577/GEMs/blob/570adda9cef7d3de248068074cf2b47ffab632e7/qa/evidence/fix-527/ac6-ac8-mobile-375-px-analyst-move-to-menu-keeps-go-dropped--mobile.webm).

### Test runs

- QA spec `e2e/fix-527/go-nogo-role.e2e.ts`: **12 passed, 0 failed** (11 desktop incl. 3 API tests, 1 mobile).
- Touched specs (006 all, 007 US2, US4, US5; 002 US3; 004 US5), 2 runs: after the fixes 006 + 007 US2 = 172 tests, 168 passed, 4 failed (see below); 002 US3 + 004 US5 + 007 US4 + US5 passed except `002 US3 sc9`.
- API: `@tp/api` vitest **920 passed, 2 skipped, 0 failed**. core 567 passed, web 319 passed, `pnpm -r typecheck` clean.

### Findings

1. **observation** — Known failures not caused by this PR: `007 US2-6` ("Tender not found", fails on clean main per the reviewer) and `002 US3 sc9` (pre-existing per the reviewer). Also `006 US5 S4`, `S5`, `S6`: S4's `div[role=status][aria-live=polite]` locator now matches two nodes since the `offline-banner` of #539; S5/S6 depend on S4's build. Neither file nor the banner is touched by this PR; the root cause is stated, but I did not re-run these on a clean main checkout. `006 US4 S7` failed once under load and passed alone; `007 US2-17` passed this time.
2. **observation** — Analyst-created Go-verdict bids now start in `analysing`. That is the intended owner decision (create path), and it is documented in the 006 amendment; Analysts who relied on auto-Go will see their bid waiting for a Bid Manager.
3. **observation** — A full-page screenshot taken mid-drag cancels a Playwright pointer drag (viewport resize); the spec takes the screenshot after release. This is a test-tooling note, not a product defect.

### Not checked

- Real hardware touch drags and an actual screen reader (announcement text is asserted from the live region).
- The extension/MCP/jobs have no stage-write path (taken from the cairn review, not re-audited).
- `006 US5 S4–S6` on a clean main checkout (see finding 1).

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
