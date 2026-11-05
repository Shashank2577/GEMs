/**
 * 008/US7 scenario 6 (FR-074, T106): with Resend configured, the dispatcher sends queued instant emails through
 * `Mailer.sendMany` → `POST /emails/batch` with ≤ 100 messages per call: 120 queued emails → exactly 2 provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { notificationPrefs, notifications, tenders } from '@tp/db';
import { RESEND_BATCH_MAX, createResendMailer } from '../src/adapters/mailer';
import { EMAIL_BATCH_SIZE, dispatchNotifications } from '../src/services/alerts';
import { createTestContext, signup, type SignedUp, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00.000Z');
let ctx: TestContext;
let owner: SignedUp;
let calls: { url: string; body: unknown; key: string | null }[] = [];
let failCall: number | null = null;
let failStatus = 422;
/** Body of the failing response (Resend sends `{"statusCode":…,"name":…,"message":…}`). */
let failBody = '{"message":"provider refused"}';
/** A message with this subject is "invalid": Resend rejects any call containing it with 422 (a batch as a whole). */
let badSubject: string | null = null;

const resendFetch = (async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  calls.push({ url, body, key: new Headers(init?.headers).get('idempotency-key') });
  if (failCall === calls.length) return new Response(failBody, { status: failStatus });
  const subjects = (Array.isArray(body) ? body : [body]).map((m: { subject: string }) => m.subject);
  if (badSubject && subjects.includes(badSubject)) return new Response('{"message":"Invalid `to` field"}', { status: 422 });
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
  failStatus = 422;
  failBody = '{"message":"provider refused"}';
  badSubject = null;
  await ctx.db.delete(notifications).where(eq(notifications.orgId, owner.me.org.id));
  await ctx.db.delete(notificationPrefs).where(eq(notificationPrefs.orgId, owner.me.org.id));
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

  it('a failed batch call affects only its rows (permanent 4xx → failed, 429 → retried later); the next batch is still sent', async () => {
    await queueEmails(150);
    // A permanent error that is not a per-message validation error (e.g. auth) fails the whole call's rows.
    failStatus = 401;
    failCall = 1;
    const report = await dispatchNotifications(deps());
    expect(calls).toHaveLength(2);
    expect(report).toMatchObject({ sent: 50, failed: 100, retried: 0 });
    const failed = await ctx.db.select({ error: notifications.error }).from(notifications)
      .where(sql`${notifications.orgId} = ${owner.me.org.id} and ${notifications.status} = 'failed'`);
    expect(failed).toHaveLength(100);
    expect(failed[0]!.error).toMatch(/Resend error 401/);

    await ctx.db.delete(notifications).where(eq(notifications.orgId, owner.me.org.id));
    calls = [];
    await queueEmails(120);
    failStatus = 429;
    failCall = 2;
    const transient = await dispatchNotifications(deps());
    expect(calls).toHaveLength(2);
    expect(transient).toMatchObject({ sent: 100, retried: 20, failed: 0 });
    const pending = await ctx.db.select({ attempts: notifications.attempts }).from(notifications)
      .where(sql`${notifications.orgId} = ${owner.me.org.id} and ${notifications.status} = 'pending'`);
    expect(pending.map((p) => p.attempts)).toEqual(Array(20).fill(1));
  });

  it('review S2: one invalid message (422 for the whole batch) → that chunk is re-sent one per call; only the bad row fails', async () => {
    await queueEmails(30);
    badSubject = 'Batch email 7';
    const report = await dispatchNotifications(deps());
    expect(calls[0]!.url).toBe('https://api.resend.com/emails/batch');
    expect(calls.slice(1).map((c) => c.url)).toEqual(Array(30).fill('https://api.resend.com/emails'));
    expect(report).toMatchObject({ sent: 29, failed: 1, retried: 0 });
    const failed = await ctx.db.select({ title: notifications.title, error: notifications.error }).from(notifications)
      .where(sql`${notifications.orgId} = ${owner.me.org.id} and ${notifications.status} = 'failed'`);
    expect(failed).toEqual([{ title: 'Batch email 7', error: expect.stringMatching(/Resend error 422/) }]);
    // Single sends carry a per-notification idempotency key.
    expect(calls.slice(1).every((c) => /^tp-notif-[0-9a-f-]{36}$/.test(c.key ?? ''))).toBe(true);
  });

  it('review S2: batch calls carry an idempotency key that is stable across a retry of the same rows; 409 (already accepted) → sent', async () => {
    await queueEmails(20);
    failStatus = 503; // e.g. the response was lost after Resend accepted the batch
    failCall = 1;
    const first = await dispatchNotifications(deps());
    expect(first).toMatchObject({ sent: 0, retried: 20 });
    expect(calls[0]!.key).toMatch(/^tp-batch-[0-9a-f]{64}$/);
    // Make the retries due now, and let Resend answer that it already processed this key.
    await ctx.db.update(notifications).set({ nextAttemptAt: new Date(NOW.getTime() - 1000) }).where(eq(notifications.orgId, owner.me.org.id));
    failStatus = 409;
    failCall = 2;
    const again = await dispatchNotifications(deps());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key); // same rows ⇒ same key ⇒ Resend does not deliver them twice
    expect(again).toMatchObject({ sent: 20, failed: 0, retried: 0 });
  });

  it('review R2-N1: 409 invalid_idempotent_request (key already settled) → sent; 409 concurrent_idempotent_requests (still in flight) → retried, then sent', async () => {
    await queueEmails(5);
    failStatus = 409;
    failBody = '{"statusCode":409,"name":"concurrent_idempotent_requests","message":"Same idempotency key used while original request is still in progress."}';
    failCall = 1;
    const first = await dispatchNotifications(deps());
    expect(first).toMatchObject({ sent: 0, failed: 0, retried: 5 });
    expect(await ctx.db.select({ status: notifications.status }).from(notifications).where(eq(notifications.orgId, owner.me.org.id)))
      .toEqual(Array.from({ length: 5 }, () => ({ status: 'pending' })));
    await ctx.db.update(notifications).set({ nextAttemptAt: new Date(NOW.getTime() - 1000) }).where(eq(notifications.orgId, owner.me.org.id));
    failBody = '{"statusCode":409,"name":"invalid_idempotent_request","message":"Same idempotency key used with a different request payload."}';
    failCall = 2;
    const again = await dispatchNotifications(deps());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(again).toMatchObject({ sent: 5, failed: 0, retried: 0 });
  });

  it('review R2-N1: a retried email is rendered as of its row (not the dispatch time) → the same payload under the same key', async () => {
    const [t] = await ctx.db.insert(tenders).values({
      bidNumber: 'GEM/2026/B/9100001', title: 'Solar street lights', endAt: new Date(NOW.getTime() + 5 * 86_400_000), status: 'open',
      sourceUrl: 'https://bidplus.gem.gov.in/all-bids#9100001', contentHash: 'r2n1-render',
    }).returning();
    await ctx.db.insert(notifications).values({
      orgId: owner.me.org.id, userId: owner.me.user.id, channel: 'email', kind: 'tender_match', status: 'pending',
      title: 'New match: Solar street lights', body: 'Solar street lights — matched solar', link: `/tenders/${t!.id}`, dedupeKey: `r2n1-${Date.now()}`,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    try {
      failStatus = 503;
      failCall = 1;
      expect(await dispatchNotifications(deps())).toMatchObject({ retried: 1 });
      // Two days later ("3 days left" instead of "5 days left" if it were rendered at dispatch time).
      const later = new Date(NOW.getTime() + 2 * 86_400_000);
      await ctx.db.update(notifications).set({ nextAttemptAt: new Date(later.getTime() - 1000) }).where(eq(notifications.orgId, owner.me.org.id));
      expect(await dispatchNotifications({ ...deps(), clock: { now: () => later } })).toMatchObject({ sent: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.key).toBe(calls[0]!.key);
      expect(calls[1]!.body).toEqual(calls[0]!.body);
    } finally {
      await ctx.db.delete(notifications).where(eq(notifications.orgId, owner.me.org.id));
      await ctx.db.delete(tenders).where(eq(tenders.id, t!.id));
    }
  });

  it('003/US5 × US7 (review R2-B1): an instant corrigendum email goes out in the batch with its own heading and intro', async () => {
    await queueEmails(2);
    await ctx.db.insert(notifications).values({
      orgId: owner.me.org.id, userId: owner.me.user.id, channel: 'email', kind: 'corrigendum', status: 'pending',
      title: 'Bid amended: GEM/2026/B/9100002', body: 'The buyer issued a corrigendum. Changed: closing date. Re-check your analysis.',
      link: '/tenders', dedupeKey: `r2b1-corr-${Date.now()}`, createdAt: new Date(NOW.getTime() - 500),
    });
    const report = await dispatchNotifications(deps());
    expect(report).toMatchObject({ sent: 3, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/emails\/batch$/);
    const corr = (calls[0]!.body as { subject: string; html: string }[]).find((m) => m.subject === 'Bid amended: GEM/2026/B/9100002')!;
    expect(corr.html).toContain('A tracked GeM bid was amended');
    expect(corr.html).toContain('The buyer changed this bid on GeM. Re-check your eligibility analysis before you bid.');
    expect(corr.html).toContain('closing date'); // the "Changed:" box
    expect(corr.html).not.toContain('A new GeM tender matches your watchlist');
  });

  it('003/US5 × US7 (review R2-B1): with a daily preference a corrigendum joins the digest, not the instant batch', async () => {
    await ctx.db.insert(notificationPrefs).values({ orgId: owner.me.org.id, userId: owner.me.user.id, frequency: 'daily' });
    await ctx.db.insert(notifications).values([
      { orgId: owner.me.org.id, userId: owner.me.user.id, channel: 'email', kind: 'corrigendum', status: 'pending',
        title: 'Bid amended: GEM/2026/B/9100003', body: 'Changed: quantity. Re-check your analysis.', link: '/tenders', dedupeKey: `r2b1-dc-${Date.now()}`, createdAt: new Date(NOW.getTime() - 500) },
      { orgId: owner.me.org.id, userId: owner.me.user.id, channel: 'email', kind: 'system', status: 'pending',
        title: 'System notice', body: 'Instant even for daily users', link: '/tenders', dedupeKey: `r2b1-ds-${Date.now()}`, createdAt: new Date(NOW.getTime() - 400) },
    ]);
    const report = await dispatchNotifications(deps());
    expect(report).toMatchObject({ failed: 0 });
    const batch = calls.filter((c) => c.url.endsWith('/emails/batch'));
    const single = calls.filter((c) => c.url.endsWith('/emails'));
    expect(batch).toHaveLength(1);
    expect((batch[0]!.body as { subject: string }[]).map((m) => m.subject)).toEqual(['System notice']);
    expect(single).toHaveLength(1); // the digest
    expect((single[0]!.body as { subject: string }).subject).toBe('Daily digest: 1 tracked bid amended today');
  });

  it('sendMany maps the provider ids back in order', async () => {
    const mailer = deps().mailer;
    const r = await mailer.sendMany!([{ to: 'a@x.in', subject: 'a' }, { to: ['b@x.in'], subject: 'b' }]);
    expect(r).toEqual([{ id: 're_1_0' }, { id: 're_1_1' }]);
    expect(calls).toHaveLength(1);
  });
});
