/** Email via the Resend HTTP API; logs and skips when RESEND_API_KEY is absent. */
import type { EmailMessage, Logger, Mailer, SendResult } from '../deps';

/** Resend's `/emails/batch` accepts at most 100 messages per call (008/FR-074). */
export const RESEND_BATCH_MAX = 100;

export function createResendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch; logger: Logger }): Mailer {
  const f = opts.fetch ?? fetch;
  const payload = (msg: EmailMessage) => ({
    from: opts.from,
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject,
    html: msg.html, text: msg.text,
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
  });
  const post = async (path: string, body: unknown): Promise<string> => {
    const res = await f(`https://api.resend.com${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${text.slice(0, 500)}`);
    return text;
  };
  return {
    configured: true,
    async send(msg: EmailMessage): Promise<SendResult> {
      const body = await post('/emails', payload(msg));
      try { return { id: (JSON.parse(body) as { id?: string }).id }; } catch { return {}; }
    },
    async sendMany(msgs: EmailMessage[]): Promise<SendResult[]> {
      const out: SendResult[] = [];
      for (let i = 0; i < msgs.length; i += RESEND_BATCH_MAX) {
        const chunk = msgs.slice(i, i + RESEND_BATCH_MAX);
        const body = await post('/emails/batch', chunk.map(payload));
        let ids: { id?: string }[] = [];
        try { ids = (JSON.parse(body) as { data?: { id?: string }[] }).data ?? []; } catch { /* ids are informational */ }
        chunk.forEach((_, j) => out.push(ids[j]?.id ? { id: ids[j]!.id } : {}));
      }
      return out;
    },
  };
}

/** Not configured: log instead of sending. `sent` keeps messages for tests and dev inspection. */
export function createLogMailer(logger: Logger): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  const mailer: Mailer & { sent: EmailMessage[] } = {
    configured: false,
    sent,
    async send(msg) {
      sent.push(msg);
      if (sent.length > 200) sent.shift();
      logger.info('email skipped (no RESEND_API_KEY)', { to: msg.to, subject: msg.subject });
      return { skipped: true };
    },
    async sendMany(msgs) {
      const out: SendResult[] = [];
      for (const m of msgs) out.push(await mailer.send(m));
      return out;
    },
  };
  return mailer;
}
