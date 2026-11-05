/** T016 — plain-English activity sentences (FR-006). */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeActivity, KNOWN_ACTIONS, SELF_CONTAINED } from './activity';

const fallback = (action: string) => action.replace(/[._]/g, ' ');

/** Every dotted action string literal written by the API and the demo seed. */
function actionsWrittenByServer(): Set<string> {
  const roots = ['../../../../api/src', '../../../../../packages/db/src'].map((p) => new URL(p, import.meta.url).pathname);
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:action:\s*|logActivity\([^)]*?|log\(c, \w+, |act\()(?:[^'`]*\?\s*)?'([a-z_]+\.[a-z_]+)'(?:\s*:\s*'([a-z_]+\.[a-z_]+)')?/g)) {
          out.add(m[1]!);
          if (m[2]) out.add(m[2]);
        }
      }
    }
  };
  roots.forEach(walk);
  return out;
}

describe('describeActivity', () => {
  it.each(KNOWN_ACTIONS.map((a) => [a]))('%s has a plain-English sentence', (action) => {
    const s = describeActivity({ action, meta: {} });
    expect(s).not.toBe(fallback(action));
    expect(s).toMatch(/^[a-z]/); // continues "<Actor> …"
    expect(s).not.toMatch(/[._]/);
  });

  it('covers every action the server writes', () => {
    const written = actionsWrittenByServer();
    expect(written.size).toBeGreaterThan(20);
    const missing = [...written].filter((a) => !(KNOWN_ACTIONS as readonly string[]).includes(a));
    expect(missing).toEqual([]);
  });

  it('renders stage moves with readable stage names', () => {
    expect(describeActivity({ action: 'workspace.stage_changed', meta: { from: 'identified', to: 'analysing' } }))
      .toBe('moved a bid from Identified to Analysing');
  });

  it('uses meta for scores, packet pages and outcomes', () => {
    expect(describeActivity({ action: 'tender.analysed', meta: { score: 78 } })).toBe('checked eligibility (score 78) for');
    expect(describeActivity({ action: 'tender.analysed', meta: {} })).toBe('checked eligibility for');
    expect(describeActivity({ action: 'packet.built', meta: { pages: 34 } })).toBe('built a 34-page bid packet for');
    expect(describeActivity({ action: 'workspace.packet_built', meta: {} })).toBe('built a bid packet for');
    expect(describeActivity({ action: 'workspace.outcome_recorded', meta: { result: 'won' } })).toBe('recorded a win on');
    expect(describeActivity({ action: 'workspace.outcome_recorded', meta: { result: 'lost' } })).toBe('recorded a loss on');
  });

  it('falls back to a spaced action name for unknown actions', () => {
    expect(describeActivity({ action: 'something.new_thing', meta: {} })).toBe('something new thing');
  });
});

describe('SELF_CONTAINED', () => {
  it('only lists known actions', () => {
    for (const a of SELF_CONTAINED) expect(KNOWN_ACTIONS).toContain(a);
  });

  it('marks sentences that read complete without a target', () => {
    expect([...SELF_CONTAINED].sort()).toEqual([
      'annexure.template_reset', 'annexure.template_updated', 'api_token.created', 'api_token.revoked', 'demo.seeded',
      'ingestion.run', 'member.joined', 'org.created', 'org.scoring_weights_updated', 'org.updated',
    ]);
  });

  it('sentences that need a target end with a preposition or verb (never self-contained)', () => {
    for (const a of ['workspace.created', 'tender.analysed', 'vault.uploaded', 'watchlist.created', 'member.invited', 'profile.updated']) {
      expect(SELF_CONTAINED.has(a)).toBe(false);
    }
  });
});
