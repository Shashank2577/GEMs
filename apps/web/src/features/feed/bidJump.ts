/** Bid-number jump (FR-037): Enter on an exact GeM bid number opens that tender when exactly one exists. */

export const BID_NUMBER_RE = /^GEM\/\d{4}\/[A-Z]\/\d+$/;

/** The normalised bid number if `q` is one (surrounding spaces and letter case are forgiven), else null. */
export function asBidNumber(q: string): string | null {
  const n = q.trim().toUpperCase();
  return BID_NUMBER_RE.test(n) ? n : null;
}

/**
 * Where to navigate for the search results of a bid number: `/tenders/<id>` only when exactly one result has
 * that bid number (the search is a "contains" match, so `GEM/2026/B/64210` can also return longer numbers).
 */
export function bidJumpTarget(q: string, results: { id: string; bidNumber: string }[] | undefined | null): string | null {
  const bid = asBidNumber(q);
  if (!bid || !results) return null;
  const exact = results.filter((t) => t.bidNumber.toUpperCase() === bid);
  return exact.length === 1 ? `/tenders/${exact[0].id}` : null;
}
