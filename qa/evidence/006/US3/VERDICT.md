## QA verdict — REJECTED

**Work item:** #181 · **PR:** #503 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mEtEp4yfQg82nf4ywc

HEAD tested: `8c65490`. Playwright: `pnpm exec playwright test e2e/006-apply-packet-assist/US3*` -> **12 passed, 1 failed** (desktop 11 tests + mobile 2 tests; the one failure is the axe gate inside S3). API suite `@tp/api` vitest: 410 passed, 1 skipped.

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
| NFR-006 / SC-006 | axe: no serious/critical violations (WCAG 2.1 A/AA) on the US3 surfaces | **not met** | [s3-overridden-desktop.axe.json](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s3-overridden-desktop.axe.json) |

Every row except the last was exercised by `e2e/006-apply-packet-assist/US3-overrides-comments.e2e.ts` (S1-S11; videos per test in the same folder).

### Findings

1. **blocking** — axe color-contrast (serious) on the Override surfaces; SC-006 / NFR-006 require no serious/critical axe violations.
   - Observed: `a11y(page,'s3-overridden',{include:['#item-oem_authorization','aside[aria-label="Discussion and activity"]']})` after overriding the OEM item -> `color-contrast` serious on (a) the **Overridden** badge (`.border-info/20.bg-info-soft`) and (b) the "Override: <reason>" line (`p.bg-info-soft.text-info`, DocumentsStep.tsx:124): foreground #1183d4 on #ebf7ff = **3.69:1**, needs 4.5:1; (c) a danger chip (`text-danger` on `bg-danger-soft`, 11px) = 4.23:1. See [axe JSON](https://github.com/Shashank2577/GEMs/blob/story/GEM-181-overrides-comments/qa/evidence/006/US3/s3-overridden-desktop.axe.json).
   - Expected: >= 4.5:1 for 12px normal-weight text (use a darker `--info` / `--danger` text token on the soft backgrounds, light theme).
   - Where: `apps/web/src/features/workspace/DocumentsStep.tsx:123-126` (info-soft chip) and the `Badge` info/danger tones; tokens `--info`/`--info-soft` in `apps/web/src/index.css:38-39`. Dialog (S2) and rail (S10) axe scans are clean.
2. **observation** — The mobile project only runs the `@mobile` tests (S2, S10); the Overridden row at 375 px was not separately scanned with axe.

### Not checked

- Dark-theme contrast; axe on the full page outside the US3 include scope.
- Real e-mail/push delivery of the notifications (in-app channel only, via GET /api/notifications and the bell).

### Bug issues filed

- None (finding 1 is in scope of this story's SC-006).

### Verdict

`qa:rejected` — all 11 functional acceptance scenarios are met; SC-006/NFR-006 (axe, no serious violations) is not met on the Overridden row. Rejection 1 of 3 on this item.

---
_Generated by [Claude Code](https://claude.ai/code)_
