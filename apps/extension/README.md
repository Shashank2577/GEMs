# TenderPilot — GeM co-pilot (Chrome extension, MV3)

Pre-fills **allow-listed, non-financial** fields on GeM bid pages from your TenderPilot bid workspace:
make, brand, model, OEM name, offered quantity, delivery period, warranty, country of origin, local
content %, MSE / Startup claim, specification compliance, HSN.

It **never** fills prices, rates, amounts or bid values. It never touches CAPTCHA, OTP, Aadhaar, DSC or
e-Sign fields, never clicks a button and never submits. Every fill needs a user click: either the
"Fill allowed fields" button in the popup or the small **TP** chip next to a field (Constitution I,
FR-026/FR-027). The same rules are enforced in three places: `@tp/core/assist/allowlist.ts` (shared
with the API, which also refuses to store price-like values), `src/fill.ts` (re-checks every field
right before writing), and the API payload (which never contains a price).

## Build and load unpacked

```bash
pnpm --filter @tp/extension build        # → apps/extension/dist
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → choose `apps/extension/dist`.
3. In TenderPilot go to **Settings → API tokens**, create a token with access **Extension (read-only)** (shown once, starts with `tp_`). The extension only ever reads (`GET`), so a read-only token is all it needs: if it leaks, nothing in TenderPilot can be changed or deleted with it. The Submit step of a workspace links straight to the dialog with that access preselected.
4. Click the TenderPilot toolbar icon → enter your TenderPilot URL (e.g. `https://tenderpilot.<you>.workers.dev`
   or `http://localhost:8787`) and the token → **Save & connect**. Chrome asks for permission to reach that URL.
5. Pick the bid workspace. Open the bid's participation page on `bidplus.gem.gov.in`, then:
   - **Highlight fields** — fillable fields get a dashed indigo outline and a **TP** chip (click to fill that one field);
     protected fields (price, CAPTCHA, OTP …) get a red outline and are left for you.
   - **Fill allowed fields** — fills every empty, allow-listed field. Values you already typed are not overwritten.
     A **Fill report** lists what was filled and what was skipped (and why).
   - Yes/No questions (radio buttons / checkboxes) that match an allow-listed value are never clicked: they get an amber
     **TP** chip whose tooltip shows the prepared answer, and appear in the report as "left for you".
   - **Clear highlights** — removes the outlines and TP chips (values already filled stay).
6. Enter the price, upload the documents (listed in the popup in order), authenticate with OTP / DSC / e-Sign and
   press **Final Submit** yourself on GeM. Then click **Mark as submitted** in the TenderPilot workspace.

## Files

| Path | Purpose |
|---|---|
| `public/manifest.json` | MV3 manifest: `storage`, `activeTab`, optional host permission for your TenderPilot URL, content script on `https://*.gem.gov.in` (and `localhost/*gem-form*` for testing) |
| `popup.html`, `src/popup.ts`, `src/popup.css` | Settings, workspace picker, values with copy buttons, upload order, human-only steps |
| `src/api.ts` | `chrome.storage.local` settings and `Bearer tp_…` calls to `/api/auth/me`, `/api/workspaces`, `/api/assist/:id` |
| `src/content.ts`, `src/listener.ts` | Listens for `tp:scan` / `tp:fill` / `tp:clear` from the popup only (`sender.id` must be this extension); adds TP chips; never submits |
| `src/fill.ts` | Pure fill logic (`plan`, `fillOne`, `fillAll`, `pickOption`) — unit-tested with fake fields |
| `src/dom.ts` | Adapts real `<input>/<select>/<textarea>` to the pure interface (labels, table context, native setters + events) |
| `test/fill.test.ts` | Unit tests: only technical fields are filled; price/CAPTCHA/OTP/DSC never written; no overwrite |
| `test/fixtures/gem-form.html` | GeM-like form with technical, financial and verification sections |
| `test/smoke.e2e.mjs` | Loads `dist/` in Chromium (Playwright), fills the fixture through the real content script |

## Tests

```bash
pnpm --filter @tp/extension test                 # unit (vitest)
pnpm --filter @tp/extension build && pnpm --filter @tp/extension test:e2e   # real Chromium, needs Playwright browsers
```
