/**
 * Vault & profile read performance (T042; NFR-003). One org with 500 vault documents on local Postgres:
 * the median of 5 timed requests (after one warm-up) must stay under the budget —
 * `GET /api/vault` and `GET /api/vault/summary` < 400 ms, `GET /api/profile` < 300 ms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyProfiles, pastContracts, vaultDocuments } from '@tp/db';
import { DOC_TYPES, type DocType } from '@tp/core/vault/status';
import { createTestContext, request, signup, type SignedUp, type TestContext } from './helpers';

const NOW = new Date('2026-11-04T04:30:00Z');
const DOCS = 500;
const RUNS = 5;

let ctx: TestContext;
let owner: SignedUp;

const iso = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  owner = await signup(ctx.app, { orgName: 'Perf Traders Pvt Ltd' });
  const orgId = owner.me.org.id;
  const userId = owner.me.user.id;
  const types = DOC_TYPES.map((d) => d.type) as DocType[];
  const rows = Array.from({ length: DOCS }, (_, i) => {
    const id = crypto.randomUUID();
    const type = types[i % types.length]!;
    // A spread of expired / expiring / valid / no-expiry documents.
    const expiry = i % 4 === 0 ? null : iso(new Date(NOW.getTime() + ((i % 400) - 60) * 86_400_000));
    const fileName = `${type}_${i}.pdf`;
    return {
      id, orgId, type, title: `${type.replace(/_/g, ' ')} document ${i}`, number: `NO-${100000 + i}`, issuer: i % 3 ? 'Issuing Authority' : null,
      issueDate: '2024-04-01', expiryDate: expiry, financialYear: i % 5 === 0 ? '2024-25' : null, tags: i % 2 ? ['gem', `batch-${i % 10}`] : [],
      blobKey: `org/${orgId}/vault/${id}/${fileName}`, fileName, mimeType: 'application/pdf', sizeBytes: 50_000 + i, pageCount: 1 + (i % 7), uploadedBy: userId,
    };
  });
  for (let i = 0; i < rows.length; i += 100) await ctx.db.insert(vaultDocuments).values(rows.slice(i, i + 100));
  await ctx.db.insert(companyProfiles).values({
    orgId, legalName: 'Perf Traders Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', state: 'Maharashtra',
    financials: [{ fy: '2025-26', turnover: 6_00_00_000 }, { fy: '2024-25', turnover: 4_50_00_000 }, { fy: '2023-24', turnover: 3_00_00_000 }],
    oemAuthorizations: [{ oem: 'Dell', products: 'Laptops', documentId: rows[1]!.id }],
  });
  await ctx.db.insert(pastContracts).values(Array.from({ length: 20 }, (_, i) => ({
    orgId, buyer: `Buyer ${i}`, buyerType: 'central' as const, title: `Contract ${i}`, value: 10_00_000 + i, startDate: '2024-04-01', endDate: '2024-09-30',
  })));
});
afterAll(() => ctx?.close());

async function medianMs(path: string): Promise<number> {
  const warm = await request(ctx.app, 'GET', path, { cookie: owner.cookie });
  expect(warm.status, path).toBe(200);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await request(ctx.app, 'GET', path, { cookie: owner.cookie });
    times.push(performance.now() - t0);
    expect(r.status, path).toBe(200);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)]!;
}

describe('vault performance with 500 documents (NFR-003)', () => {
  it('lists all 500 documents', async () => {
    const r = await request(ctx.app, 'GET', '/vault', { cookie: owner.cookie });
    expect(r.body.total).toBe(DOCS);
  });

  it('GET /vault median < 400 ms (including sorted and searched variants)', async () => {
    expect(await medianMs('/vault')).toBeLessThan(400);
    expect(await medianMs('/vault?sort=expiry')).toBeLessThan(400);
    expect(await medianMs('/vault?q=document&status=expiring')).toBeLessThan(400);
  });

  it('GET /vault/summary median < 400 ms', async () => {
    const r = await request(ctx.app, 'GET', '/vault/summary', { cookie: owner.cookie });
    expect(r.body.total).toBe(DOCS);
    expect(await medianMs('/vault/summary')).toBeLessThan(400);
  });

  it('GET /profile median < 300 ms', async () => {
    expect(await medianMs('/profile')).toBeLessThan(300);
  });
});
