/**
 * Real-browser smoke test: loads dist/ as an unpacked extension in Chromium, opens the GeM-like
 * fixture, and asks the content script (from the extension's own page) to scan + fill.
 * Run: pnpm --filter @tp/extension build && pnpm --filter @tp/extension test:e2e
 * Exits non-zero if any forbidden field (price / captcha / OTP) is written or the form is submitted.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const extPath = fileURLToPath(new URL('../dist', import.meta.url));
const id = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const html = readFileSync(new URL('./fixtures/gem-form.html', import.meta.url));
const srv = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); }).listen(4567);

const ctx = await chromium.launchPersistentContext('', {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
for (const p of ctx.pages()) await p.close(); const page = await ctx.newPage();
await page.goto('http://localhost:4567/gem-form.html');
await page.waitForTimeout(800);
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup.html`);
const fields = [
  { key: 'make', label: 'Make', value: 'Dell', selectorHints: ['\\bmake\\b'] },
  { key: 'model', label: 'Model', value: 'Latitude 5450', selectorHints: ['\\bmodel\\b'] },
  { key: 'country_of_origin', label: 'Country of origin', value: 'India', selectorHints: ['country of origin'] },
  { key: 'mse_claim', label: 'MSE', value: 'Yes', selectorHints: ['\\bmse\\b'] },
  { key: 'offered_quantity', label: 'Qty', value: '40', selectorHints: ['\\bquantity\\b'] },
  { key: 'evil', label: 'x', value: '99999', selectorHints: ['price', 'captcha', 'otp', 'value', 'rate'] },
];
const scan = await popup.evaluate(async (fields) => {
  const tabs = await chrome.tabs.query({}); const tab = tabs.find((t) => !(t.url ?? '').startsWith('chrome-extension'));
  return chrome.tabs.sendMessage(tab.id, { type: 'tp:scan', fields });
}, fields);
console.log('scan', JSON.stringify(scan));
const chips = await page.locator('.tp-fill-chip').count();
const r = await popup.evaluate(async (fields) => {
  const tabs = await chrome.tabs.query({}); const tab = tabs.find((t) => !(t.url ?? '').startsWith('chrome-extension'));
  return chrome.tabs.sendMessage(tab.id, { type: 'tp:fill', fields });
}, fields);
console.log('fill', JSON.stringify(r));
const vals = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('input,select,textarea')].map((e) => [e.id || e.name, e.value])));
const submitted = await page.evaluate(() => window.__submitted ?? false);
console.log('chips', chips, 'values', JSON.stringify(vals), 'submitted', submitted);
const bad = ['unitPrice', 'totalValue', 'rate', 'captcha', 'otp', 'dsc'].filter((k) => vals[k]);
const ok = !bad.length && !submitted && vals.make === 'Dell' && vals.coo === 'IN' && vals.mse === 'Y' && chips === 5;
console.log(ok ? 'PASS' : `FAIL ${bad.join(',')}`);
process.exitCode = ok ? 0 : 1;

await ctx.close(); srv.close();
