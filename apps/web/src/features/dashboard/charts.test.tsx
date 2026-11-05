/**
 * Regression guard for the "Go/No-Go donut ring does not render" bug: the ring must be present in the very first
 * render (no animation frame needed), sized by a viewBox, with every non-zero verdict drawn as a visible arc whose
 * colour comes from a design token applied via `style`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { VerdictDonut } from './charts';

const render = (verdicts: { go: number; review: number; no_go: number }) =>
  renderToStaticMarkup(<StaticRouter location="/dashboard"><VerdictDonut verdicts={verdicts} /></StaticRouter>);

describe('VerdictDonut', () => {
  it('renders one arc per non-zero verdict on first render', () => {
    const html = render({ go: 17, review: 0, no_go: 3 });
    expect(html).toContain('viewBox="0 0 120 120"');
    const arcs = [...html.matchAll(/<circle data-verdict="(\w+)"[^>]*stroke-dasharray="([\d.]+) [\d.]+"[^>]*style="stroke:([^"]+)"/g)];
    expect(arcs.map((m) => m[1])).toEqual(['go', 'no_go']);
    for (const [, , len] of arcs) expect(Number(len)).toBeGreaterThan(1);
    expect(arcs[0]![3]).toContain('hsl(var(--success))');
    expect(arcs[1]![3]).toContain('hsl(var(--danger))');
    expect(html).toContain('aria-label="Go 17, Review 0, No-Go 3"');
  });

  it('shows a visible track (not --muted) when nothing is analysed', () => {
    const html = render({ go: 0, review: 0, no_go: 0 });
    expect(html).not.toContain('data-verdict');
    expect(html).toMatch(/<circle[^>]*style="stroke:hsl\(var\(--muted-foreground\) \/ 0\.22\)"/);
    expect(html).toContain('>0</span>');
  });
});
