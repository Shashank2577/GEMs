import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildStoryIndex, checkTrailers, checkVerdict, verdictOf, evaluate, formatOutcome, issueRefs, parseGitLog, parseLabels, resolveStory,
  type Commit, type DodInput, type PrInfo,
} from './dod-check';

const TRAILERS = 'Work-Item: Shashank2577/GEMs#356\nRequirement: 008/FR-001\nAgent-Role: developer\nHarness: claude-code';
const goodCommit: Commit = { sha: 'a'.repeat(40), message: `Add CI\n\n${TRAILERS}` };
const index = buildStoryIndex([
  { path: 'specs/008-operations-scale/spec.md', content: '### User Story 1 - Every change is proven by CI (Priority: P1) (#356)\n\n### User Story 2 - Releases (Priority: P1) (#357)' },
  { path: 'specs/008-operations-scale/tasks.md', content: '- [ ] T016 [US1] Create ci.yml FR-001 (#374)\n- [x] T030 [P] [US2] deploy.yml (#390)' },
]);
const APPROVED = `## QA verdict — APPROVED

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | ci starts four jobs | met | [green run](https://github.com/x/blob/b/qa/evidence/008/US1/green-run.png) |
| 2 | artifact uploaded | met | [video](qa/evidence/008/US1/us1-desktop.webm) |

Verdict: approved
`;
const MEDIA = ['qa/evidence/008/US1/green-run.png', 'qa/evidence/008/US1/us1-desktop.webm', 'qa/evidence/008/US1/VERDICT.md'];

function input(over: Partial<DodInput> & { pr?: Partial<PrInfo> } = {}): DodInput {
  return {
    index,
    commits: [goodCommit],
    readVerdict: () => APPROVED,
    listEvidence: () => MEDIA,
    ...over,
    pr: { title: '[008/US1] Every change is proven by CI', body: 'Closes #356', labels: ['type:story'], ...over.pr },
  };
}
const failed = (o: ReturnType<typeof evaluate>) => o.results.filter((r) => !r.ok).map((r) => r.message.split('\n')[0]);

describe('story resolution', () => {
  it('indexes story headings and task lines', () => {
    expect(index.get(356)).toEqual({ spec: '008', story: 'US1' });
    expect(index.get(357)).toEqual({ spec: '008', story: 'US2' });
    expect(index.get(374)).toEqual({ spec: '008', story: 'US1' });
    expect(index.get(390)).toEqual({ spec: '008', story: 'US2' });
  });

  it('reads Work-Item trailers and closing keywords', () => {
    expect(issueRefs('Work-Item: Shashank2577/GEMs#356\nCloses #374, fixes Shashank2577/GEMs#375')).toEqual([356, 374, 375]);
  });

  it('prefers the [NNN/USn] PR title', () => {
    expect(resolveStory({ title: '[003/US2] Identify', body: 'Closes #356', labels: [] }, [], index)).toMatchObject({ spec: '003', story: 'US2' });
  });

  it('maps Closes #<story> / Work-Item trailers through the spec index', () => {
    expect(resolveStory({ title: 'CI gate', body: 'Closes #357', labels: [] }, [], index)).toMatchObject({ spec: '008', story: 'US2' });
    expect(resolveStory({ title: 'CI gate', body: '', labels: [] }, [goodCommit], index)).toMatchObject({ spec: '008', story: 'US1' });
  });

  it('falls back to spec:<nnn> label + USn mention', () => {
    expect(resolveStory({ title: 'US4 rate limits', body: '', labels: ['spec:008'] }, [], index)).toMatchObject({ spec: '008', story: 'US4' });
  });

  it('returns null for hardening PRs', () => {
    expect(resolveStory({ title: 'Bump deps', body: 'Hardening', labels: [] }, [{ sha: 'b'.repeat(40), message: 'x\n\nWork-Item: o/r#999' }], index)).toBeNull();
  });
});

describe('dod rules (scenario 6)', () => {
  it('passes a complete story PR', () => {
    const o = evaluate(input());
    expect(failed(o)).toEqual([]);
    expect(o.ok).toBe(true);
    expect(formatOutcome(o)).toContain('Definition of Done: OK');
  });

  it('fails with "Missing QA verdict: qa/evidence/<nnn>/US<n>/VERDICT.md" when absent', () => {
    const o = evaluate(input({ readVerdict: () => null }));
    expect(o.ok).toBe(false);
    expect(failed(o)).toEqual(['Missing QA verdict: qa/evidence/008/US1/VERDICT.md']);
  });

  it('fails with "QA verdict is not approved" without "Verdict: approved"', () => {
    const o = evaluate(input({ readVerdict: () => APPROVED.replace('Verdict: approved', 'Verdict: rejected') }));
    expect(failed(o)).toEqual(['QA verdict is not approved']);
  });

  it('accepts every approval form of the QA template; rejection wins', () => {
    expect(verdictOf('**Verdict:** approved')).toBe('approved');
    expect(verdictOf('Verdict: approved')).toBe('approved');
    expect(verdictOf('## QA verdict — APPROVED\n')).toBe('approved');
    expect(verdictOf('### QA verdict - approved')).toBe('approved');
    expect(verdictOf('`qa:approved` — every criterion met')).toBe('approved');
    expect(verdictOf('## QA verdict — REJECTED\nVerdict: approved')).toBe('rejected');
    expect(verdictOf('## QA verdict — APPROVED\n`qa:rejected`')).toBe('rejected');
    expect(verdictOf('**Verdict:** approved | rejected')).toBe('rejected');
    expect(verdictOf('## QA verdict — <APPROVED | REJECTED>')).toBe('rejected');
    expect(verdictOf('<!-- qa:rejected in a comment -->\nVerdict: approved')).toBe('approved');
    expect(verdictOf('nothing here')).toBe('missing');
  });

  it('fails when any criterion row is "not met"', () => {
    const o = evaluate(input({ readVerdict: () => APPROVED.replace('| artifact uploaded | met |', '| artifact uploaded | **not met** |') }));
    expect(o.ok).toBe(false);
    expect(o.results.find((r) => r.rule === 'criteria-met')).toMatchObject({ ok: false });
  });

  it.each(['not met', '**not met**', 'not met ❌', 'unverifiable', '**unverifiable**', '', 'partially met'])(
    'fails criteria-met for a "%s" criterion cell',
    (v) => {
      const r = checkVerdict(`| # | Criterion | Verdict | Evidence |\n|---|---|---|---|\n| 1 | a | met | x |\n| 2 | b | ${v} | y |`)[1];
      expect(r).toMatchObject({ rule: 'criteria-met', ok: false });
    },
  );

  it('accepts "met" with markup or a check mark, reading only the Verdict column', () => {
    const t = '| # | Criterion | **Verdict** | Evidence |\n|:-:|---|---|---|\n| 1 | not met before the fix | **met** | x |\n| 2 | b | met ✅ | y |';
    expect(checkVerdict(t)[1]).toMatchObject({ ok: true, message: 'all 2 acceptance criteria met' });
  });

  it('fails criteria-met without a criteria table', () => {
    expect(checkVerdict('Verdict: approved')[1].ok).toBe(false);
  });

  it('requires at least one .png and one .webm in the folder, linked from the verdict', () => {
    expect(failed(evaluate(input({ listEvidence: () => [MEDIA[0], MEDIA[2]] })))).toEqual([
      'QA evidence incomplete: no video (.webm) in qa/evidence/008/US1',
    ]);
    expect(failed(evaluate(input({ listEvidence: () => [MEDIA[1]] })))).toEqual([
      'QA evidence incomplete: no screenshot (.png) in qa/evidence/008/US1',
    ]);
    expect(failed(evaluate(input({ listEvidence: () => ['qa/evidence/008/US1/other.png', MEDIA[1]] })))).toEqual([
      'QA evidence incomplete: VERDICT.md links none of the screenshots',
    ]);
  });

  it('requires Work-Item/Requirement/Agent-Role/Harness on every commit', () => {
    const bad: Commit = { sha: 'c'.repeat(40), message: 'Fix thing\n\nWork-Item: Shashank2577/GEMs#356\nAgent-Role: qa' };
    const r = checkTrailers([goodCommit, bad]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ccccccc "Fix thing" missing Requirement, Harness');
    expect(checkTrailers([]).ok).toBe(false);
  });

  it('reports each failing rule by name', () => {
    const o = evaluate(input({ readVerdict: () => 'Verdict: rejected\n| 1 | x | not met | y |', listEvidence: () => [], commits: [{ sha: 'd'.repeat(40), message: 'wip' }] }));
    expect(o.results.filter((r) => !r.ok).map((r) => r.rule)).toEqual(['verdict-approved', 'criteria-met', 'evidence-media', 'commit-trailers']);
  });

  it('passes hardening PRs with a note', () => {
    const o = evaluate(input({ pr: { title: 'Harden headers', body: '', labels: [] }, commits: [{ sha: 'e'.repeat(40), message: 'x' }] }));
    expect(o.ok).toBe(true);
    expect(o.story).toBeNull();
    expect(formatOutcome(o)).toContain('not applicable');
  });

  it('fails a type:story PR whose story cannot be determined', () => {
    const o = evaluate(input({ pr: { title: 'Something', body: '', labels: ['type:story'] }, commits: [{ sha: 'f'.repeat(40), message: 'x' }] }));
    expect(o.ok).toBe(false);
    expect(o.results[0].rule).toBe('story-resolved');
  });
});

describe('.aisdlc/qa/verdict-comment.md template (B1)', () => {
  const template = readFileSync(join(__dirname, '..', '.aisdlc', 'qa', 'verdict-comment.md'), 'utf8');
  const filled = (verdict: 'APPROVED' | 'REJECTED') => {
    const ok = verdict === 'APPROVED';
    return template
      .replace('<APPROVED | REJECTED>', verdict)
      .replace('| 1 | <quoted `Then` / `And` clause> | met | <command output, line ref, link> |', '| 1 | ci starts four jobs | met | [png](qa/evidence/008/US1/green-run.png) |')
      .replace('| 2 | <quoted clause> | **not met** | <what was observed instead> |', `| 2 | artifact uploaded | ${ok ? 'met' : '**not met**'} | [video](qa/evidence/008/US1/us1-desktop.webm) |`)
      .replace('| 3 | <quoted clause> | **unverifiable** | <why, and what would have satisfied it> |', '| 3 | summary lists counts | met | summary.txt |')
      .replace('**Verdict:** approved | rejected', `**Verdict:** ${ok ? 'approved' : 'rejected'}`)
      .replace(ok ? /^<`qa:rejected`.*\n/m : /^<`qa:approved`.*\n/m, '')
      .replace(/^<(`qa:(?:approved|rejected)`.*)>$/m, '$1');
  };

  it('passes evaluate() when filled in as APPROVED', () => {
    const text = filled('APPROVED');
    expect(text.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/qa:rejected|not met|unverifiable/);
    const o = evaluate(input({ readVerdict: () => text }));
    expect(failed(o)).toEqual([]);
    expect(o.ok).toBe(true);
  });

  it('fails evaluate() when filled in as REJECTED', () => {
    const o = evaluate(input({ readVerdict: () => filled('REJECTED') }));
    expect(o.results.filter((r) => !r.ok).map((r) => r.rule)).toEqual(['verdict-approved', 'criteria-met']);
  });

  it('fails evaluate() for the unfilled template', () => {
    const o = evaluate(input({ readVerdict: () => template }));
    expect(o.results.filter((r) => !r.ok).map((r) => r.rule)).toEqual(['verdict-approved', 'criteria-met', 'evidence-media']);
  });
});

describe('io parsing', () => {
  it('parses labels as JSON or a comma list', () => {
    expect(parseLabels('["type:story","spec:008"]')).toEqual(['type:story', 'spec:008']);
    expect(parseLabels('[{"name":"spec:008"}]')).toEqual(['spec:008']);
    expect(parseLabels('type:story, spec:008')).toEqual(['type:story', 'spec:008']);
    expect(parseLabels(undefined)).toEqual([]);
  });

  it('parses git log records', () => {
    const out = `${'a'.repeat(40)}\x1fFirst\n\nWork-Item: o/r#1\n\x1e\n${'b'.repeat(40)}\x1fSecond\n\x1e\n`;
    expect(parseGitLog(out)).toEqual([
      { sha: 'a'.repeat(40), message: 'First\n\nWork-Item: o/r#1' },
      { sha: 'b'.repeat(40), message: 'Second' },
    ]);
  });
});

describe('review round 2 (N-R1, N-R2)', () => {
  it('an approved verdict whose findings mention an earlier qa:rejected stays approved', async () => {
    const { verdictOf } = await import('./dod-check');
    const t = '## QA verdict — APPROVED\n\n### Findings\nRound 1 qa:rejected findings are fixed; REJECTED earlier.\n\n### Verdict\n**Verdict:** approved\n`qa:approved`\n';
    expect(verdictOf(t)).toBe('approved');
  });
  it('a rejection in the Verdict section still wins', async () => {
    const { verdictOf } = await import('./dod-check');
    expect(verdictOf('## QA verdict — APPROVED\n\n### Verdict\n`qa:rejected`\n')).toBe('rejected');
  });
  it('escaped pipes inside a criterion do not shift the Verdict column', async () => {
    const { criterionRows } = await import('./dod-check');
    const rows = criterionRows('| # | Criterion | Verdict |\n|---|---|---|\n| 1 | a \\| b | met |\n');
    expect(rows).toEqual([{ row: '| 1 | a \\| b | met |', verdict: 'met' }]);
  });
});
