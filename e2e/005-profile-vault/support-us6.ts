/** Helpers for the 005/US6 renew-and-history E2E (kept out of fixtures.ts and the other support files on purpose). */
import { expect, type APIRequestContext } from '@playwright/test';
import { makePdf as makeVaultPdf } from './support';

export { sql, blobFiles, me, istDay, apiUpload, apiUploadOk, viewerPage, noHScroll, type VaultDoc } from './support';

/** A distinct PDF per label (different bytes => different SHA-256). */
export const pdf = (label: string) => makeVaultPdf(1, label);

/** Independent re-statement of the spec's suggestion: issue date + validity months − 1 day (ISO = 36 months). */
export function plusMonthsMinusDay(issueIso: string, months: number): string {
  const d = new Date(`${issueIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "04 Nov 2029" — the app's formatDateIST output. */
export function fmt(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00+05:30`));
}

export interface VersionDto { id: string; fileName: string; sizeBytes: number; replacedAt: string; replacedBy: { id: string; name: string } | null; expiryDate: string | null }

export async function listVersions(request: APIRequestContext, docId: string) {
  const res = await request.get(`/api/vault/${docId}/versions`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { items: VersionDto[] }).items;
}

/** PUT /api/vault/:id/file (renewal) without the UI. */
export async function apiRenew(request: APIRequestContext, id: string, o: { name: string; bytes: Buffer; fields?: Record<string, string> }) {
  return request.put(`/api/vault/${id}/file`, {
    multipart: { file: { name: o.name, mimeType: 'application/pdf', buffer: o.bytes }, ...(o.fields ?? {}) },
  });
}

export async function activity(request: APIRequestContext, entityId: string) {
  const res = await request.get(`/api/activity?entityType=vault_document&entityId=${entityId}&pageSize=50`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()).items as { action: string; meta: Record<string, unknown> | null }[]);
}

export interface SentForm { method: string; url: string; fields: Record<string, string>; files: string[] }
/** Record every FormData the SPA hands to fetch() (Playwright cannot read multipart bodies that carry file blobs). Call BEFORE page.goto. */
export async function captureForms(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __forms: SentForm[] };
    w.__forms = [];
    const orig = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body instanceof FormData) {
        const fields: Record<string, string> = {}; const files: string[] = [];
        for (const [k, v] of init.body.entries()) { if (typeof v === 'string') fields[k] = v; else files.push(v.name); }
        w.__forms.push({ method: String(init.method ?? 'GET'), url: String(input), fields, files });
      }
      return orig(input, init);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __forms: SentForm[] }).__forms);
}
