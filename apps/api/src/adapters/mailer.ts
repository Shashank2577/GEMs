/** Email via the Resend HTTP API; logs and skips when RESEND_API_KEY is absent. */
import type { EmailMessage, Logger, Mailer, SendOptions, SendResult } from '../deps';
import { isTransientStatus, ProviderError, providerFetch } from './provider-error';

/** Resend's `/emails/batch` accepts at most 100 messages per call (008/FR-074). */
export const RESEND_BATCH_MAX = 100;

/** Resend 409 `name` for "a request with this idempotency key is still being processed" (retry later). */
export const RESEND_CONCURRENT_IDEMPOTENT = 'concurrent_idempotent_requests';

/** The `name` field of a Resend error body (`{"statusCode":409,"name":"…","message":"…"}`), if any. */
function resendErrorName(body: string): string | undefined {
  try {
    const name = (JSON.parse(body) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch { return undefined; }
}

export function createResendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch; logger: Logger }): Mailer {
  const f = opts.fetch ?? fetch;
  const payload = (msg: EmailMessage) => ({
    from: opts.from,
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject,
    html: msg.html, text: msg.text,
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    ...(msg.headers ? { headers: msg.headers } : {}),
  });
  const post = async (path: string, body: unknown, idempotencyKey?: string): Promise<string> => {
    const res = await providerFetch('Resend', f, `https://api.resend.com${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // 408/429/5xx are transient (retried by the dispatcher); other 4xx (validation, auth, domain) are permanent.
    // Resend's 409 has two meanings, told apart by the error `name` (review R2-N1): `concurrent_idempotent_requests` —
    // the first request with this key is still in flight and may yet fail → transient; `invalid_idempotent_request` —
    // the key was already used (with a different payload) → the original request settled.
    if (!res.ok) {
      const code = resendErrorName(text);
      const transient = isTransientStatus(res.status) || (res.status === 409 && code === RESEND_CONCURRENT_IDEMPOTENT);
      throw new ProviderError(`Resend error ${res.status}: ${text.slice(0, 500)}`, transient, res.status, code);
    }
    return text;
  };
  return {
    configured: true,
    async send(msg: EmailMessage, sendOpts: SendOptions = {}): Promise<SendResult> {
      const body = await post('/emails', payload(msg), sendOpts.idempotencyKey);
      try { return { id: (JSON.parse(body) as { id?: string }).id }; } catch { return {}; }
    },
    /**
     * 008/FR-074: `/emails/batch`, ≤ 100 messages per call; a failed call rejects (the caller fails that batch, or
     * falls back to single sends on a validation error — Resend rejects the WHOLE batch for one bad message).
     * With an idempotency key, call n of a multi-call send uses `<key>:<n>`.
     */
    async sendMany(msgs: EmailMessage[], sendOpts: SendOptions = {}): Promise<SendResult[]> {
      const out: SendResult[] = [];
      const multi = msgs.length > RESEND_BATCH_MAX;
      for (let i = 0; i < msgs.length; i += RESEND_BATCH_MAX) {
        const chunk = msgs.slice(i, i + RESEND_BATCH_MAX);
        const key = sendOpts.idempotencyKey && (multi ? `${sendOpts.idempotencyKey}:${i / RESEND_BATCH_MAX}` : sendOpts.idempotencyKey);
        const body = await post('/emails/batch', chunk.map(payload), key);
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
