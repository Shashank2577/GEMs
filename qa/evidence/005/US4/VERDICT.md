## QA verdict — APPROVED

**Work item:** #117 · **PR:** #481 · **Reviewer:** qa (claude-code) · **Session:** https://claude.ai/code/session_01BUi6mGceW8rH9jD4oJ4Bsf

Spec: `specs/005-profile-vault/spec.md` User Story 4, FR-042..FR-053. Spec file: `e2e/005-profile-vault/US4-expiry-reminders.e2e.ts` (helpers in `e2e/005-profile-vault/support.ts`).
Run: `E2E_PORT=8804 E2E_GEM_PORT=4015 pnpm exec playwright test e2e/005-profile-vault/US4` against real API + Postgres + built SPA, Chromium, Asia/Kolkata, real clock (2026-11-05 IST). Result: **11 passed** (9 desktop + 2 `@mobile`). Traces/videos/screenshots are in this folder (`trace-*.zip`, `*.webm`, `*.png`).

### Acceptance criteria

Base link: https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Expiry +45/+30/+10/0/-1 -> Valid / Expires in 30d / Expires in 10d / Expires today / Expired 1d ago; no expiry -> 'No expiry' (FR-042) | met | Badges asserted per card in the UI and `status` via API: [ac1-badges-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac1-badges-desktop.png), [trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/trace-ac1-desktop.zip) |
| 2a | ISO +10, Owner/Bid Manager/Analyst(email off)/Viewer(reminders off): exactly 5 notifications | met | Run returned `{documents:1, notifications:5}`; DB rows: Owner+BM in_app:sent + email:pending, Analyst in_app only, Viewer none. [viewer bell](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac2-viewer-reminders-off-no-notification.png) |
| 2b | Exact in-app title `<title> expires in 10 days`, email title `[<Org>] <title> expires in 10 days` | met | Asserted verbatim on DB rows; [owner bell](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac2-owner-bell-title.png) |
| 2c | Exact body "Your ISO certificate "<title>" expires in 10 days (on YYYY-MM-DD). Renew it and upload the new copy to the vault so your bids stay compliant." | met | Asserted verbatim for all 4 Owner/BM rows (in-app + email) |
| 2d | Link `/vault?doc=<id>`; `last_reminder_days` = 30; dedupe key `expiry:<id>:<date>:30` | met | Asserted on rows and `vault_documents.last_reminder_days` |
| 3 | Re-run same day -> `{documents:0, notifications:0}` | met | Second run returned zeros; DB row count stays 5 ([trace](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/trace-ac2-ac3-desktop.zip)) |
| 4a | 4 days later (6 days left) the 7-day reminder "... expires in 6 days" sent once | met | Time passing simulated by shifting expiry -4 days in DB (clock cannot be advanced); one extra reminder, `last_reminder_days`=7, third run zeros. [ac4-seven-day-reminders.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac4-seven-day-reminders.png) |
| 4b | Doc uploaded with 5 days left gets only the 7-day reminder | met | Only dedupe key `...:7` exists, no `...:30` |
| 5a | Expired yesterday (last reminder 1) -> one "<title> has expired" reminder, exact body, `last_reminder_days`=0 | met | Title/body/email title asserted verbatim; value 0; re-run zeros. [ac5-expired-reminder.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac5-expired-reminder.png) |
| 5b | Expired > 30 days ago -> none | met | -31d doc: 0 notifications, `last_reminder_days` stays null |
| 6 | Editing expiry resets `last_reminder_days`; next crossing sends a new reminder with new dedupe key | met | Edited through the drawer UI: null after save, then new reminder "expires in 20 days" with key `expiry:<id>:<newdate>:30` alongside the old key. [form](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac6-edit-expiry-form.png) |
| 7 | Bell reminder opens drawer even when filtered out of list | met | On `/vault?status=expired` the doc is absent from the list; clicking the bell item opens its drawer (desktop and mobile). [desktop](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac7-bell-opens-drawer-desktop.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac7-bell-opens-drawer-mobile.png) |
| 8a | Dashboard expiring documents tile = 3 for demo org | met | [ac8-dashboard-tile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac8-dashboard-tile.png) |
| 8b | Tile links to vault | met | [ac8-tile-links-to-vault.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac8-tile-links-to-vault.png) |
| 9a | Bid Manager/Owner see **Send reminders now** in the "More vault actions" menu; Analyst and Viewer do not | met | Owner: [menu open](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-menu-open-desktop.png); [BM visible](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-menu-bid_manager-visible-desktop.png); [Analyst hidden](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-menu-analyst-hidden-desktop.png); [Viewer hidden](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-menu-viewer-hidden-desktop.png); also mobile variants |
| 9b | POST /api/vault/reminders/run -> 200 `{documents, notifications}`; org-only | met | UI run and BM API call 200; other org's due document untouched (0 notifications, `last_reminder_days` null) |
| 9c | Toast "Reminders sent for 1 document" / "... 2 documents" / "No reminders due" | met | [singular](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-toast-singular-desktop.png), [plural](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-toast-plural-desktop.png), [none](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac9-toast-no-reminders-due-desktop.png) (+ mobile) |
| 9d | Analyst 403; calling twice creates no duplicates | met | Analyst and Viewer API calls return 403; second UI run toasts "No reminders due"; 8 rows for the doc (4 members x 2 channels), unchanged |
| 10 | Drawer shows "Next reminder: 7 days before expiry (<date>)" / "expiry notice (<date>)" / "All reminders sent" | met | Valid doc: "30 days before expiry (<expiry-30>)" ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-valid.png)); expiring due now ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-expiring-due-now.png)); after 30-day sent: "7 days before expiry (<expiry-7>)" ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-expiring-after-30-sent.png)); expired due now: "expiry notice (today)" ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-expired-due-now.png)); expired after run: "All reminders sent" ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-expired-all-sent.png)); 1-day sent, not yet expired: "expiry notice (<expiry+1>)" ([png](https://github.com/Shashank2577/GEMs/blob/story/GEM-117-expiry-reminders/qa/evidence/005/US4/ac10-drawer-expiry-notice-day-after.png)) |

FR coverage: FR-042 (AC1), FR-044/045/046/049 (AC2-5), FR-048 (AC8), FR-050 (AC7), FR-051/052 (AC9), FR-053 (AC10 and the amended scenarios 9/10 copy). FR-043 (scheduler wiring) and FR-047 (email delivery) are not exercised end to end, see Not checked.

### Findings

None blocking. Observations:

1. **observation** - "4 days later" cannot be driven by the real clock, so the test shifts `vault_documents.expiry_date` in the DB to emulate it. The reminder logic is identical, but a clock-injected run would be a stronger proof.
2. **observation** - Email rows are asserted in the DB (`status: pending`, title prefix); no API exposes them other than per-notification `deliveries`.

### Not checked

- Accessibility: `@axe-core/playwright` is not installed (T003 adds it); no automated a11y scan was run.
- FR-043 scheduler tick (Worker cron / Node in-process cron): the in-process scheduler is off in the e2e server (`CRON_INTERVAL_MS` unset), so reminders were triggered via the manual endpoint only.
- FR-047 email delivery by the alerts dispatcher (only the pending rows were checked; no RESEND key).
- Unit/API test suites (`packages/core/test/vault`, `apps/api/test/vault.test.ts`) were not re-run by QA here.
- cairn-reviewer review (Definition of Done) is not verified by QA.

### Bug issues filed

- none

### Verdict

`qa:approved` - every criterion met, evidence above.
