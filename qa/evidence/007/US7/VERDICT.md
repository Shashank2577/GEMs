## QA verdict — APPROVED

**Work item:** #298 · **PR:** #539 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc
**Tested commit:** `e965a952b31ebde2ebd0def7b972aea5f9c68173` (branch `story/GEM-298-a11y-responsive`; no later code commit landed during QA)


### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| US7-1a | < 768 px: `nav[aria-label="Primary"]` shows Home, Tenders, Pipeline, Vault, More | met | labels asserted in order, real Pixel 7 touch project too: [metrics](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-1-tab-bar-metrics.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-1-tab-bar.png) |
| US7-1b | More opens the full navigation sheet | met | sheet lists all 8 destinations, axe clean, targets >= 24: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-1-more-sheet.png) |
| US7-1c | sidebar hidden; content not covered by the bar | met | sidebar hidden; main bottom padding 112 px >= bar 57 px; content end 700 < bar top 755: [metrics](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-1-tab-bar-metrics.json) |
| US7-2 | >= 768 px collapsible `aria-label="Sidebar"`, toggles "Collapse sidebar" / "Expand sidebar" | met | 248 px -> 64 px, persists on reload, 767/768 boundary checked: [widths](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-2-sidebar-widths.json), [collapsed](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-2-sidebar-collapsed.png) |
| US7-3a | first Tab shows "Skip to content"; activating moves focus to `#main` | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-3-skip-link-focused.png) (focused box height >= 24) |
| US7-3b | route change focuses `#main` and scrolls to top | met | scrolled 600 px, navigated: `{id:"main", y:0}` (test US7-3) |
| US7-3c | Ctrl/Cmd+K opens the command palette | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-3-command-palette.png), axe clean |
| US7-4a | Dark + reload: dark applied before first paint from `localStorage["tp-theme"]` | met | SPA bundle held 2.5 s: `html.dark` already set, body bg `rgb(12,13,21)`, app not mounted: [probe](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-4-before-first-paint.json) |
| US7-4b | "System" follows `prefers-color-scheme` | met | live toggle and after reload, both schemes: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-4-system-light.png) |
| US7-5a | chunk load failure: "A new version of TenderPilot is available" + reload action | met | `PipelinePage-*.js` aborted via `page.route`; shell intact; Try again reloads and recovers: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-5a-chunk-error.png) |
| US7-5b | render error: "This page hit a snag" + "Try again" inside the shell | met | malformed `/api/dashboard` via `page.route`; nav away recovers: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-5b-render-error.png) |
| US7-6 | `/nope` shows "404", "This page went off the map", "Open dashboard" | met | signed out and in, nested path: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-6-404-signed-out.png) |
| US7-7 | charts expose `role="img"` with text summary | met | "New matches over the last 14 days: 23 in total" equals API `matchesByDay` sum; "Go/No-Go verdicts, 20 analysed: Go 17, Review 0, No-Go 3" equals API: [labels](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-7-chart-labels.json), [series](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-7-api-series.json) |
| US7-8 | 11 pages x {375,1440} x {light,dark}: 0 serious/critical axe, JSON in `axe/` | met | dev sweep re-run 44/44 pass; QA 375 px touch re-run 22/22 pass; all 66 page audits have 0 violations of any impact: [axe/](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/axe) |
| US7-9a | no horizontal page scroll at 375 px | met | asserted on the 44 + 22 audits; pipeline board scrolls in its own container: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-9-pipeline-inner-scroll.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-9-pipeline-375.png) |
| US7-9b | targets >= 24x24, tab bar >= 44x44 | met | asserted on all 66 page audits (sr-only skip link exempt while hidden), More sheet, Move to… menu and dialog |
| US7-10 | `/manifest.webmanifest` linked: name/short_name TenderPilot, start_url `/dashboard`, standalone, colours, 192/512 + maskable icons | met | real icon PNG sizes verified, no `orientation` key, viewport not zoom-locked: [manifest](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-10-manifest.json), [icons](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-10-icon-dimensions.json) |
| US7-11a | offline banner "You’re offline — showing the last loaded data" | met | `context.setOffline(true)`; stale pipeline stays visible; clears on reconnect: [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-11-offline-banner.png), [mobile dark](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-11-offline-mobile-dark.png) |
| US7-11b | mutation fails fast with an error toast, not a spinner | met | "Move to…" while offline: toast after 286 ms, exactly one error toast, no `.animate-spin` / `aria-busy`: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-11-offline-mutation.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-11-offline-mutation-error-toast.png) |
| SC-003 / NFR-004 | 0 serious/critical axe; 2.5.7 / 2.5.8 | met | above, plus "Move to…" keyboard/pointer alternative to drag moved a card Identified -> Analysing: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-8-move-to-result.json) |
| SC-004 | 0 pages with horizontal scroll at 375 px | met | above |

### Test results

- `pnpm exec playwright test e2e/007-experience-growth/US7* --project=desktop`: **59 passed, 0 failed** (44 dev T073 sweep + 15 QA; 22 `@mobile`-only sweep cases skipped on desktop by design)
- `... --project=mobile` (Pixel 7 touch emulation, 375 px viewport): **25 passed, 0 failed** (22-case sweep + 3 `@mobile` scenarios)
- API `pnpm --filter @tp/api test`: 646 passed, 2 skipped; Web `pnpm --filter @tp/web test`: 279 passed (40 files); web `tsc --noEmit` clean
- QA spec: `e2e/007-experience-growth/US7-experience-qa.e2e.ts` (T078)

### Findings

1. **observation** — `aria-hidden-focus` (axe, serious) is reported behind open Radix modal menus: theme menu (4 nodes) and "Move to…" menu (6 nodes). Radix traps focus, and the test proves Tab never reaches the hidden content, so it is not a user-facing failure; all other rules are clean with the menus open. Not covered by the US7-8 criterion (pages in resting state). [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-298-a11y-responsive/qa/evidence/007/US7/us7-8-overlay-observations.json)
2. **observation** — the dev sweep runs in the `desktop` project with a resized viewport and is not tagged `@mobile`, so it never runs under touch emulation; the QA spec's 22-case mobile sweep covers that.

### Not checked

- Real Android Chrome install prompt / Lighthouse installability (only manifest validity, icons and link verified).
- Real screen-reader speech output; `prefers-reduced-motion` behaviour (FR-093 motion half) — not part of US7-1..11 clauses.
- WebKit/Firefox.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
