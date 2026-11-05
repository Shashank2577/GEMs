/**
 * 004 / US7 (#174), keyed server run. CI (scripts/e2e-ci.sh) runs every spec file once, on its own fresh API; the API's
 * key is decided by the server environment, which a file declares in this header line (read by scripts/e2e-ci.sh):
 *
 * @e2e-env ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:4119 PACKET_MAX_INPUT_BYTES=41943040
 *
 * US7-ai-ocr.e2e.ts is the no-key run (criteria 4 and 8 execute, the keyed tests skip themselves because
 * GET /api/analysis/capabilities says ai:false). This file registers the very same tests against the keyed API, where the
 * no-key tests skip and criteria 1-3, 5-7, 9-11 and x1-x5 execute (the fake Anthropic API is served by llm-stub.ts on 4119).
 * Nothing is duplicated: the tests live in US7-ai-ocr.e2e.ts and are only imported here.
 */
import './US7-ai-ocr.e2e';
