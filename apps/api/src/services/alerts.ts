/**
 * Notification dispatcher (T035; FR-005). The `notifications` table is the outbox:
 *  - instant users: each pending email / WhatsApp row is sent on its own;
 *  - daily users: pending rows are held and sent as one digest per org per IST day, from 08:00 IST;
 *  - every row ends `sent`, `skipped` (channel not configured / no phone) or `failed` (+ error);
 *  - transient provider failures (network / 408 / 429 / 5xx) stay `pending` and are retried at +5 min then +30 min;
 *    the 3rd failed attempt (or any permanent 4xx) marks the row `failed` (FR-047, T051);
 *  - rows are claimed atomically (FOR UPDATE SKIP LOCKED + a lease on next_attempt_at), so concurrent runs never send
 *    the same row twice and re-running is idempotent.
 * Email via deps.mailer (Resend), WhatsApp via deps.whatsapp (Meta Cloud API, pre-approved template).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { notificationPrefs, notifications, organizations, tenders, users } from '@tp/db';
import { isTransientSendError } from '../adapters/provider-error';
import type { AppDeps } from '../deps';

type NotificationRow = typeof notifications.$inferSelect;
type TenderRow = typeof tenders.$inferSelect;

/** `retried`: transient failures left `pending` with a back-off (FR-047); `failed` is terminal. */
export interface DispatchReport { sent: number; skipped: number; failed: number; retried: number; held: number; digests: number }

export const DIGEST_HOUR_IST = 8;
/** WhatsApp Business template used for business-initiated alerts (must be approved in Meta). */
export const WHATSAPP_TEMPLATE = 'tender_alert';

const IST_MS = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const istHour = (d: Date) => new Date(d.getTime() + IST_MS).getUTCHours();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const inr = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`;
const istDate = (d: Date | null) =>
  d ? `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} IST` : '—';
const daysLeft = (d: Date | null, now: Date) => {
  if (!d) return '';
  const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
  return days <= 0 ? 'closes today' : days === 1 ? '1 day left' : `${days} days left`;
};

function tenderIdFromLink(link: string | null): string | null {
  const m = link?.match(/\/tenders\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

// ───────────── email templates ─────────────

function tenderCard(t: TenderRow | undefined, n: NotificationRow, appUrl: string, now: Date): string {
  const url = `${appUrl}${n.link ?? '/tenders'}`;
  if (!t) {
    return `<tr><td style="padding:16px 20px;border:1px solid #e4e7ee;border-radius:12px;background:#fff">
      <a href="${esc(url)}" style="color:#1e1b4b;font-weight:600;font-size:15px;text-decoration:none">${esc(n.title)}</a>
      <p style="margin:6px 0 0;color:#475569;font-size:13px;line-height:20px">${esc(n.body)}</p></td></tr><tr><td style="height:12px"></td></tr>`;
  }
  const urgent = t.endAt && t.endAt.getTime() - now.getTime() < 3 * 86_400_000;
  const matched = n.body.includes('— matched') ? n.body.split('— matched')[1].trim() : '';
  return `<tr><td style="padding:18px 20px;border:1px solid #e4e7ee;border-radius:12px;background:#ffffff">
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#64748b">${esc(t.bidNumber)}</div>
    <a href="${esc(url)}" style="display:block;margin-top:4px;color:#1e1b4b;font-weight:600;font-size:16px;line-height:22px;text-decoration:none">${esc(t.title)}</a>
    <div style="margin-top:4px;color:#475569;font-size:13px">${esc([t.department ?? t.ministry, t.state].filter(Boolean).join(' · '))}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;width:100%;font-size:13px;color:#0f172a">
      <tr>
        <td style="padding-right:12px"><div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Closes</div><div style="font-weight:600;color:${urgent ? '#e11d48' : '#0f172a'}">${esc(istDate(t.endAt))}</div><div style="color:#64748b;font-size:12px">${esc(daysLeft(t.endAt, now))}</div></td>
        <td style="padding-right:12px"><div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em">EMD</div><div style="font-weight:600">${esc(t.emdAmount ? inr(t.emdAmount) : t.emdAmount === 0 ? 'Nil' : '—')}</div></td>
        <td style="padding-right:12px"><div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Value</div><div style="font-weight:600">${esc(inr(t.estimatedValue))}</div></td>
        <td><div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Qty</div><div style="font-weight:600">${esc(t.quantity?.toLocaleString('en-IN') ?? '—')}</div></td>
      </tr>
    </table>
    ${matched ? `<div style="margin-top:12px;font-size:12px;color:#4338ca">Matched ${esc(matched)}</div>` : ''}
    <a href="${esc(url)}" style="display:inline-block;margin-top:14px;padding:9px 16px;background:#4f46e5;color:#ffffff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none">Review &amp; score this bid →</a>
  </td></tr><tr><td style="height:12px"></td></tr>`;
}

export function renderAlertEmail(opts: {
  heading: string; intro: string; rows: { n: NotificationRow; tender?: TenderRow }[]; appUrl: string; orgName: string; now: Date;
}): string {
  const { heading, intro, rows, appUrl, orgName, now } = opts;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f9;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="padding:4px 4px 16px"><span style="display:inline-block;width:28px;height:28px;border-radius:8px;background:#4f46e5;color:#fff;font-weight:700;text-align:center;line-height:28px;font-size:14px">T</span>
    <span style="font-weight:700;font-size:16px;color:#1e1b4b;vertical-align:middle;margin-left:8px">TenderPilot</span>
    <span style="float:right;color:#64748b;font-size:12px;line-height:28px">${esc(orgName)}</span></td></tr>
  <tr><td style="padding:24px 24px 8px;background:#ffffff;border-radius:16px 16px 0 0">
    <h1 style="margin:0;font-size:20px;line-height:28px;color:#0f172a">${esc(heading)}</h1>
    <p style="margin:8px 0 0;color:#475569;font-size:14px;line-height:22px">${esc(intro)}</p></td></tr>
  <tr><td style="padding:16px 24px 8px;background:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${rows.map((r) => tenderCard(r.tender, r.n, appUrl, now)).join('')}
  </table></td></tr>
  <tr><td style="padding:8px 24px 24px;background:#ffffff;border-radius:0 0 16px 16px">
    <a href="${esc(appUrl)}/tenders?matched=1" style="color:#4f46e5;font-size:13px;font-weight:600;text-decoration:none">Open your tender feed →</a></td></tr>
  <tr><td style="padding:16px 8px;color:#94a3b8;font-size:11px;line-height:17px;text-align:center">
    TenderPilot prepares bids — you stay in control. Price entry, OTP / DSC and final submission on GeM are always done by you.<br>
    <a href="${esc(appUrl)}/settings/notifications" style="color:#64748b">Notification settings</a> · Times shown in IST</td></tr>
</table></td></tr></table></body></html>`;
}

function textVersion(rows: { n: NotificationRow }[], appUrl: string): string {
  return rows.map((r) => `${r.n.title}\n${r.n.body}\n${appUrl}${r.n.link ?? ''}`).join('\n\n') + `\n\nManage alerts: ${appUrl}/settings/notifications`;
}

// ───────────── dispatcher ─────────────

/** FR-047: a row is tried at most this many times before it is marked `failed`. */
export const MAX_SEND_ATTEMPTS = 3;
/** Back-off before retry n+1 after a transient failure on attempt n (1-based): +5 min, then +30 min. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000] as const;
/**
 * How long a dispatcher owns the rows it claimed. A claim moves `next_attempt_at` to `now + lease`, so concurrent
 * dispatchers skip those rows; if a dispatcher dies mid-run the rows become due again when the lease runs out.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

type Claimed = { n: NotificationRow; email: string; phone: string | null; name: string; frequency: 'instant' | 'daily' | null; orgName: string };

export async function dispatchNotifications(deps: AppDeps, opts: { limit?: number } = {}): Promise<DispatchReport> {
  const { db, clock, logger, mailer, whatsapp, config } = deps;
  const now = clock.now();
  const report: DispatchReport = { sent: 0, skipped: 0, failed: 0, retried: 0, held: 0, digests: 0 };
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);

  // Claim due rows atomically: rows locked by a concurrent dispatcher are skipped, and once claimed their
  // next_attempt_at is in the future, so no other run picks them up. `prev` lets held rows be released unchanged.
  const claimRes = await db.execute(sql`
    with due as (
      select id, next_attempt_at as prev from notifications
      where status = 'pending' and channel in ('email', 'whatsapp')
        and (next_attempt_at is null or next_attempt_at <= ${now})
      order by created_at
      limit ${opts.limit ?? 500}
      for update skip locked
    )
    update notifications n set next_attempt_at = ${lease}
    from due where n.id = due.id
    returning n.id as id, due.prev as prev`);
  const claimedRows = (claimRes as unknown as { rows: { id: string; prev: Date | string | null }[] }).rows;
  if (!claimedRows.length) return report;
  const prevById = new Map(claimedRows.map((r) => [r.id, r.prev == null ? null : new Date(r.prev)]));

  const pending: Claimed[] = await db
    .select({ n: notifications, email: users.email, phone: users.phone, name: users.name, frequency: notificationPrefs.frequency, orgName: organizations.name })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .innerJoin(organizations, eq(organizations.id, notifications.orgId))
    .leftJoin(notificationPrefs, and(eq(notificationPrefs.orgId, notifications.orgId), eq(notificationPrefs.userId, notifications.userId)))
    .where(inArray(notifications.id, [...prevById.keys()]))
    .orderBy(notifications.createdAt);

  const tenderIds = [...new Set(pending.map((p) => tenderIdFromLink(p.n.link)).filter((x): x is string => !!x))];
  const tenderRows = tenderIds.length ? await db.select().from(tenders).where(inArray(tenders.id, tenderIds)) : [];
  const tenderById = new Map(tenderRows.map((t) => [t.id, t]));

  // Every write below only touches rows this run still owns (pending + our lease), so a run that lost its lease
  // never overwrites a newer outcome — re-running the dispatcher is idempotent.
  const owned = (ids: string[]) => and(inArray(notifications.id, ids), eq(notifications.status, 'pending'), eq(notifications.nextAttemptAt, lease));

  /** Not sent this run (digest not due / already sent today): hand the rows back with their previous schedule. */
  const release = async (ids: string[]) => {
    const byPrev = new Map<string, string[]>();
    for (const id of ids) {
      const key = prevById.get(id)?.toISOString() ?? '';
      byPrev.set(key, [...(byPrev.get(key) ?? []), id]);
    }
    for (const [prev, group] of byPrev) {
      await db.update(notifications).set({ nextAttemptAt: prev ? new Date(prev) : null }).where(owned(group));
    }
    report.held += ids.length;
  };

  /** Provider accepted (sent) or the channel is not configured (skipped): terminal. */
  const settle = async (ids: string[], status: 'sent' | 'skipped', error: string | null = null) => {
    const done = await db.update(notifications)
      .set({
        status, error, sentAt: status === 'sent' ? now : null, nextAttemptAt: null,
        ...(status === 'sent' ? { attempts: sql`${notifications.attempts} + 1` } : {}),
      })
      .where(owned(ids)).returning({ id: notifications.id });
    report[status] += done.length;
  };

  /** Provider error: transient → stay pending with back-off until MAX_SEND_ATTEMPTS, then (or if permanent) failed. */
  const fail = async (ids: string[], e: unknown) => {
    const transient = isTransientSendError(e);
    const retry = sql`(${transient} and ${notifications.attempts} + 1 < ${MAX_SEND_ATTEMPTS})`;
    const backoff = sql`case when ${notifications.attempts} = 0
      then ${new Date(now.getTime() + RETRY_BACKOFF_MS[0])}::timestamptz
      else ${new Date(now.getTime() + RETRY_BACKOFF_MS[1])}::timestamptz end`;
    const done = await db.update(notifications)
      .set({
        status: sql`case when ${retry} then 'pending' else 'failed' end`,
        error: errMsg(e),
        attempts: sql`${notifications.attempts} + 1`,
        nextAttemptAt: sql`case when ${retry} then ${backoff} else null end`,
      })
      .where(owned(ids)).returning({ status: notifications.status });
    for (const r of done) r.status === 'pending' ? report.retried++ : report.failed++;
  };

  // Group: instant → one message per row; daily → one digest per (user, org, channel).
  const digestGroups = new Map<string, Claimed[]>();
  const digestDue = istHour(now) >= DIGEST_HOUR_IST;
  const toHold: string[] = [];
  for (const p of pending) {
    const daily = p.frequency === 'daily' && p.n.kind === 'tender_match';
    if (!daily) {
      try {
        const r = await sendOne(deps, p, tenderById, now);
        await settle([p.n.id], r.skipped ? 'skipped' : 'sent', r.skipped ? r.reason ?? 'Channel not configured' : null);
      } catch (e) {
        logger.warn('notification send failed', { id: p.n.id, channel: p.n.channel, attempt: p.n.attempts + 1, transient: isTransientSendError(e), error: errMsg(e) });
        await fail([p.n.id], e);
      }
      continue;
    }
    // A digest is sent once per IST day after DIGEST_HOUR_IST; rows created today before it wait.
    if (!digestDue) { toHold.push(p.n.id); continue; }
    const key = `${p.n.userId}|${p.n.orgId}|${p.n.channel}`;
    digestGroups.set(key, [...(digestGroups.get(key) ?? []), p]);
  }
  if (toHold.length) await release(toHold);

  for (const [key, group] of digestGroups) {
    const [userId, orgId, channel] = key.split('|') as [string, string, 'email' | 'whatsapp'];
    const dedupeKey = `digest:${orgId}:${istDay(now)}`;
    const ids = group.map((g) => g.n.id);
    const first = group[0];
    const count = group.length;
    const title = `${count} new GeM tender${count === 1 ? '' : 's'} matched today`;
    // Reserve today's digest first (unique user/channel/dedupe key): if it already exists — sent earlier today or
    // by a concurrent dispatcher — hold the rest for tomorrow. Never two digests a day.
    const [digest] = await db.insert(notifications).values({
      orgId, userId, channel, kind: 'digest', title, body: `${count} matched tenders`,
      link: '/tenders?matched=1', dedupeKey, status: 'sent', sentAt: now, createdAt: now,
    }).onConflictDoNothing().returning({ id: notifications.id });
    if (!digest) { await release(ids); continue; }
    try {
      let skipped = false;
      let reason: string | null = null;
      if (channel === 'email') {
        const rows = group.map((g) => ({ n: g.n, tender: tenderById.get(tenderIdFromLink(g.n.link) ?? '') }));
        const r = await mailer.send({
          to: first.email,
          subject: `Daily digest: ${title}`,
          html: renderAlertEmail({ heading: title, intro: `Here is your daily summary of tenders matching ${first.orgName}'s watchlists.`, rows, appUrl: config.appUrl, orgName: first.orgName, now }),
          text: textVersion(rows, config.appUrl),
        });
        skipped = !!r.skipped;
        if (skipped) reason = 'Email is not configured (RESEND_API_KEY)';
      } else {
        if (!first.phone) { skipped = true; reason = 'No mobile number on the account'; } else {
          const r = await whatsapp.send({
            to: first.phone,
            template: { name: `${WHATSAPP_TEMPLATE}_digest`, language: 'en', params: [String(count), first.orgName, `${config.appUrl}/tenders?matched=1`] },
            text: `${title} for ${first.orgName}. Review: ${config.appUrl}/tenders?matched=1`,
          });
          skipped = !!r.skipped;
          if (skipped) reason = 'WhatsApp is not configured (WHATSAPP_TOKEN)';
        }
      }
      if (skipped) await db.update(notifications).set({ status: 'skipped', error: reason, sentAt: null }).where(eq(notifications.id, digest.id));
      else await db.update(notifications).set({ attempts: 1 }).where(eq(notifications.id, digest.id));
      report.digests++;
      await settle(ids, skipped ? 'skipped' : 'sent', reason);
    } catch (e) {
      logger.warn('digest send failed', { userId, channel, transient: isTransientSendError(e), error: errMsg(e) });
      // Free today's digest slot so a retry (or the next dispatch) can send it.
      await db.delete(notifications).where(eq(notifications.id, digest.id));
      await fail(ids, e);
    }
  }
  logger.info('notifications dispatched', { ...report });
  return report;
}

async function sendOne(
  deps: AppDeps,
  p: { n: NotificationRow; email: string; phone: string | null; orgName: string },
  tenderById: Map<string, TenderRow>,
  now: Date,
): Promise<{ skipped: boolean; reason?: string }> {
  const { mailer, whatsapp, config } = deps;
  const tender = tenderById.get(tenderIdFromLink(p.n.link) ?? '');
  const url = `${config.appUrl}${p.n.link ?? ''}`;
  if (p.n.channel === 'email') {
    const heading = p.n.kind === 'tender_match' ? 'A new GeM tender matches your watchlist' : p.n.title;
    const r = await mailer.send({
      to: p.email,
      subject: p.n.title,
      html: renderAlertEmail({ heading, intro: p.n.kind === 'tender_match' ? 'Act early — the best bids are prepared well before the deadline.' : p.n.body, rows: [{ n: p.n, tender }], appUrl: config.appUrl, orgName: p.orgName, now }),
      text: textVersion([p], config.appUrl),
    });
    return r.skipped ? { skipped: true, reason: 'Email is not configured (RESEND_API_KEY)' } : { skipped: false };
  }
  if (!p.phone) return { skipped: true, reason: 'No mobile number on the account' };
  const closes = tender?.endAt ? istDate(tender.endAt) : '';
  const r = await whatsapp.send({
    to: p.phone,
    template: { name: WHATSAPP_TEMPLATE, language: 'en', params: [tender?.title ?? p.n.title, tender?.bidNumber ?? '', closes, url] },
    text: `${p.n.title}\n${p.n.body}\n${url}`,
  });
  return r.skipped ? { skipped: true, reason: 'WhatsApp is not configured (WHATSAPP_TOKEN)' } : { skipped: false };
}
