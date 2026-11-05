/**
 * Definition-of-Done gate for story PRs (spec 008 FR-004, US1 scenario 6). Pattern adapted from ai-sdlc `dod-check.yml`
 * (MIT, see NOTICE), inlined so CI stays self-contained.
 *
 * Story resolution (first match wins):
 *   1. PR title `[<NNN>/US<n>] …` (playbook convention),
 *   2. issue numbers in the PR body (`Work-Item: owner/repo#N`, `Closes|Fixes|Resolves #N`) or commit `Work-Item:`
 *      trailers, mapped to a story via `specs/<NNN>-<slug>/spec.md` headings (`### User Story <n> … (#N)`) and
 *      `specs/<NNN>-<slug>/tasks.md` lines (`[US<n>] … (#N)`),
 *   3. label `spec:<NNN>` plus `US<n>` in the title/body.
 * No story → hardening/cross-cutting PR: passes with a note (unless labelled `type:story`, which then fails).
 *
 * Rules (each reported by name): verdict-exists, verdict-approved, criteria-met, evidence-media, commit-trailers.
 *
 * Inputs (env): PR_TITLE, PR_BODY, PR_LABELS (JSON array or comma list), BASE_SHA, HEAD_SHA (default HEAD).
 * When GH_TOKEN, PR_NUMBER and GITHUB_REPOSITORY are set, title/body/labels and the PR's commits come from the GitHub
 * API; otherwise commits are `git log <merge-base(BASE_SHA, HEAD_SHA)>..HEAD_SHA`.
 *
 * A verdict counts as approved via the .aisdlc/qa/verdict-comment.md heading `## QA verdict — APPROVED`, `qa:approved`
 * or a `Verdict: approved` line; any REJECTED / `qa:rejected` / `Verdict: rejected` signal wins.
 *
 *   pnpm exec tsx scripts/dod-check.ts
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PrInfo { title: string; body: string; labels: string[] }
export interface Commit { sha: string; message: string }
export interface StoryRef { spec: string; story: string; source: string }
export interface RuleResult { rule: string; ok: boolean; message: string }
export type StoryIndex = Map<number, { spec: string; story: string }>;

export const REQUIRED_TRAILERS = ['Work-Item', 'Requirement', 'Agent-Role', 'Harness'] as const;

export const verdictPath = (s: { spec: string; story: string }) => `qa/evidence/${s.spec}/${s.story}/VERDICT.md`;

/** Pure: issue number → story, from spec.md story headings and tasks.md `[USn] … (#N)` lines. */
export function buildStoryIndex(files: { path: string; content: string }[]): StoryIndex {
  const index: StoryIndex = new Map();
  for (const { path, content } of files) {
    const spec = /specs\/(\d{3})-[^/]+\/(spec|tasks)\.md$/.exec(path.replace(/\\/g, '/'));
    if (!spec) continue;
    for (const line of content.split('\n')) {
      const heading = /^#{2,4}\s*User Story\s+(\d+)\b.*\(#(\d+)\)/i.exec(line);
      if (heading) { index.set(Number(heading[2]), { spec: spec[1], story: `US${heading[1]}` }); continue; }
      const task = /^\s*-\s*\[[ xX]\]\s*T\d+\b.*\[US(\d+)\].*\(#(\d+)\)\s*$/.exec(line);
      if (task && !index.has(Number(task[2]))) index.set(Number(task[2]), { spec: spec[1], story: `US${task[1]}` });
    }
  }
  return index;
}

/** Pure: issue numbers referenced as Work-Item trailers or closing keywords. */
export function issueRefs(text: string): number[] {
  const refs: number[] = [];
  for (const m of text.matchAll(/^\s*Work-Item:\s*(?:[\w.-]+\/[\w.-]+)?#(\d+)/gim)) refs.push(Number(m[1]));
  for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi)) refs.push(Number(m[1]));
  return refs;
}

/** Pure: which story (if any) this PR delivers. */
export function resolveStory(pr: PrInfo, commits: Commit[], index: StoryIndex): StoryRef | null {
  const title = /^\s*\[(\d{3})\/US(\d+)\]/i.exec(pr.title);
  if (title) return { spec: title[1], story: `US${title[2]}`, source: 'PR title' };
  const sources: [string, string][] = [['PR body', pr.body], ...commits.map((c) => [`commit ${c.sha.slice(0, 7)}`, c.message] as [string, string])];
  for (const [source, text] of sources) {
    for (const n of issueRefs(text)) {
      const hit = index.get(n);
      if (hit) return { ...hit, source: `${source} → #${n}` };
    }
  }
  const specLabel = pr.labels.map((l) => /^spec:(\d{3})$/i.exec(l.trim())).find(Boolean);
  const us = /\bUS(\d+)\b/.exec(`${pr.title}\n${pr.body}`);
  if (specLabel && us) return { spec: specLabel[1], story: `US${us[1]}`, source: `label spec:${specLabel[1]} + US${us[1]}` };
  return null;
}

/** Normalise a table cell: drop markdown emphasis/code markers, emoji and surrounding space. */
const cell = (c: string) => c.replace(/[*_`]/g, '').replace(/[^\p{L}\p{N}\s#:./-]/gu, '').trim().toLowerCase();
const splitRow = (l: string) => {
  const parts = l.trim().split('|');
  return parts.slice(1, parts[parts.length - 1].trim() === '' ? -1 : undefined);
};
const isSeparator = (l: string) => l.trim().startsWith('|') && splitRow(l).every((c) => /^\s*:?-+:?\s*$/.test(c));

/**
 * Pure: acceptance-criterion rows of every table whose header has a "Verdict" column, with that column's value.
 * Rows outside such tables are ignored.
 */
export function criterionRows(text: string): { row: string; verdict: string }[] {
  const lines = text.split('\n');
  const rows: { row: string; verdict: string }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !isSeparator(lines[i + 1])) continue;
    const col = splitRow(lines[i]).findIndex((h) => cell(h) === 'verdict');
    if (col < 0) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      rows.push({ row: lines[j].trim(), verdict: cell(splitRow(lines[j])[col] ?? '') });
    }
    i = j - 1;
  }
  return rows;
}

const stripComments = (t: string) => t.replace(/<!--[\s\S]*?-->/g, '');

/** Pure: the overall verdict signalled by a VERDICT.md (template heading, `qa:` label, or a `Verdict:` line). */
export function verdictOf(text: string): 'approved' | 'rejected' | 'missing' {
  const t = stripComments(text);
  const verdictLines = [...t.matchAll(/\bVerdict[*_]*[ \t]*:[*_` \t]*([^\n]*)/gi)].map((m) => m[1].toLowerCase());
  const rejected =
    /^#{1,3}\s*QA verdict\s*[—–-].*\bREJECTED\b/im.test(t) ||
    /\bqa:rejected\b/i.test(t) ||
    verdictLines.some((v) => /\brejected\b/.test(v));
  if (rejected) return 'rejected';
  const approved =
    /^#{1,3}\s*QA verdict\s*[—–-]\s*APPROVED\b/im.test(t) ||
    /\bqa:approved\b/i.test(t) ||
    verdictLines.some((v) => /^approved\b/.test(v));
  return approved ? 'approved' : 'missing';
}

/** Pure: verdict-approved + criteria-met rules over VERDICT.md text. Rejection signals win over approval. */
export function checkVerdict(text: string): RuleResult[] {
  const verdict = verdictOf(text);
  const rows = criterionRows(stripComments(text));
  // Every criterion must be exactly "met" (an emoji/markup suffix is tolerated); "not met", "unverifiable", blanks fail.
  const bad = rows.filter((r) => /^\s*not met\b/.test(r.verdict) || !/^met\b/.test(r.verdict));
  let criteria: RuleResult;
  if (!rows.length) criteria = { rule: 'criteria-met', ok: false, message: 'No acceptance-criteria table with a "Verdict" column in VERDICT.md' };
  else if (bad.length) {
    criteria = {
      rule: 'criteria-met',
      ok: false,
      message: `Acceptance criteria not "met" (not met / unverifiable / blank): ${bad.length}\n${bad.map((r) => `    ${r.row}`).join('\n')}`,
    };
  } else criteria = { rule: 'criteria-met', ok: true, message: `all ${rows.length} acceptance criteria met` };
  return [
    verdict === 'approved'
      ? { rule: 'verdict-approved', ok: true, message: 'VERDICT.md is approved' }
      : { rule: 'verdict-approved', ok: false, message: 'QA verdict is not approved' },
    criteria,
  ];
}

/** Pure: ≥1 screenshot and ≥1 video in the story folder, and the verdict links at least one of each. */
export function checkMedia(dir: string, files: string[], verdict: string): RuleResult {
  const base = (f: string) => f.split('/').pop() ?? f;
  const png = files.filter((f) => /\.png$/i.test(f));
  const webm = files.filter((f) => /\.webm$/i.test(f));
  const problems: string[] = [];
  if (!png.length) problems.push(`no screenshot (.png) in ${dir}`);
  if (!webm.length) problems.push(`no video (.webm) in ${dir}`);
  if (png.length && !png.some((f) => verdict.includes(base(f)))) problems.push('VERDICT.md links none of the screenshots');
  if (webm.length && !webm.some((f) => verdict.includes(base(f)))) problems.push('VERDICT.md links none of the videos');
  return problems.length
    ? { rule: 'evidence-media', ok: false, message: `QA evidence incomplete: ${problems.join('; ')}` }
    : { rule: 'evidence-media', ok: true, message: `${png.length} screenshot(s), ${webm.length} video(s)` };
}

/** Pure: every commit carries the CONVENTIONS.md trailers. */
export function checkTrailers(commits: Commit[]): RuleResult {
  const bad: string[] = [];
  for (const c of commits) {
    const missing = REQUIRED_TRAILERS.filter((t) => !new RegExp(`^${t}:\\s*\\S`, 'mi').test(c.message));
    if (missing.length) bad.push(`${c.sha.slice(0, 7)} "${c.message.split('\n')[0]}" missing ${missing.join(', ')}`);
  }
  if (!commits.length) return { rule: 'commit-trailers', ok: false, message: 'no commits found in the PR range' };
  return bad.length
    ? { rule: 'commit-trailers', ok: false, message: `Commits missing trailers (${REQUIRED_TRAILERS.join('/')}):\n${bad.map((b) => `    ${b}`).join('\n')}` }
    : { rule: 'commit-trailers', ok: true, message: `${commits.length} commit(s) carry ${REQUIRED_TRAILERS.join('/')}` };
}

export interface DodInput {
  pr: PrInfo;
  commits: Commit[];
  index: StoryIndex;
  /** VERDICT.md content for a story, or null when absent. */
  readVerdict: (path: string) => string | null;
  /** Files (relative paths) under a story evidence folder. */
  listEvidence: (dir: string) => string[];
}

export interface DodOutcome { ok: boolean; story: StoryRef | null; results: RuleResult[]; notes: string[] }

/** Pure given its callbacks: the whole Definition-of-Done evaluation. */
export function evaluate(input: DodInput): DodOutcome {
  const story = resolveStory(input.pr, input.commits, input.index);
  const isStoryLabelled = input.pr.labels.some((l) => l.trim().toLowerCase() === 'type:story');
  if (!story) {
    if (isStoryLabelled) {
      return { ok: false, story, notes: [], results: [{ rule: 'story-resolved', ok: false, message: 'PR is labelled type:story but no spec/story could be determined (use title "[<NNN>/US<n>] …")' }] };
    }
    return { ok: true, story, results: [], notes: ['No story referenced (hardening / cross-cutting PR): Definition-of-Done check not applicable.'] };
  }
  const path = verdictPath(story);
  const dir = path.replace(/\/VERDICT\.md$/, '');
  const results: RuleResult[] = [];
  const verdict = input.readVerdict(path);
  if (verdict === null) {
    results.push({ rule: 'verdict-exists', ok: false, message: `Missing QA verdict: ${path}` });
  } else {
    results.push({ rule: 'verdict-exists', ok: true, message: path });
    results.push(...checkVerdict(verdict));
    results.push(checkMedia(dir, input.listEvidence(dir), verdict));
  }
  results.push(checkTrailers(input.commits));
  return { ok: results.every((r) => r.ok), story, results, notes: [] };
}

export function formatOutcome(o: DodOutcome): string {
  const lines: string[] = [];
  if (o.story) lines.push(`Story: ${o.story.spec}/${o.story.story} (from ${o.story.source})`);
  lines.push(...o.notes);
  for (const r of o.results) lines.push(`${r.ok ? 'PASS' : 'FAIL'} ${r.rule}: ${r.message}`);
  lines.push(o.ok ? 'Definition of Done: OK' : 'Definition of Done: FAILED');
  return lines.join('\n');
}

export function parseLabels(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v.map((l) => (typeof l === 'string' ? l : String((l as { name?: string }).name ?? ''))).filter(Boolean);
  } catch { /* comma list */ }
  return raw.split(',').map((l) => l.trim()).filter(Boolean);
}

export function parseGitLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, message = ''] = r.split('\x1f');
      return { sha: sha.trim(), message: message.trim() };
    });
}

// ---------- IO ----------

async function loadPr(): Promise<PrInfo> {
  const env = process.env;
  const pr: PrInfo = { title: env.PR_TITLE ?? '', body: env.PR_BODY ?? '', labels: parseLabels(env.PR_LABELS) };
  if (env.GH_TOKEN && env.PR_NUMBER && env.GITHUB_REPOSITORY) {
    try {
      const res = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`, {
        headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { title?: string; body?: string | null; labels?: { name: string }[] };
      return { title: j.title ?? pr.title, body: j.body ?? '', labels: (j.labels ?? []).map((l) => l.name) };
    } catch (err) {
      console.warn(`dod-check: could not refresh PR from the GitHub API (${(err as Error).message}); using event data`);
    }
  }
  return pr;
}

async function loadCommits(): Promise<Commit[]> {
  const env = process.env;
  if (env.GH_TOKEN && env.PR_NUMBER && env.GITHUB_REPOSITORY) {
    try {
      const commits: Commit[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}/commits?per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const batch = (await res.json()) as { sha: string; commit: { message: string }; parents?: unknown[] }[];
        commits.push(...batch.filter((c) => (c.parents?.length ?? 1) < 2).map((c) => ({ sha: c.sha, message: c.commit.message.trim() })));
        if (batch.length < 100) return commits;
      }
      return commits;
    } catch (err) {
      console.warn(`dod-check: could not list PR commits from the GitHub API (${(err as Error).message}); using git`);
    }
  }
  // Only the PR's own commits: from the merge-base of base and head, so commits that landed on main later are excluded.
  const head = env.HEAD_SHA || 'HEAD';
  const base = env.BASE_SHA || 'origin/main';
  const mergeBase = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
  const out = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%B%x1e', `${mergeBase}..${head}`], { encoding: 'utf8' });
  return parseGitLog(out);
}

function loadIndex(): StoryIndex {
  const files: { path: string; content: string }[] = [];
  if (!existsSync('specs')) return new Map();
  for (const d of readdirSync('specs')) {
    for (const f of ['spec.md', 'tasks.md']) {
      const p = `specs/${d}/${f}`;
      if (existsSync(p)) files.push({ path: p, content: readFileSync(p, 'utf8') });
    }
  }
  return buildStoryIndex(files);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

async function main() {
  const outcome = evaluate({
    pr: await loadPr(),
    commits: await loadCommits(),
    index: loadIndex(),
    readVerdict: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    listEvidence: listFiles,
  });
  const text = formatOutcome(outcome);
  console.log(text);
  for (const r of outcome.results.filter((x) => !x.ok)) console.log(`::error title=dod ${r.rule}::${r.message.split('\n')[0]}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Definition of Done\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
  process.exitCode = outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
