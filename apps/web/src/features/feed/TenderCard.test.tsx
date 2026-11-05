import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { TenderListItem } from '@tp/core/contracts/identify';
import { TooltipProvider } from '@/components/ui';
import { TenderCard } from './TenderCard';

const base = {
  id: 't1', bidNumber: 'GEM/2026/B/1', title: 'Laptops', bidType: 'bid', matches: [], analysis: null, workspace: null,
  seen: true, isNew: false, dismissed: false, hasCorrigendum: true, endAt: null, emdAmount: 0, estimatedValue: null, quantity: 1,
} as unknown as TenderListItem;

const render = (t: TenderListItem) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><TooltipProvider><MemoryRouter><TenderCard t={t} /></MemoryRouter></TooltipProvider></QueryClientProvider>,
);

describe('TenderCard corrigendum badge (003/FR-050)', () => {
  it('lifts the badge above the stretched title link and makes it focusable', () => {
    const html = render(base);
    expect(html).toContain('data-testid="corrigendum-badge"');
    expect(html).toMatch(/data-testid="corrigendum-badge"[^>]*class="[^"]*z-10|class="[^"]*z-10[^"]*"[^>]*data-testid="corrigendum-badge"/);
  });
  it('omits the badge without a corrigendum', () => {
    expect(render({ ...base, hasCorrigendum: false })).not.toContain('corrigendum-badge');
  });
});
