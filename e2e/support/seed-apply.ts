/**
 * Shared seed for the spec-006 (Apply / packet assist) E2E suites.
 *
 * Mirrors apps/api/test/workspace-fixtures.ts::seedApply, but against the running E2E server:
 * accounts, profile and vault documents go through the public API; the tender and its "go" analysis are
 * inserted directly with @tp/db (there is no public API for them).
 *
 * Timeline (relative to "now"): tender endAt = now + 15 d, Dell MAF expiry = now - 35 d (expired).
 *
 * Usage:
 *   const fx = await seedApplyFixture(request);              // request = any APIRequestContext (becomes the owner session)
 *   const ctx = await browser.newContext({ storageState: fx.states.analyst });
 *   const analyst = await apiAs(fx, 'analyst');               // API client with that role's cookies
 */
import { expect, request as pwRequest, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { createRequire } from 'node:module';
import { analyses, createNodeDb, tenders, type ChecklistItem } from '../../packages/db/src/index';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('../../apps/api/node_modules/pdf-lib') as typeof import('../../apps/api/node_modules/pdf-lib');

const { eq } = createRequire(import.meta.url)('../../packages/db/node_modules/drizzle-orm') as typeof import('../../packages/db/node_modules/drizzle-orm');

export const E2E_PORT = Number(process.env.E2E_PORT || 8788);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DB_URL = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
export const PASSWORD = 'Qa!pass12345';
const DAY = 86_400_000;

export type Role = 'owner' | 'bid_manager' | 'analyst' | 'viewer';
export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

export interface SeedUser { id: string; name: string; email: string; password: string; role: Role }

export interface ApplyFixture {
  orgId: string;
  /** Users of the fixture organisation, by role. */
  users: Record<Role, SeedUser>;
  /** Playwright storage state (session cookie) per role; use with `browser.newContext({ storageState })`. */
  states: Record<Role, StorageState>;
  /** A user in a different organisation (to test "only members can be assigned"). */
  outsider: SeedUser;
  tender: { id: string; bidNumber: string; title: string; endAt: string; emdAmount: number };
  /** Tender with NO analysis (for not_analysed scenarios). */
  tenderNoAnalysis: { id: string; bidNumber: string; title: string };
  analysisId: string;
  /** Vault document ids by key. `oem` is the expired Dell MAF. */
  docs: Record<'gst' | 'pan' | 'bsOld' | 'bsNew' | 'oem', string>;
  /** Workspace id, filled in once a workspace has been created (see createWorkspace). */
  workspaceId?: string;
}

export const CHECKLIST: ChecklistItem[] = [
  { id: 'gst', label: 'GST registration certificate', docType: 'gst', mandatory: true, reason: 'Seller identity' },
  { id: 'pan', label: 'PAN card of the firm', docType: 'pan', mandatory: true, reason: 'Seller identity' },
  { id: 'balance_sheets', label: 'Audited balance sheets — last 3 financial years', docType: 'balance_sheet', mandatory: true, reason: 'Turnover' },
  { id: 'oem_authorization', label: 'OEM authorisation certificate (MAF) for this bid', docType: 'oem_authorization', mandatory: true, reason: 'OEM' },
  { id: 'udyam', label: 'Udyam registration certificate (MSE)', docType: 'udyam', mandatory: false, reason: 'MSE preference' },
  { id: 'non_blacklisting', label: 'Non-blacklisting / non-debarment undertaking', docType: null, mandatory: true, reason: 'ATC', generated: 'non_blacklisting' },
  { id: 'mii_self_cert', label: 'Make in India self-certificate (local content %)', docType: null, mandatory: true, reason: 'MII', generated: 'mii_self_cert' },
];

let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function pdfBytes(label: string, pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`${label} page ${i + 1}`, { x: 40, y: 700, size: 14, font: f });
  return Buffer.from(await d.save());
}

async function okJson<T = any>(res: Awaited<ReturnType<APIRequestContext['post']>>, what: string, status?: number): Promise<T> {
  const text = await res.text();
  if (status ? res.status() !== status : !res.ok()) throw new Error(`${what} failed: ${res.status()} ${text}`);
  return JSON.parse(text) as T;
}

export async function newApi(state?: StorageState): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: E2E_BASE_URL, storageState: state, timezoneId: 'Asia/Kolkata' } as never);
}

export async function upload(api: APIRequestContext, name: string, fields: Record<string, string>, pages = 1): Promise<string> {
  const res = await api.post('/api/vault', {
    multipart: { file: { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: await pdfBytes(name.toUpperCase(), pages) }, ...fields },
  });
  return (await okJson<{ id: string }>(res, `upload ${name}`, 201)).id;
}

/** Create the full Apply fixture. `request` becomes the owner's session (cookie jar). */
export async function seedApplyFixture(request: APIRequestContext): Promise<ApplyFixture> {
  const id = tag();
  const now = Date.now();

  // Organisation + owner (through the caller's request context)
  const ownerU = { name: `QA Owner ${id}`, email: `owner.${id}@example.in`, password: PASSWORD, orgName: `Sharma Infotech ${id}` };
  const me = await okJson<{ user: { id: string }; org: { id: string } }>(await request.post('/api/auth/signup', { data: ownerU }), 'signup', 201);
  const orgId = me.org.id;
  const users = { owner: { id: me.user.id, name: ownerU.name, email: ownerU.email, password: PASSWORD, role: 'owner' as Role } } as Record<Role, SeedUser>;
  const states = { owner: await request.storageState() } as Record<Role, StorageState>;

  // Other roles via invitation
  for (const role of ['bid_manager', 'analyst', 'viewer'] as const) {
    const email = `${role}.${id}@example.in`;
    const name = `QA ${role.replace('_', ' ')} ${id}`;
    const inv = await okJson<{ inviteUrl: string }>(await request.post('/api/org/invitations', { data: { email, role } }), `invite ${role}`, 201);
    const api = await newApi();
    const acc = await okJson<{ user: { id: string } }>(await api.post('/api/auth/accept-invite', { data: { token: inv.inviteUrl.split('/invite/')[1], name, password: PASSWORD } }), `accept ${role}`);
    users[role] = { id: acc.user.id, name, email, password: PASSWORD, role };
    states[role] = await api.storageState();
    await api.dispose();
  }

  // Outsider in a separate org
  const outU = { name: `QA Outsider ${id}`, email: `outsider.${id}@example.in`, password: PASSWORD, orgName: `Other Traders ${id}` };
  const outApi = await newApi();
  const out = await okJson<{ user: { id: string } }>(await outApi.post('/api/auth/signup', { data: outU }), 'signup outsider', 201);
  await outApi.dispose();
  const outsider: SeedUser = { id: out.user.id, name: outU.name, email: outU.email, password: PASSWORD, role: 'owner' };

  // Complete profile
  const ownerApi = await newApi(states.owner);
  const prof = await ownerApi.put('/api/profile', {
    data: {
      legalName: 'Sharma Infotech Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', address: '12 MIDC, Andheri East', state: 'Maharashtra', pincode: '400093',
      mseCategory: 'small', udyamNumber: 'UDYAM-MH-19-0012345', miiClass: 'class_1', localContentPct: 62,
      signatoryName: 'Ravi Sharma', signatoryDesignation: 'Director', contactName: 'Ravi Sharma', contactEmail: 'bids@sharma.in', contactPhone: '+919812345678',
      oemAuthorizations: [{ oem: 'Dell', products: 'Laptops' }],
    },
  });
  await okJson(prof, 'profile');

  // Tender + analysis straight into the DB (global tender rows are shared across orgs and runs)
  const { db, close } = await createNodeDb(E2E_DB_URL);
  let tender: ApplyFixture['tender'], tenderNoAnalysis: ApplyFixture['tenderNoAnalysis'], analysisId: string;
  try {
    const endAt = new Date(now + 15 * DAY);
    const mk = async (n: number, title: string, end: Date) => {
      const bidNumber = `GEM/2026/B/70000${n}`;
      const values = {
        bidNumber, title, category: 'Laptop - Notebook', quantity: 40,
        ministry: 'Ministry of Petroleum and Natural Gas', department: 'Department of Petroleum', organisation: 'Indian Oil Corporation Limited',
        buyerOffice: 'Panipat Refinery', state: 'Haryana', startAt: new Date(now - 4 * DAY), endAt: end,
        emdAmount: 150000, estimatedValue: 3_200_000, items: [{ name: 'Laptop i5 16GB', quantity: 40, unit: 'nos' }],
        sourceUrl: 'https://bidplus.gem.gov.in/all-bids', contentHash: `e2e-h${n}`,
      };
      const [row] = await db.insert(tenders).values(values).onConflictDoUpdate({ target: [tenders.source, tenders.bidNumber], set: { endAt: end, title, updatedAt: new Date() } }).returning();
      return row;
    };
    const t1 = await mk(1, 'Supply of Laptops batch 1', endAt);
    const t2 = await mk(2, 'Supply of Laptops batch 2', endAt);
    const [a] = await db.insert(analyses).values({
      orgId, tenderId: t1.id, status: 'done', method: 'rules', checklist: CHECKLIST, score: 78, confidence: 0.8, verdict: 'go',
      requirements: [{ key: 'delivery_days', label: 'Delivery days', numeric: 30, value: 30, mandatory: true, source: { page: 1 }, method: 'RULE', confidence: 0.9 }],
      factors: [],
    }).returning();
    analysisId = a.id;
    tender = { id: t1.id, bidNumber: t1.bidNumber, title: t1.title, endAt: t1.endAt!.toISOString(), emdAmount: 150000 };
    tenderNoAnalysis = { id: t2.id, bidNumber: t2.bidNumber, title: t2.title };
  } finally { await close(); }

  // Vault documents (uploaded by the analyst; the Dell MAF expired 35 days ago)
  const analystApi = await newApi(states.analyst);
  const docs = {
    gst: await upload(analystApi, 'gst', { type: 'gst', title: 'GST REG-06' }),
    pan: await upload(analystApi, 'pan', { type: 'pan', title: 'PAN card' }),
    bsOld: await upload(analystApi, 'bs-2023', { type: 'balance_sheet', title: 'Balance sheet 2023-24', financialYear: '2023-24' }, 2),
    bsNew: await upload(analystApi, 'bs-2024', { type: 'balance_sheet', title: 'Balance sheet 2024-25', financialYear: '2024-25' }, 3),
    oem: await upload(analystApi, 'maf', { type: 'oem_authorization', title: 'Dell MAF', issueDate: ymd(new Date(now - 400 * DAY)), expiryDate: ymd(new Date(now - 35 * DAY)) }),
  };
  await analystApi.dispose(); await ownerApi.dispose();

  return { orgId, users, states, outsider, tender, tenderNoAnalysis, analysisId, docs };
}

/** API client authenticated as `role` (dispose when done). */
export async function apiAs(fx: ApplyFixture, role: Role): Promise<APIRequestContext> {
  return newApi(fx.states[role]);
}

/** API client for the outsider's org is not needed; this signs in fresh (new context) with credentials. */
export async function createWorkspace(fx: ApplyFixture, tenderId = fx.tender.id, role: Role = 'analyst') {
  const api = await apiAs(fx, role);
  const res = await api.post(`/api/tenders/${tenderId}/workspace`);
  const body = await okJson<any>(res, 'create workspace');
  await api.dispose();
  // #527: a Go verdict starts a bid in "go" only when a Bid Manager+ creates it; an Analyst's waits in "analysing" for the
  // Bid Manager's call. These suites need the bid in Go, so the Bid Manager makes that call here.
  if (body.stage === 'analysing' && tenderId === fx.tender.id) {
    const bm = await apiAs(fx, 'bid_manager');
    const moved = await okJson<any>(await bm.patch(`/api/workspaces/${body.id}`, { data: { stage: 'go' } }), 'bid manager decides Go');
    await bm.dispose();
    body.stage = moved.stage;
  }
  if (tenderId === fx.tender.id) fx.workspaceId = body.id;
  return body as { id: string; created: boolean; stage: string };
}

/** Sign the test's own browser context in as `role` by installing that role's session cookie (keeps video/trace config). */
export async function signInAs(context: BrowserContext, fx: ApplyFixture, role: Role) {
  await context.clearCookies();
  await context.addCookies(fx.states[role].cookies);
}

export { expect };

/** Replace the checklist of the fixture's analysis (direct DB write; there is no public API for it). */
export async function setChecklist(fx: ApplyFixture, checklist: ChecklistItem[]) {
  const { db, close } = await createNodeDb(E2E_DB_URL);
  try { await db.update(analyses).set({ checklist }).where(eq(analyses.id, fx.analysisId)); } finally { await close(); }
}
