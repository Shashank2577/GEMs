/**
 * Spec 006 / US7, issue #537 (PR #550): QA of the clean-room parseAwardResult through the Record result dialog (FR-085).
 * Each scenario picks a saved result page and checks what is pre-filled; nothing is saved until the human confirms.
 */
import { test, expect, evidence, collectRunArtifacts } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, setChecklist, CHECKLIST, type ApplyFixture } from '../support/seed-apply';
import type { Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '006';
const STORY = 'US7-cleanroom';
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, name);
const dialog = (page: Page) => page.getByRole('dialog');

const T = (head: string[], rows: string[][]) =>
  `<html><body><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></body></html>`;

async function setup(page: Page, context: any) {
  const a = await newApi();
  const fx: ApplyFixture = await seedApplyFixture(a);
  await a.dispose();
  const ws = (await createWorkspace(fx)).id;
  await setChecklist(fx, CHECKLIST.filter((i) => i.id !== 'oem_authorization'));
  const api = await apiAs(fx, 'analyst');
  expect((await api.patch(`/api/workspaces/${ws}`, { data: { stage: 'ready' } })).status()).toBe(200);
  expect((await api.post(`/api/workspaces/${ws}/submitted`, { data: {} })).status()).toBe(200);
  await api.dispose();
  await signInAs(context, fx, 'analyst');
  await page.goto(`/workspaces/${ws}?step=submit`);
  await expect(page.getByRole('heading', { name: 'Human-only steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Record result' }).click();
  return dialog(page);
}
const files = () => mkdtempSync(join(tmpdir(), 'us7-cr-'));

test.describe('US7 clean-room award parser (#537)', () => {
  test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

  test('CR1 S.No|Seller|Price|Rank layout: L1 is the rank-1 seller, not the first row', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'sno-layout.html');
    writeFileSync(f, T(['S.No', 'Seller', 'Price', 'Rank'], [['1', 'Bravo Traders', '2,00,000', '2'], ['2', 'Alpha Systems', '1,00,000', '1']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('100000');
    await expect(d.getByLabel('Notes')).toHaveValue(/Alpha Systems/);
    await expect(d.getByLabel('Notes')).not.toHaveValue(/Bravo Traders/);
    await shot(page, 'cr1-sno-seller-price-rank');
  });

  test('CR2 Rupee symbol, Rs. and INR prices in lakh format', async ({ page, context }) => {
    const d = await setup(page, context);
    const dir = files();
    const cases: [string, string, string, string][] = [
      ['rupee', '₹ 28,40,500.00', '2840500', 'Rupee Co'],
      ['rs', 'Rs. 1,50,000', '150000', 'Rs Co'],
      ['inr', '15,00,000 INR', '1500000', 'Inr Co'],
    ];
    for (const [k, price, expected, seller] of cases) {
      const f = join(dir, `${k}.html`);
      writeFileSync(f, T(['Rank', 'Seller Name', 'Total Price'], [['L1', seller, price], ['L2', 'Other Co', '99,99,999']]));
      await d.locator('input[type=file]').setInputFiles(f);
      await expect(d.getByLabel('L1 price (₹)')).toHaveValue(expected);
      await expect(d.getByLabel('Notes')).toHaveValue(new RegExp(seller));
      await shot(page, `cr2-${k}-price`);
    }
  });

  test('CR3 Amount above 1e13 is rejected: no pre-fill', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'huge.html');
    writeFileSync(f, T(['Rank', 'Seller', 'Price'], [['L1', 'Huge Co', '1,00,00,00,00,00,001']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
    await expect(d.getByLabel('Notes')).toHaveValue('');
    await shot(page, 'cr3-over-1e13-rejected');
  });

  test('CR4 Hostile 512 KB file: UI stays responsive and finishes under 2 s', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'hostile-512k.html');
    const cell = 'Rank Seller Price '.repeat(Math.ceil(512 * 1024 / 18)).slice(0, 512 * 1024);
    writeFileSync(f, `<html><body><table><tr><th>${cell}</th><th>Seller Name</th><th>Total Price</th></tr><tr><td>L1</td><td>X</td><td>1,00,000</td></tr></table></body></html>`);
    const t0 = Date.now();
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByRole('status').first()).toBeVisible({ timeout: 2_000 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'hostile-ms', description: String(ms) });
    console.log(`HOSTILE_MS=${ms}`);
    expect(ms).toBeLessThan(2_000);
    await d.getByLabel('L1 price (₹)').fill('123');
    await expect(d.getByText('₹123', { exact: true })).toBeVisible();
    await shot(page, 'cr4-hostile-512k-responsive');
  });

  test('CR5 No price table: message shown, nothing pre-filled', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'no-table.html');
    writeFileSync(f, '<html><body><h1>Government e Marketplace</h1><p>No evaluation here.</p><table><tr><td>RA End Date</td><td>05-11-2026</td></tr></table></body></html>');
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
    await shot(page, 'cr5-no-table-message');
  });
});
