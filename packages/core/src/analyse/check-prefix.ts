/**
 * The "Check documents: a.pdf is for GEM/2026/B/1; b.pdf is for GEM/2026/B/2." prefix the API puts on an
 * analysis summary when documents carry another bid's number (FR-010). Shared by the API (which keeps it
 * when a factor override recomputes the summary) and the web app (which shows it). Non-greedy: it ends at
 * the first ". " after the last `is for GEM/…` entry, never at a later bid number in the summary body.
 */
const ENTRY = String.raw`.+? is for GEM/\d{4}/[A-Z]/\d+`;
export const CHECK_PREFIX_RE = new RegExp(String.raw`^Check documents: ${ENTRY}(?:; ${ENTRY})*\.(?= |$)`);

/** The check-documents prefix of `summary`, or null. */
export function matchCheckPrefix(summary: string | null | undefined): string | null {
  return summary?.match(CHECK_PREFIX_RE)?.[0] ?? null;
}
