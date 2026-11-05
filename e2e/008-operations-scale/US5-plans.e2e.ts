/**
 * 008 / US5 — Plans, trial expiry and AI usage are metered and enforced with honest messages (story #360).
 *
 * One test (or a desktop + @mobile pair) per acceptance scenario of specs/008-operations-scale/spec.md US5 (scenarios 1–12).
 * Screenshots go to qa/evidence/008/US5/, one video per test, API/DB transcripts as .txt, axe results as .axe.json.
 *
 * Server environment this spec needs (set by the runner, not by product code):
 *   ADMIN_TOKEN=<>= 32 chars>                       (scenario 12; the spec reads the same variable)
 *   ANTHROPIC_API_KEY=qa-fake LLM_BASE_URL=http://127.0.0.1:${E2E_LLM_PORT:-4115}   (this file serves a counting fake Anthropic API)
 * Direct DB access (psql) is used only to create states the public API cannot produce in a test run: usage counters of a past
 * month-like volume (10 analyses, 200 packets, 10 GB of vault rows), a trial that ends in N days / ended N days ago, an org on a plan.
 *
 * The scenario-1 example date (sign-up on 2026-11-05 10:00 IST) cannot be replayed against a live server clock; the test checks the
 * same rule on real data (trialEndsAt == created_at + 14 × 24 h to the millisecond) and the example's arithmetic separately.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, uniqueUser, evidence, atPhone, noHorizontalOverflow, a11y, inviteAs, type InvitedRole } from '../support/fixtures';
import { createWorkspace, seedApplyFixture, signInAs, type ApplyFixture } from '../support/seed-apply';
import { fixturePath } from '../004-analyse/support';

const SPEC = '008';
const STORY = 'US5';
const DIR = join('qa', 'evidence', SPEC, STORY);
const DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LLM_PORT = Number(process.env.E2E_LLM_PORT || 4115);
const MB = 1024 * 1024;
const GIB = 1024 * MB;
const PROJECT = () => test.info().project.name;
const shot = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${PROJECT()}`);
const SALES = 'mailto:sales@tenderpilot.in?subject=TenderPilot%20plan';

// Same contract as fixtures.collectRunArtifacts (one .webm per test), but it waits for the recorder to finish (`video.saveAs`).
test.afterEach(async ({ page }) => {
  const info = test.info();
  if (info.status === 'skipped') return;
  mkdirSync(DIR, { recursive: true });
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const video = page.video();
  await page.close();
  if (video) await video.saveAs(join(DIR, `${slug}-${info.project.name}.webm`)).catch(() => undefined);
});

// ───────────── helpers ─────────────

function psql(sql: string): string {
  return execFileSync('psql', [DB, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

class Transcript {
  private lines: string[] = [];
  constructor(private name: string) { this.add(`# ${name} — project ${PROJECT()} — ${new Date().toISOString()}`); }
  add(line = '') { this.lines.push(line); }
  async http(label: string, res: Awaited<ReturnType<APIRequestContext['get']>>, reqNote: string) {
    this.add(`### ${label}`);
    this.add(`> ${reqNote}`);
    this.add(`< ${res.status()}`);
    this.add((await res.text()).slice(0, 900));
    this.add();
  }
  save() {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${this.name}-${PROJECT()}.txt`), this.lines.join('\n') + '\n');
  }
}

async function errorOf(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  const j = await res.json().catch(() => ({}));
  return { status: res.status(), code: j?.error?.code as string | undefined, message: j?.error?.message as string | undefined, details: j?.error?.details };
}

/** Fresh trial org + owner session on `page`. */
async function newOrg(page: Page, prefix = 'plan') {
  const user = uniqueUser(prefix);
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { user, orgId: body.org.id as string };
}
const setPlan = (orgId: string, plan: 'trial' | 'starter' | 'pro' | 'enterprise') =>
  psql(`update organizations set plan='${plan}', trial_ends_at = ${plan === 'trial' ? 'trial_ends_at' : 'null'} where id='${orgId}'`);
const setTrialEnds = (orgId: string, interval: string) => psql(`update organizations set plan='trial', trial_ends_at = now() + interval '${interval}' where id='${orgId}'`);

/** Switch the page's browser session (and page.request) to an invited member with `role`. */
async function asRole(page: Page, role: InvitedRole) {
  const inv = await inviteAs(page.request, role);
  await page.context().clearCookies();
  await page.context().addCookies(inv.storageState.cookies);
  await inv.api.dispose();
  return inv;
}

function insertTender(): { id: string; bidNumber: string } {
  const bid = `GEM/2026/B/${9_300_000 + Math.floor(Math.random() * 699_999)}`;
  const id = psql(`insert into tenders (source, bid_number, title, source_url, content_hash, status, end_at)
    values ('gem', '${bid}', 'QA plans tender ${bid}', 'https://example.invalid/${bid}', 'qa-plan-${Date.now()}-${Math.random()}', 'open', now() + interval '20 days') returning id;`).split('\n')[0];
  return { id, bidNumber: bid };
}
const seedAnalyses = (orgId: string, tenderId: string, n: number) =>
  psql(`insert into analyses (org_id, tender_id, status, method, verdict, score, confidence) select '${orgId}', '${tenderId}', 'done', 'rules', 'review', 60, 0.7 from generate_series(1, ${n})`);
const seedLlmSlots = (orgId: string, n: number, input = 100, output = 20) =>
  psql(`insert into llm_usage (org_id, analysis_ref, kind, model, input_tokens, output_tokens, reserved) select '${orgId}', gen_random_uuid(), 'extract', 'qa-seed', ${input}, ${output}, false from generate_series(1, ${n})`);
const seedVaultBytes = (orgId: string, bytes: number) => {
  const full = Math.floor(bytes / 2_000_000_000);
  const rest = bytes - full * 2_000_000_000;
  const row = (size: number, i: number) => `('${orgId}', 'gst', 'QA ballast ${i}', 'qa/ballast-${i}', 'ballast-${i}.pdf', 'application/pdf', ${size})`;
  const rows = [...Array.from({ length: full }, (_, i) => row(2_000_000_000, i)), ...(rest > 0 ? [row(rest, full)] : [])];
  psql(`insert into vault_documents (org_id, type, title, blob_key, file_name, mime_type, size_bytes) values ${rows.join(', ')}`);
};
const seedPacketLedger = (orgId: string, n: number) => psql(`insert into packet_ledger (packet_id, org_id) select gen_random_uuid(), '${orgId}' from generate_series(1, ${n})`);
const seedPendingInvites = (orgId: string, n: number) =>
  psql(`insert into invitations (org_id, email, role, token_hash, expires_at) select '${orgId}', 'ballast'||g||'@example.in', 'viewer', md5(random()::text||g), now() + interval '7 days' from generate_series(1, ${n}) g`);

const pdfOf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) });
async function attachBid(request: APIRequestContext, tenderId: string) {
  const res = await request.post(`/api/tenders/${tenderId}/documents`, { multipart: { kind: 'bid', file: pdfOf('bid.pdf') } });
  expect(res.status(), await res.text()).toBe(201);
}
/** A PDF padded with a trailing comment to `bytes` (still a valid PDF for readers; plan check / size are what we test). */
async function paddedPdf(bytes: number) {
  const base = readFileSync(fixturePath('go-it-services'));
  return Buffer.concat([base, Buffer.from('\n%' + 'x'.repeat(Math.max(0, bytes - base.length - 3)) + '\n')]);
}

const planDialog = (page: Page) => page.locator('[data-plan-dialog]');

// ───────────── fake Anthropic API (scenarios 10, 11) ─────────────
interface LlmCall { at: number; input: number; output: number }
const llmCalls: LlmCall[] = [];
let llmServer: Server | undefined;
async function startFakeLlm() {
  if (llmServer) return;
  let n = 0;
  llmServer = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      n += 1;
      const call = { at: Date.now(), input: 1000 + n * 37, output: 200 + n * 11 };
      llmCalls.push(call);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_qa', type: 'message', role: 'assistant', model: 'qa-fake', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"requirements":[]}' }], usage: { input_tokens: call.input, output_tokens: call.output } }));
    });
  });
  await new Promise<void>((ok, bad) => { llmServer!.once('error', bad); llmServer!.listen(LLM_PORT, '127.0.0.1', () => ok()); });
}
test.beforeAll(async () => { await startFakeLlm(); });
test.afterAll(async () => { await new Promise<void>((ok) => (llmServer ? llmServer.close(() => ok()) : ok())); llmServer = undefined; });

// ═════════════ scenario 1 — trial dates ═════════════

test('sc1 sign-up gives plan "trial" and trialEndsAt = created + 14 × 24 h on /api/auth/me and /api/org', async ({ page }) => {
  const t = new Transcript('sc1-trial-dates');
  const { orgId } = await newOrg(page, 'sc1');
  const meRes = await page.request.get('/api/auth/me');
  await t.http('GET /api/auth/me', meRes, 'GET /api/auth/me');
  const me = await meRes.json();
  const orgRes = await page.request.get('/api/org');
  await t.http('GET /api/org', orgRes, 'GET /api/org');
  const org = await orgRes.json();
  expect(me.org.plan).toBe('trial');
  expect(org.plan).toBe('trial');
  expect(typeof me.org.trialEndsAt).toBe('string');
  const createdMs = Number(psql(`select (extract(epoch from created_at)*1000)::bigint from organizations where id='${orgId}'`));
  const storedMs = Number(psql(`select (extract(epoch from trial_ends_at)*1000)::bigint from organizations where id='${orgId}'`));
  t.add(`organizations.created_at = ${new Date(createdMs).toISOString()}; trial_ends_at = ${new Date(storedMs).toISOString()}; difference = ${(storedMs - createdMs) / 3_600_000} h`);
  expect(storedMs - createdMs, 'trial_ends_at - created_at').toBe(14 * 24 * 3_600_000);
  expect(Date.parse(me.org.trialEndsAt)).toBe(storedMs);
  expect(org.trialEndsAt).toBe(me.org.trialEndsAt);
  // The scenario's worked example: sign-up on 2026-11-05 10:00 IST → 2026-11-19T04:30:00.000Z.
  const example = new Date(Date.parse('2026-11-05T10:00:00+05:30') + 14 * 24 * 3_600_000).toISOString();
  t.add(`example: 2026-11-05 10:00 IST + 14 × 24 h = ${example}`);
  expect(example).toBe('2026-11-19T04:30:00.000Z');
  await page.goto('/settings/usage');
  await expect(page.getByTestId('trial-line')).toContainText(/Trial ends \d{1,2} \w{3} \d{4} \(in 14 days\)/);
  await shot(page, 'sc1-trial-line');
  t.save();
});

// ═════════════ scenario 2 — 11th analysis → 402 + dialog ═════════════

for (const phone of [false, true]) {
  test(`sc2 trial org with 10 analyses this month: Analyse → 402 plan_limit_reached, no row inserted, "Plan limit reached" dialog with Talk to sales / Close${phone ? ' @mobile' : ''}`, async ({ page }) => {
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    const t = new Transcript('sc2-analysis-limit');
    if (phone) await atPhone(page);
    const { orgId } = await newOrg(page, 'sc2');
    const tenderA = insertTender();
    const tenderB = insertTender();
    seedAnalyses(orgId, tenderA.id, 10);
    seedLlmSlots(orgId, 10);
    await asRole(page, 'analyst');
    await attachBid(page.request, tenderB.id);
    t.add(`analyses this month (non-failed): ${psql(`select count(*) from analyses where org_id='${orgId}'`)}`);

    const res = await page.request.post(`/api/tenders/${tenderB.id}/analyse`);
    await t.http('11th analysis', res, `POST /api/tenders/${tenderB.id}/analyse (analyst)`);
    const err = await errorOf(res);
    const istMonthEnd = (() => { const ist = new Date(Date.now() + 330 * 60_000); return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - 330 * 60_000).toISOString(); })();
    expect(err.status).toBe(402);
    expect(err.code).toBe('plan_limit_reached');
    expect(err.details).toEqual({ limit: 'analysesPerMonth', used: 10, max: 10, plan: 'trial', resetsAt: istMonthEnd });
    expect(err.message).toMatch(/^Your Free trial includes 10 analyses a month\. You've used 10\. Talk to us to upgrade, or wait until \d{1,2} \w{3}\.$/);
    t.add(`message: ${err.message}`);
    expect(psql(`select count(*) from analyses where org_id='${orgId}'`), 'no analyses row is inserted').toBe('10');

    await page.goto(`/tenders/${tenderB.id}`);
    await page.getByRole('button', { name: /analyse eligibility/i }).first().click();
    const dlg = planDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('heading', { name: 'Plan limit reached' })).toBeVisible();
    await expect(dlg).toContainText(err.message!);
    await expect(dlg.getByTestId('plan-limit-usage')).toHaveText('10 / 10 analyses this month');
    await expect(dlg.getByRole('link', { name: 'Talk to sales' })).toHaveAttribute('href', SALES);
    await expect(dlg.getByRole('button', { name: 'Close' }).first()).toBeVisible();
    await shot(page, 'sc2-plan-limit-dialog');
    if (phone) await noHorizontalOverflow(page);
    await dlg.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dlg).toBeHidden();
    expect(psql(`select count(*) from analyses where org_id='${orgId}'`), 'still no row after the UI attempt').toBe('10');
    t.add('UI: dialog shown with heading "Plan limit reached", usage "10 / 10 analyses this month", links Talk to sales + Close; closed.');
    t.save();
  });
}

// ═════════════ scenario 3 — Starter watchlists and seats ═════════════

test('sc3a Starter org with 5 watchlists: a bid manager saving a 6th gets 402 (limit watchlists, max 5) and the dialog', async ({ page }) => {
  const t = new Transcript('sc3a-starter-watchlists');
  const { orgId } = await newOrg(page, 'sc3a');
  setPlan(orgId, 'starter');
  await asRole(page, 'bid_manager');
  for (let i = 1; i <= 5; i++) {
    const r = await page.request.post('/api/watchlists', { data: { name: `QA list ${i}`, criteria: { keywords: [`kw${i}`] } } });
    expect(r.status(), await r.text()).toBe(201);
  }
  t.add(`watchlists: ${psql(`select count(*) from watchlists where org_id='${orgId}'`)}`);
  const res = await page.request.post('/api/watchlists', { data: { name: 'QA list 6', criteria: { keywords: ['kw6'] } } });
  await t.http('6th watchlist', res, 'POST /api/watchlists (bid manager, Starter)');
  const err = await errorOf(res);
  expect(err.status).toBe(402);
  expect(err.code).toBe('plan_limit_reached');
  expect(err.details).toMatchObject({ limit: 'watchlists', used: 5, max: 5, plan: 'starter' });
  expect(psql(`select count(*) from watchlists where org_id='${orgId}'`)).toBe('5');
  // UI
  await page.goto('/watchlists?new=1');
  await page.getByLabel('Name', { exact: false }).first().fill('QA list 6 via UI');
  const chip = page.getByPlaceholder(/laptop, CCTV/i);
  await chip.fill('router');
  await chip.press('Enter');
  await page.getByRole('button', { name: 'Create watchlist' }).click();
  const dlg = planDialog(page);
  await expect(dlg.getByRole('heading', { name: 'Plan limit reached' })).toBeVisible();
  await expect(dlg).toContainText('Your Starter plan includes 5 watchlists. You have 5.');
  await expect(dlg.getByTestId('plan-limit-usage')).toHaveText('5 / 5 watchlists');
  await shot(page, 'sc3a-watchlist-dialog');
  expect(psql(`select count(*) from watchlists where org_id='${orgId}'`)).toBe('5');
  t.save();
});

test('sc3b Starter org with 3 members + pending invites: the owner inviting a 4th person gets 402 (limit seats, max 3) and the dialog', async ({ page }) => {
  const t = new Transcript('sc3b-starter-seats');
  const { orgId } = await newOrg(page, 'sc3b');
  await inviteAs(page.request, 'analyst'); // member #2
  setPlan(orgId, 'starter');
  const third = await page.request.post('/api/org/invitations', { data: { email: `third.${Date.now()}@example.in`, role: 'viewer' } });
  expect(third.status(), await third.text()).toBe(201); // pending invite → 3 seats
  t.add(`members: ${psql(`select count(*) from memberships where org_id='${orgId}'`)}, pending invitations: ${psql(`select count(*) from invitations where org_id='${orgId}' and accepted_at is null`)}`);
  const res = await page.request.post('/api/org/invitations', { data: { email: `fourth.${Date.now()}@example.in`, role: 'viewer' } });
  await t.http('4th seat', res, 'POST /api/org/invitations (owner, Starter)');
  const err = await errorOf(res);
  expect(err.status).toBe(402);
  expect(err.code).toBe('plan_limit_reached');
  expect(err.details).toMatchObject({ limit: 'seats', used: 3, max: 3, plan: 'starter' });
  await page.goto('/settings/team');
  await page.getByRole('button', { name: /invite teammate/i }).click();
  await page.getByLabel(/email/i).fill(`fourth.ui.${Date.now()}@example.in`);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const dlg = planDialog(page);
  await expect(dlg.getByRole('heading', { name: 'Plan limit reached' })).toBeVisible();
  await expect(dlg).toContainText('Your Starter plan includes 3 seats (members and pending invitations). You\'re using 3.');
  await shot(page, 'sc3b-seat-dialog');
  expect(psql(`select count(*) from invitations where org_id='${orgId}' and accepted_at is null`)).toBe('1');
  t.save();
});

// ═════════════ scenario 4 — Pro vault and packets ═════════════

test('sc4a Pro org whose vault holds 9.99 GB: uploading a ~11 MB file gets 402 (limit vaultBytes)', async ({ page }) => {
  const t = new Transcript('sc4a-pro-vault');
  const { orgId } = await newOrg(page, 'sc4a');
  setPlan(orgId, 'pro');
  seedVaultBytes(orgId, 10 * GIB - 10 * MB);
  const usage = await (await page.request.get('/api/org/usage')).json();
  t.add(`usage.vaultBytes = ${usage.usage.vaultBytes} (${(usage.usage.vaultBytes / GIB).toFixed(3)} GiB) of ${usage.limits.vaultBytes}`);
  const file = await paddedPdf(11 * MB);
  const res = await page.request.post('/api/vault', { multipart: { file: { name: 'big.pdf', mimeType: 'application/pdf', buffer: file }, type: 'gst', title: 'GST big' } });
  await t.http('upload 11 MB at 9.99 GB', res, 'POST /api/vault (11 MB)');
  const err = await errorOf(res);
  expect(err.status).toBe(402);
  expect(err.code).toBe('plan_limit_reached');
  expect(err.details).toMatchObject({ limit: 'vaultBytes', plan: 'pro', max: 10 * GIB });
  expect(psql(`select count(*) from vault_documents where org_id='${orgId}' and title='GST big'`)).toBe('0');
  // A file that fits is still accepted (the limit is on bytes, not a block).
  const small = await page.request.post('/api/vault', { multipart: { file: { name: 'small.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) }, type: 'gst', title: 'GST small' } });
  t.add(`a file that fits (${readFileSync(fixturePath('go-it-services')).length} bytes) → ${small.status()}`);
  expect(small.status()).toBe(201);
  await page.goto('/settings/usage');
  await expect(page.getByTestId('meter-vaultBytes')).toHaveAttribute('data-tone', /warning|danger/);
  await shot(page, 'sc4a-vault-meter');
  t.save();
});

test('sc4b Pro org with 200 packets this month: building the 201st gets 402 (limit packetsPerMonth) and no packet is created', async ({ page }) => {
  test.setTimeout(150_000);
  const t = new Transcript('sc4b-pro-packets');
  const fx = await seedApplyFixture(page.request);
  setPlan(fx.orgId, 'pro');
  const ws = await createWorkspace(fx);
  seedPacketLedger(fx.orgId, 200);
  await signInAs(page.context(), fx, 'analyst');
  const res = await page.request.post(`/api/workspaces/${ws.id}/packets`, { data: {} });
  await t.http('201st packet', res, `POST /api/workspaces/${ws.id}/packets`);
  const err = await errorOf(res);
  expect(err.status).toBe(402);
  expect(err.code).toBe('plan_limit_reached');
  expect(err.details).toMatchObject({ limit: 'packetsPerMonth', used: 200, max: 200, plan: 'pro' });
  expect(err.message).toMatch(/^Your Pro plan includes 200 packets a month\. You've used 200\./);
  expect(psql(`select count(*) from packets where org_id='${fx.orgId}'`)).toBe('0');
  expect(psql(`select count(*) from packet_ledger where org_id='${fx.orgId}'`)).toBe('200');
  await page.goto(`/workspaces/${ws.id}?step=packet`);
  await page.getByRole('button', { name: /build packet/i }).click();
  const dlg = planDialog(page);
  await expect(dlg.getByRole('heading', { name: 'Plan limit reached' })).toBeVisible();
  await expect(dlg.getByTestId('plan-limit-usage')).toHaveText('200 / 200 packets this month');
  await shot(page, 'sc4b-packet-dialog');
  expect(psql(`select count(*) from packets where org_id='${fx.orgId}'`)).toBe('0');
  t.save();
});

// ═════════════ scenario 5 — Enterprise never limited ═════════════

test('sc5 Enterprise org at 10× the Pro numbers: analyse, invite, vault upload, packet build and watchlists never return 402; usage limits are null', async ({ page }) => {
  test.setTimeout(150_000);
  const t = new Transcript('sc5-enterprise');
  const fx = await seedApplyFixture(page.request);
  setPlan(fx.orgId, 'enterprise');
  const ws = await createWorkspace(fx);
  const tender = insertTender();
  await signInAs(page.context(), fx, 'owner');
  await attachBid(page.request, tender.id);
  seedAnalyses(fx.orgId, tender.id, 5000);       // Pro: 500/month
  seedLlmSlots(fx.orgId, 2500);                  // Pro: 250 AI/month
  seedPendingInvites(fx.orgId, 100);             // Pro: 10 seats
  seedVaultBytes(fx.orgId, 100 * GIB + 2_000_000_000); // Pro: 10 GiB
  seedPacketLedger(fx.orgId, 2000);              // Pro: 200/month
  const usage = await (await page.request.get('/api/org/usage')).json();
  t.add(`GET /api/org/usage → plan=${usage.plan}, usage=${JSON.stringify(usage.usage)}, limits=${JSON.stringify(usage.limits)}`);
  expect(usage.plan).toBe('enterprise');
  expect(usage.trialEndsAt).toBeNull();
  for (const k of ['seats', 'watchlists', 'analysesPerMonth', 'llmAnalysesPerMonth', 'vaultBytes', 'packetsPerMonth']) expect(usage.limits[k], `limits.${k}`).toBeNull();
  expect(usage.usage.analysesThisMonth).toBeGreaterThanOrEqual(5000);

  const statuses: Record<string, number> = {};
  statuses.analyse = (await page.request.post(`/api/tenders/${tender.id}/analyse`)).status();
  statuses.invite = (await page.request.post('/api/org/invitations', { data: { email: `ent.${Date.now()}@example.in`, role: 'viewer' } })).status();
  statuses.vault = (await page.request.post('/api/vault', { multipart: { file: { name: 'e.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) }, type: 'gst', title: 'Enterprise GST' } })).status();
  statuses.packet = (await page.request.post(`/api/workspaces/${ws.id}/packets`, { data: {} })).status();
  statuses.watchlist = (await page.request.post('/api/watchlists', { data: { name: 'Ent list', criteria: { keywords: ['ent'] } } })).status();
  t.add(`statuses: ${JSON.stringify(statuses)}`);
  for (const [k, s] of Object.entries(statuses)) expect(s, `${k} must not be 402`).not.toBe(402);
  expect(statuses.analyse).toBe(201);
  expect(statuses.invite).toBe(201);
  expect(statuses.vault).toBe(201);
  expect(statuses.watchlist).toBe(201);
  await page.goto('/settings/usage');
  await expect(page.getByTestId('plan-badge')).toContainText('Enterprise');
  await expect(page.getByTestId('meter-analysesPerMonth')).toContainText('/ Unlimited');
  await expect(page.getByTestId('meter-seats')).toContainText('/ Unlimited');
  await expect(page.getByTestId('meter-vaultBytes')).toContainText('/ Unlimited');
  await expect(page.getByTestId('meter-packetsPerMonth')).toContainText('/ Unlimited');
  await shot(page, 'sc5-enterprise-usage');
  t.save();
});

// ═════════════ scenario 6 — expired trial API ═════════════

test('sc6 expired trial: writes outside the allow-list → 402 plan_expired with the dated message; every GET (feed, analysis, vault + packet download) → 200; allow-listed writes pass', async ({ page }) => {
  test.setTimeout(150_000);
  const t = new Transcript('sc6-expired-api');
  const fx = await seedApplyFixture(page.request);
  const ws = await createWorkspace(fx);
  await signInAs(page.context(), fx, 'analyst');
  const built = await page.request.post(`/api/workspaces/${ws.id}/packets`, { data: {} });
  t.add(`packet built before expiry: ${built.status()}`);
  const packetId = built.status() === 201 ? (await built.json()).id as string : null;
  const tender = insertTender();
  await attachBid(page.request, tender.id);
  // The trial ended two days ago.
  psql(`update organizations set trial_ends_at = now() - interval '2 days' where id='${fx.orgId}'`);
  const endedAt = psql(`select to_char(trial_ends_at at time zone 'Asia/Kolkata', 'FMDD Mon YYYY') from organizations where id='${fx.orgId}'`);
  const expectedMsg = `Your free trial ended on ${endedAt}. Your data is safe and read-only — talk to us to choose a plan.`;
  t.add(`expected message: ${expectedMsg}`);

  const writes: [string, string, unknown?][] = [
    ['POST', '/api/watchlists', { name: 'x', criteria: { keywords: ['x'] } }],
    ['POST', '/api/org/invitations', { email: `exp.${Date.now()}@example.in`, role: 'viewer' }],
    ['POST', `/api/tenders/${tender.id}/analyse`],
    ['POST', `/api/workspaces/${ws.id}/packets`, {}],
    ['PUT', '/api/profile', { legalName: 'Changed Pvt Ltd' }],
  ];
  for (const [method, url, data] of writes) {
    const res = await page.request.fetch(url, { method, data: data as never });
    const e = await errorOf(res);
    t.add(`${method} ${url} → ${e.status} ${e.code ?? ''}`);
    expect(e.status, `${method} ${url}`).toBe(402);
    expect(e.code).toBe('plan_expired');
    expect(e.message).toBe(expectedMsg);
  }
  const vaultUp = await page.request.post('/api/vault', { multipart: { file: { name: 'v.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) }, type: 'gst', title: 'Expired upload' } });
  const ve = await errorOf(vaultUp);
  t.add(`POST /api/vault → ${ve.status} ${ve.code}`);
  expect(ve).toMatchObject({ status: 402, code: 'plan_expired' });
  expect(psql(`select count(*) from vault_documents where org_id='${fx.orgId}' and title='Expired upload'`)).toBe('0');

  const gets = ['/api/tenders', '/api/watchlists', '/api/vault', '/api/org', '/api/org/usage', `/api/tenders/${fx.tender.id}/analysis`, '/api/workspaces', `/api/vault/${fx.docs.gst}/download`, '/api/auth/me'];
  if (packetId) gets.push(`/api/packets/${packetId}/download`);
  for (const url of gets) {
    const res = await page.request.get(url);
    t.add(`GET ${url} → ${res.status()}`);
    expect(res.status(), `GET ${url}`).toBe(200);
  }
  // Allow-list: the profile of the person, notification read-all, logout are still writable.
  const allowed: [string, string, unknown?][] = [['PATCH', '/api/me', { name: 'Still Editable' }], ['POST', '/api/notifications/read-all', {}], ['PUT', '/api/me/notification-prefs', { quietHours: null }]];
  for (const [method, url, data] of allowed) {
    const res = await page.request.fetch(url, { method, data: data as never });
    t.add(`allow-list ${method} ${url} → ${res.status()}`);
    expect(res.status(), `${method} ${url} is on the allow-list, must not be 402`).not.toBe(402);
  }
  const out = await page.request.post('/api/auth/logout');
  t.add(`allow-list POST /api/auth/logout → ${out.status()}`);
  expect(out.status()).not.toBe(402);
  t.save();
});

// ═════════════ scenario 7 — expired banner + write buttons open the dialog ═════════════

for (const phone of [false, true]) {
  test(`sc7 expired trial: non-dismissible banner for every role; Analyse / Save watchlist / Upload / Build packet / Invite open the plan dialog without calling the API${phone ? ' @mobile' : ''}`, async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    const t = new Transcript('sc7-expired-ui');
    if (phone) await atPhone(page);
    const fx = await seedApplyFixture(page.request);
    const ws = await createWorkspace(fx);
    const tender = insertTender();
    await signInAs(page.context(), fx, 'analyst');
    await attachBid(page.request, tender.id);
    psql(`update organizations set trial_ends_at = now() - interval '2 days' where id='${fx.orgId}'`);

    const writes: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && u.pathname.startsWith('/api/') && !/\/seen$|^\/api\/auth\//.test(u.pathname)) writes.push(`${r.method()} ${u.pathname}`);
    });

    // Banner for every role (analyst here; viewer + owner below).
    await page.goto('/tenders');
    const banner = page.getByTestId('trial-expired-banner');
    await expect(banner).toHaveText(/Your free trial has ended\. TenderPilot is read-only until you choose a plan\.\s*Talk to sales/);
    await expect(banner.getByRole('link', { name: 'Talk to sales' })).toHaveAttribute('href', SALES);
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(banner).toHaveAttribute('role', 'alert');
    await shot(page, 'sc7-expired-banner');
    if (phone) await noHorizontalOverflow(page);
    await page.reload();
    await expect(banner).toBeVisible();
    t.add('banner visible after reload; no dismiss control');

    const expectDialog = async (label: string, shotName: string) => {
      const dlg = planDialog(page);
      await expect(dlg.getByRole('heading', { name: 'Your trial has ended' }), label).toBeVisible();
      await expect(dlg).toContainText('Your data is safe and read-only');
      await expect(dlg.getByRole('link', { name: 'Talk to sales' })).toBeVisible();
      if (shotName.endsWith('-unshot')) { /* no screenshot */ } else if (shotName === 'sc7-analyse-dialog' || (!phone && shotName === 'sc7-packet-dialog')) await shot(page, shotName); // evidence budget: one phone dialog is enough
      await dlg.getByRole('button', { name: 'Close', exact: true }).first().click();
      await expect(dlg).toBeHidden();
      t.add(`${label}: plan dialog opened; writes so far: ${JSON.stringify(writes)}`);
    };

    // 1 Analyse
    await page.goto(`/tenders/${tender.id}`);
    await page.getByRole('button', { name: /analyse eligibility/i }).first().click();
    await expectDialog('Analyse', 'sc7-analyse-dialog');
    // 2 Save watchlist
    await page.goto('/watchlists?new=1');
    await page.getByLabel('Name', { exact: false }).first().fill('Expired list');
    const chip = page.getByPlaceholder(/laptop, CCTV/i);
    await chip.fill('router');
    await chip.press('Enter');
    // Observation: the builder's live preview is a POST (not on the FR-038 allow-list), so the plan dialog may already open while typing.
    await page.waitForTimeout(1500);
    if (await planDialog(page).isVisible()) {
      t.add('observation: the plan dialog opened by itself when the watchlist builder requested its live preview (a POST outside the allow-list)');
      await expectDialog('Watchlist live preview', 'sc7-watchlist-preview-dialog-unshot');
    }
    await page.getByRole('button', { name: 'Create watchlist' }).click();
    await expectDialog('Save watchlist', 'sc7-watchlist-dialog');
    // 3 Upload
    await page.goto('/vault?upload=1');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'gst.pdf', mimeType: 'application/pdf', buffer: readFileSync(fixturePath('go-it-services')) });
    const titleField = page.getByLabel(/title/i).first();
    if (await titleField.isVisible().catch(() => false)) { if (!(await titleField.inputValue())) await titleField.fill('Expired GST'); }
    await page.getByRole('button', { name: 'Upload document' }).click();
    await expectDialog('Upload', 'sc7-upload-dialog');
    // 4 Build packet
    await page.goto(`/workspaces/${ws.id}?step=packet`);
    await page.getByRole('button', { name: /build packet/i }).click();
    await expectDialog('Build packet', 'sc7-packet-dialog');
    // 5 Invite (owner)
    await signInAs(page.context(), fx, 'owner');
    await page.goto('/settings/team');
    await page.getByRole('button', { name: /invite teammate/i }).click();
    await page.getByLabel(/email/i).fill(`expired.${Date.now()}@example.in`);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expectDialog('Invite', 'sc7-invite-dialog');

    expect(writes, 'no mutating API request was sent by any of the five write buttons').toEqual([]);
    t.add(`mutating /api requests observed: ${writes.length}`);

    // Banner for the other roles.
    for (const role of ['viewer', 'owner'] as const) {
      await signInAs(page.context(), fx, role);
      await page.goto('/tenders');
      await expect(page.getByTestId('trial-expired-banner'), role).toBeVisible();
    }
    t.save();
  });
}

// ═════════════ scenario 8 — countdown banners ═════════════

for (const phone of [false, true]) {
  test(`sc8 trial with 5 days left: dismissible-per-day banner "5 days left in your free trial" + See plans; on the last day "Your trial ends today"${phone ? ' @mobile' : ''}`, async ({ page }) => {
    test.skip(phone && PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
    test.skip(!phone && PROJECT() === 'mobile', 'desktop variant');
    const t = new Transcript('sc8-countdown-banners');
    if (phone) await atPhone(page);
    const { orgId } = await newOrg(page, 'sc8');
    setTrialEnds(orgId, '5 days');
    await page.goto('/tenders');
    const banner = page.getByTestId('trial-banner');
    await expect(banner).toContainText('5 days left in your free trial');
    await expect(banner.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/usage');
    await shot(page, 'sc8-five-days-banner');
    if (phone) await noHorizontalOverflow(page);
    // dismiss → stays hidden for the day
    await banner.getByRole('button', { name: 'Dismiss until tomorrow' }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByTestId('trial-banner')).toBeHidden();
    const key = `tp-trial-banner-dismissed:${orgId}`;
    const stored = await page.evaluate((k) => localStorage.getItem(k), key);
    t.add(`localStorage ${key} = ${stored}`);
    expect(stored).toMatch(/^"\d{4}-\d{2}-\d{2}"$/);
    // "per day": a dismissal from yesterday no longer hides it
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify('2020-01-01')), key);
    await page.reload();
    await expect(page.getByTestId('trial-banner')).toContainText('5 days left in your free trial');
    t.add('dismissal stored for 2020-01-01 → banner shown again (dismissal is per IST day)');
    // last day
    setTrialEnds(orgId, '6 hours');
    await page.evaluate((k) => localStorage.removeItem(k), key);
    await page.reload();
    await expect(page.getByTestId('trial-banner')).toContainText('Your trial ends today');
    await expect(page.getByTestId('trial-banner').getByRole('button', { name: 'Dismiss until tomorrow' })).toBeVisible();
    if (!phone) await shot(page, 'sc8-last-day-banner'); // evidence budget
    if (!phone) {
      // Roles below bid manager do not see the countdown.
      await asRole(page, 'viewer');
      await page.goto('/tenders');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByTestId('trial-banner')).toHaveCount(0);
      t.add('viewer: no countdown banner');
    }
    t.save();
  });
}

// ═════════════ scenario 9 — Settings → Plan & usage ═════════════

async function seedUsagePage(page: Page, prefix: string) {
  const { orgId } = await newOrg(page, prefix);
  const tender = insertTender();
  seedAnalyses(orgId, tender.id, 7);
  const ids = psql(`select id from analyses where org_id='${orgId}'`).split('\n');
  psql(`insert into llm_usage (org_id, analysis_id, analysis_ref, kind, model, input_tokens, output_tokens) select '${orgId}', id, id, 'extract', 'qa-seed', 100, 20 from analyses where org_id='${orgId}'`);
  expect(ids).toHaveLength(7);
  for (let i = 1; i <= 2; i++) expect((await page.request.post('/api/watchlists', { data: { name: `Usage list ${i}`, criteria: { keywords: [`u${i}`] } } })).status()).toBe(201);
  psql(`insert into vault_documents (org_id, type, title, blob_key, file_name, mime_type, size_bytes) values ('${orgId}', 'gst', 'QA 120 MB', 'qa/120', '120.pdf', 'application/pdf', ${120 * MB})`);
  return { orgId, tender };
}

async function checkMeters(page: Page) {
  const bars = page.getByRole('progressbar');
  await expect(bars).toHaveCount(6);
  const expectMeter = async (key: string, label: string, text: string, now: number, max: number) => {
    const card = page.getByTestId(`meter-${key}`);
    await expect(card).toContainText(label);
    await expect(card).toContainText(text);
    const bar = card.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', String(now));
    await expect(bar).toHaveAttribute('aria-valuemax', String(max));
  };
  await expectMeter('analysesPerMonth', 'Analyses this month', '7 / 10', 7, 10);
  await expectMeter('llmAnalysesPerMonth', 'AI analyses this month', '7 / 10', 7, 10);
  await expectMeter('watchlists', 'Watchlists', '2 / 50', 2, 50);
  await expectMeter('seats', 'Seats', '1 / 10', 1, 10);
  await expectMeter('vaultBytes', 'Vault storage', '120 MB / 1 GB', 120 * MB, GIB);
  await expectMeter('packetsPerMonth', 'Packets this month', '0 / 10', 0, 10);
}

test('sc9a Plan & usage (desktop, light): plan badge, "Trial ends … (in 14 days)", six role=progressbar meters with aria values, amber ≥ 80 %, red at 100 %, axe', async ({ page }) => {
  test.skip(PROJECT() === 'mobile', 'desktop variant');
  const t = new Transcript('sc9a-usage-page');
  const { orgId, tender } = await seedUsagePage(page, 'sc9a');
  await page.goto('/settings/usage');
  await expect(page.getByRole('heading', { name: 'Plan & usage' })).toBeVisible();
  await expect(page.getByTestId('plan-badge')).toContainText('Free trial');
  const trialEndsAt = (await (await page.request.get('/api/org')).json()).trialEndsAt as string;
  const endsLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(trialEndsAt));
  await expect(page.getByTestId('trial-line')).toHaveText(`Trial ends ${endsLabel} (in 14 days)`);
  await checkMeters(page);
  await expect(page.getByTestId('usage-reset')).toContainText('Usage resets on');
  for (const k of ['analysesPerMonth', 'llmAnalysesPerMonth', 'watchlists', 'seats', 'vaultBytes', 'packetsPerMonth']) await expect(page.getByTestId(`meter-${k}`)).toHaveAttribute('data-tone', 'ok');
  await shot(page, 'sc9a-usage-7-of-10');
  await a11y(page, 'sc9a-usage-light');
  t.add('7/10 state: all six meters tone=ok; progressbars=6; aria-valuenow/max verified');

  // amber at 80 %
  const barColour = (key: string) => page.getByTestId(`meter-${key}`).getByRole('progressbar').locator('> div').evaluate((el) => getComputedStyle(el).backgroundColor);
  const okColour = await barColour('analysesPerMonth');
  seedAnalyses(orgId, tender.id, 1); // 8 / 10
  await page.reload();
  await expect(page.getByTestId('meter-analysesPerMonth')).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByTestId('meter-analysesPerMonth')).toContainText('8 / 10');
  const amber = await barColour('analysesPerMonth');
  await shot(page, 'sc9a-usage-amber-80');
  // red at 100 %
  seedAnalyses(orgId, tender.id, 2); // 10 / 10
  await page.reload();
  await expect(page.getByTestId('meter-analysesPerMonth')).toHaveAttribute('data-tone', 'danger');
  await expect(page.getByTestId('meter-analysesPerMonth')).toContainText('10 / 10');
  const red = await barColour('analysesPerMonth');
  await shot(page, 'sc9a-usage-red-100');
  t.add(`bar colours: ok=${okColour}, amber(80%)=${amber}, red(100%)=${red}`);
  const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const [ar, ag, ab] = rgb(amber);
  const [rr, rg, rb] = rgb(red);
  expect(new Set([okColour, amber, red]).size, 'three distinct bar colours').toBe(3);
  expect(ar > 120 && ag > 50 && ab < 80 && ar > ag && ag > ab, `amber-ish: ${amber}`).toBeTruthy();
  expect(rr > 150 && rg < 110 && rb < 110, `red-ish: ${red}`).toBeTruthy();
  await a11y(page, 'sc9a-usage-red-light');
  t.save();
});

test('sc9b Plan & usage on a 375 px phone: one meter per row, no horizontal scroll, axe @mobile', async ({ page }) => {
  test.skip(PROJECT() !== 'mobile', 'phone variant runs in the mobile project');
  const t = new Transcript('sc9b-usage-375');
  await atPhone(page);
  await seedUsagePage(page, 'sc9b');
  await page.goto('/settings/usage');
  await expect(page.getByRole('heading', { name: 'Plan & usage' })).toBeVisible();
  await checkMeters(page);
  const xs = await page.locator('[data-testid^="meter-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  t.add(`meter card left edges: ${xs.join(', ')}`);
  expect(new Set(xs).size, 'one column').toBe(1);
  const m = await noHorizontalOverflow(page);
  t.add(`scrollWidth ${m.scrollWidth} <= innerWidth ${m.innerWidth}`);
  await shot(page, 'sc9b-usage-375');
  await a11y(page, 'sc9b-usage-375');
  t.save();
});

test('sc9c Plan & usage in the dark theme: meters, tones and contrast (axe)', async ({ page }) => {
  test.skip(PROJECT() === 'mobile', 'desktop variant');
  const t = new Transcript('sc9c-usage-dark');
  await page.addInitScript(() => { try { localStorage.setItem('tp-theme', 'dark'); } catch { /* ignore */ } });
  const { orgId, tender } = await seedUsagePage(page, 'sc9c');
  await page.goto('/settings/usage');
  await expect(page.getByRole('heading', { name: 'Plan & usage' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await checkMeters(page);
  await shot(page, 'sc9c-usage-dark');
  await a11y(page, 'sc9c-usage-dark');
  seedAnalyses(orgId, tender.id, 1);
  seedAnalyses(orgId, tender.id, 2);
  await page.reload();
  await expect(page.getByTestId('meter-analysesPerMonth')).toHaveAttribute('data-tone', 'danger');
  await shot(page, 'sc9c-usage-dark-red');
  await a11y(page, 'sc9c-usage-dark-red');
  t.add('dark theme: class "dark" on <html>; axe serious/critical = 0 in both states');
  t.save();
});

// ═════════════ scenario 10 — llm_usage rows == fake LLM usage ═════════════

test('sc10 an analysis that used the LLM writes one llm_usage row per call with the fake LLM\'s exact tokens; /api/org/usage returns the totals', async ({ page }) => {
  const t = new Transcript('sc10-llm-usage');
  const { orgId } = await newOrg(page, 'sc10');
  const tender = insertTender();
  await attachBid(page.request, tender.id);
  const before = llmCalls.length;
  const res = await page.request.post(`/api/tenders/${tender.id}/analyse`);
  await t.http('analyse', res, `POST /api/tenders/${tender.id}/analyse`);
  expect(res.status()).toBe(201);
  const analysis = await res.json();
  const mine = llmCalls.slice(before);
  t.add(`fake LLM calls during the analysis: ${mine.length} → ${JSON.stringify(mine.map((c) => [c.input, c.output]))}`);
  expect(mine.length, 'the analysis called the (fake) LLM at least once').toBeGreaterThan(0);
  expect(analysis.method).toBe('rules+llm');
  const rows = psql(`select analysis_id, kind, model, input_tokens, output_tokens, reserved from llm_usage where org_id='${orgId}' order by created_at, id`).split('\n').map((l) => l.split('|'));
  t.add(`llm_usage rows:\n${rows.map((r) => r.join(' | ')).join('\n')}`);
  expect(rows, 'exactly one llm_usage row per LLM call').toHaveLength(mine.length);
  for (const r of rows) { expect(r[0]).toBe(analysis.id); expect(r[1]).toBe('extract'); expect(r[2]).toBeTruthy(); expect(r[5]).toBe('f'); }
  const sorted = (a: number[][]) => a.map((x) => x.join(',')).sort();
  expect(sorted(rows.map((r) => [Number(r[3]), Number(r[4])]))).toEqual(sorted(mine.map((c) => [c.input, c.output])));
  const sumIn = mine.reduce((n, c) => n + c.input, 0);
  const sumOut = mine.reduce((n, c) => n + c.output, 0);
  const usageRes = await page.request.get('/api/org/usage');
  await t.http('GET /api/org/usage', usageRes, 'GET /api/org/usage');
  const usage = await usageRes.json();
  expect(usage.usage.llmTokensThisMonth).toEqual({ input: sumIn, output: sumOut });
  expect(usage.usage.llmAnalysesThisMonth).toBe(1);
  expect(usage.usage.analysesThisMonth).toBe(1);
  expect(usage.limits.llmAnalysesPerMonth).toBe(10);
  t.add(`fake LLM total in=${sumIn} out=${sumOut}; /api/org/usage llmTokensThisMonth=${JSON.stringify(usage.usage.llmTokensThisMonth)}`);
  await page.goto('/settings/usage');
  await expect(page.getByTestId('meter-llmAnalysesPerMonth')).toContainText('1 / 10');
  await shot(page, 'sc10-usage-after-llm-analysis');
  t.save();
});

// ═════════════ scenario 11 — AI quota exhausted → rules-only ═════════════

test('sc11 AI analyses used up but analyses left: the analysis completes rules-only, makes no LLM call and shows "Monthly AI review limit reached — this analysis used rules only."', async ({ page }) => {
  const t = new Transcript('sc11-llm-quota');
  const { orgId } = await newOrg(page, 'sc11');
  seedLlmSlots(orgId, 10); // all 10 AI analyses used, 0 analyses recorded
  const tender = insertTender();
  await attachBid(page.request, tender.id);
  const before = llmCalls.length;
  await page.goto(`/tenders/${tender.id}`);
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tenders/${tender.id}/analyse`));
  await page.getByRole('button', { name: /analyse eligibility/i }).first().click();
  const res = await done;
  await t.http('analyse (AI quota exhausted)', res, 'POST analyse');
  expect(res.status()).toBe(201);
  const a = await res.json();
  expect(a.method).toBe('rules');
  expect(a.warnings).toEqual([{ code: 'llm_quota_reached' }]);
  expect(llmCalls.length - before, 'no LLM call was made').toBe(0);
  expect(psql(`select count(*) from llm_usage where org_id='${orgId}' and analysis_id is not null`), 'no llm_usage row for the rules-only analysis').toBe('0');
  expect(psql(`select count(*) from llm_usage where org_id='${orgId}'`)).toBe('10');
  await expect(page.getByText('Monthly AI review limit reached — this analysis used rules only.')).toBeVisible();
  await shot(page, 'sc11-rules-only-message');
  t.add('analysis.method=rules, warnings=[llm_quota_reached], fake LLM calls=0, UI shows the message');
  t.save();
});

// ═════════════ scenario 12 — operator plan flip ═════════════

test('sc12 POST /api/admin/orgs/:id/plan: 404 without / with a wrong token; with the token plan → starter, trial_ends_at cleared, subscriptions row, org.plan_changed activity, writes work again', async ({ page }) => {
  expect(ADMIN_TOKEN.length, 'the runner must export ADMIN_TOKEN (>= 32 chars) to the API and to this spec').toBeGreaterThanOrEqual(32);
  const t = new Transcript('sc12-admin-plan-flip');
  const { orgId } = await newOrg(page, 'sc12');
  psql(`update organizations set trial_ends_at = now() - interval '2 days' where id='${orgId}'`);
  const blocked = await page.request.post('/api/watchlists', { data: { name: 'x', criteria: { keywords: ['x'] } } });
  expect(blocked.status()).toBe(402);
  await page.goto('/tenders');
  await expect(page.getByTestId('trial-expired-banner')).toBeVisible();
  await shot(page, 'sc12-before-flip-expired');

  const url = `/api/admin/orgs/${orgId}/plan`;
  const body = { plan: 'starter', note: 'Invoice INV-0012' };
  const noToken = await page.request.post(url, { data: body });
  await t.http('no token', noToken, `POST ${url}`);
  expect(noToken.status()).toBe(404);
  const wrong = await page.request.post(url, { data: body, headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' } });
  await t.http('wrong token', wrong, `POST ${url} (wrong bearer)`);
  expect(wrong.status()).toBe(404);
  const unknownOrg = await page.request.post('/api/admin/orgs/00000000-0000-4000-8000-000000000000/plan', { data: body, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  expect(unknownOrg.status()).toBe(404);
  expect(psql(`select plan from organizations where id='${orgId}'`), 'rejected calls change nothing').toBe('trial');

  const ok = await page.request.post(url, { data: body, headers: { authorization: `Bearer ${ADMIN_TOKEN.slice(0, 6)}...` } });
  expect(ok.status(), 'a truncated token is not accepted').toBe(404);
  const flip = await page.request.post(url, { data: body, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  t.add('### with the operator token\n> POST ' + url + ' {"plan":"starter","note":"Invoice INV-0012"} (Authorization: Bearer <ADMIN_TOKEN>)');
  t.add(`< ${flip.status()}\n${(await flip.text()).slice(0, 400)}`);
  expect(flip.status()).toBe(200);
  expect(psql(`select plan || '|' || coalesce(trial_ends_at::text, 'NULL') from organizations where id='${orgId}'`)).toBe('starter|NULL');
  const sub = psql(`select plan || '|' || status || '|' || note from subscriptions where org_id='${orgId}'`);
  t.add(`subscriptions: ${sub}`);
  expect(sub).toBe('starter|active|Invoice INV-0012');
  const act = psql(`select meta::text from activity_log where org_id='${orgId}' and action='org.plan_changed'`);
  t.add(`activity_log org.plan_changed meta: ${act}`);
  const meta = JSON.parse(act);
  expect(meta).toMatchObject({ from: 'trial', to: 'starter', note: 'Invoice INV-0012' });
  const feed = await (await page.request.get('/api/activity?pageSize=50')).json();
  expect(feed.items.some((i: { action: string }) => i.action === 'org.plan_changed'), 'visible in the org activity').toBeTruthy();

  const works = await page.request.post('/api/watchlists', { data: { name: 'After flip', criteria: { keywords: ['after'] } } });
  t.add(`POST /api/watchlists after the flip → ${works.status()}`);
  expect(works.status()).toBe(201);
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.org).toMatchObject({ plan: 'starter', trialEndsAt: null });
  await page.goto('/tenders');
  await expect(page.getByTestId('trial-expired-banner')).toHaveCount(0);
  await page.goto('/settings/usage');
  await expect(page.getByTestId('plan-badge')).toContainText('Starter');
  await shot(page, 'sc12-after-flip-starter');
  await page.goto('/settings/activity');
  await expect(page.getByText(/changed the plan to Starter/i).first()).toBeVisible();
  await shot(page, 'sc12-activity-plan-changed');
  t.save();
});
