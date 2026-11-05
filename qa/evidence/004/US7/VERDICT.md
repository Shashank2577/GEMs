## QA verdict - REJECTED

**Work item:** #174 - **PR:** #560 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq
**Code under test:** `7b22770` (cairn round-2 commit "OCR cost control round 2"). Rejection 1 of 3.

Test files: `e2e/004-analyse/US7-ai-ocr.e2e.ts`, `e2e/004-analyse/llm-stub.ts` (local HTTP stub of the Anthropic Messages API on `E2E_LLM_PORT`, recording every request; modes: ESI item, conflict/duplicate items, empty, HTTP 500, non-JSON, hang (timeout), refusal, max_tokens, OCR pages reply, OCR missing page). The API runs with `ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:4119 PACKET_MAX_INPUT_BYTES=41943040`; its stdout goes to a file (`E2E_API_LOG`) so log lines can be asserted. The Playwright config cannot switch the key per test, so criteria 4 and 8 ran as a second invocation against a second API on :8789 with the key unset (same spec file; each test reads `GET /api/analysis/capabilities` and skips on the other kind of server). Rules-only baselines for "identical factors" come from another org whose 10 monthly AI slots are used up (`llm_usage` rows seeded in SQL), which the API answers with method `rules` and zero LLM calls. Scanned documents come from mock-gem `/__admin/document-mode scanned` (reset to `normal` after every test).

**Playwright, keyed server** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`): **136 passed, 9 failed, 5 skipped** (desktop + mobile). US7 file: desktop 23 run (21 passed, 2 failed: 9c, x4), mobile 3 run (2 passed, 1 failed: x4).
**Playwright, no-key server** (US7 file, desktop + mobile): **4 passed, 1 failed (8b), 22 skipped** (the keyed tests).
Failures outside US7 (7 of the 9): `a11y.e2e.ts` x2 (only on the keyed server: AnalysisWarnings is `<ul role="status">` so its `<li>` fail axe `listitem`; passes on the no-key server; 008 markup, not touched by this PR), `US1-documents` tests 15 and 16 desktop and 15 mobile (strict-mode locator collision: the new "We couldn't read text from <file>" notice is also an `li` containing the file name; fails on both servers, see finding 3), `US6-stale` test 2 mobile (two corrigendum events on a shared mock tender; passes on desktop, unrelated).
**API tests**: 970 passed, 0 failed, 2 skipped (51 files + 2 skipped). **Core tests**: 590 passed, 0 failed (30 files).
API tests cited: `apps/api/test/analyse.test.ts`, `analyse-llm-tiers.test.ts` ("chunked enrichment", "GET /analysis/capabilities"), `ocr.test.ts` ("manual OCR: quota, partial replies, races, force"), `llm-privacy.test.ts`, `llm-adapter.test.ts` ("reports model and usage, and logs model / stop_reason / usage..." - uses a fake logger, which is why finding 1 was not caught).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | ESI item: `rules+llm`, item LLM capped 0.9, header, toast | met | API: `method: rules+llm`; the ESI item `method: LLM, confidence: 0.9` (stub sent 0.95), page 4; stub got exactly 1 enrichment call (`claude-sonnet-5-5`, JSON schema). Header reads exactly "33 requirements extracted · 32 by rules · 1 by AI"; toast "Rules + AI analysis complete". `01a`, `01b` (desktop + mobile) |
| 2 | Rule value kept; new keys added; fuzzy duplicates not added twice | met | Stub sent turnover_min with a different value at 0.9: stays RULE 0.95 (one item); new key `past_performance` added as LLM; a duplicate of a rule document ("... (self-attested copy)") and ESI sent twice ("ESI registration" and "ESI registration certificate") added once. 32 baseline -> 34 (+2). `02a`, `02b` |
| 3 | LLM throw / timeout / non-JSON -> `rules`, identical factors, warning log | met (minor deviation) | HTTP 500 (3a), non-JSON (3b), hung call (3c): `method: rules`; factors (10), score 46, verdict review and all 32 requirements deep-equal to the rules-only baseline. Log line `{"level":"warn","msg":"analyse: LLM enrichment failed; using rules only","error":"Anthropic API error 500"}` (3b: "Model reply was not valid JSON"). Deviation: the hung call is aborted by the API after **60 s** (analysis wall clock 60.1 s), the criterion says 90 s (008/FR-031 sets 60 s per call). `03aa`..`03c-timeout-warning-log` |
| 4 | No key: zero LLM requests, "Works without AI keys", rules-only Analysing copy | met | No-key server: capabilities `{ai:false, ocr:false, models:{}}`; empty state "Works without AI keys · AI adds ATC extras when enabled"; while analysing "Deterministic rules read the standard GeM fields — no AI key needed."; toast "Rules-only analysis complete", badge "Rules only"; the stub (the API's `LLM_BASE_URL`) received 0 requests. `04a`-`04d` (desktop + mobile) |
| 5 | "AI-assisted" tooltip: AI never decides the verdict | met | Tooltip text exactly "Rules extracted the standard GeM fields; AI added ATC-specific requirements. AI never decides the verdict." `05` |
| 6 | (gap) AI enabled: Analysing copy via `GET /analysis/capabilities` | met | Capabilities `{ai:true, ocr:true, models:{enrichment:'claude-sonnet-5-5', ocr:'claude-opus-5-5'}}` fetched by the page; while the stub delays the answer the card reads "Deterministic rules first, then AI reads the ATC for anything the rules missed." `06` |
| 7 | (gap) Scanned document: Read with AI (OCR) -> "Text via OCR", requirements <= 0.8 with OCR tooltip | met (minor deviation) | mock-gem scanned doc: row "No text — scanned?" + button; click -> toast "<file> read with AI" / "Text via OCR...", badge "Text via OCR"; DTO `textSource: ocr, hasText: true, needsOcr: false`, `pageCount` unchanged (3); one OCR call to `claude-opus-5-5`. Analysis: 30 requirements from the scan, all `source.ocr: true`, max confidence 0.8, pages 1-3; "Read by AI (OCR)" marker on every row. Also reachable by just running an analysis (7b). Deviation: tooltip reads "Read by AI from a scanned page — check against the original", criterion says "Read from a scanned page by AI OCR — check against the PDF". `07a`-`07d` (7 also mobile) |
| 8 | (gap) No OCR model: notice; `POST .../ocr` 503; analysis completes from listing data | **not met** (partly) | Met: notice "We couldn't read text from <file>. Upload a text PDF or ask your admin to enable AI OCR." (on the **Documents tab**, there is none on the Analysis tab), no OCR button, `POST .../ocr` -> 503 `ocr_unavailable`, 0 LLM requests. `08a`, `08b`. **Not met**: with the scanned document as the only document, `POST /analyse` -> **422 `scanned_document`** "This PDF is a scan without text. Upload the text PDF from GeM or an OCR’d copy." - the analysis does not complete from listing data (test 8b fails: expected 201, got 422; `08c`, `08d`). That 422 is 008/FR-030 behaviour (008 US4 sc9 and `apps/api/test/analyse.test.ts` "a scanned PDF is accepted on upload but analyse -> 422") and contradicts US7 scenario 8 as written: the spec conflict needs an owner decision |
| 9 | (gap) refusal/max_tokens = failure; model and token usage logged | **not met** (partly) | Met: refusal and max_tokens -> `method: rules`, warning "…stop_reason: refusal" / "…max_tokens", log `{"msg":"llm: call","model":"claude-sonnet-5-5","stopReason":"refusal"...}` (9a, 9b). **Not met**: the same line reads `"inputTokens":"[redacted]","outputTokens":"[redacted]"` for every call (9c fails: expected 1200, got "[redacted]"). The logger redacts any key matching `/token/i` (`apps/api/src/adapters/logger.ts` REDACT_KEY), and `apps/api/src/adapters/llm.ts:98` logs `inputTokens`/`outputTokens`. The unit test uses a fake logger, so it passes. `09a`-`09c` |
| 10 | (gap) text > 60,000 chars chunked (<= 4), not truncated | met | 14-page, ~157k-character PDF: 3 calls, page text 58,595 / 58,595 / 46,876 chars (each <= 60,000), pages 1..14 each sent once with real page numbers, one distinct item per chunk merged, no "not read" note. 30-page PDF: exactly 4 calls (<= 60,000 each) and note "Pages N–30 of very-long-annexure-30p.pdf were not read by AI". `10a`-`10c` |
| 11 | (gap) payload never contains profile, financials, past contracts, vault | met | Org with canary legal name/GSTIN/PAN, turnover, past contract buyer/title/value, vault title/file name/file content; every recorded stub request (enrichment and OCR) searched case/separator-insensitively: 0 hits. Positive control: enrichment body holds the bid text and "Already extracted by deterministic rules ... turnover_min"; OCR request content is exactly `[document, text]`. `11` |
| x1 | Manual OCR consumes the monthly AI quota; 402 when exhausted | met | 9 slots used -> OCR 200 (10/10) -> next OCR 402 `plan_limit_reached {limit: llmAnalysesPerMonth, used 10, max 10}`, UI "Plan limit reached" dialog; the refused call never reached the model. `x1` |
| x2 | OCR reply with a missing page -> 502, nothing stored | met | 502 `ocr_failed`; document stays `textSource: pdf, needsOcr: true`, no "Text via OCR" badge; error toast. `x2` |
| x3 | Viewer 403, cross-org 404, `?force=1` bid_manager+ | met | viewer 403; other org 404; text PDF 409; analyst OCR on a scan without OCR text 200 (round 2: the force check applies once OCR text exists); analyst `?force=1` with OCR text 403; owner `?force=1` 200; owner `?force=1` on a shared GeM copy 403. `x3` |
| x4 | (a11y) Documents tab with OCR action / Requirements OCR marker pass axe | **not met** (minor) | axe serious `label-content-name-mismatch` on the "Read with AI (OCR)" button: visible text "Read with AI (OCR)" but `aria-label="Read <file> with AI (OCR)"` (WCAG 2.5.3). Fails desktop and mobile. `x4a` |

Videos (one per test): this folder, `N-*-desktop.webm` / `-mobile.webm`.

### Findings

1. **major** - Token usage is never logged. Observed: every `llm: call` line has `inputTokens`/`outputTokens` = `"[redacted]"`. Expected (FR-049, criterion 9): input/output token usage and model id logged for every call. Where: `apps/api/src/adapters/llm.ts:98` (keys match the logger's `/token/i` redaction in `apps/api/src/adapters/logger.ts`); rename the keys (e.g. `usageIn`/`usageOut`, as the last commit did for `usageUnknown`) and test through the real logger.
2. **major** - Scanned-only tender without an OCR model: analyse -> 422 `scanned_document`, not "completes from listing data" (criterion 8; see table). Either the spec scenario or 008/FR-030 has to change; QA did not re-litigate it.
3. **minor** - New notice breaks existing e2e: `US1-documents.e2e.ts` tests 15 and 16 (`li:not([data-sonner-toast])` filtered by file name now matches the unreadable-document notice `li` as well as the row; test 16 because its 1-page header-only PDF counts as needing OCR). Fails on both servers.
4. **minor** - OCR button accessible name does not contain its visible text (axe `label-content-name-mismatch`), see x4.
5. **minor** - Timeout is 60 s (not 90 s), OCR tooltip wording and the notice being on the Documents tab rather than the Analysis tab differ from the criteria text.
6. **observation** - `AnalysisWarnings` renders `<ul role="status">`, so its `<li>` children fail axe `listitem` whenever a warning/note is shown (seen in `a11y.e2e.ts` on the keyed server). 008 markup, not introduced here.

### Not checked

- A real Anthropic API / real scanned PDFs (stub and mock-gem only); the optional escalation model (off by default, covered by `analyse-llm-tiers.test.ts` "escalation"); cairn commits after `7b22770`.

### Bug issues filed

- none

### Verdict

`qa:rejected` - criteria 8 and 9 not met (plus the a11y finding x4). Rejection 1 of 3. T094 not ticked.

---
_Generated by [Claude Code](https://claude.ai/code)_
