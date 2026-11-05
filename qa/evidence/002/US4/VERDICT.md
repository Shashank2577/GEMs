## QA verdict — APPROVED (re-review round 2)

**Work item:** #6 · **PR:** #496 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mFdfjz9y1F3zKYmWQB

Re-review round 2 against branch HEAD `c89e4cf` (includes fix commit `d1e3b8e`: always-on in-app test row, inline aria-live result line, short toast, mobile toast offset). Round 1 approved `ee2af4d`.

Tests: `e2e/002/US4-account-prefs.e2e.ts`: **15 passed, 0 failed, 1 skipped** (desktop 12 passed + 1 skipped by design: the tab-bar test only applies to the phone viewport; mobile project 3 passed). New cases: sc8c (in-app OFF still creates row), `@mobile` toast-above-tab-bar; sc8/sc8b assertions moved to the status line.
API suite: 299 passed, 1 skipped (opt-in perf) of 300; `prefs.test.ts` 12/12. See [api-tests.txt](api-tests.txt).

### Acceptance criteria

| # | Criterion (spec US4) | Verdict | Evidence |
|---|---|---|---|
| 1a | sc1: new member sees In-app on, Email on (to their email), WhatsApp off, Match alerts Instant, Expiry reminders on | met | [sc1-defaults.png](sc1-defaults.png); `GET /api/me/notification-prefs` asserted equal to defaults |
| 1b | sc1: "Save preferences" disabled until something changes | met | [sc1-defaults.png](sc1-defaults.png) (disabled), [sc1-save-enabled-after-change.png](sc1-save-enabled-after-change.png) (enabled after toggle) |
| 2a | sc2: WhatsApp on, no mobile, Save -> no request sent | met | [sc2-whatsapp-needs-number.png](sc2-whatsapp-needs-number.png) (request recorder empty; phone and prefs unchanged server-side) |
| 2b | sc2: field shows "Add a valid 10-digit mobile number to get WhatsApp alerts" | met | [sc2-whatsapp-needs-number.png](sc2-whatsapp-needs-number.png), [mobile-notifications-error.png](mobile-notifications-error.png) |
| 3a | sc3: `PATCH /api/me` stores `+919822012345` | met | [sc3-saved.png](sc3-saved.png) (PATCH body `{phone:"+919822012345"}`, 200; `me.user.phone` re-read) |
| 3b | sc3: `PUT /api/me/notification-prefs` stores prefs (WhatsApp on, Daily) | met | [sc3-saved.png](sc3-saved.png) (PUT 200, body asserted; GET round-trips) |
| 3c | sc3: toast "Notification preferences saved" | met | [sc3-saved.png](sc3-saved.png) |
| 3d | sc3: hint reads "We’ll message +919822012345" | met | [sc3-filled.png](sc3-filled.png), [sc3-saved.png](sc3-saved.png) |
| 3e | Independent test: values persist after reload | met | [sc3-after-reload.png](sc3-after-reload.png) |
| 4 | sc4: `PUT` whatsapp:true with no phone -> 400 `details.fields.whatsapp = "Phone number required"` (nothing stored) | met | [sc4-api-400.png](sc4-api-400.png); API `auth.test.ts` and `prefs.test.ts` |
| 5 | sc5: user in two orgs, Daily in org A, org B unchanged | met | [sc5-org-a-daily.png](sc5-org-a-daily.png), [sc5-org-b-still-instant.png](sc5-org-b-still-instant.png); switching back shows A still Daily; API `prefs.test.ts` per-org isolation |
| 6a | sc6: name "Priya S." + mobile 9822012345, Save -> 200 `Me` | met | [sc6-saved-menu-updated.png](sc6-saved-menu-updated.png) (PATCH body `{name,phone:"+919822012345"}`, response user/org asserted) |
| 6b | sc6: toast "Profile saved" | met | [sc6-saved-menu-updated.png](sc6-saved-menu-updated.png) |
| 6c | sc6: avatar initials and user menu update without reload | met | [sc6-saved-menu-updated.png](sc6-saved-menu-updated.png) (initials "PS", menu shows "Priya S."; no navigation between save and assertion) |
| 6d | sc6: invalid mobile `12345` shows "Enter a 10-digit Indian mobile number starting with 6–9" | met | [sc6-invalid-mobile.png](sc6-invalid-mobile.png), [mobile-account-invalid.png](mobile-account-invalid.png) (no PATCH sent) |
| 6e | sc6: Email read-only with hint "Contact your org owner to change it." | met | [sc6-account-initial.png](sc6-account-initial.png) |
| 7a | sc7: Daily -> in-app immediate; email/WhatsApp held and sent as one digest per org per IST day from 08:00 IST | met (API suite) | Server behaviour, no UI. `ingest.test.ts` "daily digest: held before 08:00 IST, one digest email after, never twice a day" passed ([api-tests.txt](api-tests.txt)); UI stores the Daily choice: [sc7-daily-expiry-off-stored.png](sc7-daily-expiry-off-stored.png). See Findings 1 on in-app immediacy. |
| 7b | sc7: Expiry reminders off -> no vault expiry reminders for that user | met (API suite) | `vault.test.ts` "notifies members once per threshold and respects prefs (FR-022)" and "run with every member opted out ... reports 0 notifications" passed ([api-tests.txt](api-tests.txt)); UI stores expiryReminders:false: [sc7-daily-expiry-off-stored.png](sc7-daily-expiry-off-stored.png) |
| 8a | sc8: "Send a test alert" creates in-app notification "Test alert from TenderPilot" (now always, also with the in-app pref OFF) | met | [sc8-notification-listed.png](sc8-notification-listed.png) (title in `/api/notifications` and on the Notifications page; `inApp:'sent'`); [sc8c-in-app-off-still-created.png](sc8c-in-app-off-still-created.png) (pref OFF saved, still created, pref unchanged); API `prefs.test.ts` "always creates the in-app row..." ([api-tests.txt](api-tests.txt)) |
| 8b | sc8: test email/WhatsApp attempted for each enabled external channel (and the active org's prefs are used) | met | Log adapters on the e2e server: email reported per its real result, WhatsApp "off" ([sc8-test-alert-status-line.png](sc8-test-alert-status-line.png)). API `prefs.test.ts` "always creates the in-app row; email/WhatsApp only when enabled", "reports sent ... failed", "uses the preferences of the active org (two-org user)" ([api-tests.txt](api-tests.txt)) |
| 8c | sc8: outcome per channel ("Email sent", "WhatsApp not configured on this server") — now an inline aria-live status line; toast is short | met | [sc8-test-alert-status-line.png](sc8-test-alert-status-line.png) (`role=status` "Test alert: In-app sent · Email not configured on this server · WhatsApp is off"; toast "Test alert sent with warnings"); 429 in toast and status line: [sc8b-rate-limited.png](sc8b-rate-limited.png) |
| T068 | `@mobile` layout of account + notifications | met | [mobile-notifications.png](mobile-notifications.png), [mobile-notifications-error.png](mobile-notifications-error.png), [mobile-account-invalid.png](mobile-account-invalid.png), [mobile-account-saved.png](mobile-account-saved.png) (no horizontal overflow, buttons inside viewport; Pixel 7) |
| T068 | axe on account + notifications | **unverifiable** | T014 axe helper not available in this repo state; see Not checked |
| R2-1 | Fix: desktop toast no longer covers the footer buttons | met | [sc8-toast-vs-footer-desktop.png](sc8-toast-vs-footer-desktop.png) (toast bottom-right below the footer; bounding-box overlap with both buttons asserted false) |
| R2-2 | Fix: `@mobile` toast sits above the fixed tab bar | met | [mobile-toast-above-tab-bar.png](mobile-toast-above-tab-bar.png) (toast bottom <= tab bar top asserted on Pixel 7); video `-mobile-test-alert-toast-sits-above-the-tab-bar-status-line--mobile.webm` |

Videos (one per test, desktop and mobile): `*.webm` in this folder, including the two `@mobile` tests on the mobile project. `dev-*.png` are the developer's screenshots (kept).

### Findings

1. **observation** — sc7a "in-app notifications appear immediately" for Daily users is not asserted directly by an API test; the digest test shows only the email-channel rows are held (`held == email rows`), which is consistent with in-app being sent at once. Not blocking.
2. **observation** — The WhatsApp success path (`sent`) and the real email provider are only exercised with fake providers in the API suite; the e2e server uses log adapters, so toast lines are "not configured on this server".

3. **observation (round 2)** — On the phone the toast (shown a few seconds, dismissible) briefly overlays the footer buttons when the page is scrolled to the bottom ([mobile-toast-above-tab-bar.png](mobile-toast-above-tab-bar.png)); it no longer covers the tab bar, which was the fix goal. The per-channel result stays readable in the status line above. Not blocking.
4. **observation** — Full-page screenshots on mobile show the fixed top bar overlaid mid-page (screenshot artifact, not a layout defect).

### Not checked

- axe accessibility scans on `/settings/account` and `/settings/notifications` (T068 lists them): the T014 helper is not available, so not run. Does not block the spec criteria above.
- Real email / WhatsApp provider delivery (log adapters only).
- Chromium only; mobile covered by Pixel 7 emulation (412 px), not a 375 px viewport.
- Password change and sessions panel on the Account page (outside US4 criteria).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none.

### Verdict

`qa:approved` (round 2) — every criterion met (7a/7b via API test evidence); the axe item is an unavailable-tooling gap listed under Not checked.
