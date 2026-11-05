/**
 * 008/US7 scenario 6 (FR-074, T106): with Resend configured, the dispatcher sends queued instant emails through
 * `Mailer.sendMany` → `POST /emails/batch` with ≤ 100 messages per call: 120 queued emails → exactly 2 provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { notifications } from '@tp/db';
import { RESEND_BATCH_MAX, createResendMailer } from '../src/adapters/mailer';
import { EMAIL_BATCH_SIZE, dispatchNotifications } from '../src/services/alerts';
import { createTestContext, signup, type SignedUp, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00.000Z');
let ctx: TestContext;
let owner: SignedUp;
let calls: { url: string; body: unknown }[] = [];
let failCall: number | null = null;

const resendFetch = (async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  calls.push({ url, body });
  if (failCall === calls.length) return new Response('{"message":"rate limited"}', { status: 429 });
  if (url.endsWith('/emails/batch')) return Response.json({ data: (body as unknown[]).map((_, i) => ({ id: `re_${calls.length}_${i}` })) });
  return Response.json({ id: `re_${calls.length}` });
}) as unknown as typeof fetch;

async function queueEmails(n: number) {
  await ctx.db.insert(notifications).values(Array.from({ length: n }, (_, i) => ({
    orgId: owner.me.org.id, userId: owner.me.user.id, channel: 'email' as const, kind: 'system' as const, status: 'pending' as const,
    title: `Batch email ${i}`, body: `Body ${i}`, link: '/tenders', dedupeKey: `batch-email-${Date.now()}-${i}`, createdAt: new Date(NOW.getTime() - (n - i) * 1000),
  })));
}
const deps = () => ({ ...ctx.deps, mailer: createResendMailer({ apiKey: 're_test', from: 'TenderPilot <alerts@tenderpilot.in>', fetch: resendFetch, logger: ctx.deps.logger }) });

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  owner = await signup(ctx.app, { orgName: 'Batch Mail Co' });
});
afterAll(() => ctx?.close());
beforeEach(async () => {
  calls = [];
  failCall = null;
  await ctx.db.delete(notifications).where(eq(notifications.orgId, owner.me.org.id));
});

describe('Resend batch sending (US7 scenario 6)', () => {
  it('limits are 100 per call', () => {
    expect(RESEND_BATCH_MAX).toBe(100);
    expect(EMAIL_BATCH_SIZE).toBe(100);
  });

  it('120 queued emails → exactly 2 calls to /emails/batch (100 + 20); every row sent', async () => {
    await queueEmails(120);
    const report = await dispatchNotifications(deps());
    expect(calls.map((c) => c.url)).toEqual(['https://api.resend.com/emails/batch', 'https://api.resend.com/emails/batch']);
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 20]);
    expect((calls[0]!.body as { to: string[]; subject: string; from: string }[])[0]).toMatchObject({ to: [owner.me.user.email], subject: 'Batch email 0', from: 'TenderPilot <alerts@tenderpilot.in>' });
    expect(report).toMatchObject({ sent: 120, failed: 0, skipped: 0 });
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
      .where(sql`${notifications.orgId} = ${owner.me.org.id} and ${notifications.status} = 'sent' and ${notifications.sentAt} is not null`);
    expect(n).toBe(120);
  });

  it('a failed batch call marks only its rows failed; the next batch is still sent', async () => {
    await queueEmails(150);
    failCall = 1;
    const report = await dispatchNotifications(deps());
    expect(calls).toHaveLength(2);
    expect(report).toMatchObject({ sent: 50, failed: 100 });
    const failed = await ctx.db.select({ error: notifications.error }).from(notifications)
      .where(sql`${notifications.orgId} = ${owner.me.org.id} and ${notifications.status} = 'failed'`);
    expect(failed).toHaveLength(100);
    expect(failed[0]!.error).toMatch(/Resend error 429/);
  });

  it('sendMany maps the provider ids back in order', async () => {
    const mailer = deps().mailer;
    const r = await mailer.sendMany!([{ to: 'a@x.in', subject: 'a' }, { to: ['b@x.in'], subject: 'b' }]);
    expect(r).toEqual([{ id: 're_1_0' }, { id: 're_1_1' }]);
    expect(calls).toHaveLength(1);
  });
});
