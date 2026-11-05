## QA verdict - APPROVED (round 2)

**Work item:** #174 - **PR:** #560 - **Reviewer:** qa (claude-code) - **Session:** https://claude.ai/code/session_01BUi6mG5jQ8e8oe3shm7NHq
**Code under test:** `d8cee29` (developer rework `3dc2922` merged with origin/main, on top of cairn round 2 `7b22770`). Round 1 was a rejection (criteria 8, 9, x4).

Test files: `e2e/004-analyse/US7-ai-ocr.e2e.ts`, `e2e/004-analyse/llm-stub.ts` (local stub of the Anthropic Messages API on `E2E_LLM_PORT`, records every request; modes: ESI item, conflict/duplicates, empty, HTTP 500, non-JSON, hang, refusal, max_tokens, OCR pages reply, missing OCR page, OCR/enrichment delay). Keyed API: `ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:4119 PACKET_MAX_INPUT_BYTES=41943040`, stdout captured via `E2E_API_LOG` for the log assertions. Criteria 4 and 8 need no key; the config cannot switch it per test, so they ran as a second invocation against a second API (:8789, key unset, same spec file; each test reads `GET /api/analysis/capabilities` and skips on the other server kind). Rules-only baseline for "identical factors": an org with its 10 AI slots used up. Scanned documents: mock-gem `/__admin/document-mode scanned` (reset to `normal` after every test).

**Playwright, keyed** (`pnpm exec playwright test e2e/000-smoke e2e/004-analyse`, desktop + mobile): **146 passed, 0 failed, 5 skipped** (the no-key tests).
**Playwright, no-key** (US7 file, desktop + mobile): **5 passed, 0 failed, 23 skipped** (the keyed tests).
**API tests**: 982 passed, 1 failed, 2 skipped (53 files): `isolation.test.ts` "mapping, packet items, past-contract CRAC links and assignees reject A's ids" failed in the full run and passes alone (4/4); not US7 (shared test DB, from #527). **Core tests**: 592 passed, 0 failed (30 files).

### Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | ESI item: `rules+llm`, LLM item 0.9, header, toast | met | Header "33 requirements extracted · 32 by rules · 1 by AI"; item `method: LLM`, 0.9 (stub sent 0.95); toast "Rules + AI analysis complete". `01a`, `01b` |
| 2 | Rule kept; new keys; fuzzy duplicates once | met | turnover_min stays RULE 0.95; new key added; duplicate document and ESI sent twice added once (32 -> 34). `02a`, `02b` |
| 3 | Throw / timeout / non-JSON -> `rules`, identical factors, warning log | met (minor deviation) | 500, non-JSON, hung call: `method: rules`; 10 factors, score 46, 32 requirements equal to the rules-only baseline; warn log "analyse: LLM enrichment failed; using rules only". Deviation: API aborts after 60 s, not 90 s (008/FR-031). `03*` |
| 4 | No key: zero requests, "Works without AI keys", rules-only copy | met | No-key server: capabilities `{ai:false,ocr:false}`, copy "Deterministic rules read the standard GeM fields — no AI key needed.", stub got 0 requests. `04a`-`04d` |
| 5 | "AI-assisted" tooltip | met | Exact text. `05` |
| 6 | AI Analysing copy via capabilities | met | `{ai:true, ocr:true, models:{enrichment:'claude-sonnet-5-5', ocr:'claude-opus-5-5'}}`; "Deterministic rules first, then AI reads the ATC for anything the rules missed." `06` |
| 7 | Read with AI (OCR) -> "Text via OCR", <= 0.8, tooltip | met (minor deviation) | Badge, pageCount unchanged (3), 30 requirements `ocr:true`, max 0.8, pages 1-3; 1 call to `claude-opus-5-5`; also via plain analyse (7b). Deviation: tooltip "Read by AI from a scanned page — check against the original". `07a`-`07d` |
| 8 | No OCR model: notice, 503 (scenario as amended: scanned-only -> 422 `scanned_document`) | met | 503 `ocr_unavailable`; scanned-only analyse -> 422 `scanned_document` with `details.documents`; notice "We couldn't read text from <file>. Upload a text PDF or ask your admin to enable AI OCR." on the Analysis tab (with "Open Documents" link, test 8b) and on the Documents tab; no OCR button; 0 LLM requests. `08a`-`08d` |
| 9 | refusal/max_tokens = failure; model and token usage logged | met | refusal and max_tokens -> `rules`; log `{"msg":"llm: call","model":"claude-sonnet-5-5","stopReason":"end_turn","usageIn":1200,"usageOut":90}` (real logger; stop reason refusal / max_tokens in 9a/9b). Note the fields are `usageIn`/`usageOut`, not `inputTokens`/`outputTokens`. `09a`-`09c` |
| 10 | > 60,000 chars chunked (<= 4) | met | 157k chars: 3 calls of 58,595 / 58,595 / 46,876, pages 1..14 once each; 30 pages: 4 calls + note "Pages N–30 ... were not read by AI". `10a`-`10c` |
| 11 | No profile/financials/contracts/vault in payload | met | Canary values: 0 hits in every enrichment and OCR request; positive control present. `11` |
| x1 | Manual OCR uses AI quota; 402 | met | 10/10 then 402 `plan_limit_reached`; dialog; no model call. `x1` |
| x2 | Missing OCR page -> 502, nothing stored | met | 502 `ocr_failed`; document unchanged. `x2` |
| x3 | Viewer 403, cross-org 404, `?force=1` | met | viewer 403; other org 404; text PDF 409; analyst on a fresh scan 200; analyst `?force=1` once OCR text exists 403; owner force 200; owner force on a shared GeM copy 403. `x3` |
| x4 | a11y of OCR action / marker (axe) | met | No serious/critical violations on Documents tab with "Read with AI (OCR): <file>" button and on the Requirements OCR marker, desktop + mobile. `x4a` |
| x5 | Manual OCR already being read -> 409; one slot | met | Two concurrent POSTs on one scan: first 200, second 409 `conflict`; one model call; one AI slot used. `x5` |

Videos (one per test, re-encoded at crf 38 to fit the budget): this folder.

### Findings

1. **minor** - Hung-call timeout is 60 s (criterion text: 90 s); OCR requirement tooltip wording differs from the criterion text.
2. **observation** - Token fields are logged as `usageIn`/`usageOut` (the logger redacts `*token*` keys).
3. **observation** - `apps/api/test/isolation.test.ts` flaked once in a full API run (passes alone); not US7.

### Not checked

- Real Anthropic API and real scans (stub and mock-gem only); the optional escalation model (API tests only); cairn commits after `d8cee29`.

### Bug issues filed

- none

### Verdict

`qa:approved` - every criterion met (2 with a minor deviation); T094 ticked.

---
_Generated by [Claude Code](https://claude.ai/code)_


## Evidence index

Screenshots:

- [01a-toast-rules-plus-ai-desktop.png](01a-toast-rules-plus-ai-desktop.png)
- [01a-toast-rules-plus-ai-mobile.png](01a-toast-rules-plus-ai-mobile.png)
- [01b-requirements-header-esi-row-desktop.png](01b-requirements-header-esi-row-desktop.png)
- [01b-requirements-header-esi-row-mobile.png](01b-requirements-header-esi-row-mobile.png)
- [02a-requirements-merged-desktop.png](02a-requirements-merged-desktop.png)
- [02b-turnover-stays-rule-desktop.png](02b-turnover-stays-rule-desktop.png)
- [03aa-rules-only-toast-desktop.png](03aa-rules-only-toast-desktop.png)
- [03ab-warning-log-desktop.png](03ab-warning-log-desktop.png)
- [03ba-rules-only-toast-desktop.png](03ba-rules-only-toast-desktop.png)
- [03bb-warning-log-desktop.png](03bb-warning-log-desktop.png)
- [03c-timeout-rules-only-desktop.png](03c-timeout-rules-only-desktop.png)
- [03c-timeout-warning-log-desktop.png](03c-timeout-warning-log-desktop.png)
- [04a-works-without-ai-keys-desktop.png](04a-works-without-ai-keys-desktop.png)
- [04a-works-without-ai-keys-mobile.png](04a-works-without-ai-keys-mobile.png)
- [04b-analysing-rules-only-copy-desktop.png](04b-analysing-rules-only-copy-desktop.png)
- [04b-analysing-rules-only-copy-mobile.png](04b-analysing-rules-only-copy-mobile.png)
- [04c-rules-only-result-desktop.png](04c-rules-only-result-desktop.png)
- [04c-rules-only-result-mobile.png](04c-rules-only-result-mobile.png)
- [04d-zero-llm-requests-desktop.png](04d-zero-llm-requests-desktop.png)
- [04d-zero-llm-requests-mobile.png](04d-zero-llm-requests-mobile.png)
- [05-ai-assisted-tooltip-desktop.png](05-ai-assisted-tooltip-desktop.png)
- [06-analysing-ai-copy-desktop.png](06-analysing-ai-copy-desktop.png)
- [07a-scanned-row-ocr-action-desktop.png](07a-scanned-row-ocr-action-desktop.png)
- [07a-scanned-row-ocr-action-mobile.png](07a-scanned-row-ocr-action-mobile.png)
- [07b-text-via-ocr-badge-desktop.png](07b-text-via-ocr-badge-desktop.png)
- [07b-text-via-ocr-badge-mobile.png](07b-text-via-ocr-badge-mobile.png)
- [07c-requirements-ocr-tooltip-desktop.png](07c-requirements-ocr-tooltip-desktop.png)
- [07c-requirements-ocr-tooltip-mobile.png](07c-requirements-ocr-tooltip-mobile.png)
- [07d-analyse-ran-ocr-text-via-ocr-desktop.png](07d-analyse-ran-ocr-text-via-ocr-desktop.png)
- [08a-documents-notice-no-ocr-desktop.png](08a-documents-notice-no-ocr-desktop.png)
- [08a-documents-notice-no-ocr-mobile.png](08a-documents-notice-no-ocr-mobile.png)
- [08b-ocr-503-no-llm-request-desktop.png](08b-ocr-503-no-llm-request-desktop.png)
- [08b-ocr-503-no-llm-request-mobile.png](08b-ocr-503-no-llm-request-mobile.png)
- [08c-analysis-tab-scanned-notice-desktop.png](08c-analysis-tab-scanned-notice-desktop.png)
- [08d-documents-tab-notice-after-link-desktop.png](08d-documents-tab-notice-after-link-desktop.png)
- [09a-log-stop-reason-desktop.png](09a-log-stop-reason-desktop.png)
- [09a-rules-only-result-desktop.png](09a-rules-only-result-desktop.png)
- [09b-log-stop-reason-desktop.png](09b-log-stop-reason-desktop.png)
- [09b-rules-only-result-desktop.png](09b-rules-only-result-desktop.png)
- [09c-llm-call-log-usage-desktop.png](09c-llm-call-log-usage-desktop.png)
- [10a-chunk-calls-desktop.png](10a-chunk-calls-desktop.png)
- [10b-analysis-ai-assisted-desktop.png](10b-analysis-ai-assisted-desktop.png)
- [10c-four-chunks-and-note-desktop.png](10c-four-chunks-and-note-desktop.png)
- [11-no-company-data-in-llm-requests-desktop.png](11-no-company-data-in-llm-requests-desktop.png)
- [dev-documents-scanned-ocr-action.png](dev-documents-scanned-ocr-action.png)
- [dev-documents-text-via-ocr-mobile.png](dev-documents-text-via-ocr-mobile.png)
- [dev-documents-text-via-ocr.png](dev-documents-text-via-ocr.png)
- [dev-requirements-ocr-badge.png](dev-requirements-ocr-badge.png)
- [dev-unreadable-no-ocr.png](dev-unreadable-no-ocr.png)
- [x1-ocr-402-plan-limit-dialog-desktop.png](x1-ocr-402-plan-limit-dialog-desktop.png)
- [x2-partial-ocr-error-desktop.png](x2-partial-ocr-error-desktop.png)
- [x3-ocr-roles-matrix-desktop.png](x3-ocr-roles-matrix-desktop.png)
- [x4a-a11y-documents-ocr-action-desktop.png](x4a-a11y-documents-ocr-action-desktop.png)
- [x4a-a11y-documents-ocr-action-mobile.png](x4a-a11y-documents-ocr-action-mobile.png)
- [x5-ocr-already-being-read-409-desktop.png](x5-ocr-already-being-read-409-desktop.png)

Videos (one per test):

- [1-fake-llm-returns-an-esi-registration-item-rules-llm-item-l-desktop.webm](1-fake-llm-returns-an-esi-registration-item-rules-llm-item-l-desktop.webm)
- [1-fake-llm-returns-an-esi-registration-item-rules-llm-item-l-mobile.webm](1-fake-llm-returns-an-esi-registration-item-rules-llm-item-l-mobile.webm)
- [10-gap-a-150k-character-document-is-sent-in-page-aligned-chu-desktop.webm](10-gap-a-150k-character-document-is-sent-in-page-aligned-chu-desktop.webm)
- [10b-gap-at-most-4-chunks-per-document-pages-beyond-are-repor-desktop.webm](10b-gap-at-most-4-chunks-per-document-pages-beyond-are-repor-desktop.webm)
- [11-gap-llm-payloads-enrichment-and-ocr-contain-no-profile-fi-desktop.webm](11-gap-llm-payloads-enrichment-and-ocr-contain-no-profile-fi-desktop.webm)
- [2-rule-value-kept-over-a-lower-confidence-llm-value-new-key--desktop.webm](2-rule-value-kept-over-a-lower-confidence-llm-value-new-key--desktop.webm)
- [3a-llm-call-throws-http-500-method-rules-factors-identical-t-desktop.webm](3a-llm-call-throws-http-500-method-rules-factors-identical-t-desktop.webm)
- [3b-llm-replies-with-non-json-method-rules-factors-identical--desktop.webm](3b-llm-replies-with-non-json-method-rules-factors-identical--desktop.webm)
- [3c-llm-never-answers-timeout-analysis-still-completes-with-m-desktop.webm](3c-llm-never-answers-timeout-analysis-still-completes-with-m-desktop.webm)
- [4-no-api-key-zero-llm-requests-works-without-ai-keys-ai-adds-desktop.webm](4-no-api-key-zero-llm-requests-works-without-ai-keys-ai-adds-desktop.webm)
- [4-no-api-key-zero-llm-requests-works-without-ai-keys-ai-adds-mobile.webm](4-no-api-key-zero-llm-requests-works-without-ai-keys-ai-adds-mobile.webm)
- [5-ai-assisted-badge-tooltip-says-ai-never-decides-the-verdic-desktop.webm](5-ai-assisted-badge-tooltip-says-ai-never-decides-the-verdic-desktop.webm)
- [6-gap-ai-enabled-get-analysis-capabilities-ai-true-and-the-a-desktop.webm](6-gap-ai-enabled-get-analysis-capabilities-ai-true-and-the-a-desktop.webm)
- [7-gap-scanned-gem-document-read-with-ai-ocr-text-via-ocr-pag-desktop.webm](7-gap-scanned-gem-document-read-with-ai-ocr-text-via-ocr-pag-desktop.webm)
- [7-gap-scanned-gem-document-read-with-ai-ocr-text-via-ocr-pag-mobile.webm](7-gap-scanned-gem-document-read-with-ai-ocr-text-via-ocr-pag-mobile.webm)
- [7b-gap-running-an-analysis-reads-a-scanned-only-tender-with--desktop.webm](7b-gap-running-an-analysis-reads-a-scanned-only-tender-with--desktop.webm)
- [8-gap-no-ocr-model-notice-we-couldn-t-read-text-from-file-up-desktop.webm](8-gap-no-ocr-model-notice-we-couldn-t-read-text-from-file-up-desktop.webm)
- [8-gap-no-ocr-model-notice-we-couldn-t-read-text-from-file-up-mobile.webm](8-gap-no-ocr-model-notice-we-couldn-t-read-text-from-file-up-mobile.webm)
- [8b-gap-spec-scenario-8-as-amended-no-ocr-model-scan-is-the-o-desktop.webm](8b-gap-spec-scenario-8-as-amended-no-ocr-model-scan-is-the-o-desktop.webm)
- [9a-gap-stop-reason-refusal-treated-as-llm-failure-rules-fall-desktop.webm](9a-gap-stop-reason-refusal-treated-as-llm-failure-rules-fall-desktop.webm)
- [9b-gap-stop-reason-max-tokens-treated-as-llm-failure-rules-f-desktop.webm](9b-gap-stop-reason-max-tokens-treated-as-llm-failure-rules-f-desktop.webm)
- [9c-gap-token-usage-input-output-and-model-id-are-logged-for--desktop.webm](9c-gap-token-usage-input-output-and-model-id-are-logged-for--desktop.webm)
- [x1-manual-ocr-takes-a-monthly-ai-slot-the-run-that-uses-the--desktop.webm](x1-manual-ocr-takes-a-monthly-ai-slot-the-run-that-uses-the--desktop.webm)
- [x2-an-ocr-reply-that-leaves-out-a-page-502-ocr-failed-and-no-desktop.webm](x2-an-ocr-reply-that-leaves-out-a-page-502-ocr-failed-and-no-desktop.webm)
- [x3-ocr-roles-viewer-403-another-org-404-text-pdf-409-force-1-desktop.webm](x3-ocr-roles-viewer-403-another-org-404-text-pdf-409-force-1-desktop.webm)
- [x4-a11y-axe-serious-critical-documents-tab-with-the-ocr-acti-desktop.webm](x4-a11y-axe-serious-critical-documents-tab-with-the-ocr-acti-desktop.webm)
- [x4-a11y-axe-serious-critical-documents-tab-with-the-ocr-acti-mobile.webm](x4-a11y-axe-serious-critical-documents-tab-with-the-ocr-acti-mobile.webm)
- [x5-a-second-manual-ocr-of-a-document-that-is-already-being-r-desktop.webm](x5-a-second-manual-ocr-of-a-document-that-is-already-being-r-desktop.webm)
