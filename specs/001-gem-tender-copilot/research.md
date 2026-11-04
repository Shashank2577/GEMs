# Research — TenderPilot

## GeM BidPlus public data
- Reference implementations studied: `erenmyeager15/india-government-tenders-scraper` (Apache-2.0, TypeScript —
  filters, watchlists, PDF enrichment; reused design), `arush15june/gem-search` (MIT — bid status/result
  endpoints), and, for endpoint observations only (no code copied, no licence): `Giridar33/gem-tender-tracker`,
  `PranavTamada/Tender_Scraper`, `IshanMaheshwari-777/GEM-SCRAPER`, `Mujahid-Alam/gem-tender-pdf-extractor`,
  `Giri-Aayush/gem`, `rounittxx/gem-bid-scraper`.
- Listing: GET `/all-bids` sets `csrf_gem_cookie`; POST `/all-bids-data` with form fields `payload` (JSON) and
  `csrf_bd_gem_nk`. Response `{code:200, response:{response:{numFound, docs:[…]}}}`, 10 docs/page.
  Doc fields are often single-element arrays (`b_bid_number: ["GEM/2026/B/…"]`).
- Bid document PDF: `/showbidDocument/{b_id}`; RA documents: `/showradocumentPdf/{id}`.
- GeM is not reachable from CI sandboxes; everything is fixture-tested via `tools/mock-gem`.

## Decisions
- Rules-first extraction keyed on standard GeM bid-document labels; LLM (Claude) only enriches (Constitution III).
- `unpdf` for text extraction (runs in Workers and Node); `pdf-lib` for generating and merging PDFs.
- One Worker serves API + SPA assets; cron trigger every 30 minutes for ingestion/alerts/reminders.
- Neon serverless `Pool` in Workers, `pg` locally — same Drizzle schema.
