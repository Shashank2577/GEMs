/** Fractional Kanban ordering: the position for a card dropped at `index` among `siblings` (excluding the card). */
export function positionAt(siblings: { position: number }[], index: number): number {
  const prev = siblings[index - 1]?.position;
  const next = siblings[index]?.position;
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next! - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

/** Closing filter used by the board & table. */
export type ClosingFilter = 'any' | '3' | '7' | '30' | 'closed';

export function matchesClosing(endAt: string | null, f: ClosingFilter, now = Date.now()): boolean {
  if (f === 'any') return true;
  if (!endAt) return false;
  const t = Date.parse(endAt);
  if (f === 'closed') return t < now;
  return t >= now && t <= now + Number(f) * 86_400_000;
}
