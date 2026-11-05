/** Pure wizard helpers (T039): the step list, popular categories, keyword derivation and resume logic. */

// Popular GeM categories with the keywords that find them in bid titles.
export const POPULAR_CATEGORIES: { label: string; keywords: string[] }[] = [
  { label: 'Desktop computers', keywords: ['desktop'] },
  { label: 'Laptops & notebooks', keywords: ['laptop', 'notebook'] },
  { label: 'CCTV & surveillance', keywords: ['cctv', 'surveillance', 'network video recorder'] },
  { label: 'Networking (switches, Wi-Fi)', keywords: ['network switch', 'access point', 'router'] },
  { label: 'UPS & power', keywords: ['ups', 'inverter'] },
  { label: 'Printers & MFMs', keywords: ['printer', 'multifunction machine'] },
  { label: 'Servers & storage', keywords: ['server', 'storage'] },
  { label: 'Monitors & displays', keywords: ['monitor', 'interactive flat panel'] },
  { label: 'Furniture', keywords: ['chair', 'table', 'almirah'] },
  { label: 'Medical equipment', keywords: ['hospital bed', 'patient monitor', 'medical'] },
  { label: 'Stationery & paper', keywords: ['paper', 'stationery'] },
  { label: 'Manpower services', keywords: ['manpower', 'outsourcing'] },
  { label: 'Housekeeping & cleaning', keywords: ['housekeeping', 'cleaning'] },
  { label: 'Vehicle hiring', keywords: ['vehicle hiring', 'taxi'] },
  { label: 'Solar & electricals', keywords: ['solar', 'led light'] },
  { label: 'Security services', keywords: ['security manpower', 'security guard'] },
];

export function keywordsFor(categories: string[]): string[] {
  const out = new Set<string>();
  for (const c of categories) {
    const known = POPULAR_CATEGORIES.find((p) => p.label === c);
    (known ? known.keywords : [c.toLowerCase()]).forEach((k) => out.add(k));
  }
  return [...out].slice(0, 30);
}

export const STEPS = [
  { key: 'company', label: 'Company basics' },
  { key: 'categories', label: 'What you sell' },
  { key: 'watchlist', label: 'First watchlist' },
  { key: 'documents', label: 'Key documents' },
  { key: 'done', label: 'Done' },
] as const;

export type StepKey = (typeof STEPS)[number]['key'];

/** Index of the first unticked step (resume point); everything ticked → the Done step. */
export function initialStep(state: Record<string, boolean>): number {
  const i = STEPS.findIndex((s) => s.key !== 'done' && !state[s.key]);
  return i < 0 ? STEPS.length - 1 : i;
}

/** The WatchlistStep form is seeded once at mount, so it must not mount before the profile has hydrated (or failed to load). */
export function watchlistStepReady(o: { hydrated: boolean; profileFailed: boolean }): boolean {
  return o.hydrated || o.profileFailed;
}

/** Initial name/keywords for the first watchlist, derived from the profile's categories and operating states. */
export function watchlistSeed(categories: string[], states: string[]): { name: string; keywords: string[] } {
  const name = categories.length
    ? `${categories.slice(0, 2).join(' & ')}${states.length === 1 ? ` – ${states[0]}` : ''}`
    : 'My first watchlist';
  return { name: name.slice(0, 80), keywords: keywordsFor(categories) };
}
