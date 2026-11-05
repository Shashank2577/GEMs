import { useEffect, useState } from 'react';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const useIsMobile = () => !useMediaQuery('(min-width: 768px)');

/** Re-render every `ms` (for countdowns / relative times). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Sets `document.title` to `<title> · TenderPilot`, or to `title` verbatim with `{ raw: true }` (007/FR-084). */
export function useDocumentTitle(title?: string, opts?: { raw?: boolean }) {
  const raw = opts?.raw ?? false;
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = raw ? title : `${title} · TenderPilot`;
    return () => { document.title = prev; };
  }, [title, raw]);
}

/**
 * Points `<link rel="canonical">` at `path` on the same origin as index.html's canonical (007/NFR-004), restoring it on
 * unmount. index.html's canonical is "/" (the landing page); /login and /signup are indexable pages of their own.
 */
export function useCanonical(path: string) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) return;
    const prev = link.href;
    link.href = new URL(path, prev).href;
    return () => { link.href = prev; };
  }, [path]);
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV] as const;
}
