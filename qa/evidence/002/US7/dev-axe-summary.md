# 002/US7 — developer axe sweep (T097)

axe-core 4.14.0 via `@axe-core/playwright`, tags `wcag2a, wcag2aa, wcag21a, wcag21aa`; counts are **serious + critical
violation nodes**. Each cell is `before → after`. "Before" = `origin/main` @ fb87e27 build, "after" = this branch, both
served by `e2e/support/start-api.sh` against fresh Postgres DBs, signed in as a new Owner (auth pages signed out),
`reducedMotion: reduce`, Chromium, viewport 375×812 (mobile, touch) and 1440×900. Theme set via `localStorage['tp-theme']`.
Overlays are scanned on `/dashboard` with the command palette (Ctrl+K), the "?" shortcuts dialog (new — n/a before),
the phone navigation drawer (375 only) and the open account menu. The `/dashboard` row skips the once-per-session
onboarding redirect. Activity log (`/settings/activity`) does not exist yet (US6/T085), so it is not scanned.

| Page / state | light 375 | light 1440 | dark 375 | dark 1440 |
|---|---|---|---|---|
| `/login` | 0 → 0 | 0 → 0 | 3 → 0 | 3 → 0 |
| `/signup` | 0 → 0 | 0 → 0 | 2 → 0 | 2 → 0 |
| `/forgot-password` | 0 → 0 | 0 → 0 | 2 → 0 | 2 → 0 |
| `/dashboard` | 2 → 0 | 4 → 0 | 4 → 0 | 5 → 0 |
| `/settings/organization` | 1 → 0 | 3 → 0 | 4 → 0 | 5 → 0 |
| `/settings/account` | 2 → 0 | 4 → 0 | 3 → 0 | 4 → 0 |
| `/settings/team` | 1 → 0 | 3 → 0 | 4 → 0 | 5 → 0 |
| `/settings/notifications` | 1 → 0 | 3 → 0 | 3 → 0 | 4 → 0 |
| `/settings/scoring` | 1 → 0 | 3 → 0 | 3 → 0 | 4 → 0 |
| `/settings/api-tokens` | 1 → 0 | 3 → 0 | 3 → 0 | 4 → 0 |
| `/settings/sync` | 1 → 0 | 3 → 0 | 3 → 0 | 4 → 0 |
| `/does-not-exist` | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| `overlay:palette` | 1 → 0 | 2 → 0 | 3 → 0 | 3 → 0 |
| `overlay:shortcuts` | n/a → 0 | n/a → 0 | n/a → 0 | n/a → 0 |
| `overlay:drawer` | 2 → 0 | – | 4 → 0 | – |
| `overlay:usermenu` | 1 → 0 | 2 → 0 | 3 → 0 | 3 → 0 |

Totals (serious + critical nodes): **before 136 → after 0** across 62 scans.

Before, by rule: `aria-progressbar-name` 4, `label-content-name-mismatch` 50, `color-contrast` 74, `aria-required-children` 4, `aria-hidden-focus` 4.


## What was fixed

| Rule | Where | Fix |
|---|---|---|
| `color-contrast` (dark) | `text-primary` links, logo "Pilot", active Settings tab, Owner badge, onboarding link — 3.6–4.2 : 1 | New `--primary-text` token (`243 90% 74%` in dark, = `--primary` in light) mapped to `text-primary` in `tailwind.config.ts`; ≥ 5.1 : 1 on every dark surface. Buttons keep `--primary` (white text 4.6 : 1). |
| `color-contrast` (light) | Sidebar "ORGANIZATION" heading `text-muted-foreground/80` (3.74 : 1) | Dropped the opacity modifier (5.78 : 1). |
| `color-contrast` (light) | Success badge ("This device", 11 px) `#189567` on success-soft (3.53 : 1) | Light `--success` 34% → 28% lightness (4.92 : 1 on success-soft; white-on-success 3.79 → 5.27). |
| `label-content-name-mismatch` | Account menu trigger (`aria-label="Account menu"`, visible initials) | Name now starts with the visible initials: "PS Account menu". |
| `label-content-name-mismatch` | Org switcher trigger (`aria-label="Organization: X. Switch organization"`) | Name from visible content + sr-only "Switch organization"; chip initials `aria-hidden`. |
| `aria-required-children` | Command palette listbox containing cmdk `role="separator"` | `CommandSeparator` renders a decorative `aria-hidden` divider (still hidden while searching). |
| `aria-hidden-focus` | Open account menu: Radix modal menu sets `aria-hidden` on the shell while links stay tabbable | Account menu and org switcher use `modal={false}`. |
| `aria-progressbar-name` | Dashboard "Finish setting up" progress bar | `Progress` gets a default name ("N% complete"); the dashboard passes "Setup X of Y done". |
