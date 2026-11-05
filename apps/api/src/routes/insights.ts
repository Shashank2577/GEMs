/**
 * Competitor insights (003/US6: FR-064, NFR-004; Constitution IV).
 *
 *   GET /insights/competitors?category=&state=&page=&pageSize=  → CompetitorsResponse
 *
 * Built ONLY from the caller's org's tracked tenders (lib/tracked.ts: non-dismissed match, analysis or workspace)
 * that GeM has awarded with a published bidder table (`tender_results`, global public data). Another org's tracking
 * never adds a tender here, so an org cannot learn what others follow. Sellers are grouped case-insensitively and
 * ranked by wins, then awarded value, then bids. `category` matches the tender's category or a GeM category on its
 * result page; `state` the buyer state (both case-insensitive). Aggregation runs over at most MAX_TENDERS tenders
 * (most recently closed first).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { tenderResults, tenders } from '@tp/db';
import { competitorsQuerySchema, type CompetitorDto, type CompetitorsResponse } from '@tp/core/contracts/identify';
import { orgId, requireAuth } from '../middleware/auth';
import { visibleTenderSource } from '../lib/tender-scope';
import { trackedByOrg } from '../lib/tracked';
import { parseWith } from '../lib/validate';
import type { AppEnv } from '../types';
import { rawQuery } from './tenders';

export const insightsRoutes = new Hono<AppEnv>();

/** Awarded tracked tenders aggregated per request at most. */
export const MAX_TENDERS = 5000;
const MAX_CATEGORIES_PER_SELLER = 5;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

insightsRoutes.get('/insights/competitors', requireAuth, async (c) => {
  const deps = c.var.deps;
  const q = parseWith(competitorsQuerySchema, rawQuery(c), 'query');
  const org = orgId(c);

  const rows = await deps.db.select({
    endAt: tenders.endAt, state: tenders.state, category: tenders.category,
    bidders: tenderResults.bidders, categories: tenderResults.categories,
  })
    .from(tenders)
    .innerJoin(tenderResults, eq(tenderResults.tenderId, tenders.id))
    .where(and(
      visibleTenderSource(c.var.org),
      eq(tenderResults.evaluationStatus, 'awarded'),
      sql`jsonb_array_length(${tenderResults.bidders}) > 0`,
      trackedByOrg(org),
    ))
    .orderBy(desc(tenders.endAt), tenders.id)
    .limit(MAX_TENDERS);

  const tenderCategories = (r: (typeof rows)[number]) => {
    const all = [...(r.category ? [r.category] : []), ...(r.categories ?? [])].map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const seen = new Set<string>();
    return all.filter((x) => (seen.has(norm(x)) ? false : (seen.add(norm(x)), true)));
  };

  // Facets over every awarded tracked tender (ignoring the current filters), so the filter menus stay stable.
  const facetCats = new Map<string, string>();
  const facetStates = new Map<string, string>();
  for (const r of rows) {
    for (const cat of tenderCategories(r)) if (!facetCats.has(norm(cat))) facetCats.set(norm(cat), cat);
    if (r.state && !facetStates.has(norm(r.state))) facetStates.set(norm(r.state), r.state.trim());
  }
  const byName = (a: string, b: string) => a.localeCompare(b, 'en-IN');

  const wantCat = q.category ? norm(q.category) : null;
  const wantState = q.state ? norm(q.state) : null;
  const filtered = rows.filter((r) =>
    (!wantState || (r.state != null && norm(r.state) === wantState))
    && (!wantCat || tenderCategories(r).some((x) => norm(x) === wantCat)));

  interface Acc { seller: string; wins: number; awardedValue: number; bids: number; cats: Map<string, { label: string; n: number }>; anomalies: number; lastWinAt: Date | null }
  const sellers = new Map<string, Acc>();
  let flaggedAwards = 0;
  for (const r of filtered) {
    const bidders = r.bidders ?? [];
    const winner = bidders.find((b) => b.awarded) ?? bidders.find((b) => b.level.toUpperCase() === 'L1') ?? null;
    const lowest = Math.min(...bidders.map((b) => b.price));
    const flagged = !!winner && bidders.length > 1 && winner.price > lowest;
    if (flagged) flaggedAwards++;
    const cats = tenderCategories(r);
    const counted = new Set<string>(); // a seller listed twice on one page counts one bid
    for (const b of bidders) {
      const key = norm(b.seller);
      if (!key) continue;
      const acc = sellers.get(key) ?? { seller: b.seller.trim(), wins: 0, awardedValue: 0, bids: 0, cats: new Map(), anomalies: 0, lastWinAt: null };
      if (!counted.has(key)) {
        counted.add(key);
        acc.bids++;
        for (const cat of cats) {
          const e = acc.cats.get(norm(cat)) ?? { label: cat, n: 0 };
          e.n++;
          acc.cats.set(norm(cat), e);
        }
      }
      if (b === winner) {
        acc.wins++;
        acc.awardedValue += b.price;
        if (flagged) acc.anomalies++;
        if (r.endAt && (!acc.lastWinAt || r.endAt > acc.lastWinAt)) acc.lastWinAt = r.endAt;
      }
      sellers.set(key, acc);
    }
  }

  const all: CompetitorDto[] = [...sellers.values()]
    .sort((a, b) => b.wins - a.wins || b.awardedValue - a.awardedValue || b.bids - a.bids || byName(a.seller, b.seller))
    .map((a) => ({
      seller: a.seller,
      wins: a.wins,
      awardedValue: Math.round(a.awardedValue * 100) / 100,
      bids: a.bids,
      categories: [...a.cats.values()].sort((x, y) => y.n - x.n || byName(x.label, y.label)).slice(0, MAX_CATEGORIES_PER_SELLER).map((x) => x.label),
      anomalies: a.anomalies,
      lastWinAt: a.lastWinAt?.toISOString() ?? null,
    }));
  const offset = (q.page - 1) * q.pageSize;
  const body: CompetitorsResponse = {
    items: all.slice(offset, offset + q.pageSize),
    total: all.length,
    tenders: filtered.length,
    flaggedAwards,
    facets: { categories: [...facetCats.values()].sort(byName), states: [...facetStates.values()].sort(byName) },
  };
  return c.json(body);
});
