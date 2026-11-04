# Implementation Plan: TenderPilot — GeM Tender Co-Pilot

**Branch**: `claude/gem-tender-automation-om9hyj` | **Date**: 2026-11-04 | **Spec**: [spec.md](./spec.md)

## Summary

A multi-tenant SaaS that (1) ingests public GeM BidPlus bids on a cron and matches them to saved
watchlists with in-app/email/WhatsApp alerts, (2) parses bid PDFs into structured eligibility
requirements and scores them deterministically (LLM optional) against the company profile, and
(3) runs a document vault + bid workspace that auto-maps documents, generates annexures and
compiles a merged PDF packet, plus a browser extension that pre-fills only non-financial GeM fields.
One TypeScript monorepo; one Cloudflare Worker serves the API and the SPA; Neon Postgres stores data;
R2 stores files.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 (local/CI), Cloudflare Workers runtime (prod)
**Primary Dependencies**:
- API: Hono 4, Drizzle ORM, zod, `@neondatabase/serverless` (prod) / `pg` (local), `unpdf` (PDF text),
  `pdf-lib` (packet/annexures), WebCrypto PBKDF2 for passwords.
- Web: React 18, Vite 5, React Router 6, TanStack Query 5, Tailwind CSS 3 with a token-based design
  system (CSS variables, light/dark), Radix UI primitives, lucide-react icons, Recharts, sonner
  toasts, cmdk command palette, @dnd-kit for the Kanban.
- Extension: Chrome Manifest V3, built with Vite.
**Storage**: Postgres (Neon in prod, local Postgres 16 in dev/CI); object storage R2 (prod) / local
filesystem (dev/CI) behind a `BlobStore` interface.
**Testing**: Vitest (unit, `packages/core` and API integration against real Postgres), Playwright
(E2E against the Node server + built SPA + mock GeM server).
**Target Platform**: Cloudflare Workers (+ static assets, Cron Triggers, R2), Neon.
**Project Type**: Web application (SPA + API) + browser extension.
**Performance Goals**: see NFR-001..003.
**Constraints**: Constitution I (human-in-the-loop), II (polite public ingestion), III (rules first).
**Scale/Scope**: 100s of orgs, 10^5 tenders, ~15 screens.

## Constitution Check

| Principle | How the plan complies |
|---|---|
| I Human-in-the-loop | No GeM login, no price fields in data model, extension allow-list excludes price/OTP/captcha/submit (`packages/core/src/assist/allowlist.ts`), tested. |
| II Polite ingestion | `GemClient` throttles ≤ 1 req/s, retries with back-off, upserts by bid number, keeps `sourceUrl`/`fetchedAt`. |
| III Rules first | `extractRequirementsRules()` + `scoreTender()` are pure and key-less; LLM extractor only adds/enriches with `method: 'LLM'`. |
| IV Tenant isolation | Every org-owned table has `org_id`; `requireOrg()` middleware + repository helpers always filter by it; files under `org/{orgId}/…` keys; signed download URLs. |
| V UX | Design system in `apps/web/src/components/ui`, every page has skeleton/empty/error states, dark mode, responsive. |
| VI Test-first E2E | Unit tests per core module; Playwright spec per user story in `e2e/`. |
| VII Edge-native | `apps/api/src/worker.ts` (fetch + scheduled) and `apps/api/src/node.ts` share `createApp(deps)`. |
| VIII Simplicity | Single schema in `packages/db/src/schema.ts`; shared zod contracts in `packages/core/src/contracts`. |

## Project Structure

### Documentation (this feature)

```text
specs/001-gem-tender-copilot/
├── spec.md  plan.md  research.md  data-model.md  tasks.md
└── contracts/api.md
```

### Source Code (repository root)

```text
packages/
  core/            # pure domain logic, no I/O except fetch injected
    src/gem/        # BidPlus listing parser, GemClient, amount/date normalisers
    src/match/      # watchlist matcher
    src/analyse/    # pdf text → requirements (rules), LLM extractor, scorer, checklist
    src/vault/      # validators (GSTIN/PAN/Udyam), doc status/expiry, checklist→doc mapping
    src/packet/     # annexure templates, PDF generation, merge with index/bookmarks
    src/assist/     # extension fill allow-list + field mapping
    src/contracts/  # zod DTOs shared by API and web
    test/fixtures/  # recorded BidPlus JSON, sample bid PDFs
  db/              # drizzle schema, migrations (SQL), db factory (pg | neon), seed/demo data
apps/
  api/             # Hono app: routes/, services/, middleware/, adapters/ (blob, llm, mail, whatsapp)
    src/app.ts      # createApp(deps)
    src/worker.ts   # Cloudflare entry: fetch + scheduled
    src/node.ts     # local entry: serves API + built SPA, FS blob store
    test/           # API integration tests (vitest + real Postgres)
  web/             # React SPA
    src/components/ui/  # design system
    src/features/<area>/ # pages per area: feed, tender, vault, workspace, pipeline, dashboard, settings, onboarding, auth
  extension/       # MV3 extension (popup + content script)
tools/mock-gem/    # local mock of BidPlus endpoints serving fixtures (dev + E2E)
e2e/               # Playwright specs per user story
wrangler.toml      # one Worker: API at /api/*, SPA via static assets, cron, R2 binding
```

**Structure Decision**: pnpm workspace monorepo with the layout above.

## Key Design Decisions

1. **GeM ingestion** (from Apache-2.0 `erenmyeager15/india-government-tenders-scraper` approach and
   public-endpoint observations): GET `/all-bids` for session cookie `csrf_gem_cookie`, then POST
   `/all-bids-data` form-encoded `payload=<json {page, param:{searchBid, searchType}, filter:{bidStatusType, byType, highBidValue, byEndDate, sort}}>`
   and `csrf_bd_gem_nk=<token>`; response `response.response.docs[]` with fields such as
   `b_bid_number`, `b_category_name`, `b_total_quantity`, `ba_official_details_minName`,
   `ba_official_details_deptName`, `final_start_date_sort`, `final_end_date_sort`, `b_id`,
   `b_bid_type`, `b_ra_to_bid_details`. Bid document: `/showbidDocument/{b_id}`. Base URL is
   configurable (`GEM_BASE_URL`) so dev/E2E point at `tools/mock-gem`.
2. **Requirement extraction rules** target the standard GeM bid-document labels ("Minimum Average
   Annual Turnover of the bidder", "Years of Past Experience Required", "Past Experience of Similar
   Services", "EMD Amount", "ePBG Percentage", "MSE Exemption for Years of Experience and Turnover",
   "Startup Exemption …", "Document required from seller", "MII Purchase Preference", "Bid End Date/Time",
   "Bid Offer Validity", "Item Category", "Estimated Bid Value", "Evaluation Method", "Delivery days").
3. **Scoring**: factors {turnover, experience, similarWork, emd, mii, oem, certificates, documents,
   deliveryFeasibility, timeToClose}; each → pass|fail|unknown|exempt with weight; hard blockers
   (turnover, experience, oem when mandatory & no exemption) force No-Go. Score = Σ(weight × value)/Σweight
   with unknown = 0.5; confidence = share of known factors.
4. **Auth**: email+password, PBKDF2-SHA256 (100k iterations, WebCrypto), opaque session token stored
   hashed in `sessions`, httpOnly SameSite=Lax cookie `tp_session`; API tokens for the extension.
5. **Packet**: pdf-lib; generated cover/index page, annexures rendered from templates
   (Handlebars-like `{{company.legalName}}` substitution in core), merged documents, outline bookmarks.
6. **Alerts**: `notifications` table is the outbox; dispatcher sends email (Resend API) / WhatsApp
   (Meta Cloud API) when keys exist, else marks `skipped`.
7. **Single Worker deploy**: `wrangler.toml` `assets = { directory = "apps/web/dist", not_found_handling = "single-page-application" }`,
   `run_worker_first = ["/api/*"]`, cron `*/30 * * * *`, R2 binding `BLOBS`, secrets `DATABASE_URL`,
   `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `SESSION_SECRET`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Two DB drivers | Neon in Workers, `pg` locally | Neon serverless driver cannot target a local Postgres without a proxy in CI |
