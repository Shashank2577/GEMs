/**
 * 003 / HARDEN (#61, PR #555) — QA for the T004 scaffold helpers. Each helper from e2e/support/fixtures.ts is exercised
 * once against the real mock GeM and the real API: resetGem, publishOnGem, gemCorrigendum, gemCancel, gemFail,
 * syncNow, evidence003. One real sync only (the default manual-sync cooldown is 10 minutes, 008/FR-026), then a second
 * syncNow proves the fail-fast branch (wait > 60 s throws instead of sleeping).
 */
import { test, expect, collectRunArtifacts, mockGem, uniqueUser, signupViaApi, resetGem, publishOnGem, gemCorrigendum, gemCancel, gemFail, syncNow, evidence003, GEM_URL } from '../support/fixtures';

const STORY = 'HARDEN';
const BID = 'GEM/2026/B/6421001';
const BID2 = 'GEM/2026/B/6421010';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => { await collectRunArtifacts('003', STORY, page); });

test('HARDEN scaffold helpers drive the mock GeM and a real sync', async ({ page, request }) => {
  await signupViaApi(page, uniqueUser('harden'));
  const state = async () => (await request.get(`${GEM_URL}/__admin/state`)).json();

  // resetGem: fixtures restored, outage off
  await mockGem(request, '/__admin/fail', { mode: 'down' });
  await resetGem(request);
  expect((await request.get(`${GEM_URL}/all-bids`)).status()).toBe(200);
  const base = await state();
  const baseTotal = (base.total ?? base.bidNumbers?.length ?? base.docs?.length) as number;
  expect(baseTotal).toBeGreaterThanOrEqual(36);

  // publishOnGem: N fresh bids
  const pub = await publishOnGem(request, 2);
  expect(pub.ok).toBe(true);
  expect(pub.published).toHaveLength(2);
  expect(pub.total).toBe(baseTotal + 2);

  // gemCorrigendum: amend end date, quantity, EMD
  const cor = await gemCorrigendum(request, BID, { days: 7, quantity: 90, emd: 300000 });
  expect(cor.ok).toBe(true);
  await expect(gemCorrigendum(request, 'GEM/2026/B/0000000', {})).rejects.toThrow();

  // gemCancel
  const can = await gemCancel(request, BID2);
  expect(can).toMatchObject({ ok: true, bidNumber: BID2, cancelled: true });

  // gemFail: down (5xx), html (format drift), off (healthy)
  expect((await gemFail(request, 'down')).failMode).toBe('down');
  expect((await request.get(`${GEM_URL}/all-bids`)).status()).toBe(503);
  expect((await gemFail(request, 'html')).failMode).toBe('html');
  expect((await gemFail(request, 'off')).failMode).toBe('off');
  expect((await request.get(`${GEM_URL}/all-bids`)).status()).toBe(200);

  // syncNow: one real sync picks up the published, amended and cancelled bids
  const res = await syncNow(page.request);
  expect(res.status(), await res.text()).toBe(200);
  const run = await res.json();
  expect(run).toMatchObject({ status: 'success', error: null });
  expect(run.tendersCreated).toBe(baseTotal + 2);

  const feed = await (await page.request.get('/api/tenders?status=all&pageSize=100')).json();
  const rows = feed.items ?? feed.tenders ?? feed.data;
  const byBid = (b: string) => rows.find((t: { bidNumber: string }) => t.bidNumber === b);
  expect(byBid(BID2)).toBeTruthy();
  expect(JSON.stringify(byBid(BID2))).toMatch(/cancel/i);
  expect(byBid(BID)).toBeTruthy();

  await page.goto('/tenders');
  await expect(page.getByRole('heading', { name: 'Tenders', exact: true }).first()).toBeVisible();
  const file = await evidence003(page, STORY, `feed-after-scaffold-sync-${test.info().project.name}`);
  expect(file).toContain('qa/evidence/003/HARDEN/');
});

test('HARDEN syncNow fails fast when the 10-minute cooldown is active', async ({ page }) => {
  const t0 = Date.now();
  // same session needs the org from test 1: log in is not stored, so re-use a fresh owner with a stale-sync cooldown (platform-wide)
  await signupViaApi(page, uniqueUser('harden2'));
  await expect(syncNow(page.request)).rejects.toThrow(/cooldown/i);
  expect(Date.now() - t0).toBeLessThan(15_000);
  await page.goto('/tenders');
  await evidence003(page, STORY, `syncnow-failfast-${test.info().project.name}`);
});
