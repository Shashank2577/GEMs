// Spec 003 T070 (FR-060): mock-gem serves submitted-bid listings (bidrastatus + byStatus), the recorded result views
// and POST /__admin/award/<bidNumber>, exercised through the real GemClient + parseBidResultHtml.
import { beforeEach, describe, expect, it } from 'vitest';
import { GemClient } from '@tp/core/gem/client';
import { parseGemDate } from '@tp/core/gem/normalize';
import { parseBidResultHtml } from '@tp/core/gem/result';
import { createMockGem } from '../../../tools/mock-gem/src/app';

const GEM = 'http://mock-gem.test';
const mock = createMockGem({ token: 'd'.repeat(32) });
const client = () => new GemClient(async (input, init) => mock.app.fetch(new Request(input as string, init)), { baseUrl: GEM, minIntervalMs: 0, backoffMs: 0, maxRetries: 0 });
const admin = (path: string, body: unknown = {}) => mock.app.request(`${GEM}${path}`, { method: 'POST', body: JSON.stringify(body) });
const bid = () => mock.state.docs[0]!;
const bidNumber = () => String(bid().b_bid_number[0]);

beforeEach(async () => { await admin('/__admin/reset'); });

describe('mock-gem award + bidrastatus', () => {
  it('awarding a bid makes it appear under byStatus bid_awarded only', async () => {
    const gem = client();
    const before = await gem.fetchSubmittedPage({ byStatus: 'bid_awarded' }).catch(() => ({ numFound: 0, docs: [] }));
    expect(before.numFound).toBe(0);
    const res = await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`);
    expect(await res.json()).toMatchObject({ ok: true, bidNumber: bidNumber(), status: 'awarded', buyerStatus: 3 });
    const awarded = await gem.fetchSubmittedPage({ byStatus: 'bid_awarded', search: bidNumber() });
    expect(awarded.docs.map((d) => (d.b_bid_number as string[])[0])).toEqual([bidNumber()]);
    expect(awarded.docs[0]!.b_buyer_status).toEqual([3]);
    await expect(gem.fetchSubmittedPage({ byStatus: 'tech_evaluated', search: bidNumber() })).resolves.toMatchObject({ numFound: 0 });
  });

  it('tech_evaluated status lists under tech_evaluated and its result view says not yet published', async () => {
    const gem = client();
    await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`, { status: 'tech_evaluated' });
    const p = await gem.fetchSubmittedPage({ byStatus: 'tech_evaluated', search: bidNumber() });
    expect(p.numFound).toBe(1);
    const r = await gem.fetchBidResult(String(bid().b_id[0]));
    expect(parseBidResultHtml(r!.html)).toEqual({ ok: false, reason: 'not_published' });
  });

  it('serves the recorded awarded result (4 bidders, L1 marked) for an awarded bid, bound to its id and bid number', async () => {
    await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`);
    const r = await client().fetchBidResult(String(bid().b_id[0]));
    expect(r!.html).toContain(`var bid_id = "${bid().b_id[0]}"`);
    expect(r!.html).toContain(bidNumber());
    const parsed = parseBidResultHtml(r!.html);
    expect(parsed.ok && parsed.bidders.map((b) => b.level)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(parsed.ok && parsed.winner?.level).toBe('L1');
  });

  it('closes an open bid when awarded, rejects unknown bids and bad status, and reset undoes it', async () => {
    expect((await admin('/__admin/award/GEM%2F2026%2FB%2F0')).status).toBe(404);
    expect((await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`, { status: 'bogus' })).status).toBe(400);
    await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`);
    expect(parseGemDate(bid().final_end_date_sort)!.getTime()).toBeLessThan(Date.now());
    await admin('/__admin/reset');
    expect(bid().b_buyer_status ?? [0]).toEqual([0]);
    expect((await client().fetchSubmittedPage({ byStatus: 'bid_awarded' }).catch(() => ({ numFound: 0 }))).numFound).toBe(0);
  });

  it('un-awarded bids keep the generic result page (spec 007 behaviour) and bidrastatus without byStatus lists only closed bids', async () => {
    const r = await client().fetchBidResult('8100037');
    const parsed = parseBidResultHtml(r!.html);
    expect(parsed.ok && parsed.bidders).toHaveLength(3);
    expect((await client().fetchSubmittedPage()).numFound).toBe(0); // the fixtures hold no closed bids
    await admin(`/__admin/award/${encodeURIComponent(bidNumber())}`, { status: 'fin_evaluated' });
    const all = await client().fetchSubmittedPage();
    expect(all.numFound).toBe(1);
    expect(all.docs[0]!.b_buyer_status).toEqual([2]);
  });
});
