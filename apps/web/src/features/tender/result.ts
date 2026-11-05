/** Pure helpers for the tender Result tab (003/US6, FR-062) — kept out of the component so they are unit-testable. */
import type { EvaluationStatus, TenderResultDto } from '@tp/core/contracts/identify';
import type { BadgeTone } from '@/components/ui';
import { formatDateIST, formatINR } from '@/lib/format';

export const NOT_PUBLISHED_COPY = 'GeM hasn’t published the result yet. We check daily for 30 days after closing.';

export const EVALUATION_TONE: Record<EvaluationStatus, BadgeTone> = {
  not_evaluated: 'neutral',
  technical_evaluated: 'info',
  financial_evaluated: 'warning',
  awarded: 'success',
};

/** A result is "published" once GeM's bidder table has rows. */
export const isPublished = (r: Pick<TenderResultDto, 'bidders'>) => r.bidders.length > 0;

/** Second line under the "not published" message: when the daily checks stop (closing + 30 days). */
export function checkWindowCopy(checkUntil: string | null, now = new Date()): string | null {
  if (!checkUntil) return null;
  const end = new Date(checkUntil);
  if (Number.isNaN(end.getTime())) return null;
  return end.getTime() < now.getTime()
    ? `The 30-day checking window ended on ${formatDateIST(end)}.`
    : `Checking daily until ${formatDateIST(end)}.`;
}

/** Notice shown when the latest check failed; says how fresh the data on screen is. */
export function lastCheckFailedCopy(r: Pick<TenderResultDto, 'lastCheckFailed' | 'fetchedAt'>): string | null {
  if (!r.lastCheckFailed) return null;
  return r.fetchedAt
    ? `We couldn’t reach GeM on the last check. Showing the result from ${formatDateIST(r.fetchedAt, { time: true })}; we’ll try again tomorrow.`
    : 'We couldn’t reach GeM on the last check. We’ll try again tomorrow.';
}

/** How much more the winner quoted than the lowest bidder (rupees), or null when there is no gap. */
export function winnerPremium(r: Pick<TenderResultDto, 'winner' | 'lowestPrice'>): number | null {
  if (!r.winner || r.lowestPrice == null) return null;
  const gap = r.winner.price - r.lowestPrice;
  return gap > 0 ? gap : null;
}

/** Plain-language anomaly note, with the rupee gap when known. */
export function anomalyNote(r: Pick<TenderResultDto, 'anomalies' | 'winner' | 'lowestPrice'>): string | null {
  if (!r.anomalies.length) return null;
  const gap = winnerPremium(r);
  const base = r.anomalies.map((a) => a.message).join('. ');
  return gap ? `${base}: ${r.winner!.seller} quoted ${formatINR(gap)} above the lowest price (${formatINR(r.lowestPrice)}).` : `${base}.`;
}
