## QA verdict — APPROVED (round 2)

**Work item:** #66 · **PR:** #543 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mGtwn84Qge91FivDUC · **Evidence commit:** f541d0315233a0a831484690f7a190c90675399f (fix under test: d745b2a)

Spec: `e2e/003-identify-ingestion-alerts/US5-corrigendum.e2e.ts`. Private DB `tp_e2e_us5r2`, ports 8995/4995. Round 1 rejected on 2c; dev fixed in d745b2a. `git diff 4bacf70..HEAD -- e2e` had no dev edits; QA added one assertion (cancelled hero has no "Closes in").

### Test results
- Playwright **desktop**: **17 passed, 0 failed**, 2 skipped (the 2 @mobile tests, run in the mobile project).
- Playwright **mobile** (@mobile only): **2 passed, 0 failed**.
- API vitest `test/ingest.test.ts` + `test/identify.test.ts`: 77 passed (38 + 39), 0 failed (unchanged).
- axe (WCAG 2.1 A/AA, serious/critical) light + dark on the tender detail with the Cancelled banner and on the History tab: 4 passed.

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1a | Sync after `corrigendum {days:7}` reports `tendersUpdated:1, tendersCreated:0` | met | setup + S1 (run JSON) |
| 1b | `endAt` exactly 7 days later | met | S1: newEnd - oldEnd = 604800000 ms |
| 1c | One `corrigendum` event with `changes = {endAt:{from,to}}` | met | S1: keys == ['endAt'], from/to match |
| 1d | Match not duplicated | met | S1: 1 tender_matches row, 36 tenders |
| 2a | Analysis has `stale:true` | met | S2: API `stale:true, staleReason:corrigendum` |
| 2b | Card shows score ring + "Re-check" badge, tooltip "A corrigendum changed this bid after it was scored — re-run the analysis." | met | [S2a](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S2a-recheck-tooltip-desktop.png) |
| 2c | Card shows "Corrigendum" badge with tooltip "GeM published a corrigendum this week — dates or terms changed." | met (was not met in round 1) | Real mouse hover now opens the tooltip; badge is above the stretched link (`relative z-10`) and focusable. [S2b](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S2b-corrigendum-badge-hover-desktop.png) |
| 3a | History newest entry "Corrigendum issued" in a highlighted box | met | [S3](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S3-history-corrigendum-desktop.png) |
| 3b | "Re-check eligibility" badge | met | S3 |
| 3c | Change list shows old and new end date in IST | met | S3: "19 Nov 2026, 3:00 pm IST → 26 Nov 2026, 3:00 pm IST" (row label is "Closing date") |
| 4a | One in-app "Corrigendum: <title>" per member with in-app on, link `/tenders/<id>` | met | S4: owner, analyst, viewer, em, wa = 1 each; in-app-off member 0; org Y 0 |
| 4b | Body "<bid> was amended on GeM — now closes <date> IST. Re-check the analysis before you bid." | met | S4 body: "…now closes 26 Nov, 3:00 pm IST. Changed: Bid end date: … Re-check the analysis before you bid." [bell](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S4-bell-corrigendum-desktop.png) |
| 4c | Second identical sync creates no duplicate | met | S4b: tendersUpdated 0; notifications, events and mail counts unchanged |
| 5 | A value that disappears from the listing (stored ePBG 5%, listing none) and a re-cased title: stored value kept, no corrigendum, no alert | met | S5: ePBG stays 5, no new corrigendum event/notification/email ([S5](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S5-no-new-corrigendum-desktop.png)). Stored title was upper-cased via SQL (mock-gem cannot re-case) |
| 6a | Open bid whose end date passes is set `closed` by next sync | met | S6a ([shot](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S6a-closed-tender-desktop.png)); arranged via mock-gem past endAt + stored end_at |
| 6b | GeM cancel -> `cancelled` event; History shows "Bid cancelled" | met | S6b: 1 event; [history](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S6b-history-bid-cancelled-desktop.png) |
| 7a | Instant email queued/sent with same dedupe semantics | met | S7: 1 email per member, subject "Corrigendum: …", "A tracked GeM bid was amended", Changed section, List-Unsubscribe(+Post); rows `skipped` (no RESEND_API_KEY); [email](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S7-corrigendum-email-rendered-desktop.png) |
| 7b | WhatsApp per prefs | met | S7: exactly 1 row (member with phone + WhatsApp on) |
| 7c | Human summary of every changed field, e.g. "Bid end date … · Quantity: 75 → 90" | met | S7b: "Bid end date: 16 Nov, 6:00 pm → 19 Nov, 6:00 pm IST · Quantity: 40 → 90 · EMD: ₹1 L → ₹3 L" in app and email ([email](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S7b-email-changed-section-desktop.png)) |
| 7d | Daily-digest users get it in the digest (FR-052) | unverifiable in E2E | Needs the IST digest window; covered by API test "FR-052: digests list amended bids under a Changed section" (in the 77 passing) |
| 8a | `kind` is `corrigendum`, not `deadline` | met | S4/S8: kind column + 0 `deadline` rows |
| 8b | "Corrigendum" label + warning icon in bell and /notifications | met | [S8](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S8-notifications-corrigendum-label-desktop.png) |
| 8c | `?kind=corrigendum` filters; `?kind=bogus` -> 400 | met | S8 |
| 9a | Cancellation alert "Cancelled on GeM: <title>" on chosen channels | met | S6b: in-app x5, email x6 (captured), WhatsApp x1, none for org Y, none duplicated on re-sync; [bell](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S9-bell-cancelled-alert-desktop.png) |
| 9b | "Cancelled on GeM" banner | met (and the hero shows no "Closes in" countdown; asserted) | [banner](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S6b-cancelled-banner-desktop.png); axe light/dark pass |
| M | @mobile history at 375 px | met | [history](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S3-mobile-history-375-mobile.png), [bell](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5/S4-mobile-bell-375-mobile.png); no horizontal overflow |

Videos: one `.webm` per test in [qa/evidence/003/US5](https://github.com/Shashank2577/GEMs/blob/f541d0315233a0a831484690f7a190c90675399f/qa/evidence/003/US5).

### Findings
1. Round-1 major (Corrigendum tooltip unreachable): **resolved** (2c).
2. Round-1 observation (cancelled hero read "Closes in 21d 0h"): **resolved**; new assertion in S6b. Note the Analysis tab still lists a stale "Time to bid closing" factor on a cancelled bid (pre-cancel analysis text, not the hero). Observation only.

### Not checked
- Real email/WhatsApp provider delivery (sent/failed/retry): needs a provider, covered by API tests.
- Daily-digest delivery in E2E (see 7d).
- Bid workspace banner (scenario 9) checked on the tender page only.

### Verdict
`qa:approved` — every criterion met except 7d, which is covered by the API test (unchanged from round 1).
