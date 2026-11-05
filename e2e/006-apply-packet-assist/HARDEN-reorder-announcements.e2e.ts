/**
 * Spec 006 / HARDEN (PR #536, epic #173): cross-cutting hardening checks by QA.
 *  - T097 / NFR-006: dnd-kit screen-reader announcements on the Packet step (keyboard drag), axe 0 serious/critical.
 *  - T010 / FR-036: concurrent PUT /annexure-templates/:key -> only 200s and exactly one row (unique index).
 *  - T096: spot-check of the documented error codes against live API calls.
 * Evidence: qa/evidence/006/HARDEN/.
 */
import { test, expect, evidence, collectRunArtifacts, a11y, noHorizontalOverflow } from '../support/fixtures';
import { seedApplyFixture, newApi, apiAs, signInAs, createWorkspace, E2E_DB_URL, type ApplyFixture } from '../support/seed-apply';
import { createNodeDb } from '../../packages/db/src/index';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const req = createRequire(import.meta.url);
const { sql } = req('../../packages/db/node_modules/drizzle-orm') as typeof import('../../packages/db/node_modules/drizzle-orm');

const SPEC = '006';
const STORY = 'HARDEN';
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
/** Viewport-only screenshot for use mid-drag (a full-page capture resizes the viewport, which makes dnd-kit cancel the drag). */
async function dragShot(page: Page, name: string) {
  mkdirSync(`qa/evidence/${SPEC}/${STORY}`, { recursive: true });
  const file = `qa/evidence/${SPEC}/${STORY}/${name}-${test.info().project.name}.png`;
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

interface Ctx { fx: ApplyFixture; ws: string }
let ctxP: Promise<Ctx> | undefined;
function main(): Promise<Ctx> {
  ctxP ??= (async () => {
    const a = await newApi();
    const fx = await seedApplyFixture(a);
    await a.dispose();
    return { fx, ws: (await createWorkspace(fx)).id };
  })();
  return ctxP;
}

async function openPacket(page: Page, context: any, c: Ctx) {
  await signInAs(context, c.fx, 'analyst');
  await page.goto(`/workspaces/${c.ws}?step=packet`);
  await expect(page.getByRole('heading', { name: 'Packet contents' })).toBeVisible();
}
/** Every text the dnd-kit live region has held, in order (what an assertive aria-live region would have read out). */
async function recordLive(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[id^="DndLiveRegion"]')!;
    (window as any).__live = [] as string[];
    new MutationObserver(() => { const t = el.textContent?.trim(); if (t) (window as any).__live.push(t); }).observe(el, { childList: true, characterData: true, subtree: true });
  });
}
/** Announcements made after the first `from` ones (so each step is asserted against fresh output only). */
const heardSince = async (page: Page, from: number) => (await heard(page)).slice(from);
const heard = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__live as string[]);
const liveText = async (page: Page) => (await page.locator('[id^="DndLiveRegion"]').first().textContent())?.trim() ?? '';
const list = (page: Page) => page.getByRole('list', { name: 'Documents in the packet, in order' });
const rowTitles = async (page: Page) => (await list(page).locator('li div.truncate.font-medium').allTextContents()).map((s) => s.trim());

const PAN = 'PAN card of the firm';
const GST = 'GST registration certificate';

test('@mobile T097 keyboard drag on the Packet step announces pick-up, move, drop and cancel', async ({ page, context }) => {
  const c = await main();
  await openPacket(page, context, c);
  const titles = await rowTitles(page);
  const total = titles.length;
  const panPos = titles.indexOf(PAN) + 1;
  expect(panPos, titles.join(' | ')).toBeGreaterThan(1);

  // The instructions the screen reader reads on focus.
  const instr = page.locator('[id^="DndDescribedBy"]').first();
  await expect(instr).toHaveText(/To pick up a document, press space or enter\. Use the up and down arrow keys to move it, space or enter to drop it, escape to cancel\./);
  await expect(page.getByRole('button', { name: `Reorder ${PAN}` })).toHaveAttribute('aria-describedby', /DndDescribedBy/);

  const grip = page.getByRole('button', { name: `Reorder ${PAN}` });
  await recordLive(page);
  await grip.focus();
  let n0 = (await heard(page)).length;
  await page.keyboard.press('Space');
  await expect.poll(() => heardSince(page, n0)).toContain(`Picked up ${PAN}. Position ${panPos} of ${total}.`);
  await dragShot(page, 'announce-1-picked-up');
  n0 = (await heard(page)).length;
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => heardSince(page, n0)).toContain(`${PAN} moved to position ${panPos - 1} of ${total}.`);
  await dragShot(page, 'announce-2-moved');
  n0 = (await heard(page)).length;
  await page.keyboard.press('Space');
  await expect.poll(() => heardSince(page, n0)).toContain(`Dropped ${PAN}. Position ${panPos - 1} of ${total}.`);
  expect((await rowTitles(page)).indexOf(PAN) + 1).toBe(panPos - 1);
  await shot(page, 'announce-3-dropped');

  // Cancel path: pick up, move down, Escape -> returns to its (new) position.
  const now = (await rowTitles(page)).indexOf(PAN) + 1;
  await page.getByRole('button', { name: `Reorder ${PAN}` }).focus();
  n0 = (await heard(page)).length;
  await page.keyboard.press('Space');
  await expect.poll(() => heardSince(page, n0)).toContain(`Picked up ${PAN}. Position ${now} of ${total}.`);
  n0 = (await heard(page)).length;
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => heardSince(page, n0)).toContain(`${PAN} moved to position ${now + 1} of ${total}.`);
  n0 = (await heard(page)).length;
  await page.keyboard.press('Escape');
  await expect.poll(() => heardSince(page, n0)).toContain(`Reordering cancelled. ${PAN} returned to position ${now} of ${total}.`);
  expect((await rowTitles(page)).indexOf(PAN) + 1, 'cancel leaves order unchanged').toBe(now);
  await shot(page, 'announce-4-cancelled');
  const seq = await heard(page);
  await test.info().attach('live-region-sequence.txt', { body: seq.join('\n'), contentType: 'text/plain' });
  const { writeFileSync } = await import('node:fs');
  mkdirSync(`qa/evidence/${SPEC}/${STORY}`, { recursive: true });
  writeFileSync(`qa/evidence/${SPEC}/${STORY}/live-region-sequence-${test.info().project.name}.txt`, seq.join('\n') + '\n');
  if (test.info().project.name === 'mobile') await noHorizontalOverflow(page);
  // Restore default order for later tests.
  const reset = page.getByRole('button', { name: 'Default order' });
  if (await reset.count()) await reset.click();
});

test('@mobile T097 axe scan on the Packet step has 0 serious/critical violations', async ({ page, context }) => {
  const c = await main();
  await openPacket(page, context, c);
  const proj = test.info().project.name;
  // Scoped to the Packet step grid (same scope as US5); the full-page scan is recorded as an observation below.
  const grid = { include: ['div[class*="xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"]'] };
  const r = await a11y(page, `packet-step-${proj}`, { spec: SPEC, story: STORY, ...grid });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  // Also with the reorder live region active (mid-drag).
  await page.getByRole('button', { name: `Reorder ${GST}` }).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => liveText(page)).toContain(GST);
  await a11y(page, `packet-step-mid-drag-${proj}`, { spec: SPEC, story: STORY, ...grid });
  await page.keyboard.press('Escape');
  await shot(page, 'axe-packet-step');
  // Observation only: whole page (shared workspace header included).
  try { await a11y(page, `packet-full-page-observation-${proj}`, { spec: SPEC, story: STORY }); } catch (e) {
    test.info().annotations.push({ type: 'axe-full-page', description: String((e as Error).message).split('\n')[0] });
  }
});

test('T010 concurrent PUT /annexure-templates/:key -> only 200s, exactly one row; indexes present', async ({ page, context }) => {
  const c = await main();
  const key = 'non_blacklisting';
  const apis = await Promise.all(Array.from({ length: 12 }, () => apiAs(c.fx, 'bid_manager')));
  const res = await Promise.all(apis.map((a, i) => a.put(`/api/annexure-templates/${key}`, { data: { title: `Concurrent ${i}`, body: `Concurrent save number ${i} for {{company.legalName}} on bid {{tender.bidNumber}}.` } })));
  const statuses = res.map((r) => r.status());
  await Promise.all(apis.map((a) => a.dispose()));
  expect(statuses, JSON.stringify(statuses)).toEqual(Array(12).fill(200));
  const { db, close } = await createNodeDb(E2E_DB_URL);
  try {
    const rows: any = await db.execute(sql`select count(*)::int as n from annexure_templates where org_id = ${c.fx.orgId} and key = ${key}`);
    expect((rows.rows ?? rows)[0].n).toBe(1);
    const idx: any = await db.execute(sql`select indexname from pg_indexes where indexname in ('annexure_templates_org_key_uq','comments_ws_idx','bid_workspaces_org_stage_idx') order by 1`);
    expect((idx.rows ?? idx).map((r: any) => r.indexname)).toEqual(['annexure_templates_org_key_uq', 'bid_workspaces_org_stage_idx', 'comments_ws_idx']);
  } finally { await close(); }
  await signInAs(context, c.fx, 'bid_manager');
  await page.goto(`/workspaces/${c.ws}?step=annexures&annexure=${key}`);
  await expect(page.locator('body')).toContainText(/Concurrent \d+|Non-blacklisting/);
  await shot(page, 'concurrent-put-annexure');
});

test('T096 documented error codes exist against live calls', async ({ page, context }) => {
  const c = await main();
  const out: string[] = [];
  const note = (s: string) => { out.push(s); };
  const E = (b: any) => b?.error ?? b;
  const am = await apiAs(c.fx, 'analyst');
  const bm = await apiAs(c.fx, 'bid_manager');
  // invalid_transition
  const inv = await am.patch(`/api/workspaces/${c.ws}`, { data: { stage: 'won' } });
  const invJ = E(await inv.json()); note(`PATCH stage=won before submitted -> ${inv.status()} ${invJ.code}`);
  expect(inv.status()).toBe(409); expect(invJ.code).toBe('invalid_transition');
  // nothing_to_override
  const no = await bm.post(`/api/workspaces/${c.ws}/overrides`, { data: { itemId: 'gst', reason: 'Trying to override a present item' } });
  const noJ = E(await no.json()); note(`POST overrides gst (present) -> ${no.status()} ${noJ.code}`);
  expect(no.status()).toBe(409); expect(noJ.code).toBe('nothing_to_override');
  // unknown_placeholder
  const up = await bm.put('/api/annexure-templates/non_blacklisting', { data: { title: 'Bad', body: 'Hello {{company.gstn}} this body is long enough.' } });
  const upJ = E(await up.json()); note(`PUT template {{company.gstn}} -> ${up.status()} ${upJ.code} details=${JSON.stringify(upJ.details)}`);
  expect(up.status()).toBe(400); expect(upJ.code).toBe('unknown_placeholder'); expect(upJ.details.unknown).toContain('company.gstn');
  // forbidden_field
  const ff = await am.put(`/api/workspaces/${c.ws}/assist-values`, { data: { unit_price: '1000' } });
  const ffJ = E(await ff.json()); note(`PUT assist-values unit_price -> ${ff.status()} ${ffJ.code}`);
  expect(ff.status()).toBe(400); expect(ffJ.code).toBe('forbidden_field');
  // DELETE comment
  const cm = await am.post(`/api/workspaces/${c.ws}/comments`, { data: { body: 'HARDEN contract probe' } });
  expect(cm.status()).toBe(201);
  const cid = (await cm.json()).id;
  const del = await am.delete(`/api/workspaces/${c.ws}/comments/${cid}`);
  note(`DELETE comment (author) -> ${del.status()}`); expect(del.status()).toBe(204);
  const del2 = await am.delete(`/api/workspaces/${c.ws}/comments/${cid}`);
  note(`DELETE comment again -> ${del2.status()}`); expect(del2.status()).toBe(404);
  const bmc = await bm.post(`/api/workspaces/${c.ws}/comments`, { data: { body: 'bid manager note' } });
  const bmcId = (await bmc.json()).id;
  const del3 = await am.delete(`/api/workspaces/${c.ws}/comments/${bmcId}`);
  const del3J = E(await del3.json()); note(`DELETE comment (analyst, other's) -> ${del3.status()} ${del3J.code}`);
  expect(del3.status()).toBe(403); expect(del3J.code).toBe('forbidden');
  // read_only_token
  const tk = await bm.post('/api/me/api-tokens', { data: { name: 'harden-read', scope: 'read' } });
  expect(tk.status(), await tk.text()).toBeLessThan(300);
  const secret = (await tk.json()).token;
  const bearer = await newApi();
  const ro = await bearer.post(`/api/workspaces/${c.ws}/comments`, { headers: { Authorization: `Bearer ${secret}` }, data: { body: 'x' } });
  const roJ = E(await ro.json()); note(`POST comment with scope=read token -> ${ro.status()} ${roJ.code} "${roJ.message}"`);
  expect(ro.status()).toBe(403); expect(roJ.code).toBe('read_only_token'); expect(roJ.message).toBe('This API token is read-only');
  const rg = await bearer.get(`/api/workspaces/${c.ws}`, { headers: { Authorization: `Bearer ${secret}` } });
  note(`GET workspace with scope=read token -> ${rg.status()}`); expect(rg.status()).toBe(200);
  // packet_too_large is exercised by US5 S14 in the full regression run (needs a >60 MB stored-size fixture).
  await Promise.all([am.dispose(), bm.dispose(), bearer.dispose()]);
  await test.info().attach('contract-spot-check.txt', { body: out.join('\n'), contentType: 'text/plain' });
  const { writeFileSync } = await import('node:fs');
  mkdirSync(`qa/evidence/${SPEC}/${STORY}`, { recursive: true });
  writeFileSync(`qa/evidence/${SPEC}/${STORY}/contract-spot-check.txt`, out.join('\n') + '\n');
  await signInAs(context, c.fx, 'analyst');
  await page.goto(`/workspaces/${c.ws}?step=packet`);
  await shot(page, 'contract-probe-done');
});
