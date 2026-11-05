/** Email via the Resend HTTP API; logs and skips when RESEND_API_KEY is absent. */
import type { EmailMessage, Logger, Mailer, SendResult } from '../deps';

export function createResendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch; logger: Logger }): Mailer {
  const f = opts.fetch ?? fetch;
  return {
    configured: true,
    async send(msg: EmailMessage): Promise<SendResult> {
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: opts.from,
          to: Array.isArray(msg.to) ? msg.to : [msg.to],
          subject: msg.subject,
          html: msg.html, text: msg.text,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Resend error ${res.status}: ${body.slice(0, 500)}`);
      try { return { id: (JSON.parse(body) as { id?: string }).id }; } catch { return {}; }
    },
  };
}

/** Not configured: log instead of sending. `sent` keeps messages for tests and dev inspection. */
export function createLogMailer(logger: Logger): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    configured: false,
    sent,
    async send(msg) {
      sent.push(msg);
      if (sent.length > 200) sent.shift();
      logger.info('email skipped (no RESEND_API_KEY)', { to: msg.to, subject: msg.subject });
      return { skipped: true };
    },
  };
}
