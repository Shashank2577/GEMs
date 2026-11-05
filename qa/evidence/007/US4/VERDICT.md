## QA verdict — APPROVED

**Work item:** #295 · **PR:** #519 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc

Branch `story/GEM-295-demo-data`, reviewed at head 540c5d2. Spec: `specs/007-experience-growth/spec.md` US4 (US4-1 … US4-14), FR-060 … FR-067, SC-007.

**Playwright:** `pnpm exec playwright test e2e/007-experience-growth/US4*` → **20 passed, 0 failed** (desktop 17, mobile 3 @mobile). **API:** `pnpm --filter @tp/api test` → 555 passed, 2 skipped (pre-existing perf skips), 0 failed (includes `apps/api/test/demo.test.ts`).

Base URL for links: https://github.com/Shashank2577/GEMs/blob/story/GEM-295-demo-data/qa/evidence/007/US4/

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| US4-1 | No session -> 401; Viewer or Analyst -> 403 on `POST /api/demo/seed` | met | [roles.json](US4-1-roles.json), [screenshot](US4-1-viewer-empty-dashboard-no-explore-button.png) (Viewer sees no "Explore" button); refused calls seeded nothing |
| US4-2 | Bid Manager on a fresh org -> 201 with `{created:true, tenders:40, watchlists:3, workspaces:16, analyses:20, pastContracts:5, vaultDocuments:15, matches:>15}` and `onboardingState.demo = true` | met | [seed-response.json](US4-2-seed-response.json) |
| US4-3 | Second seed (Owner) -> 200 `created:false`; analyses, workspaces, vault docs, global tenders (40) unchanged | met | [second-seed.json](US4-3-second-seed.json) (before/after, DB counts) |
| US4-4 | Profile: Aarav Technologies Pvt Ltd, GSTIN 27AAJCA4721K1ZK, micro, class_1, 3 financial years | met | [profile.json](US4-4-profile.json) |
| US4-5 | Existing profile "Shree Ganesh Traders LLP" kept; org still gets 16 workspaces | met | [profile-kept.json](US4-5-profile-kept.json) |
| US4-6 | Every vault doc downloads as valid one-page PDF (`%PDF-`, `application/pdf`) with the sample footer | met | [pdf-downloads.json](US4-6-pdf-downloads.json) (all 15: content-type, content-disposition, 1 page, footer), [vault](US4-6-vault-15-documents.png) |
| US4-7 | Ready card `verdict = go`; Preparing card bound to the expired OEM (Dell) authorisation -> 409 on move to Ready | met | [blocked-and-ready.json](US4-7-blocked-and-ready.json) (409 `not_ready`, blocker `oem_authorization` state `expired`), [kanban](US4-7-kanban-all-stages.png) |
| US4-8 | Banner "Explore with demo data": spinner, toast "Demo data loaded — explore away!", queries refreshed, "Demo data" badge without reload | met | [desktop](US4-8-badge-and-toast-no-reload-desktop.png), [no-reload.json](US4-8-no-reload-desktop.json) (window marker survived, 0 navigations, seed 201), mobile [json](US4-8-no-reload-mobile.json); [video](us4-8-explore-with-demo-data-on-the-dashboard-banner-spinner-desktop.webm) |
| US4-9 | Seeded notifications `channel = in_app` only, no email/WhatsApp | met | [channels.json](US4-9-channels.json) (all notification rows in_app; activity `meta.demo` rows and one `demo.seeded`) |
| US4-10 | (gap) `DELETE /api/demo` 200 with counts; 0 demo workspaces/analyses/matches/comments/notifications/past contracts/vault docs; demo watchlists gone; "My laptops", "Real GST.pdf" and a user watchlist that has a demo name remain; `demo=false`; `demo.removed` logged; second call all zeros | met | [removal.json](US4-10-removal.json), [watchlists](US4-10-watchlists-after-removal.png), [user workspace on a real tender kept](US4-10b-user-workspace.json) / [png](US4-10b-user-workspace-kept.png). Blob deletion is covered by the API test (spy blob store), not re-proven in e2e |
| US4-11 | (gap) Viewer or Analyst `DELETE /api/demo` -> 403 | met | [forbidden.json](US4-11-forbidden.json) (also 401 anonymous; data intact) |
| US4-12 | (gap) Owner banner "You’re exploring sample data for Aarav Technologies Pvt Ltd." + "Remove demo data"; dialog "Remove all demo data? Your own watchlists, documents and bids stay."; confirm -> toast "Demo data removed", empty dashboard; Viewer/Analyst have no buttons | met | [banner desktop](US4-12-demo-banner-desktop.png), [banner mobile](US4-12-demo-banner-mobile.png), [dialog desktop](US4-12-confirm-dialog-desktop.png), [dialog mobile](US4-12-confirm-dialog-mobile.png), [empty dashboard](US4-12-removed-toast-empty-dashboard-desktop.png), [video](us4-12-banner-confirmation-dialog-cancel-keeps-data-confirm--desktop.webm); cancel keeps data; no horizontal overflow at 375 px |
| US4-13 | (gap) Demo tenders carry a "Sample" badge in the tender feed and on a demo tender page | met | [feed](US4-13-feed-sample-badge-desktop.png), [tender page](US4-13-tender-page-sample-badge-desktop.png), [video](us4-13-demo-tenders-carry-a-sample-badge-in-the-feed-and-on--desktop.webm); mobile layout asserted (no overflow) |
| US4-14 | (gap) Still-demo profile reset on removal; user-edited profile kept | met | [profile.json](US4-14-profile.json) (`profileReset` true vs false) |
| IT | Independent Test: fresh org -> Explore -> badge, 16 cards, 15 docs; real watchlist; Remove -> 0 / 0 / exactly 1 watchlist | met | [screenshot](US4-independent-test-one-watchlist-left.png), [video](independent-test-fresh-org-explore-with-demo-data-badge-16-c-desktop.webm) |

FR coverage: FR-060 (US4-1/2/3), FR-061 (US4-3/5), FR-062 (US4-6/7), FR-063 (US4-9), FR-064 (US4-8), FR-065 (US4-10/11/14), FR-066 (US4-12), FR-067 (US4-13, partly, see below).

### Findings

1. **observation (noted gap, deferred by the team)** — FR-067 says demo tenders MUST be badged "Sample" "wherever tenders are listed or shown". The badge is present in the feed (cards and table) and on the tender page, but not on the dashboard lists or on pipeline cards. Recorded as a Playwright annotation and in [noted-gap-desktop.json](US4-13-noted-gap-desktop.json) shows 0 badges on both surfaces. US4-13 as written ("tender feed or a demo tender page") is met.
2. **observation** — a brand-new owner is redirected to `/onboarding` on the first dashboard visit of a browser session, so the empty-dashboard "Explore with demo data" banner is reached on the second visit. This is existing behaviour (US3), the test accounts for it.

### Not checked

- Blob deletion on removal (verified by `apps/api/test/demo.test.ts` with a spy store, not by e2e).
- Concurrent seed/remove interleaving (code comment says the org row is locked; not exercised).
- Mobile videos were dropped to stay within the evidence budget; mobile tests passed and their screenshots (banner, dialog, feed) are kept for US4-12/13.

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above (one known deferred gap noted, FR-067 follow-up).
