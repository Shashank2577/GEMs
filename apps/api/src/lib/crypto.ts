/**
 * Password hashing (PBKDF2-SHA256 via WebCrypto — identical on Workers and Node) and opaque tokens.
 * Format: `pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url>`.
 * 100k iterations is the Cloudflare Workers PBKDF2 maximum.
 */
const enc = new TextEncoder();
export const PBKDF2_ITERATIONS = 100_000;

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token with ~256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, saltS, hashS] = stored.split('$');
  if (alg !== 'pbkdf2_sha256' || !iter || !saltS || !hashS) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = await derive(password, fromB64url(saltS), iterations);
  return timingSafeEqual(actual, fromB64url(hashS));
}

/** A hash to verify against when the user does not exist (keeps login timing uniform). */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomToken(12)));
}
