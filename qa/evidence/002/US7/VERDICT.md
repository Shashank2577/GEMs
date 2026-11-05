# QA verdict — 002 / US7 (#9, PR #508): REJECTED (recommended)

Reviewer: qa (claude-code). Task T098. Spec: `specs/002-platform-tenancy/spec.md` US7 scenarios 1-12, FR-045..FR-048, NFR-004, NFR-005.
Tests: `e2e/002/US7-shell.e2e.ts`. Run: `E2E_PORT=8800 E2E_GEM_PORT=8801 E2E_DATABASE_URL=postgres://tp:tp@localhost:5433/tenderpilot_e2e_us7 pnpm exec playwright test e2e/002/US7*`
Commit under test: 2c1b665.

## Playwright summary

`17 passed, 6 failed, 1 skipped` (24 runs). Desktop project: 13 passed, 4 failed, 1 skipped (20 tests). Mobile project (`@mobile`, Pixel 7): 2 passed, 2 failed (4 tests).
All 6 failures are the axe sweeps of scenario 12 (see Findings). The 1 skip is scenario 10 "activity" (gated until US6 T085).

## Per-criterion results

| # | Scenario (spec US7) | Result | Evidence |
|---|---|---|---|
| 1 | Desktop shell: 248 px sidebar, logo, org switcher "<Org> · <plan> plan · <Role>", "Search… Ctrl K", main nav, Organization group, Co-pilot card, active highlight + left bar | met | `sc1-desktop-shell-248.png` |
| 2 | Collapse -> 64 px icons-only with tooltips, content shifts left, persists (`tp-sidebar-collapsed`) | met | `sc2-collapsed-64-tooltip.png`, `sc2-collapsed-after-reload.png`, `sc2-expanded-after-reload.png` |
| 3 | 375 px: no h-scroll, top bar (menu, logo, search, bell, avatar), tab bar Home/Tenders/Pipeline/Vault/More, More + menu open drawer, closes on navigation (desktop + mobile projects) | met | `sc3-mobile-shell-375.png`, `sc3-drawer-via-more.png`, `sc3-drawer-via-menu-button.png` |
| 4 | Ctrl/Cmd+K and "/" open palette; groups Go to / Quick actions / Preferences (+ Settings); role-filtered quick actions (Analyst+: watchlist, vault; Bid Manager+: invite); >= 2 chars adds "Search tenders for"; opens `/tenders?q=`; Esc closes | met | `sc4-palette-open-ctrl-k.png`, `sc4-palette-filter-vault.png`, `sc4-palette-tender-search-option.png`, `sc4-palette-quick-actions-bid_manager.png` / `-analyst.png` / `-viewer.png`, `sc4-quick-action-create-watchlist.png`, `sc4-quick-action-upload-vault.png`, `sc4-signed-out-from-palette.png` |
| 5 | G then D/T/W/P/V/C/S/N navigates; not in text fields; 1.2 s window | met | `sc5-g-then-d-dashboard.png`, `sc5-no-shortcuts-while-typing.png` |
| 6 | System + dark OS renders dark with no light frame (every rAF frame sampled from the first, 0 light frames); Light/Dark persist in `tp-theme` from toggle, account menu, palette; System follows OS live | met | `sc6-system-dark-no-flash.png`, `sc6-light-persisted-over-dark-os.png`, `sc6-dark-persisted-account-menu.png`, `sc6-system-follows-os.png` |
| 7 | First Tab stop is "Skip to content"; Enter moves focus to `main#main`; focus ring on every following tab stop; focus moves to `main#main` after route change (click and G-shortcut) | met (see observation 1) | `sc7-skip-link-first-tab-stop.png`, `sc7-focus-ring-visible.png`, `sc7-focus-on-main-after-route-change.png` |
| 8 | Unknown URL "This page went off the map" + "Open dashboard"; failed lazy chunk -> "A new version of TenderPilot is available / Reload to get the latest version."; other render error -> "This page hit a snag"; shell survives | met | `sc8-404-page.png`, `sc8-chunk-load-failed-new-version.png`, `sc8-render-error-snag.png` |
| 9 | `prefers-reduced-motion: reduce`: route changes not animated (control with motion allowed: min opacity 0 + transform; reduced: opacity 1, no transform on 3 navigations) | met | `sc9-reduced-motion-route-change.png` (samples in test annotations) |
| 10a | Palette "team", "api token", "notification settings" show the Settings sub-pages and open the right sub-route | met | `sc10-palette-team.png`, `sc10-palette-api-token.png`, `sc10-palette-notification-settings.png` |
| 10b | Palette "activity" shows Activity log | **unverifiable - depends on US6 T085** (entry gated `ready:false` in `apps/web/src/features/settings/items.ts`; test is skipped and flips to an assertion once the entry ships) | `sc10-palette-activity-query.png` (shows no Activity log entry) |
| 11 | "?" opens "Keyboard shortcuts" dialog listing Ctrl K, /, G+letter rows, Esc; also from user menu and palette; dialog is axe-clean | met | `sc11-shortcuts-dialog-via-question-mark.png`, `shortcuts-dialog-desktop.axe.json` |
| 12a | axe 0 serious/critical: overlays at 1440 light+dark (palette, account menu, org switcher) | met | `overlay-*-1440-desktop.axe.json`, `sc12-overlay-*.png` |
| 12b | axe 0 serious/critical: org switcher opened inside the 375 px drawer (light + dark), pick org switches it, Esc returns focus to trigger (both projects) | met | `drawer-org-switcher-open-{light,dark}-375-*.axe.json`, `sc12-mobile-drawer-org-switcher-open-light.png`, `-open-dark.png`, `-esc-focus-returned.png`, `sc12-mobile-drawer-org-switched.png` |
| 12c | axe 0 serious/critical on every shell + settings screen (14 routes) light/dark at 1440 and 375 | **not met** | `shell-{light,dark}-{1440,375}-{tenders,profile}-*.axe.json`; screenshots `sc12-{light,dark}-{1440,375}-dashboard.png`, `sc12-*-settings-team.png` |
| FR-045..047, NFR-005 | covered by scenarios 1-9 above (NFR-005: no h-scroll asserted on all 14 routes at 375; tab-bar touch targets >= 40 px) | met | as above |
| FR-048 | design-system rules (tokens, `ResponsiveTable`, `Field` wiring, etc.) | not exercised by e2e | n/a (static/convention; not an acceptance scenario) |

## Findings

1. **blocking** - Scenario 12 / NFR-004 not met: serious axe violations on `/tenders` and `/profile` (WCAG 2.1 AA, light and dark, 375 and 1440).
   - `/tenders` (light + dark, 1440): `label-content-name-mismatch` (serious) on a closed popover trigger `.shadow-xs[aria-haspopup="dialog"]` - visible text not part of its accessible name.
   - `/profile` light (1440 + 375): `color-contrast` (serious): `.border-info/20` badge text 3.69:1 (#1183d4 on #ebf7ff, 11 px); `.mt-2` text 3.32:1 (#ce7809 on #ffffff, 12 px); `.text-muted-foreground/70` text 3.12:1 (#8e91a1 on #fff, 14 px). Required 4.5:1.
   - `/profile` dark (1440 + 375): `color-contrast` `.text-muted-foreground/70` 4.08:1 (#737687 on #12141e).
   - `/profile` all variants: `label-content-name-mismatch` on `.h-10` (and `.py-1` at 375).
   - Expected: 0 serious/critical on every shell screen. Details: the `*.axe.json` files above (full axe result with node targets). `dev-axe-summary.md` reported these screens clean; the full-route sweep does not.
   - Where: tender filter popover trigger in the Tenders feed; Company profile page (`apps/web/src/features/**`), `apps/web/src/index.css` tokens (`text-muted-foreground/70`).
2. **observation (minor)** - Skip link has no focus ring: on focus it appears as a solid pill (`box-shadow: none`, `outline-style: none`). It is visible so likely WCAG-acceptable, but scenario 7 says "focus rings are visible on every interactive element". The ring assertion in the test covers the 18 stops after it.
3. **observation** - Scenario 9: page transitions only run for already-loaded routes (first visit of a lazy route shows the skeleton with no transition). Reduced-motion behaviour is correct either way.
4. **observation** - `/vault?upload=1` and `/watchlists?new=1` open their dialogs, which then block the next Ctrl+K (expected modal behaviour; the test navigates away between actions).

## Not checked

- FR-048 design-system conventions (tokens, README, `ResponsiveTable` stacked cards) beyond what the screens show; no e2e criterion.
- Content max width 1400 px at 1440 (NFR-005) not measured; no horizontal overflow checked.
- Activity log palette entry (waiting on US6 T085).
- API test counts and unit/typecheck gates were not run in this QA pass.

## Verdict

`qa:rejected` recommended - scenario 12 (axe, NFR-004) not met on `/tenders` and `/profile`. Scenarios 1-9, 10a and 11 are met; 10b is unverifiable until US6 T085 and is not a rejection reason. T098 is NOT ticked.
