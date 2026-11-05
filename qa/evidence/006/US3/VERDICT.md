## QA verdict — APPROVED

**Work item:** #181 · **PR:** #503 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

HEAD tested: `773e96f` (+ QA spec S12). Round 1 (`8c65490`) was **rejected only** for axe color-contrast (NFR-006/SC-006) on the Overridden row; developer fix `773e96f` (badge.tsx info/danger tones, DocumentsStep.tsx) is verified here. Playwright: `pnpm exec playwright test e2e/006-apply-packet-assist/US3*` -> **15 passed, 0 failed** (desktop 12 + mobile 3: S2, S10, S12). API suite `@tp/api` vitest: 410 passed, 1 skipped (0 failed).

### Acceptance criteria

| # | Criterion (quoted from the work item) | Verdict | Evidence |
|---|---|---|---|
| 1 | Analyst on the OEM row: no **Override** button; POST /overrides as Analyst is **403** "You need to be at least a Bid Manager to do that" | met | [s1-analyst-no-override-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s1-analyst-no-override-desktop.png) |
| 2 | Dialog title “Override “OEM authorisation certificate (MAF) for this bid””, explanation copy, required Reason textarea (max 500), hint, Override disabled until trimmed 5+ chars, 1-4 chars shows "Explain in a few more words" | met | [s2-dialog-4-chars-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s2-dialog-4-chars-desktop.png) |
| 3a | Confirm with reason -> 201, `readiness.canMarkReady: true`, `overrides[0]` = {itemId, reason, by, byName, at} | met | [s3-overridden-100-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s3-overridden-100-desktop.png) |
| 3b | Toast "Override recorded"; row **Overridden** + "Override: Renewed MAF arriving tomorrow from Dell"; ring **100%** + "All required documents are covered"; activity "overrode “…”: reason" | met | [s3-overridden-100-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s3-overridden-100-desktop.png) |
| 4 | Analyst moves stage to Ready to submit -> PATCH 200 (409 without override) | met | [s4-analyst-moves-stage-to-ready-to-submit-200-once-overridde-desktop.webm](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s4-analyst-moves-stage-to-ready-to-submit-200-once-overridde-desktop.webm) |
| 5 | Remove override -> DELETE 200 with one blocker, toast "Override removed", row Expired again; delete of non-existent -> 404 "Override not found" | met | [s5-after-remove-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s5-after-remove-desktop.png) |
| 6 | Reason "" / itemId not in checklist -> 400 with the two field messages (also 4 chars and 501 chars -> 400) | met | [s6-api-400-empty-reason-and-unknown-itemid-desktop.webm](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s6-api-400-empty-reason-and-unknown-itemid-desktop.webm) |
| 7 | Ready / Expiring / Generated item override -> 409 `nothing_to_override` "Only a missing or expired item can be overridden." (nothing stored) | met | [s7-409-nothing-to-override-for-ready-expiring-and-generated--desktop.webm](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s7-409-nothing-to-override-for-ready-expiring-and-generated--desktop.webm) |
| 8a | Empty Discussion reads "No comments yet. Coordinate who is chasing which document." | met | [s8-empty-discussion-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s8-empty-discussion-desktop.png) |
| 8b | Analyst types and presses Ctrl+Enter (and send button) -> 201 `{id, body, user, createdAt}`, textarea clears, comment with avatar + relative time | met | [s8-comment-posted-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s8-comment-posted-desktop.png) |
| 8c | Owner and every assignee except the author get in-app notification "New comment on GEM/2026/B/700001" whose body starts with "<author>: Chasing Dell…" (author gets none) | met | [s8-owner-bell-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s8-owner-bell-desktop.png) |
| 9 | Empty/whitespace comment -> 400 "Write a comment"; >4000 chars rejected (4000 ok); Viewer sees comments but no composer; Viewer POST 403 | met | [s9-viewer-no-composer-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s9-viewer-no-composer-desktop.png) |
| 10a | 375 px: segmented control "Bid steps | Discussion (1)" above steps; Discussion hides steps and shows comments + activity full-width, no horizontal scroll | met | [s10-mobile-discussion-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s10-mobile-discussion-mobile.png) |
| 10b | >=1024 px: rail is a sticky 300-340 px right column, segmented control hidden | met | [s10-desktop-rail-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s10-desktop-rail-desktop.png) |
| 11a | `@Full Name` mention of a member who is neither owner nor assignee -> that member also notified (exactly once) | met | [s11-delete-confirm-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s11-delete-confirm-desktop.png) |
| 11b | Author or Bid Manager+ can delete a comment -> 204; others 403 (analyst on others', viewer), 404 unknown | met | [s11-bm-deleted-others-desktop.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s11-bm-deleted-others-desktop.png) |
| NFR-006 / SC-006 | axe: no serious/critical violations (WCAG 2.1 A/AA) on the US3 surfaces (desktop Overridden row + rail, dialog, 375px rail, and 375px Overridden row [s12-overridden-row-375-mobile.png](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s12-overridden-row-375-mobile.png)) | met (0 violations; fixed in round 2) | [s3-overridden-desktop.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s3-overridden-desktop.axe.json) |

Every row except the last was exercised by `e2e/006-apply-packet-assist/US3-overrides-comments.e2e.ts` (S1-S11; videos per test in the same folder).

### Findings

1. **resolved** — Round 1 blocking finding (color-contrast on Overridden badge, "Override: ..." line, danger chip) no longer reproduces: all six axe JSONs (s2 dialog x2, s3 desktop row+rail, s10 rail x2, s12 375px Overridden row x2) report 0 violations.
2. **resolved** — Round 1 observation: Overridden row at 375px is now scanned (new QA test S12 `@mobile`), 0 violations.

### Not checked

- Dark-theme contrast; axe on the full page outside the US3 include scope.
- Real e-mail/push delivery of the notifications (in-app channel only, via GET /api/notifications and the bell).

### Bug issues filed

- None (finding 1 is in scope of this story's SC-006).

### Verdict

`qa:approved` - every criterion met, evidence above. Round 1 rejection (axe color-contrast) fixed by `773e96f`.

---
_Generated by [Claude Code](https://claude.ai/code)_
