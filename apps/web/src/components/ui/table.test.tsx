/**
 * Regression guard for #493 (axe `nested-interactive`): the mobile card of ResponsiveTable must not be a
 * role=button, because cells can contain their own controls. Row-open goes through a real <button> instead.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResponsiveTable, type Column } from './table';

type Row = { id: string; title: string };
const columns: Column<Row>[] = [
  { key: 'title', header: 'Title', primary: true, cell: (r) => <span>{r.title}</span> },
  { key: 'actions', header: 'Actions', cell: (r) => <button type="button" aria-label={`Actions for ${r.title}`}>…</button> },
];
const rows = [{ id: '1', title: 'Supply of laptops' }];
const mobileCards = (html: string) => html.slice(html.indexOf('<ul'));

describe('ResponsiveTable mobile cards', () => {
  it('with onRowClick: card is not role=button and the title is a real button (no nested interactive)', () => {
    const html = mobileCards(renderToStaticMarkup(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={() => {}} />));
    expect(html).not.toContain('role="button"');
    expect(html).not.toMatch(/data-row-card=""[^>]*tabindex/);
    expect(html).toMatch(/<button type="button" data-row-open=""[^>]*><span>Supply of laptops<\/span><\/button>/);
    // The row-actions button is a sibling of the open button, never inside it.
    expect(html).toMatch(/<\/button>.*aria-label="Actions for Supply of laptops"/);
  });

  it('without onRowClick: plain, non-interactive card', () => {
    const html = mobileCards(renderToStaticMarkup(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} />));
    expect(html).not.toContain('data-row-open');
    expect(html).toContain('<div class="font-medium"><span>Supply of laptops</span></div>');
  });
});
