## QA verdict — APPROVED (re-review round 2, commit 7f7c16f; supersedes round 1 REJECTED)

**Work item:** #4 · **PR:** #487 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mFdfjz9y1F3zKYmWQB

Tests: `e2e/002/US2-invitations.e2e.ts` (desktop + mobile `@mobile` accept flow): **17 passed, 0 failed**. Round 1 had 16 passed / 1 failed (sc3 UI defect); sc3 now asserts the exact spec copy, sc14b now asserts last-used org survives sign-out, sc14 also covers a switch made in an older session, sc10 asserts the full invalid-link copy on the page.
API suite: 202/202 passed (new test: FR-021 sign-in resumes the last-used org across sign-outs), see [api-tests.txt](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/api-tests.txt).

### Acceptance criteria

| # | Criterion (spec US2) | Verdict | Evidence |
|---|---|---|---|
| 1a | sc1: `POST /api/org/invitations` returns 201 `{id,email,role,inviteUrl,expiresAt}`, expiresAt = now + 7 days | met | [sc1-dialog-sent.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc1-dialog-sent.png) (test asserts keys and +7d within 2 min) |
| 1b | sc1: dialog switches to "Invitation sent to asha@sharma.in" with read-only link and "Copy" (-> "Copied", toast "Invite link copied") | met | [sc1-dialog-sent.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc1-dialog-sent.png), [sc1-copied.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc1-copied.png) |
| 1c | sc1: email with subject "<Inviter> invited you to <Org> on TenderPilot" sent/logged | met (API suite) | Not capturable from Playwright (log mailer writes to API stdout). `apps/api/test/auth.test.ts` "owner invites; invitee previews..." asserts `mailer.sent` subject contains the org name; passed, see [api-tests.txt](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/api-tests.txt). Exact subject format confirmed by reading `org.ts` `sendInviteEmail`. |
| 2 | sc2: "asha@" -> inline "Enter a valid email address", no request sent | met | [sc2-invalid-email.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc2-invalid-email.png) (request counter = 0) |
| 3a | sc3: already a member -> 409 `conflict` "asha@sharma.in is already a member of this organization" | met (API) | e2e response assertion in sc3 test |
| 3b | sc3: that message is "shown under the email field" | met | UI now shows "<email> is already a member of this organization" under the field (exact-text assertion). [sc3-already-member.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc3-already-member.png) |
| 4a | sc4: re-invite deletes old invitation, old link 404 `invite_invalid` | met | sc4 test; [sc4-one-pending-row.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc4-one-pending-row.png) |
| 4b | sc4: new one created; Team page shows exactly one pending row | met | [sc4-one-pending-row.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc4-one-pending-row.png) |
| 5a | sc5: Bid Manager's Role select does not offer "Owner" | met | [sc5-role-options-bid-manager.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc5-role-options-bid-manager.png) (control: Owner sees it, [sc5-role-options-owner-control.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc5-role-options-owner-control.png)) |
| 5b | sc5: direct API `role:"owner"` -> 403 `forbidden` "Only an Owner can invite another Owner" | met | sc5 test |
| 6 | sc6: Revoke -> `{ok:true}`, toast "Invitation revoked", row disappears, link 404 | met | [sc6-before-revoke.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc6-before-revoke.png), [sc6-after-revoke.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc6-after-revoke.png) |
| 7a | sc7: accept-invite 200 `Me` with invited role | met | [sc7-landed-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc7-landed-desktop.png) |
| 7b | sc7: session cookie set; toast "You’ve joined <Org> as Analyst"; lands on /dashboard | met | [sc7-landed-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc7-landed-desktop.png), [sc7-landed-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc7-landed-mobile.png) (mobile run) |
| 7c | Independent test: member in Team as Analyst; activity shows "invited" and "joined the team" | met | [sc7-team-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc7-team-desktop.png), [sc7-activity-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc7-activity-desktop.png) |
| 8a | sc8: existing user joins with invited role; `orgs` has both; active org = inviter | met | [sc8-joined.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc8-joined.png) |
| 8b | sc8: wrong password -> 401 `details.fields.password = "Incorrect password"` | met | [sc8-wrong-password.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc8-wrong-password.png) |
| 9a | sc9: signed-in user "Accept & join team" joins with current account, active org switches | met | [sc9-signed-in-form.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc9-signed-in-form.png), [sc9-joined.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc9-joined.png) |
| 9b | sc9: "Not you? Use a different account" signs out and shows signed-out form | met | [sc9-not-you-before.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc9-not-you-before.png), [sc9-not-you-after.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc9-not-you-after.png) |
| 10a | sc10: expired / revoked / accepted -> 404 `invite_invalid` "This invitation link is invalid, already used or has expired. Ask your admin for a new one." (open and accept) | met | [sc10-expired.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc10-expired.png), [sc10-revoked.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc10-revoked.png), [sc10-accepted.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc10-accepted.png) (expired simulated via DB row edit) |
| 10b | sc10: page shows error alert, not an unusable form (including revoked while form open) | met | [sc10-revoked-while-open.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc10-revoked-while-open.png) |
| 11a | sc11: page calls `GET /api/auth/invite/:token` first; shows "<Inviter> invited you to join <Org> as Analyst" and "Expires <date>" | met | [sc11-new-user-preview.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc11-new-user-preview.png) |
| 11b | sc11: existingUser + signed out -> only password, email read-only, "Sign in & join" | met | [sc11-existing-user-preview.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc11-existing-user-preview.png) |
| 11c | sc11: loading skeleton | met | [sc11-skeleton.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc11-skeleton.png) |
| 11d | sc11: 404 error state "Ask your admin for a new invitation" + "Go to sign in" link | met | [sc11-404-state.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc11-404-state.png) |
| 12a | sc12: wrong signed-in email -> 403 `invite_email_mismatch` with exact message | met | sc12 test; [sc12-mismatch.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc12-mismatch.png) |
| 12b | sc12: no membership created | met | sc12 test (members list, `/me` orgs unchanged) |
| 13a | sc13: switch-org returns `Me`, toast "Switched to <Org>", on /dashboard | met | [sc13-switcher-open.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc13-switcher-open.png), [sc13-switched-dashboard.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc13-switched-dashboard.png) |
| 13b | sc13: cached queries cleared, new org's data shown | met | [sc13-new-org-team.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc13-new-org-team.png) (previous org's member no longer shown) |
| 13c | sc13: switching to a non-member org -> 404 | met | sc13 test |
| 14a | sc14: sign-in resumes the active org of the most recent session (if still a member) | met | sc14 test: second-device login resumes last-used org; [sc14-ui-login-org.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc14-ui-login-org.png) |
| 14b | sc14: otherwise oldest membership | met | sc14 test (removed from last org -> own/oldest org) |
| 14c | sc14: "signs in again later" after explicit sign-out | met | `sc14b` test: after logout, login resumes the last-used org (`users.last_org_id`); a switch made in an older session also counts; API test FR-021 |
| 15 | sc15: Resend creates fresh link + new 7-day expiry (old link dead), emailed, toast "Invitation resent to <email>" | met (email via API suite) | [sc15-before-resend.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc15-before-resend.png), [sc15-after-resend.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-4-invitations/qa/evidence/002/US2/sc15-after-resend.png); email: `apps/api/test/auth.test.ts` FR-020 resend test (mailer) passed |

Videos (6, each < 1 MB): sc3, sc4, sc7 desktop/mobile, sc13, sc15 `*.webm` in this folder. Full list of screenshots is in this folder.

### Findings

Round 1 findings 1 (sc3 copy) and 2 (last org lost after sign-out) are fixed and verified above. Round 1 observation 4 (invalid-link page body) is also fixed: the page now shows the full API copy (asserted in sc10).

1. **observation** — The rework added migration 0002 (`users.last_org_id`); applied automatically by the e2e server and API tests without error. Not separately reviewed for data backfill on existing users.

### Not checked

- Actual delivery of the invite email and its subject from the browser run (log mailer to stdout is not captured by Playwright); covered by API suite only.
- Cross-browser (Chromium only), viewport coverage beyond Pixel 7 for the accept flow.
- Rate limiting on accept-invite (covered by US1/rate-limit API tests, not re-run here beyond the full API suite passing).

An approval covers what is in the table above. It is not a statement that the change is free of defects.

### Bug issues filed

- none (findings 1 and 2 are in scope of this story).

### Verdict

`qa:approved` — every criterion met, evidence above. Re-review round 2; replaces the earlier `qa:rejected` (round 1).
