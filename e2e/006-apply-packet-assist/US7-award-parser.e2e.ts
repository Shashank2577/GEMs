/**
 * Spec 006 / US7, issue #537 (PR #550): QA of the independent parseAwardResult reimplementation through the Record result dialog (FR-085).
 * Each scenario picks a saved result page and checks what is pre-filled; nothing is saved until the human confirms.
 */
import { test, expect, evidence, collectRunArtifacts } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, setChecklist, CHECKLIST, type ApplyFixture } from '../support/seed-apply';
import type { Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = '006';
const STORY = 'US7-award-parser';
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
const files = () => mkdtempSync(join(tmpdir(), 'us7-ap-'));

test.describe('US7 award parser (#537)', () => {
  test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

  test('AP1 S.No|Seller|Price|Rank layout: L1 is the rank-1 seller, not the first row', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'sno-layout.html');
    writeFileSync(f, T(['S.No', 'Seller', 'Price', 'Rank'], [['1', 'Bravo Traders', '2,00,000', '2'], ['2', 'Alpha Systems', '1,00,000', '1']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('100000');
    await expect(d.getByLabel('Notes')).toHaveValue(/Alpha Systems/);
    await expect(d.getByLabel('Notes')).not.toHaveValue(/Bravo Traders/);
    await shot(page, 'ap1-sno-seller-price-rank');
  });

  test('AP2 Rupee symbol, Rs. and INR prices in lakh format', async ({ page, context }) => {
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
      await shot(page, `ap2-${k}-price`);
    }
  });

  test('AP3 Amount above 1e13 is rejected: no pre-fill', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'huge.html');
    writeFileSync(f, T(['Rank', 'Seller', 'Price'], [['L1', 'Huge Co', '1,00,00,00,00,00,001']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
    await expect(d.getByLabel('Notes')).toHaveValue('');
    await shot(page, 'ap3-over-1e13-rejected');
  });

  test('AP4 Hostile 512 KB file: UI stays responsive and finishes under 2 s', async ({ page, context }) => {
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
    await shot(page, 'ap4-hostile-512k-responsive');
  });

  test('AP5 No price table: message shown, nothing pre-filled', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'no-table.html');
    writeFileSync(f, '<html><body><h1>Government e Marketplace</h1><p>No evaluation here.</p><table><tr><td>RA End Date</td><td>05-11-2026</td></tr></table></body></html>');
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByText('No price table found in this page.')).toBeVisible();
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('');
    await shot(page, 'ap5-no-table-message');
  });

  test('AP6 Header "Rank | Firm | Price"', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'firm.html');
    writeFileSync(f, T(['Rank', 'Firm', 'Price'], [['L2', 'Second Firm', '9,00,000'], ['L1', 'First Firm Pvt Ltd', '4,50,000']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('450000');
    await expect(d.getByLabel('Notes')).toHaveValue(/First Firm Pvt Ltd/);
    await shot(page, 'ap6-firm-header');
  });

  test('AP7 Header "Rank | Participant | Total Price (₹)"', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'participant.html');
    writeFileSync(f, T(['Rank', 'Participant', 'Total Price (₹)'], [['L1', 'Participant One Co', '7,25,000'], ['L2', 'Participant Two Co', '8,00,000']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('725000');
    await expect(d.getByLabel('Notes')).toHaveValue(/Participant One Co/);
    await shot(page, 'ap7-participant-header');
  });

  test('AP8 Devanagari seller name is accepted', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'devanagari.html');
    writeFileSync(f, T(['Rank', 'Seller Name', 'Total Price'], [['L1', 'श्री गणेश ट्रेडर्स', '3,10,000'], ['L2', 'Other Co', '5,00,000']]), 'utf8');
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('310000');
    await expect(d.getByLabel('Notes')).toHaveValue(/श्री गणेश ट्रेडर्स/);
    await shot(page, 'ap8-devanagari-seller');
  });

  test('AP9 "Acme<br>Traders" seller shown as "Acme Traders"', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'br.html');
    writeFileSync(f, T(['Rank', 'Seller Name', 'Total Price'], [['L1', 'Acme<br>Traders', '2,20,000'], ['L2', 'Other Co', '3,00,000']]));
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('220000');
    await expect(d.getByLabel('Notes')).toHaveValue(/Acme Traders/);
    await expect(d.getByLabel('Notes')).not.toHaveValue(/AcmeTraders/);
    await shot(page, 'ap9-br-spacing');
  });

  test('AP10 Nested table: the outer rank-1 row wins', async ({ page, context }) => {
    const d = await setup(page, context);
    const f = join(files(), 'nested.html');
    const inner = '<table><tr><th>Rank</th><th>Seller Name</th><th>Total Price</th></tr><tr><td>L1</td><td>Inner Decoy</td><td>1,11,111</td></tr></table>';
    writeFileSync(f, `<html><body><table><tr><th>Rank</th><th>Seller Name</th><th>Total Price</th></tr><tr><td>L1</td><td>Outer Winner Co ${inner}</td><td>6,00,000</td></tr><tr><td>L2</td><td>Outer Second</td><td>7,00,000</td></tr></table></body></html>`);
    await d.locator('input[type=file]').setInputFiles(f);
    await expect(d.getByLabel('L1 price (₹)')).toHaveValue('600000');
    await expect(d.getByLabel('Notes')).toHaveValue(/Outer Winner Co/);
    await shot(page, 'ap10-nested-table');
  });
});
