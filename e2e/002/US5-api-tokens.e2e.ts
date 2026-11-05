import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { test, expect, uniqueUser, evidence, collectRunArtifacts } from '../support/fixtures';

/**
 * 002 / US5 (#7): API tokens for the Chrome extension. One test per acceptance scenario 1-9; scenario numbers are in
 * the titles and evidence screenshots are named sc<N>-*.png. Bearer checks use a cookie-less request context.
 */
const SPEC = '002';
const STORY = 'US5';
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, name);

function sql(q: string): string {
  return execFileSync('psql', [E2E_DB, '-qtAX', '-c', q], { encoding: 'utf8' }).trim();
}
function skipOnboarding(email: string) {
  sql(`update organizations set onboarding_state='{"basics":true}' where id in (select m.org_id from memberships m join users u on u.id=m.user_id where u.email='${email}')`);
}

async function signedUp(page: Page, prefix = 'tok') {
  const user = uniqueUser(prefix);
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  skipOnboarding(user.email);
  return user;
}

/** A request context with ONLY an Authorization header: no cookie jar shared with the page. */
async function bearer(baseURL: string, token: string) {
  return pwRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}
const baseOf = () => test.info().project.use.baseURL as string;

async function mint(page: Page, name = 'Chrome extension', extra: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/me/api-tokens', { data: { name, ...extra } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; name: string; token: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; hint: string | null };
}
async function errOf(res: { status(): number; json(): Promise<any> }) {
  const j = await res.json().catch(() => ({}));
  return { status: res.status(), message: j?.error?.message as string | undefined };
}
async function noOverflow(page: Page) {
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(m.s, `horizontal overflow ${m.s} > ${m.w}`).toBeLessThanOrEqual(m.w);
}

test('sc1 empty state + extension setup guide + compliance note @mobile', async ({ page }) => {
  await signedUp(page);
  await page.goto('/settings/api-tokens');
  await expect(page.getByText('No tokens yet')).toBeVisible();
  await expect(page.getByText('Create one to connect the browser extension.')).toBeVisible();
  const steps = page.locator('ol > li');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText('Build it with');
  await expect(steps.nth(1)).toContainText('Load unpacked');
  await expect(steps.nth(2)).toContainText('Save & connect');
  await expect(steps.nth(3)).toContainText('Fill allowed fields');
  await expect(page.getByText('You stay in control.')).toBeVisible();
  await expect(page.getByText(/never enters prices, never touches CAPTCHA, OTP, Aadhaar, DSC or e-Sign/)).toBeVisible();
  await noOverflow(page);
  await ev(page, `sc1-empty-state-guide-${test.info().project.name}`);
});

test('sc2 create (default name) → 201 shape, secret dialog, copy, close, list row, secret never shown again @mobile', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await signedUp(page);
  await page.goto('/settings/api-tokens');
  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Token name')).toHaveValue('Chrome extension');
  await ev(page, `sc2-create-dialog-${test.info().project.name}`);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST'),
    dlg.getByRole('button', { name: 'Create token' }).click(),
  ]);
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  // `scope` was added by 006/US6 (read/write tokens for the extension).
  expect(Object.keys(body).sort()).toEqual(['createdAt', 'expiresAt', 'hint', 'id', 'lastUsedAt', 'name', 'scope', 'token'].sort());
  expect(body.name).toBe('Chrome extension');
  expect(body.lastUsedAt).toBeNull();
  expect(body.token).toMatch(/^tp_/);
  await expect(dlg.getByText('Copy your new token')).toBeVisible();
  await expect(dlg.getByText('This is the only time it’s shown.')).toBeVisible();
  await expect(dlg.getByLabel('API token')).toHaveValue(body.token);
  await dlg.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText('Token copied')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clip !== null) expect(clip).toBe(body.token);
  await expect(dlg.getByRole('button', { name: 'Copied' })).toBeVisible();
  await ev(page, `sc2-secret-shown-once-${test.info().project.name}`);
  await dlg.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(dlg).toBeHidden();
  const row = page.getByTestId('api-token-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Chrome extension');
  await expect(row).toContainText(/Created .+ · never used/);
  await expect(page.locator('body')).not.toContainText(body.token);
  await noOverflow(page);
  await ev(page, `sc2-list-after-close-${test.info().project.name}`);
  await page.reload();
  await expect(page.getByTestId('api-token-row')).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText(body.token);
  expect(await page.content()).not.toContain(body.token);
  const list = await page.request.get('/api/me/api-tokens');
  const lj = await list.json();
  expect(JSON.stringify(lj)).not.toContain(body.token);
  expect(lj.items.every((t: any) => !('token' in t))).toBe(true);
  // reopening the create dialog does not resurface the secret either
  await page.getByRole('button', { name: 'Create token' }).first().click();
  await expect(page.getByRole('dialog')).not.toContainText(body.token);
  await expect(page.getByRole('dialog').getByLabel('API token')).toHaveCount(0);
  await ev(page, `sc2-reopened-dialog-no-secret-${test.info().project.name}`);
});

test('sc3 bearer authenticates as token user/org with current role; lastUsedAt at most once per minute', async ({ page }) => {
  const user = await signedUp(page);
  const t = await mint(page);
  const api = await bearer(baseOf(), t.token);
  try {
    const me = await api.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const mj = await me.json();
    expect(mj.user.email).toBe(user.email);
    expect(mj.role).toBe('owner');
    const org = (await (await page.request.get('/api/auth/me')).json()).org.id;
    expect(mj.org.id).toBe(org);
    const ws = await api.get('/api/workspaces');
    expect(ws.status()).toBe(200);
    // lastUsedAt set on first use, unchanged by a second call within the minute
    const first = sql(`select to_char(last_used_at at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') from api_tokens where id='${t.id}'`);
    expect(first).not.toBe('');
    await api.get('/api/workspaces');
    await api.get('/api/workspaces');
    const second = sql(`select to_char(last_used_at at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') from api_tokens where id='${t.id}'`);
    expect(second).toBe(first);
    // after >1 minute it is refreshed
    sql(`update api_tokens set last_used_at = now() - interval '2 minutes' where id='${t.id}'`);
    const stale = sql(`select to_char(last_used_at at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') from api_tokens where id='${t.id}'`);
    await api.get('/api/workspaces');
    const third = sql(`select to_char(last_used_at at time zone 'utc','YYYY-MM-DD HH24:MI:SS.US') from api_tokens where id='${t.id}'`);
    expect(third).not.toBe(stale);
    test.info().annotations.push({ type: 'lastUsedAt', description: `first=${first} second=${second} stale=${stale} third=${third}` });
    await page.goto('/settings/api-tokens');
    await expect(page.getByTestId('api-token-row')).toContainText(/last used/);
    await ev(page, 'sc3-list-last-used');
    // current role applies: demote nothing here (covered by sc3b); org scope = same org id asserted above
  } finally { await api.dispose(); }
});

test('sc3b token request uses the user\'s CURRENT role (viewer → 403 on write, promoted → allowed)', async ({ page, browser }) => {
  await signedUp(page, 'own');
  // invite a member, accept in a separate context, mint the member's token
  const m = uniqueUser('mem');
  const inv = await page.request.post('/api/org/invitations', { data: { email: m.email, role: 'viewer' } });
  expect(inv.status()).toBe(201);
  const itoken = String((await inv.json()).inviteUrl).split('/invite/')[1];
  const ctx = await browser.newContext({ baseURL: baseOf() });
  try {
    const acc = await ctx.request.post('/api/auth/accept-invite', { data: { token: itoken, name: m.name, password: m.password } });
    expect(acc.status(), await acc.text()).toBe(200);
    const uid = (await (await ctx.request.get('/api/auth/me')).json()).user.id;
    const res = await ctx.request.post('/api/me/api-tokens', { data: { name: 'Member ext' } });
    expect(res.status()).toBe(201);
    const tok = (await res.json()).token;
    const api = await bearer(baseOf(), tok);
    try {
      const w1 = await errOf(await api.post('/api/watchlists', { data: { name: 'x', keywords: ['a'] } }));
      expect(w1.status).toBe(403);
      expect((await api.get('/api/auth/me').then((r) => r.json())).role).toBe('viewer');
      const up = await page.request.patch(`/api/org/members/${uid}`, { data: { role: 'analyst' } });
      expect(up.status(), await up.text()).toBe(200);
      expect((await api.get('/api/auth/me').then((r) => r.json())).role).toBe('analyst');
      const w2 = await api.post('/api/watchlists', { data: { name: 'x', keywords: ['a'] } });
      expect(w2.status(), await w2.text()).not.toBe(403);
    } finally { await api.dispose(); }
  } finally { await ctx.close(); }
  await ev(page, 'sc3b-owner-page');
});

test('sc4 token-authenticated account endpoints → 403 "This action requires signing in on the web app"', async ({ page }) => {
  const user = await signedUp(page);
  const t = await mint(page);
  const api = await bearer(baseOf(), t.token);
  const lines: string[] = [];
  try {
    const cases: [string, string, unknown][] = [
      ['/api/me/api-tokens', 'POST', { name: 'nope' }],
      ['/api/me/password', 'POST', { currentPassword: user.password, newPassword: 'Another!pass9876' }],
      ['/api/auth/switch-org', 'POST', { orgId: '00000000-0000-0000-0000-000000000000' }],
    ];
    for (const [url, method, data] of cases) {
      const r = await errOf(await api.fetch(url, { method, data }));
      lines.push(`${method} ${url} -> ${r.status} "${r.message}"`);
      expect(r.status, url).toBe(403);
      expect(r.message).toBe('This action requires signing in on the web app');
    }
    // the password was not changed (cookie login still works)
    const login = await pwRequest.newContext({ baseURL: baseOf() });
    expect((await login.post('/api/auth/login', { data: { email: user.email, password: user.password } })).status()).toBe(200);
    await login.dispose();
    test.info().annotations.push({ type: 'sc4', description: lines.join(' | ') });
  } finally { await api.dispose(); }
  await page.goto('/settings/api-tokens');
  await ev(page, 'sc4-token-list-after-403s');
});

test('sc5 revoke via UI: confirm dialog, {ok:true}, toast, token immediately 401 @mobile', async ({ page }) => {
  await signedUp(page);
  const t = await mint(page);
  const api = await bearer(baseOf(), t.token);
  try {
    expect((await api.get('/api/workspaces')).status()).toBe(200);
    await page.goto('/settings/api-tokens');
    await expect(page.getByTestId('api-token-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Revoke' }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dlg.getByText('Revoke “Chrome extension”?')).toBeVisible();
    await ev(page, `sc5-revoke-dialog-${test.info().project.name}`);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/me/api-tokens/') && r.request().method() === 'DELETE'),
      dlg.getByRole('button', { name: 'Revoke token' }).click(),
    ]);
    expect(resp.status()).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    await expect(page.getByText('Token revoked')).toBeVisible();
    await expect(page.getByTestId('api-token-row')).toHaveCount(0);
    await ev(page, `sc5-after-revoke-${test.info().project.name}`);
    const after = await errOf(await api.get('/api/workspaces'));
    expect(after.status).toBe(401);
    expect((await api.get('/api/auth/me')).status()).toBe(401);
  } finally { await api.dispose(); }
});

test('sc6 user A revoking user B\'s token id → 404 "API token not found"', async ({ page, browser }) => {
  await signedUp(page, 'a');
  const ctx = await browser.newContext({ baseURL: baseOf() });
  try {
    const b = uniqueUser('b');
    expect((await ctx.request.post('/api/auth/signup', { data: b })).status()).toBe(201);
    const bt = (await (await ctx.request.post('/api/me/api-tokens', { data: { name: 'B token' } })).json()) as { id: string; token: string };
    const r = await errOf(await page.request.delete(`/api/me/api-tokens/${bt.id}`));
    expect(r.status).toBe(404);
    expect(r.message).toBe('API token not found');
    // B's token still works
    const api = await bearer(baseOf(), bt.token);
    expect((await api.get('/api/workspaces')).status()).toBe(200);
    await api.dispose();
    expect((await ctx.request.get('/api/me/api-tokens').then((x) => x.json())).items).toHaveLength(1);
  } finally { await ctx.close(); }
  await page.goto('/settings/api-tokens');
  await ev(page, 'sc6-a-has-no-tokens');
});

test('sc7 member removed from the org → their token returns 401', async ({ page, browser }) => {
  await signedUp(page, 'own');
  const m = uniqueUser('mem');
  const inv = await page.request.post('/api/org/invitations', { data: { email: m.email, role: 'analyst' } });
  const itoken = String((await inv.json()).inviteUrl).split('/invite/')[1];
  const ctx = await browser.newContext({ baseURL: baseOf() });
  try {
    expect((await ctx.request.post('/api/auth/accept-invite', { data: { token: itoken, name: m.name, password: m.password } })).status()).toBe(200);
    const uid = (await (await ctx.request.get('/api/auth/me')).json()).user.id;
    const tok = (await (await ctx.request.post('/api/me/api-tokens', { data: { name: 'Member ext' } })).json()).token;
    const api = await bearer(baseOf(), tok);
    try {
      expect((await api.get('/api/workspaces')).status()).toBe(200);
      await page.goto('/settings/team');
      await ev(page, 'sc7-team-before-removal');
      const rm = await page.request.delete(`/api/org/members/${uid}`);
      expect(rm.status(), await rm.text()).toBe(200);
      expect((await api.get('/api/workspaces')).status()).toBe(401);
      expect(sql(`select count(*) from api_tokens where user_id='${uid}'`)).toBe('0');
      await page.reload();
      await ev(page, 'sc7-team-after-removal');
    } finally { await api.dispose(); }
  } finally { await ctx.close(); }
});

test('sc8 expiry choices stored; list shows Expires in N days (amber < 7d), red Expired; expired token → 401', async ({ page }) => {
  await signedUp(page);
  const api = (t: string) => bearer(baseOf(), t);
  // API: default 90, explicit 30/365/null
  const def = await mint(page, 'default');
  const days = (iso: string | null, from: string) => iso ? Math.round((Date.parse(iso) - Date.parse(from)) / 86400000) : null;
  expect(days(def.expiresAt, def.createdAt)).toBe(90);
  expect(days((await mint(page, 'thirty', { expiresInDays: 30 })).expiresAt, def.createdAt)).toBe(30);
  expect(days((await mint(page, 'year', { expiresInDays: 365 })).expiresAt, def.createdAt)).toBeGreaterThanOrEqual(364);
  expect((await mint(page, 'forever-token', { expiresInDays: null })).expiresAt).toBeNull();
  // UI: dialog offers all four options; choose "1 year" and "Never" through the UI
  await page.goto('/settings/api-tokens');
  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('combobox', { name: 'Expires' }).click(); // 006/US6 added an `Access` (scope) select
  const opts = await page.getByRole('option').allInnerTexts();
  expect(opts.map((o) => o.trim())).toEqual(['30 days', '90 days', '1 year', 'Never']);
  await expect(page.getByRole('option', { name: '90 days' })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'qa/evidence/002/US5/sc8-expiry-options-open.png' }); // viewport only: a full-page capture resizes and dismisses the popup
  await page.getByRole('option', { name: '30 days' }).click();
  await dlg.getByLabel('Token name').fill('UI thirty');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST'),
    dlg.getByRole('button', { name: 'Create token' }).click(),
  ]);
  const ui = await resp.json();
  expect(days(ui.expiresAt, ui.createdAt)).toBe(30);
  await expect(dlg).toContainText('Expires');
  await dlg.getByRole('button', { name: 'I’ve saved it' }).click();
  // force states via the DB
  const mk = async (name: string) => (await mint(page, name, { expiresInDays: 365 }));
  const soon = await mk('expires-soon'); const week = await mk('expires-in-8-days'); const dead = await mk('already-expired');
  sql(`update api_tokens set expires_at = now() + interval '3 days' where id='${soon.id}'`);
  sql(`update api_tokens set expires_at = now() + interval '8 days' where id='${week.id}'`);
  sql(`update api_tokens set expires_at = now() - interval '1 minute' where id='${dead.id}'`);
  await page.reload();
  const rowOf = (n: string) => page.getByTestId('api-token-row').filter({ hasText: n });
  const badge = (n: string) => rowOf(n).getByText(/Expires in|Expired|Never expires/);
  await expect(badge('expires-soon')).toHaveText('Expires in 3 days');
  await expect(badge('expires-in-8-days')).toHaveText('Expires in 8 days');
  await expect(badge('already-expired')).toHaveText('Expired');
  await expect(badge('forever-token')).toHaveText('Never expires');
  const cls = async (n: string) => (await badge(n).getAttribute('class')) ?? '';
  const soonCls = await cls('expires-soon'); const weekCls = await cls('expires-in-8-days'); const deadCls = await cls('already-expired');
  expect(soonCls).toMatch(/warning|amber/);
  expect(deadCls).toMatch(/danger|destructive|red/);
  expect(weekCls).not.toMatch(/warning|amber|danger|destructive|red/);
  test.info().annotations.push({ type: 'badge-classes', description: `soon=${soonCls} | 8d=${weekCls} | expired=${deadCls}` });
  await ev(page, 'sc8-list-expiry-states');
  // expired → 401, non-expired → 200
  for (const [t, code] of [[dead.token, 401], [soon.token, 200], [week.token, 200]] as const) {
    const c = await api(t);
    expect((await c.get('/api/workspaces')).status()).toBe(code);
    await c.dispose();
  }
});

test('sc9 last-4 hint on each row; 10 active tokens max, 11th → 409 @mobile', async ({ page }) => {
  await signedUp(page);
  const made: Awaited<ReturnType<typeof mint>>[] = [];
  for (let i = 1; i <= 10; i++) made.push(await mint(page, `token-${i}`));
  expect(made.every((t) => t.hint === t.token.slice(-4))).toBe(true);
  await page.goto('/settings/api-tokens');
  await expect(page.getByTestId('api-token-row')).toHaveCount(10);
  for (const t of made) {
    await expect(page.getByTestId('api-token-row').filter({ hasText: `token-${made.indexOf(t) + 1}` }).filter({ hasText: `tp_…${t.hint}` }).first()).toBeVisible();
  }
  await noOverflow(page);
  await ev(page, `sc9-ten-tokens-with-hints-${test.info().project.name}`);
  const over = await page.request.post('/api/me/api-tokens', { data: { name: 'eleventh' } });
  const e = await errOf(over);
  expect(e.status).toBe(409);
  expect(e.message).toBe('You already have 10 tokens. Revoke one first.');
  // UI shows the error and the list stays at 10
  await page.getByRole('button', { name: 'Create token' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('You already have 10 tokens. Revoke one first.')).toBeVisible();
  await ev(page, `sc9-eleventh-409-toast-${test.info().project.name}`);
  // revoking one frees a slot
  const del = await page.request.delete(`/api/me/api-tokens/${made[0].id}`);
  expect(del.status()).toBe(200);
  expect((await page.request.post('/api/me/api-tokens', { data: { name: 'after-revoke' } })).status()).toBe(201);
});

test('independent test: create in UI → bearer 200 → bearer POST /me/api-tokens 403 → revoke → 401 @mobile', async ({ page }) => {
  await signedUp(page);
  await page.goto('/settings/api-tokens');
  await page.getByRole('button', { name: 'Create token' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create token' }).click();
  const token = await page.getByRole('dialog').getByLabel('API token').inputValue();
  expect(token).toMatch(/^tp_/);
  await page.getByRole('dialog').getByRole('button', { name: 'I’ve saved it' }).click();
  const api = await bearer(baseOf(), token);
  try {
    expect((await api.get('/api/workspaces')).status()).toBe(200);
    expect((await api.post('/api/me/api-tokens', { data: { name: 'x' } })).status()).toBe(403);
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke token' }).click();
    await expect(page.getByText('Token revoked')).toBeVisible();
    expect((await api.get('/api/workspaces')).status()).toBe(401);
  } finally { await api.dispose(); }
  await ev(page, `independent-flow-done-${test.info().project.name}`);
});
