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
