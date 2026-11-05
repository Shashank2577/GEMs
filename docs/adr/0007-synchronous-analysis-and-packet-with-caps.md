# ADR-0007: Analysis and packet builds stay synchronous, bounded by explicit caps; Queues only on a stated trigger

**Status**: Proposed
**Date**: 2026-11-05
**Priority**: MUST (caps) · LATER (Cloudflare Queues)

## Context

`POST /tenders/:id/analyse` (`services/analyse.ts#analyseTender`) and `POST /workspaces/:id/packets`
(`services/packet.ts#buildWorkspacePacket`) do all the work inside the request. Measured shape of the work:

- Text extraction: `unpdf` over the whole PDF on upload / GeM fetch (`MAX_TENDER_DOC_BYTES` = 25 MB, no page cap).
- LLM: one call **per document** with up to 60,000 chars of input (`packages/core/src/analyse/llm.ts#MAX_CHARS`)
  and a 90 s timeout each (`adapters/llm.ts`). A tender with bid + ATC + BOQ + 2 corrigenda = 5 calls, up to
  7.5 minutes wall clock in the worst case; the browser waits.
- Packet: every item's bytes are loaded into memory and copied with pdf-lib; vault files are ≤ 20 MB, item count is
  unbounded; peak memory ≈ 2–3× input total against a 128 MB isolate.

Cloudflare Queues would decouple this (consumer Worker, retries, 15-min consumer wall clock), but adds a binding,
a consumer entry point, a job table, polling in the UI, and a Node equivalent for parity — real complexity for a
problem that explicit limits remove today.

## Decision

Keep both operations synchronous. Make the bounds explicit, cheap to check, and user-visible:

1. **Document size/page caps** (`packages/core/src/contracts/analyse.ts`, `services/analyse.ts`):
   `MAX_TENDER_DOC_PAGES = 300`; after extraction, documents with more pages are rejected 422 `too_many_pages`
   ("Split the document or upload only the bid and ATC sections"). `looksScanned` documents (OCR not supported)
   return 422 `scanned_pdf` instead of silently yielding an empty analysis.
2. **LLM budget per analysis** (`services/analyse.ts`): at most `LLM_MAX_CALLS_PER_ANALYSIS = 2` calls (bid, then
   ATC/corrigenda concatenated) and `LLM_MAX_CHARS_PER_ANALYSIS = 90,000`; per-call timeout 60 s; total LLM wall
   clock ≤ 120 s, after which the analysis completes with rules only and `method = 'rules'` plus a `warnings` entry
   ("AI enrichment timed out; rules-only result"). Constitution III already guarantees the rules path.
3. **Packet pre-flight** (`services/packet.ts`): before inserting `packets(building)`, sum `size_bytes` of the vault
   and tender-doc items (already loaded for validation) and reject 413 `packet_too_large` when > `MAX_PACKET_INPUT_BYTES`
   (40 MB) or > 40 items, with the offending items listed. `DEFAULT_MAX_PACKET_BYTES` (20 MB output warning) stays.
4. **CPU limit** raised to 120 s (ADR-0001).
5. **Queues trigger (LATER)**: adopt Cloudflare Queues for LLM enrichment and packet builds when any of: p95
   analysis latency > 60 s over a week; a "analyse all new matches" batch feature is scheduled; or a customer needs
   > 300-page documents. Design sketch when that happens: `analysis_jobs` table + `[[queues.producers]]`, consumer in
   `worker.ts#queue`, UI polls `GET /tenders/:id/analysis` (status `running` already exists in the schema).

## Consequences

- Worst-case request time drops from minutes to ~2 minutes with a deterministic result; cost per analysis is
  bounded (see ADR-0008).
- Some very large documents are refused with guidance instead of failing opaquely; this is acceptable for MSME bid
  documents (typically 20–120 pages).
- Packet users with very large scans are asked to compress — the same limit GeM itself imposes on uploads.

## Acceptance

- Unit tests for the caps (pages, chars, calls, packet bytes/items) in `packages/core` and `apps/api/test`.
- An analysis with 5 documents makes ≤ 2 LLM calls (fake LLM counts calls) and finishes < 10 s in tests.
- A packet request totalling 45 MB returns 413 with `details.items`; no `packets` row is created.
