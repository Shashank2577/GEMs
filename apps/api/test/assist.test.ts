/** Submission assistant API (T064–T065, T067; FR-026, FR-027, US5). Constitution I: never price / OTP / submit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bidWorkspaces } from '@tp/db';
import { createTestContext, request, signup, type TestContext } from './helpers';
import { NOW, seedApply } from './workspace-fixtures';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof seedApply>>;
let wsId: string;
let token: string;

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  s = await seedApply(ctx);
  wsId = (await request(ctx.app, 'POST', `/tenders/${s.tender.id}/workspace`, { cookie: s.org.analyst.cookie })).body.id;
  const t = await request(ctx.app, 'POST', '/me/api-tokens', { cookie: s.org.analyst.cookie, json: { name: 'Chrome extension' } });
  token = t.body.token;
});
afterAll(() => ctx?.close());

describe('PUT /workspaces/:id/assist-values', () => {
  it('rejects price-like and authentication keys with 400 forbidden_field', async () => {
    for (const key of ['price', 'unit_price', 'totalValue', 'bid_value', 'otp', 'captcha', 'dsc', 'esign', 'final_submit']) {
      const r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.analyst.cookie, json: { make: 'Dell', [key]: '123' } });
      expect(r.status, key).toBe(400);
      expect(r.body.error.code).toBe('forbidden_field');
      expect(r.body.error.details.forbidden).toEqual([key]);
    }
    const [w] = await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.id, wsId));
    expect(w.assistValues).toEqual({}); // nothing was saved
  });

  it('rejects every spelling of the forbidden-key matrix (SC-002) and saves nothing', async () => {
    const SPELLINGS = [
      'unitPrice', 'unit-rate', 'Total Bid Value', 'quoted_amount', 'GST Amount', '₹', 'Rs', 'captchaText', 'otpCode', 'e-Sign',
      'aadhaarNo', 'DSC PIN', 'password', 'finalSubmit', 'placeBid',
    ];
    expect(SPELLINGS.length).toBeGreaterThanOrEqual(15);
    for (const key of SPELLINGS) {
      const r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.analyst.cookie, json: { make: 'Dell', [key]: '123' } });
      expect(r.status, key).toBe(400);
      expect(r.body.error.code, key).toBe('forbidden_field');
      expect(r.body.error.details.forbidden, key).toEqual([key]);
    }
    const [w] = await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.id, wsId));
    expect(w.assistValues).toEqual({});
  });

  it('rejects unknown keys and non-text values', async () => {
    const r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.analyst.cookie, json: { colour: 'red' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  });

  it('saves allow-listed values (empty string clears)', async () => {
    let r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.analyst.cookie, json: { model: 'Latitude 5450', warranty_months: '36', make: 'Dell' } });
    expect(r.status).toBe(200);
    r = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.analyst.cookie, json: { make: '' } });
    expect(r.body.assistValues).toEqual({ model: 'Latitude 5450', warranty_months: '36' });
    expect((await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { cookie: s.org.viewer.cookie, json: { model: 'x' } })).status).toBe(403);
  });
});

describe('GET /assist/:workspaceId', () => {
  it('works with a Bearer API token (browser extension) and never includes a price', async () => {
    await request(ctx.app, 'POST', `/workspaces/${wsId}/packets`, { cookie: s.org.analyst.cookie, json: {} });
    const r = await request(ctx.app, 'GET', `/assist/${wsId}`, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body.tender).toEqual({ bidNumber: 'GEM/2026/B/700001', title: 'Supply of Laptops batch 1' });
    expect(r.body.noFinancials).toBe(true);
    expect(r.body.readiness.analysed).toBe(true); // 006/FR-009
    const keys = r.body.fields.map((f: any) => f.key);
    expect(keys).not.toEqual(expect.arrayContaining(['price']));
    for (const k of keys) expect(k).not.toMatch(/price|rate|amount|value|otp|captcha|dsc|sign|submit|password/);
    const v = Object.fromEntries(r.body.fields.map((f: any) => [f.key, f.value]));
    expect(v).toMatchObject({ model: 'Latitude 5450', make: 'Dell', offered_quantity: '40', delivery_period_days: '30', country_of_origin: 'India', local_content_pct: '62', mse_claim: 'Yes', warranty_months: '36' });
    expect(r.body.fields[0].selectorHints.length).toBeGreaterThan(0);
    expect(r.body.humanSteps.map((h: any) => h.key)).toEqual(['price', 'upload', 'auth', 'submit']);
    expect(r.body.documents[0]).toMatchObject({ kind: 'packet', url: expect.stringMatching(/^http:\/\/tp\.test\/api\/packets\/.+\/download$/) });
    expect(r.body.documents.filter((d: any) => d.kind === 'vault').map((d: any) => d.fileName)).toEqual(['gst.pdf', 'pan.pdf', 'bs-2024.pdf', 'maf.pdf']);
    expect(JSON.stringify(r.body)).not.toMatch(/"price"\s*:/);
  });

  it('works with the session cookie too', async () => {
    const r = await request(ctx.app, 'GET', `/assist/${wsId}`, { cookie: s.org.viewer.cookie });
    expect(r.status).toBe(200);
  });

  it('the extension token can list workspaces but is refused without auth or across orgs', async () => {
    const l = await request(ctx.app, 'GET', '/workspaces', { bearer: token });
    expect(l.status).toBe(200);
    expect(l.body.items[0].id).toBe(wsId);
    expect((await request(ctx.app, 'GET', `/assist/${wsId}`)).status).toBe(401);
    expect((await request(ctx.app, 'GET', `/assist/${wsId}`, { bearer: 'tp_not_a_real_token' })).status).toBe(401);
    const other = await signup(ctx.app);
    expect((await request(ctx.app, 'GET', `/assist/${wsId}`, { cookie: other.cookie })).status).toBe(404);
  });
});

describe('006/FR-074 read-only ("Extension (read-only)") API token', () => {
  const READ_ONLY = { code: 'read_only_token', message: 'This API token is read-only' };
  let readToken: string;
  beforeAll(async () => {
    const t = await request(ctx.app, 'POST', '/me/api-tokens', { cookie: s.org.analyst.cookie, json: { name: 'Extension (read-only)', scope: 'read' } });
    expect(t.status).toBe(201);
    expect(t.body.scope).toBe('read');
    readToken = t.body.token;
  });

  it('GET /assist/:id, GET /workspaces and GET /auth/me work', async () => {
    const a = await request(ctx.app, 'GET', `/assist/${wsId}`, { bearer: readToken });
    expect(a.status).toBe(200);
    expect(a.body.noFinancials).toBe(true);
    const l = await request(ctx.app, 'GET', '/workspaces', { bearer: readToken });
    expect(l.status).toBe(200);
    expect(l.body.items.map((w: any) => w.id)).toContain(wsId);
    const me = await request(ctx.app, 'GET', '/auth/me', { bearer: readToken });
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('analyst');
  });

  it('PUT assist-values and POST comments are 403 "This API token is read-only" and change nothing', async () => {
    const [before] = await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.id, wsId));
    const put = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { bearer: readToken, json: { model: 'Hacked' } });
    expect(put.status).toBe(403);
    expect(put.body.error).toEqual(READ_ONLY);
    const post = await request(ctx.app, 'POST', `/workspaces/${wsId}/comments`, { bearer: readToken, json: { body: 'from the extension' } });
    expect(post.status).toBe(403);
    expect(post.body.error).toEqual(READ_ONLY);
    const [after] = await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.id, wsId));
    expect(after.assistValues).toEqual(before.assistValues);
    const comments = await request(ctx.app, 'GET', `/workspaces/${wsId}/comments`, { bearer: readToken });
    expect(comments.status).toBe(200);
    expect(JSON.stringify(comments.body)).not.toContain('from the extension');
  });

  it('the same writes still work with a full-scope token and with the session cookie', async () => {
    const full = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { bearer: token, json: { model: 'Latitude 5450' } });
    expect(full.status).toBe(200);
    const cookie = await request(ctx.app, 'POST', `/workspaces/${wsId}/comments`, { cookie: s.org.analyst.cookie, json: { body: 'from the web app' } });
    expect(cookie.status).toBe(201);
  });

  it('GET /tenders/:id/result-hint (outbound call, cache write, quota) is 403 read_only_token for a read token', async () => {
    const [ws] = await ctx.db.select().from(bidWorkspaces).where(eq(bidWorkspaces.id, wsId));
    const r = await request(ctx.app, 'GET', `/tenders/${ws.tenderId}/result-hint`, { bearer: readToken });
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual(READ_ONLY);
    const ok = await request(ctx.app, 'GET', `/tenders/${ws.tenderId}/result-hint`, { bearer: token });
    expect(ok.status).toBe(200);
  });

  it('another org\'s read token cannot read this workspace (404) and its writes are 403 read_only_token', async () => {
    const other = await signup(ctx.app);
    const otherWs = await request(ctx.app, 'GET', '/workspaces', { cookie: other.cookie });
    expect(otherWs.status).toBe(200);
    expect((await request(ctx.app, 'GET', `/assist/${wsId}`, { bearer: readToken })).status).toBe(200);
    const otherTok = (await request(ctx.app, 'POST', '/me/api-tokens', { cookie: other.cookie, json: { name: 'x', scope: 'read' } })).body.token as string;
    expect((await request(ctx.app, 'GET', `/assist/${wsId}`, { bearer: otherTok })).status).toBe(404);
    const w = await request(ctx.app, 'PUT', `/workspaces/${wsId}/assist-values`, { bearer: otherTok, json: { model: 'x' } });
    expect(w.status).toBe(403);
    expect(w.body.error).toEqual(READ_ONLY);
  });
});
