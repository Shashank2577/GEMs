import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can as canRole } from '@/lib/auth';

let role: 'owner' | 'bid_manager' | 'analyst' | 'viewer' = 'owner';
vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, useAuth: () => ({ can: (min: Parameters<typeof canRole>[1]) => canRole(role, min) }) };
});

import { DemoBanner, DEMO_BANNER_TEXT, DEMO_REMOVE_CONFIRM } from './DemoBanner';

const render = () => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><DemoBanner /></QueryClientProvider>);

describe('DemoBanner (007/FR-066)', () => {
  beforeEach(() => { role = 'owner'; });

  it('uses the specified copy', () => {
    expect(DEMO_BANNER_TEXT).toBe('You’re exploring sample data for Aarav Technologies Pvt Ltd.');
    expect(DEMO_REMOVE_CONFIRM).toBe('Remove all demo data? Your own watchlists, documents and bids stay.');
  });

  it.each(['owner', 'bid_manager'] as const)('shows the text and "Remove demo data" to %s', (r) => {
    role = r;
    const html = render();
    expect(html).toContain('You’re exploring sample data for Aarav Technologies Pvt Ltd.');
    expect(html).toContain('Remove demo data');
  });

  it.each(['analyst', 'viewer'] as const)('hides the button from %s', (r) => {
    role = r;
    const html = render();
    expect(html).toContain('sample data');
    expect(html).not.toContain('Remove demo data');
  });
});
