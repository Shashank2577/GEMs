/** Shared helpers for the 005 profile & vault E2E specs (QA). Read-only use of app APIs; DB access is for assertions/clock shifting only. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uniqueUser } from '../support/fixtures';

// pdf-lib is a dependency of apps/api (not of the repo root); resolve it from there rather than adding a dependency.
const { PDFDocument, StandardFonts } = createRequire(join(process.cwd(), 'apps/api/package.json'))('pdf-lib') as typeof import('pdf-lib');

export const E2E_PORT = Number(process.env.E2E_PORT || 8788);
export const BASE_URL = `http://localhost:${E2E_PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL || `postgres://tp:tp@localhost:5433/${process.env.E2E_DB_NAME || 'tenderpilot_e2e'}`;

/** IST calendar date `offset` days from today (YYYY-MM-DD). */
export function istDate(offset = 0): string {
  const ms = Date.now() + 5.5 * 3600_000 + offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Same format the app uses (formatDateIST): e.g. "07 Nov 2026". */
export function fmtIST(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00+05:30`));
}

export async function makePdf(label: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.drawText(label, { x: 30, y: 150, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
}

export interface DocFields { type?: string; title: string; expiryDate?: string | null; issueDate?: string; number?: string; issuer?: string }
export interface VaultDoc { id: string; title: string; type: string; status: string; daysToExpiry: number | null; expiryDate: string | null; nextReminder: { days: number; date: string } | null }

export async function uploadDoc(request: APIRequestContext, f: DocFields): Promise<VaultDoc> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    file: { name: `${f.title.replace(/\W+/g, '-')}.pdf`, mimeType: 'application/pdf', buffer: await makePdf(f.title) },
    type: f.type ?? 'iso', title: f.title,
  };
  if (f.expiryDate) multipart.expiryDate = f.expiryDate;
  if (f.issueDate) multipart.issueDate = f.issueDate;
  if (f.number) multipart.number = f.number;
  if (f.issuer) multipart.issuer = f.issuer;
  const res = await request.post('/api/vault', { multipart });
  if (res.status() !== 201) throw new Error(`upload failed ${res.status()}: ${await res.text()}`);
  return res.json();
}

export interface Member { email: string; name: string; password: string; request: APIRequestContext; role: string }

/** Invite via POST /api/org/invitations (as `inviter`) and accept via POST /api/auth/accept-invite in a fresh API context. */
export async function addMember(inviter: APIRequestContext, role: 'bid_manager' | 'analyst' | 'viewer', label: string): Promise<Member> {
  const u = uniqueUser(label);
  const inv = await inviter.post('/api/org/invitations', { data: { email: u.email, role } });
  if (inv.status() !== 201) throw new Error(`invite failed ${inv.status()}: ${await inv.text()}`);
  const { inviteUrl } = await inv.json();
  const token = String(inviteUrl).split('/invite/')[1];
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
  const acc = await ctx.post('/api/auth/accept-invite', { data: { token, name: u.name, password: u.password } });
  if (!acc.ok()) throw new Error(`accept-invite failed ${acc.status()}: ${await acc.text()}`);
  return { email: u.email, name: u.name, password: u.password, request: ctx, role };
}

export async function setPrefs(request: APIRequestContext, p: Partial<{ inApp: boolean; email: boolean; expiryReminders: boolean }>) {
  const res = await request.put('/api/me/notification-prefs', { data: { inApp: true, email: true, whatsapp: false, frequency: 'instant', expiryReminders: true, ...p } });
  if (!res.ok()) throw new Error(`prefs failed ${res.status()}: ${await res.text()}`);
}

/** A browser page signed in as `request`'s user (cookies copied from the API context). */
export async function pageFor(browser: Browser, request: APIRequestContext, opts: { mobile?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
  const state = await request.storageState();
  const context = await browser.newContext({
    baseURL: BASE_URL, storageState: state, timezoneId: 'Asia/Kolkata', locale: 'en-IN',
    viewport: opts.mobile ? { width: 412, height: 915 } : { width: 1440, height: 900 },
  });
  return { page: await context.newPage(), context };
}

export interface Notif { id: string; kind: string; title: string; body: string; link: string | null; read: boolean }
export async function inAppNotifs(request: APIRequestContext): Promise<Notif[]> {
  const res = await request.get('/api/notifications?pageSize=100');
  return (await res.json()).items as Notif[];
}

export async function runReminders(request: APIRequestContext) {
  const res = await request.post('/api/vault/reminders/run');
  return { status: res.status(), body: await res.json().catch(() => null) as { documents: number; notifications: number } | null };
}

/** Run SQL against the e2e database (assertions and simulated clock shifts only). */
export function sql(query: string): string[][] {
  const out = execFileSync('psql', [DB_URL, '-At', '-F', '\t', '-c', query], { encoding: 'utf8' }).trim();
  return out ? out.split('\n').map((l) => l.split('\t')) : [];
}
const q = (s: string) => s.replace(/'/g, "''");

export function lastReminderDays(docId: string): number | null {
  const r = sql(`select last_reminder_days from vault_documents where id='${q(docId)}'`)[0]?.[0];
  return r === '' || r === undefined ? null : Number(r);
}
export function setLastReminderDays(docId: string, v: number | null) {
  sql(`update vault_documents set last_reminder_days=${v === null ? 'null' : v} where id='${q(docId)}'`);
}
/** Simulate the passage of time: shift a document's expiry by `days` (negative = closer), keeping its reminder state. */
export function shiftExpiry(docId: string, days: number) {
  sql(`update vault_documents set expiry_date = expiry_date + (${days}) where id='${q(docId)}'`);
}
export interface DbNotif { email: string; channel: string; status: string; title: string; body: string; link: string; dedupeKey: string }
export function notificationsForDoc(docId: string): DbNotif[] {
  return sql(`select u.email, n.channel, n.status, n.title, n.body, n.link, n.dedupe_key from notifications n join users u on u.id=n.user_id where n.dedupe_key like 'expiry:${q(docId)}:%' order by u.email, n.channel`)
    .map(([email, channel, status, title, body, link, dedupeKey]) => ({ email, channel, status, title, body, link, dedupeKey }));
}
