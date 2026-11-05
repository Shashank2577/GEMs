## QA verdict — APPROVED

**Work item:** #297 · **PR:** #530 · **Reviewer:** qa (claude-code/Sonnet 5.5) · **Session:** https://claude.ai/code/session_01BUi6mHKg4iL9ojV8hxLAhc
**Code tested:** branch `story/GEM-297-landing-pricing` @ a9c9cab (plus QA-only e2e + evidence commit)

### Acceptance criteria

| # | Criterion (US6, spec.md) | Verdict | Evidence |
|---|---|---|---|
| US6-1 | Signed-in user opening `/`, `/login`, `/signup` is redirected to `/dashboard` or safe same-origin `?next=`; `//evil.com` ignored | met | 11 cases incl. `//evil.com`, absolute URL, backslash: [redirects](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-1-redirects.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-1-signed-in-lands-on-dashboard.png) |
| US6-2 | h1 text, pill → `#control`, "Start free trial" → `/signup`, "See how it works" → `#how`, three ticks | met | [hero](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-2-hero.png); static shell gone after paint, one h1/main/banner/contentinfo, no duplicate ids, shell links present with JS off: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-2b-shell-handover.json), [no-JS](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-2c-no-js-shell.png) |
| FR-081 | Sections in order nav, hero, built for, how, control, metrics, teams, pricing, faq, final CTA, footer | met | [order](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/fr-081-section-order.json), [full page](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/fr-081-full-landing.png) |
| US6-3 | Desktop nav links scroll to `#how/#control/#teams/#pricing/#faq`, heading not under sticky nav | met | [anchors](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-3-anchors.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-3-pricing-anchor-clear-of-nav.png) |
| US6-4 | 375 px: "Open menu" aria-expanded=false → "Mobile" nav (5 links + Sign in + Start free trial), "Close menu" aria-expanded=true, link tap closes | met | [menu](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-4-mobile-menu-open.png), [pricing](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-4-mobile-pricing.png); passes in Pixel 7 project too |
| US6-5 | Starter ₹2,999/month, Pro ₹7,999/month + "Most popular", Enterprise Custom, GST/trial note, CTA destinations (mailto) | met | [text](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-5-pricing-text.json), [desktop](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-5-pricing-desktop.png), [mobile](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-5-pricing-mobile.png) |
| US6-6 | Keyboard Tab+Enter on FAQ trigger expands "No — and that’s deliberate.", aria-expanded=true | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-6-faq-expanded.png), [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-6-faq.json) |
| US6-7 | Arrow-key selection of "Bid Manager" shows "Run every bid like a well-oiled pipeline" | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-7-bid-manager-tab.png) |
| US6-8 | prefers-reduced-motion: sections appear without slide/fade | met | baseline animates, reduced has 0 faded/offset wrappers: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-8-reduced-motion.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-8-reduced-motion-pricing.png) |
| US6-9 | No claim of submitting/price entry/OTP-DSC; "typed by you, on GeM" | met | all 6 FAQ answers + 4 tabs scanned, 0 forbidden hits: [json](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-9-copy-guard.json), [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-9-compliance-section.png) |
| US6-10 | head: exact title (no double suffix), description, canonical, og:*, og:image 1200x630, og:locale en_IN, twitter:card, JSON-LD 2 INR Offers | met | served HTML as WhatsApp UA: [head](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-10-head.html), [summary](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-10-head-summary.json) |
| US6-11 | `/signup?plan=pro` shows trial note; Starter passes `?plan=starter`; unknown ignored; plan stays `trial` after sign-up | met | [shot](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-11-signup-pro-trial-note.png), [me](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-11-me-plan.json) |
| US6-12 | robots allows `/`, disallows app routes; sitemap lists `/`, `/signup`, `/login` | met | [robots](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-12-robots.txt), [sitemap](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/us6-12-sitemap.xml) |
| FR-080..087 | covered by rows above (FR-086 via core plans tests and rendered values) | met | see rows |
| NFR-003 / SC-006 | Lighthouse mobile medians of 3 runs: Perf>=85, A11y>=95, BP>=90, SEO>=90, LCP<2.5 s, CLS<0.1 | met | Perf 93, A11y 100, BP 96, SEO 100, LCP 905 ms, CLS 0: [summary](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/lighthouse/summary.json), [report](https://github.com/Shashank2577/GEMs/blob/story/GEM-297-landing-pricing/qa/evidence/007/US6/lighthouse/report.html) |

### Test results

- Playwright `e2e/007-experience-growth/US6-landing.e2e.ts`: **18 passed, 0 failed** (16 desktop 1440x900, 2 @mobile Pixel 7 375 px).
- Unit/API gates re-run: core 428 passed; api 606 passed (2 skipped, pre-existing); web 249 passed.
- Videos: one desktop .webm per test in this folder.

### Findings

1. **observation** — Signed-out load of `/` makes `GET /api/auth/me` return 401, logged as a console error (Lighthouse "errors-in-console"; Best Practices 96, not 100). Expected for the auth probe; not a defect.
2. **observation** — Lighthouse TBT is 259-366 ms (score ~0.75); Performance still 91-95.
3. **observation** — Re-running `scripts/lighthouse-landing.mjs` overwrites the developer's lighthouse report with QA's run (intended).

### Not checked

- Real-device Safari/iOS rendering; WhatsApp/LinkedIn live preview scrapers (head verified from served HTML only).
- Worker (wrangler) static-asset serving; verified on the Node server only (developer evidence claims Worker).
- Dark theme visual review of the landing.

### Bug issues filed

- none

### Verdict

`qa:approved` — every criterion met, evidence above.
