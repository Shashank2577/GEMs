/** WhatsApp via the Meta WhatsApp Cloud API; logs and skips when not configured. */
import type { Logger, SendResult, WhatsApp, WhatsAppMessage } from '../deps';

export function createMetaWhatsApp(opts: { token: string; phoneNumberId: string; apiVersion?: string; fetch?: typeof fetch }): WhatsApp {
  const f = opts.fetch ?? fetch;
  const url = `https://graph.facebook.com/${opts.apiVersion || 'v21.0'}/${opts.phoneNumberId}/messages`;
  return {
    configured: true,
    async send(msg: WhatsAppMessage): Promise<SendResult> {
      const to = msg.to.replace(/^\+/, '');
      const payload = msg.template
        ? {
            messaging_product: 'whatsapp', to, type: 'template',
            template: {
              name: msg.template.name,
              language: { code: msg.template.language || 'en' },
              ...(msg.template.params?.length
                ? { components: [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text })) }] }
                : {}),
            },
          }
        : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text ?? '', preview_url: true } };
      const res = await f(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${body.slice(0, 500)}`);
      try { return { id: (JSON.parse(body) as { messages?: { id: string }[] }).messages?.[0]?.id }; } catch { return {}; }
    },
  };
}

export function createLogWhatsApp(logger: Logger): WhatsApp & { sent: WhatsAppMessage[] } {
  const sent: WhatsAppMessage[] = [];
  return {
    configured: false,
    sent,
    async send(msg) {
      sent.push(msg);
      if (sent.length > 200) sent.shift();
      logger.info('whatsapp skipped (no WHATSAPP_TOKEN)', { to: msg.to });
      return { skipped: true };
    },
  };
}
