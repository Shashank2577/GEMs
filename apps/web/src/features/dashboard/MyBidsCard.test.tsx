import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { MyWorkItem } from '@tp/core/contracts/experience';
import { isOverdue, MyBidsCard, MY_BIDS_EMPTY } from './MyBidsCard';

const item = (over: Partial<MyWorkItem> = {}): MyWorkItem => ({
  workspaceId: 'w1', tenderId: 't1', bidNumber: 'GEM/2026/B/100', title: 'Supply of laptops', stage: 'preparing',
  dueAt: '2099-01-10T10:00:00Z', endAt: '2099-01-12T10:00:00Z', readiness: { percent: 60, blockers: 2, analysed: true }, ...over,
});
const render = (items?: MyWorkItem[]) => renderToStaticMarkup(<MemoryRouter><MyBidsCard items={items} /></MemoryRouter>);

describe('MyBidsCard (007/FR-071)', () => {
  it('shows the specified empty text', () => {
    expect(MY_BIDS_EMPTY).toBe('Nothing assigned to you — bids you own or are assigned to will appear here.');
    const html = render([]);
    expect(html).toContain('My bids');
    expect(html).toContain('Nothing assigned to you — bids you own or are assigned to will appear here.');
  });

  it('renders stage badge, due date, readiness and links to the workspace', () => {
    const html = render([item()]);
    expect(html).toContain('Supply of laptops');
    expect(html).toContain('Preparing');
    expect(html).toContain('Due 10 Jan 2099');
    expect(html).toContain('60% · 2 blockers');
    expect(html).toContain('href="/workspaces/w1"');
    expect(html).not.toContain('data-overdue');
  });

  it('marks an overdue due date red and says "Not analysed" with an empty bar', () => {
    const html = render([item({ dueAt: '2020-01-01T00:00:00Z', readiness: { percent: 0, blockers: 0, analysed: false } })]);
    expect(html).toContain('data-overdue="true"');
    expect(html).toContain('text-danger');
    expect(html).toContain('Not analysed');
  });

  it('isOverdue is strictly past-due and false without a due date', () => {
    const now = new Date('2026-11-04T04:30:00Z');
    expect(isOverdue('2026-11-04T04:29:59Z', now)).toBe(true);
    expect(isOverdue('2026-11-04T04:30:01Z', now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });
});
