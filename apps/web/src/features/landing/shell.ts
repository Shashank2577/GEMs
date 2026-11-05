/**
 * index.html paints a static copy of the hero (`#lp-shell`, an overlay above #root) so the landing's LCP does not wait for the
 * JS bundle (007/NFR-003). React renders the real page underneath at identical geometry; once that has painted, the shell is
 * removed. Removing it after (not instead of) the real hero keeps the LCP candidate from being replaced by a later paint.
 */
export function dropLandingShell(): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('lp-shell')?.remove()));
}
