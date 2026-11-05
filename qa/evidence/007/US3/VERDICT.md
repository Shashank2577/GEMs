## QA verdict - REJECTED (round 1)

**Work item:** #294 (T048 / #327) - **PR:** #510 - **Reviewer:** qa (claude-code/Sonnet 5.5) - **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc

Head tested: `e5bf5a2`. Test file: `e2e/007-experience-growth/US3-guided-onboarding.e2e.ts`. Run: `pnpm exec playwright test e2e/007-experience-growth/US3*` (desktop + mobile projects): **25 passed, 1 failed** (desktop 20 passed / 1 failed, mobile 5 passed / 0 failed; the mobile US3-1 run first failed on a locator bug in my own test, fixed and re-run green). The single failure is US3-10b, a product defect (below). API/unit gates re-run on the branch: core 379 passed, api 443 passed (2 skipped), web 173 passed, 0 failed; `pnpm typecheck` clean. Independent Test (sign up to matched feed): 50.8 s scripted, 10 matched rows (< 90 s).

Note: the task named `e2e/007/`; the repository convention (US1, US2) is `e2e/007-experience-growth/`, so the file lives there.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| US3-1 | /signup -> /onboarding (or safe ?next=), "Company basics" current; 375 px shows "Step 1 of 5 · Company basics" | met | [US3-01-signup-step1-desktop.png](US3-01-signup-step1-desktop.png); [US3-01-signup-step1-mobile.png](US3-01-signup-step1-mobile.png); [US3-01-step-line-375-from-desktop.png](US3-01-step-line-375-from-desktop.png) |
| US3-2 | Fresh Owner redirected to /onboarding once per session; second /dashboard visit shows dashboard; sessionStorage `tp:onboarding-redirected` = org id | met | [US3-02-first-dashboard-visit-redirected.png](US3-02-first-dashboard-visit-redirected.png); [US3-02-session-key.json](US3-02-session-key.json) (second-visit screenshot dropped for the size budget; assertion is in the test) |
| US3-3 | Empty name: "Enter your registered company name", no request; GSTIN `27AAJCA4721K1ZA` errors at 15 chars | met | [US3-03-empty-name-and-bad-gstin.png](US3-03-empty-name-and-bad-gstin.png); [US3-03-gstin-error.json](US3-03-gstin-error.json) |
| US3-4 | GSTIN `27AAJCA4721K1ZK`: "Valid · Maharashtra · PAN AAJCA4721K", Home state Maharashtra; Continue sends PUT /api/profile (legalName, gstin, pan, state, mseCategory, isStartup, miiClass class_1), PATCH /api/org {company:true}, step 2 | met | [US3-04-gstin-valid-hint-and-home-state.png](US3-04-gstin-valid-hint-and-home-state.png); [US3-04-step2-opened.png](US3-04-step2-opened.png); [US3-04-requests.json](US3-04-requests.json) |
| US3-5 | No category: role=alert text; HSN "84" rejected and no chip; two chips `aria-pressed=true` + custom "Biometric devices"; Continue saves categories/hsnCodes/operatingStates and ticks categories | met | [US3-05-no-category-alert.png](US3-05-no-category-alert.png); [US3-05-chips-hsn-and-custom.png](US3-05-chips-hsn-and-custom.png); [US3-05-requests.json](US3-05-requests.json) |
| US3-6 | Step 3 name "Desktop computers & CCTV & surveillance – Maharashtra", keywords `desktop, cctv, surveillance, network video recorder, biometric devices`, "Live preview N open bids match today", refreshed within 1 s of an edit (481 ms measured) | met (on the fresh path; see US3-10b for the resume path) | [US3-06-watchlist-preview-desktop.png](US3-06-watchlist-preview-desktop.png); [US3-06-watchlist-preview-mobile.png](US3-06-watchlist-preview-mobile.png); [US3-06-preview-timing.json](US3-06-preview-timing.json) |
| US3-7 | Empty keywords+states: "Add at least one keyword", no POST; valid: POST /api/watchlists 201, toast "Watchlist created", watchlist ticked, step 4 | met | [US3-07-add-at-least-one-keyword.png](US3-07-add-at-least-one-keyword.png); [US3-07-watchlist-created-toast.png](US3-07-watchlist-created-toast.png); [US3-07-create-response.json](US3-07-create-response.json) |
| US3-8 | 21 MB PDF: toast "That file is larger than 20 MB", nothing uploaded; valid PDF: file name + Replace, "1 uploaded", button "Continue" (reads "Skip for now" with nothing uploaded); documents:true / documents:false ticked | met | [US3-08-21mb-rejected-toast.png](US3-08-21mb-rejected-toast.png); [US3-08-uploaded-1-uploaded-continue.png](US3-08-uploaded-1-uploaded-continue.png); [US3-08-requests.json](US3-08-requests.json) |
| US3-9 | Done: "You’re ready to win more bids", completed ticked, confetti rendered (none with prefers-reduced-motion), "Go to my feed" -> /tenders?matched=1, "Explore with demo data" seeds, toast "Demo data loaded", -> /dashboard | met | [US3-09-done-step-confetti.png](US3-09-done-step-confetti.png); [US3-09-done-reduced-motion-no-confetti.png](US3-09-done-reduced-motion-no-confetti.png); [US3-09-go-to-my-feed.png](US3-09-go-to-my-feed.png); [US3-09-explore-demo-toast-dashboard.png](US3-09-explore-demo-toast-dashboard.png) |
| US3-10a | Steps 1-2 completed, tab closed: reopening /onboarding opens at step 3; step 1-2 values pre-filled from saved profile; completed stepper step navigates back | met | [US3-10-reopened-at-step-3.png](US3-10-reopened-at-step-3.png); [US3-10-step-1-prefilled-from-profile.png](US3-10-step-1-prefilled-from-profile.png); [US3-10-step-2-prefilled-from-profile.png](US3-10-step-2-prefilled-from-profile.png) |
| US3-10b | (FR-046 "values pre-filled from the saved profile" + FR-043 pre-fill) the step-3 form that opens on resume | **not met** | Watchlist name "My first watchlist", no keywords, no state chips, preview 0: [US3-10b-resume-step-3-form-state.png](US3-10b-resume-step-3-form-state.png); [US3-10b-resume-step3-state.json](US3-10b-resume-step3-state.json) |
| US3-11 | Skip for now: skipped ticked, /dashboard "Finish setting up", progress bar, "0/6", six items linking to /profile, /profile, /watchlists?new=1, /vault?upload=1, /tenders?matched=1, /settings/team; first unfinished highlighted; "Open the guided setup" -> /onboarding | met | [US3-11-finish-setting-up-desktop.png](US3-11-finish-setting-up-desktop.png); [US3-11-finish-setting-up-mobile.png](US3-11-finish-setting-up-mobile.png); [US3-11-checklist-links.json](US3-11-checklist-links.json) |
| US3-12 | setupComplete = true only when all six rules hold (team rule enforced for non-demo orgs); dashboard shows Go / No-Go card instead of "Finish setting up" | met | [US3-12-setup-complete-go-no-go-card.png](US3-12-setup-complete-go-no-go-card.png); [US3-12-before-invite.json](US3-12-before-invite.json) (false, only team missing); [US3-12-after-invite.json](US3-12-after-invite.json) (true) |
| US3-13 | Analyst and Viewer: "You’re all set" / "Your organization’s owners handle setup…" / "Go to dashboard"; PATCH /api/org answers 403 | met | [US3-13-analyst-all-set.png](US3-13-analyst-all-set.png); [US3-13-viewer-all-set.png](US3-13-viewer-all-set.png); [US3-13-patch-403.json](US3-13-patch-403.json) |
| US3-14 | After reload, step 3 primary button reads "Continue", no second watchlist, GET /api/watchlists still exactly one | met | [US3-14-step-3-reads-continue.png](US3-14-step-3-reads-continue.png); [US3-14-watchlists.json](US3-14-watchlists.json) |
| US3-15 | PATCH /api/org `{hacked:true}` and 17 keys: 400 validation_error with details.fields.onboardingState; allowed keys 200 and merged; only one `onboarding.completed` activity entry | met | [US3-15-validation.json](US3-15-validation.json) (API-only criterion, no screenshot) |
| US3-16 | PATCH /api/org 500: wizard still advances, exactly one retry (2 attempts), toast "Couldn’t save your progress — your data is saved, but setup may restart at this step" | met | [US3-16-progress-toast-after-retry.png](US3-16-progress-toast-after-retry.png); [US3-16-retry.json](US3-16-retry.json) |
| US3-17 | GST and PAN already in vault: step 4 cards show uploaded with vault titles, badge "2 uploaded" (Udyam still "Choose file") | met | [US3-17-two-uploaded-premarked.png](US3-17-two-uploaded-premarked.png) |
| IT | Independent Test: sign up, Company, two categories, pre-filled watchlist, skip docs, "Go to my feed": /tenders?matched=1 lists mock-gem bids, scripted time < 90 s | met | [US3-IT-matched-feed-after-onboarding.png](US3-IT-matched-feed-after-onboarding.png); [US3-IT-timing.json](US3-IT-timing.json) (50.8 s, 10 rows) |
| A11y | Wizard step 1 axe WCAG 2.1 A/AA, no serious/critical | met | [onboarding-step1-desktop.axe.json](onboarding-step1-desktop.axe.json) |

Videos (one per test, `*.webm` in this folder): 26 files, one per test per project.

### Findings

1. **major** - Resuming the wizard at step 3 leaves the watchlist form empty instead of pre-filled from the saved categories and states.
   - Observed: signup, complete steps 1 and 2 (categories Desktop computers, CCTV & surveillance, Biometric devices; state Maharashtra), reload/reopen `/onboarding` -> step 3 shows name "My first watchlist", no keyword chips, States "All of India", preview "0 open bids match today". `US3-10b-resume-step3-state.json`: `{"watchlistName":"My first watchlist","chipCount":0}`. Clicking "Create watchlist" in that state yields "Add at least one keyword" (no keywords and no states).
   - Expected: FR-043 "Step 3 MUST pre-fill the watchlist name and keywords from the categories" and FR-046 "reopening the wizard MUST start at the first unticked step with values pre-filled from the saved profile" (US3-10 scenario). The user who did the right thing in steps 1-2 gets a blank step 3, which undermines the "matched feed in under 5 minutes" goal.
   - Where: `apps/web/src/features/onboarding/OnboardingPage.tsx` - `WatchlistStep` seeds `name`, `keywords`, `wlStates` with `useState(() => ...)` from `categories`/`states` props at mount, but the parent hydrates those from `useProfile()` in an effect after the first render, so on a direct resume (`initialStep` = 2) the step mounts with empty arrays and never re-seeds. Rendering the step only after `hydrated`, or keying it on `hydrated`, would address it (suggestion only; QA does not fix).
   - Failing test: `US3-10b` in `e2e/007-experience-growth/US3-guided-onboarding.e2e.ts` (fails on `e5bf5a2`, should pass after the fix; the fresh path US3-6 already passes).

2. **observation** - After "Skip for now" on step 4 `documents:false` is ticked, so the resume point is step 4 again rather than Done (by design: `initialStep` uses the first falsy tick). Not a criterion failure.
3. **observation** - Under `prefers-reduced-motion` the Done step still ticks `completed` and shows no confetti (verified).

### Not checked

- Real GeM BidPlus (mock-gem only). Real DSC/OTP flows are out of scope by constitution.
- Cross-browser (Chromium only) and screen-reader behaviour beyond axe.
- SC-001 duration measurement from `onboarding.completed.durationSec` beyond confirming the entry is written once (US3-15 JSON).

An approval would cover only what is in the table above; this is a rejection.

### Bug issues filed

- None separate; the defect is the rework item for this story (finding 1).

### Verdict

`qa:rejected` - criterion US3-10 (step-3 form pre-filled from the saved profile on resume, FR-043/FR-046) not met. All other criteria met. Rejection 1 of 3 on this item.
