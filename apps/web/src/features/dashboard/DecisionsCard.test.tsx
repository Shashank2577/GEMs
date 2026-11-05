import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionItem } from '@tp/core/contracts/experience';
import { TooltipProvider } from '@/components/ui';
import { can as canRole } from '@/lib/auth';
import { moveBody } from '../pipeline/api';

let role: 'owner' | 'bid_manager' | 'analyst' | 'viewer' = 'owner';
vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, useAuth: () => ({ can: (min: Parameters<typeof canRole>[1]) => canRole(role, min) }) };
});

import { CHOICES, DecisionsCard, DECISIONS_EMPTY } from './DecisionsCard';

const item: DecisionItem = { tenderId: 't1', workspaceId: 'w1', bidNumber: 'GEM/2026/B/200', title: 'Network switches', score: 78, verdict: 'go', endAt: '2099-01-10T10:00:00Z' };
const render = (items?: DecisionItem[]) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><TooltipProvider><MemoryRouter><DecisionsCard items={items} /></MemoryRouter></TooltipProvider></QueryClientProvider>);

describe('DecisionsCard (007/FR-072)', () => {
  beforeEach(() => { role = 'owner'; });

  it('moves to Go / Dropped through the pipeline stages', () => {
    expect(CHOICES.go.stage).toBe('go');
    expect(CHOICES.drop.stage).toBe('dropped');
  });

  it('Go is one tap: PATCH {stage:"go"} with no position', () => {
    expect(CHOICES.go.done).toBe('Moved to Go');
    expect(moveBody({ stage: CHOICES.go.stage })).toStrictEqual({ stage: 'go' });
    expect(moveBody({ stage: 'go', position: 0 })).toStrictEqual({ stage: 'go', position: 0 });
  });

  it('exposes the card as a labelled region', () => {
    const html = render([item]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="decisions-title"');
  });

  it.each(['owner', 'bid_manager'] as const)('%s sees Go and Drop on each row', (r) => {
    role = r;
    const html = render([item]);
    expect(html).toContain('Awaiting your decision');
    expect(html).toContain('Network switches');
    expect(html).toContain('aria-label="Go: Network switches"');
    expect(html).toContain('aria-label="Drop: Network switches"');
    expect(html).toContain('href="/workspaces/w1"');
  });

  it('analyst sees the list read-only (no Go / Drop)', () => {
    role = 'analyst';
    const html = render([item]);
    expect(html).toContain('Network switches');
    expect(html).not.toContain('Go: Network switches');
    expect(html).not.toContain('Drop: Network switches');
  });

  it('shows an empty state', () => {
    expect(render([])).toContain(DECISIONS_EMPTY);
  });
});
