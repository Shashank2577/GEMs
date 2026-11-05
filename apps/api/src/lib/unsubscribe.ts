/**
 * One-click email unsubscribe (003/FR-048, RFC 8058). The token is `<b64url payload>.<b64url HMAC-SHA256>` over
 * `userId:orgId:email_matches`, keyed by `UNSUBSCRIBE_SECRET`. It does not expire (old emails must keep working) and
 * can only switch OFF email match alerts for that user in that org, so replaying it is harmless.
 */
import type { AppConfig, EmailMessage } from '../deps';
import { b64url, fromB64url, timingSafeEqual } from './crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();
export const UNSUBSCRIBE_SCOPE = 'email_matches';

async function mac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export async function signUnsubscribeToken(secret: string, userId: string, orgId: string): Promise<string> {
  const payload = `${userId}:${orgId}:${UNSUBSCRIBE_SCOPE}`;
  return `${b64url(enc.encode(payload))}.${b64url(await mac(secret, payload))}`;
}

/** The `(userId, orgId)` the token was issued for, or null when malformed, tampered or signed with another key. */
export async function verifyUnsubscribeToken(secret: string | null, token: string): Promise<{ userId: string; orgId: string } | null> {
  if (!secret) return null;
  const [p, s, ...rest] = token.split('.');
  if (!p || !s || rest.length) return null;
  try {
    const payload = dec.decode(fromB64url(p));
    const [userId, orgId, scope, extra] = payload.split(':');
    if (!userId || !orgId || scope !== UNSUBSCRIBE_SCOPE || extra !== undefined) return null;
    if (!timingSafeEqual(await mac(secret, payload), fromB64url(s))) return null;
    return { userId, orgId };
  } catch {
    return null;
  }
}

/** List-Unsubscribe + List-Unsubscribe-Post headers; none when no secret is configured. */
export async function unsubscribeHeaders(config: Pick<AppConfig, 'appUrl' | 'unsubscribeSecret'>, userId: string, orgId: string): Promise<EmailMessage['headers']> {
  if (!config.unsubscribeSecret) return undefined;
  const token = await signUnsubscribeToken(config.unsubscribeSecret, userId, orgId);
  return {
    'List-Unsubscribe': `<${config.appUrl}/api/notifications/unsubscribe?token=${token}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
