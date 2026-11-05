/** 003/NFR-008 — GET /api/__test/mail exists only when the app is built with the E2E test hooks (E2E_TEST_HOOKS=1), outside production. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createTestContext, TEST_APP_URL, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); });

describe('E2E mail capture hook', () => {
  it('is absent (404) by default, as on the Worker', async () => {
    const r = await ctx.app.request(`${TEST_APP_URL}/api/__test/mail`);
    expect(r.status).toBe(404);
  });

  it('exposes the log mailer sent list when enabled', async () => {
    await ctx.deps.mailer.send({ to: 'a@example.com', subject: 'Hello', text: 'hi', headers: { 'List-Unsubscribe': '<x>' } });
    const app = createApp(ctx.deps, { testHooks: true });
    const r = await app.request(`${TEST_APP_URL}/api/__test/mail`);
    expect(r.status).toBe(200);
    expect((await r.json()).sent).toEqual([expect.objectContaining({ to: 'a@example.com', subject: 'Hello', headers: { 'List-Unsubscribe': '<x>' } })]);
  });

  it('is never mounted in production, even when enabled', async () => {
    const app = createApp({ ...ctx.deps, config: { ...ctx.deps.config, environment: 'production' } }, { testHooks: true });
    expect((await app.request(`${TEST_APP_URL}/api/__test/mail`)).status).toBe(404);
  });

  it('does nothing for a real (non-log) mailer even when enabled', async () => {
    const app = createApp({ ...ctx.deps, mailer: { configured: true, send: async () => ({}) } }, { testHooks: true });
    expect((await app.request(`${TEST_APP_URL}/api/__test/mail`)).status).toBe(404);
  });
});
