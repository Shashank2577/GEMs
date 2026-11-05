/**
 * 007 / US1 — Owner's morning dashboard (story #292, QA task T024 / #310).
 *
 * One test per acceptance scenario US1-1 … US1-15 (specs/007-experience-growth/spec.md), plus SC-002 (API vs SQL
 * ground truth), SC-008 (375 px first viewport, @mobile), FR-008 (greeting boundaries), FR-013 (onboarding redirect)
 * and the Go / No-Go donut-ring regression (arcs must actually render, not just the legend).
 * Every scenario writes a named screenshot to qa/evidence/007/US1/; tests whose title contains "[video]" also keep
 * their video there (collectRunArtifacts) — the rest stay in the git-ignored qa/.runs/ output.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, type Route } from '@playwright/test';
import {
  test, expect, signupViaApi, uniqueUser, seedDemo, seedDemoAndGetWorkspaces, inviteAs, evidence007, collectRunArtifacts, atPhone,
  noHorizontalOverflow, a11y,
} from '../support/fixtures';

const STORY = 'US1';
const EVID_DIR = join('qa', 'evidence', '007', STORY);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const PROJECT = () => test.info().project.name;

test.afterEach(async ({ page }) => {
  if (test.info().title.includes('[video]')) await collectRunArtifacts('007', STORY, page);
});

// ───────────── helpers ─────────────

type Dash = {
  tiles: { newMatchesToday: number; closingThisWeek: number; activeBids: number; emdAtStake: number; winRate: number | null; expiringDocs: number };
  stats: { newMatchesYesterday: number; closingToday: number; won: number; lost: number; expiredDocs: number; analysesThisWeek: number; openTenders: number };
  pipeline: Record<string, number>;
  verdicts: { go: number; review: number; no_go: number };
  matchesByDay: { date: string; count: number }[];
  closingSoon: { id: string; endAt: string; workspace: { id: string; stage: string } | null }[];
  recentMatches: unknown[];
  expiringDocuments: { title: string; daysToExpiry: number; status: string }[];
  activity: { id: string; action: string; user: { name: string } | null; target: { label: string; href: string } | null }[];
  setupComplete: boolean;
  demo: boolean;
  generatedAt: string;
};

async function getDash(page: Page): Promise<Dash> {
  const res = await page.request.get('/api/dashboard');
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

function saveJson(name: string, data: unknown) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

const istToday = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (isoDate: string, n: number) => new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** UTC instant for today's IST date at hh:mm IST. */
const todayAtIst = (hh: number, mm = 0) => new Date(`${istToday()}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);

async function demoOwner(page: Page, name = 'Priya Sharma') {
  const user = await signupViaApi(page, { ...uniqueUser('own'), name });
  await seedDemo(page.request);
  return user;
}

const kpi = (page: Page) => page.getByRole('region', { name: 'Key numbers' });
const tile = (page: Page, label: RegExp) => kpi(page).getByRole('link', { name: label });
const card = (page: Page, title: string) => page.locator('div.rounded-xl, div.rounded-lg').filter({ has: page.getByText(title, { exact: true }) }).last();

function psql(sql: string): string {
  return execFileSync('psql', [E2E_DB, '-Atqc', sql], { encoding: 'utf8' }).trim();
}

async function waitDashboardLoaded(page: Page) {
  await expect(kpi(page).getByText('Active bids')).toBeVisible();
  await expect(kpi(page).locator('[aria-hidden="true"]')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
}

const stageCount = async (page: Page, stage: string) => {
  const txt = (await page.locator(`a[href="/pipeline?stage=${stage}"]`).first().innerText()).trim().split('\n');
  return Number(txt[txt.length - 1].trim());
};

// ───────────── US1-1 … US1-5: API ─────────────

test('US1-1: no session -> GET /api/dashboard answers 401', async ({ page, request }) => {
  const res = await request.get('/api/dashboard');
  expect(res.status()).toBe(401);
  saveJson('US1-01-401-response', { status: res.status(), body: await res.json().catch(() => null) });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
  await evidence007(page, STORY, 'US1-01-unauthenticated-redirect-to-login');
});

test('US1-2: fresh org -> zeroed payload, 14 IST days, setupComplete=false, demo=false', async ({ page }) => {
  await signupViaApi(page);
  const d = await getDash(page);
  saveJson('US1-02-fresh-org-response', d);
  expect(d.tiles).toEqual({ newMatchesToday: 0, closingThisWeek: 0, activeBids: 0, emdAtStake: 0, winRate: null, expiringDocs: 0 });
  expect(d.matchesByDay).toHaveLength(14);
  const today = istToday();
  expect(d.matchesByDay[13].date).toBe(today);
  expect(d.matchesByDay[0].date).toBe(addDays(today, -13));
  for (const row of d.matchesByDay) expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(d.closingSoon).toEqual([]);
  expect(d.verdicts).toEqual({ go: 0, review: 0, no_go: 0 });
  expect(d.setupComplete).toBe(false);
  expect(d.demo).toBe(false);
  await page.goto('/dashboard'); // first visit redirects to onboarding (FR-013)
  await expect(page).toHaveURL(/\/onboarding/);
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toBeVisible();
  await evidence007(page, STORY, 'US1-02-fresh-org-dashboard-zeros');
});

test('US1-3: demo org -> pipeline, tiles, verdict total, recentMatches, activity, flags', async ({ page }) => {
  await demoOwner(page);
  const d = await getDash(page);
  saveJson('US1-03-demo-org-response', d);
  expect(d.pipeline).toEqual({ identified: 3, analysing: 2, go: 2, preparing: 2, ready: 1, submitted: 3, won: 2, lost: 1, dropped: 0 });
  expect(d.tiles.activeBids).toBe(13);
  expect(d.tiles.winRate).toBe(67);
  expect(d.tiles.expiringDocs).toBe(3);
  expect(d.stats.expiredDocs).toBe(1);
  expect(d.verdicts.go + d.verdicts.review + d.verdicts.no_go).toBe(20);
  expect(d.recentMatches).toHaveLength(6);
  expect(d.activity.length).toBeLessThanOrEqual(15);
  expect(d.activity.filter((a) => a.action === 'demo.seeded')).toHaveLength(1);
  expect.soft(d.setupComplete).toBe(true);
  expect(d.demo).toBe(true);
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  await evidence007(page, STORY, 'US1-03-demo-org-dashboard');
});

test('US1-4: demo org -> closingSoon 1-8, ascending, within 7 days, closingToday>=1, one workspace in "ready"', async ({ page }) => {
  await demoOwner(page);
  const before = Date.now();
  const d = await getDash(page);
  saveJson('US1-04-closing-soon', { closingSoon: d.closingSoon, tiles: d.tiles, stats: d.stats });
  expect(d.closingSoon.length).toBeGreaterThanOrEqual(1);
  expect(d.closingSoon.length).toBeLessThanOrEqual(8);
  const ends = d.closingSoon.map((t) => new Date(t.endAt).getTime());
  expect(ends).toEqual([...ends].sort((a, b) => a - b));
  for (const e of ends) {
    expect(e).toBeGreaterThanOrEqual(before - 60_000); // allow clock skew between runner and server
    expect(e).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
  }
  expect(d.tiles.closingThisWeek).toBeGreaterThanOrEqual(d.closingSoon.length);
  expect(d.stats.closingToday).toBeGreaterThanOrEqual(1);
  expect(d.closingSoon.some((t) => t.workspace?.stage === 'ready')).toBe(true);
  await page.goto('/dashboard');
  await expect(page.getByText('Closing soon', { exact: true })).toBeVisible();
  await evidence007(page, STORY, 'US1-04-closing-soon-card');
});

test('US1-5: tiles.emdAtStake equals SUM(tenders.emd_amount) over active workspaces (SQL ground truth)', async ({ page }) => {
  const user = await demoOwner(page);
  const d = await getDash(page);
  const org = psql(`select id from organizations where name = '${user.orgName.replace(/'/g, "''")}'`);
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  const sum = Number(psql(`select coalesce(sum(t.emd_amount),0) from bid_workspaces w join tenders t on t.id = w.tender_id where w.org_id = '${org}' and w.stage in ('identified','analysing','go','preparing','ready','submitted')`));
  saveJson('US1-05-emd-ground-truth', { sql: sum, api: d.tiles.emdAtStake });
  expect(sum).toBeGreaterThan(0);
  expect(d.tiles.emdAtStake).toBe(sum);
  await page.goto('/dashboard');
  await expect(page.getByRole('region', { name: 'Key numbers' })).toContainText('EMD at stake');
  await evidence007(page, STORY, 'US1-05-emd-at-stake');
});

test('SC-002: six KPI tiles and nine pipeline counts equal SQL ground truth (demo org)', async ({ page }) => {
  const user = await demoOwner(page);
  const d = await getDash(page);
  const org = psql(`select id from organizations where name = '${user.orgName.replace(/'/g, "''")}'`);
  const ist0 = `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
  const relevant = `(exists (select 1 from tender_matches m where m.tender_id = t.id and m.org_id = '${org}' and m.dismissed = false) or exists (select 1 from bid_workspaces w where w.tender_id = t.id and w.org_id = '${org}' and w.stage not in ('won','lost','dropped')))`;
  const truth = {
    newMatchesToday: Number(psql(`select count(distinct tender_id) from tender_matches where org_id = '${org}' and dismissed = false and created_at >= ${ist0}`)),
    closingThisWeek: Number(psql(`select count(*) from tenders t where t.status = 'open' and t.end_at is not null and t.end_at >= now() and t.end_at <= now() + interval '7 days' and ${relevant}`)),
    activeBids: Number(psql(`select count(*) from bid_workspaces where org_id = '${org}' and stage in ('identified','analysing','go','preparing','ready','submitted')`)),
    emdAtStake: Number(psql(`select coalesce(sum(t.emd_amount),0) from bid_workspaces w join tenders t on t.id = w.tender_id where w.org_id = '${org}' and w.stage in ('identified','analysing','go','preparing','ready','submitted')`)),
    won: Number(psql(`select count(*) from bid_workspaces where org_id = '${org}' and stage = 'won'`)),
    lost: Number(psql(`select count(*) from bid_workspaces where org_id = '${org}' and stage = 'lost'`)),
    expiringDocs: Number(psql(`select count(*) from vault_documents where org_id = '${org}' and expiry_date is not null and expiry_date <= (now() at time zone 'Asia/Kolkata')::date + 30`)),
  };
  const pipeline: Record<string, number> = {};
  for (const row of psql(`select stage, count(*) from bid_workspaces where org_id = '${org}' group by stage`).split('\n').filter(Boolean)) {
    const [s, n] = row.split('|'); pipeline[s] = Number(n);
  }
  const stages = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost', 'dropped'];
  const truthPipeline = Object.fromEntries(stages.map((s) => [s, pipeline[s] ?? 0]));
  const truthWinRate = truth.won + truth.lost ? Math.round((truth.won / (truth.won + truth.lost)) * 100) : null;
  saveJson('SC-002-ground-truth', { api: { tiles: d.tiles, pipeline: d.pipeline }, sql: { ...truth, winRate: truthWinRate, pipeline: truthPipeline } });
  expect(d.tiles.newMatchesToday).toBe(truth.newMatchesToday);
  expect(d.tiles.closingThisWeek).toBe(truth.closingThisWeek);
  expect(d.tiles.activeBids).toBe(truth.activeBids);
  expect(d.tiles.emdAtStake).toBe(truth.emdAtStake);
  expect(d.tiles.winRate).toBe(truthWinRate);
  expect(d.tiles.expiringDocs).toBe(truth.expiringDocs);
  expect(d.pipeline).toEqual(truthPipeline);
  await page.goto('/dashboard');
  await expect(tile(page, /Win rate/)).toContainText('67%');
  await evidence007(page, STORY, 'SC-002-tiles-and-pipeline-match-sql');
});

// ───────────── US1-6 … US1-9: demo org UI ─────────────

test('US1-6 / FR-008: 09:30 IST -> "Good morning, Priya", IST long date, summary joined by " · "', async ({ page }) => {
  const at = todayAtIst(9, 30);
  await page.clock.install({ time: at });
  await demoOwner(page, 'Priya Sharma');
  const d = await getDash(page);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Good morning, Priya');
  const dateLine = at.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  await expect(page.getByText(dateLine, { exact: true })).toBeVisible();
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (d.tiles.newMatchesToday) parts.push(`${plural(d.tiles.newMatchesToday, 'new match', 'new matches')} today`);
  if (d.stats.closingToday) parts.push(`${plural(d.stats.closingToday, 'bid')} closing today`);
  if (d.stats.expiredDocs) parts.push(plural(d.stats.expiredDocs, 'expired document'));
  expect(parts.length, 'demo org should have something urgent').toBeGreaterThan(0);
  const expected = `${parts.join(' · ')}.`;
  await expect(page.getByText(expected, { exact: true })).toBeVisible();
  expect(expected).toContain('closing today');
  expect(expected).toContain('expired document');
  await evidence007(page, STORY, 'US1-06-greeting-date-summary-0930-ist');

  // FR-008 boundaries (IST hour): <05 Working late, <12 morning, <17 afternoon, else evening.
  const cases: [number, number, string][] = [[4, 59, 'Working late'], [5, 0, 'Good morning'], [11, 59, 'Good morning'], [12, 0, 'Good afternoon'], [16, 59, 'Good afternoon'], [17, 0, 'Good evening'], [23, 30, 'Good evening']];
  const seen: Record<string, string> = {};
  for (const [h, m, want] of cases) {
    await page.clock.setFixedTime(todayAtIst(h, m));
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${want}, Priya`);
    seen[`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`] = want;
  }
  saveJson('US1-06-greeting-boundaries', seen);
});

test('US1-7: each KPI tile deep-links to the documented destination', async ({ page }) => {
  await demoOwner(page);
  const targets: [RegExp, string][] = [
    [/New matches today/, '/tenders?matched=1'],
    [/Closing this week/, '/tenders?matched=1&closing=7&sort=endAt'],
    [/Active bids/, '/pipeline'],
    [/EMD at stake/, '/pipeline'],
    [/Win rate/, '/pipeline?stage=won'],
    [/Docs expiring/, '/vault?status=expiring'],
  ];
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  await evidence007(page, STORY, 'US1-07-kpi-tiles-before-click');
  const landed: Record<string, string> = {};
  for (const [label, dest] of targets) {
    await page.goto('/dashboard');
    await expect(tile(page, label)).toBeVisible();
    await expect(tile(page, label)).toHaveAttribute('href', dest);
    await tile(page, label).click();
    await expect.poll(() => { const u = new URL(page.url()); return u.pathname + u.search; }, { message: `after clicking ${label}` }).toBe(dest);
    landed[String(label)] = new URL(page.url()).pathname + new URL(page.url()).search;
    if (label.source === 'Docs expiring') await evidence007(page, STORY, 'US1-07-last-destination-vault-expiring');
  }
  saveJson('US1-07-tile-destinations', landed);
});

test('US1-8: tile hints (Win rate 67% "2 won · 1 lost", Docs expiring 3 "1 expired" in danger, Active bids 13 "1 ready to submit") and Demo badge', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/dashboard');
  const win = tile(page, /Win rate/);
  await expect(win).toContainText('67%');
  await expect(win).toContainText('2 won · 1 lost');
  const docs = tile(page, /Docs expiring/);
  await expect(docs).toContainText('3');
  const expired = docs.getByText('1 expired', { exact: true });
  await expect(expired).toBeVisible();
  const rgb = await expired.evaluate((el) => getComputedStyle(el).color);
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  expect(r, `"1 expired" colour ${rgb} should be red-ish (danger)`).toBeGreaterThan(g + 40);
  expect(r).toBeGreaterThan(b + 40);
  await expect(expired).toHaveClass(/text-danger/);
  const active = tile(page, /Active bids/);
  await expect(active).toContainText('13');
  await expect(active).toContainText('1 ready to submit');
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  // FR-009: EMD tooltip text
  await page.getByText('EMD at stake', { exact: true }).hover();
  await expect(page.getByText('Earnest Money Deposit on your active bids. MSEs with Udyam are usually exempt.')).toBeVisible();
  await evidence007(page, STORY, 'US1-08-tile-hints-and-demo-badge');
});

test('US1-9: Expiring documents -> Dell OEM "Expired 5d ago", then "10d left", "25d left"', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/dashboard');
  const rows = page.locator('a[href="/vault?status=expiring"]').filter({ hasText: /Expired \d+d ago|\d+d left|Today/ });
  await expect(rows.first()).toBeVisible();
  const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  saveJson('US1-09-expiring-rows', texts);
  expect(texts).toHaveLength(3);
  expect(texts[0]).toMatch(/Dell/i);
  expect(texts[0]).toMatch(/OEM/i);
  expect(texts[0]).toContain('Expired 5d ago');
  expect(texts[1]).toContain('10d left');
  expect(texts[2]).toContain('25d left');
  await rows.first().scrollIntoViewIfNeeded();
  await evidence007(page, STORY, 'US1-09-expiring-documents');
});

// ───────────── US1-10 … US1-14: states ─────────────

test('US1-10 / FR-013: fresh org -> onboarding redirect once, then empty-state dashboard', async ({ page }) => {
  await signupViaApi(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/onboarding/); // FR-013: first visit in this browser session
  await evidence007(page, STORY, 'US1-10-first-visit-redirects-to-onboarding');
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);   // second visit stays
  await expect(page.getByText('Your command centre fills up as GeM bids arrive')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore with demo data' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a watchlist', exact: true })).toBeVisible();
  await expect(page.getByText('Nothing closing this week')).toBeVisible();
  await expect(page.getByText('No matches yet')).toBeVisible();
  const d = await getDash(page);
  expect(d.activity.map((a) => a.action)).toEqual(['org.created']);
  await expect(page.getByText('created the organization')).toBeVisible();
  await evidence007(page, STORY, 'US1-10-fresh-org-empty-states');
});

test('US1-11: API 500 on first load -> "We couldn’t load this" + Try again; recovers on retry', async ({ page }) => {
  await demoOwner(page);
  await page.route('**/api/dashboard', (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) }));
  await page.goto('/dashboard');
  const alert = page.getByRole('alert').filter({ hasText: 'We couldn’t load this' });
  await expect(alert).toBeVisible({ timeout: 30_000 }); // react-query retries twice (1 s + 2 s back-off) before the error state
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(kpi(page)).toHaveCount(0);            // widgets replaced
  await evidence007(page, STORY, 'US1-11-error-state-500');
  await page.unroute('**/api/dashboard');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(tile(page, /Active bids/)).toContainText('13');
  await expect(page.getByRole('alert').filter({ hasText: 'We couldn’t load this' })).toHaveCount(0);
  await evidence007(page, STORY, 'US1-11-recovered-after-try-again');
});

test('US1-12 [video]: 2 s slow API -> 6 tile skeletons + per-card skeleton rows (aria-hidden), no header layout shift', async ({ page }) => {
  await demoOwner(page);
  await page.addInitScript(() => {
    (window as any).__headerMoves = [];
    (window as any).__pageShift = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.hadRecentInput) continue;
        (window as any).__pageShift += e.value;
        const el = (n: any) => (n && (n.nodeType === 1 ? n : n.parentElement)) as Element | null;
        for (const s of e.sources ?? []) {
          if (!el(s.node)?.closest?.('header') || !s.previousRect || !s.currentRect) continue;
          const p = s.previousRect, c = s.currentRect;
          const moved = Math.abs(c.y - p.y) > 2;
          if (moved) (window as any).__headerMoves.push({ node: (el(s.node)?.textContent ?? '').trim().slice(0, 40), from: [p.x, p.y, p.width, p.height].map(Math.round), to: [c.x, c.y, c.width, c.height].map(Math.round) });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/dashboard', async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue(); });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  const tileSk = kpi(page).locator('div[aria-hidden="true"]');
  await expect(tileSk).toHaveCount(6);
  const hidden = await tileSk.evaluateAll((els) => els.every((e) => e.getAttribute('aria-hidden') === 'true'));
  expect(hidden).toBe(true);
  const cardRows = page.locator('div.grid.gap-3[aria-hidden="true"] > div');
  expect(await cardRows.count(), 'per-card skeleton rows while loading').toBeGreaterThanOrEqual(10);
  const pageHeader = page.locator('header').filter({ has: h1 });
  const actions = [page.getByRole('link', { name: 'Pipeline', exact: true }).first(), page.getByRole('link', { name: /Review matches/ })];
  const headerBefore = await pageHeader.boundingBox();
  const actionsBefore = await Promise.all(actions.map((a) => a.boundingBox()));
  const h1Before = await h1.boundingBox();
  await evidence007(page, STORY, 'US1-12-skeletons-while-loading');
  await expect(tile(page, /Active bids/)).toContainText('13', { timeout: 15_000 });
  await expect(kpi(page).locator('div[aria-hidden="true"]')).toHaveCount(0);
  const headerAfter = await pageHeader.boundingBox();
  const actionsAfter = await Promise.all(actions.map((a) => a.boundingBox()));
  const h1After = await h1.boundingBox();
  const headerMoves = await page.evaluate(() => (window as any).__headerMoves as unknown[]);
  const pageShift = await page.evaluate(() => (window as any).__pageShift as number);
  saveJson('US1-12-header-layout', { headerBefore, headerAfter, h1Before, h1After, actionsBefore, actionsAfter, headerNodesMoved: headerMoves, pageWideLayoutShiftScore: pageShift });
  expect(h1After!.y).toBeCloseTo(h1Before!.y, 0);
  expect(headerAfter!.y).toBeCloseTo(headerBefore!.y, 0);
  expect(Math.abs(headerAfter!.height - headerBefore!.height), `header height ${headerBefore!.height} -> ${headerAfter!.height}`).toBeLessThanOrEqual(2);
  actionsBefore.forEach((b, i) => { expect(Math.abs(actionsAfter[i]!.y - b!.y), 'action button vertical drift (px)').toBeLessThanOrEqual(2); expect(actionsAfter[i]!.x + actionsAfter[i]!.width).toBeCloseTo(b!.x + b!.width, 0); });
  expect(headerMoves, 'header nodes moved by a layout shift (>2 px)').toEqual([]);
  await evidence007(page, STORY, 'US1-12-loaded-after-delay');
});

test('US1-13 / FR-011: teammate moves a bid Identified->Analysing; 120 s auto-refresh shows 2/3 + activity entry', async ({ page, browser }) => {
  await page.clock.install({ time: new Date() });
  await signupViaApi(page);
  const { workspaces } = await seedDemoAndGetWorkspaces(page.request);
  const target = workspaces.find((w) => w.stage === 'identified')!;
  expect(target, 'demo org has an identified workspace').toBeTruthy();
  const mate = await inviteAs(page.request, 'analyst');
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  expect(await stageCount(page, 'identified')).toBe(3);
  expect(await stageCount(page, 'analysing')).toBe(2);
  await evidence007(page, STORY, 'US1-13-before-move');
  const res = await mate.api.patch(`/api/workspaces/${target.id}`, { data: { stage: 'analysing' } });
  expect(res.status(), await res.text()).toBe(200);
  // Let the page's 120 s refetchInterval elapse on the emulated clock (no manual reload / navigation).
  await page.clock.fastForward(125_000);
  await expect.poll(() => stageCount(page, 'identified'), { timeout: 20_000 }).toBe(2);
  expect(await stageCount(page, 'analysing')).toBe(3);
  const top = page.locator('ol > li').filter({ has: page.locator('time') }).first();
  await expect(top).toContainText(`${mate.user.name} moved a bid from Identified to Analysing`);
  await expect(top.locator(`a[href="/workspaces/${target.id}"]`)).toBeVisible();
  await top.scrollIntoViewIfNeeded();
  await evidence007(page, STORY, 'US1-13-after-auto-refresh');
  void browser;
});

test('US1-14 / FR-012: background refresh 503 -> data stays, "Couldn’t refresh — showing data from HH:MM IST" + Retry', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await demoOwner(page);
  let generatedAt = '';
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/dashboard') && r.status() === 200) { try { generatedAt = (await r.json()).generatedAt; } catch { /* ignore */ } }
  });
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  expect(generatedAt).not.toBe('');
  const hhmm = new Date(generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
  await page.route('**/api/dashboard', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'down' } }) }));
  await page.clock.fastForward(125_000);
  const banner = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(`showing data from ${hhmm} IST`);
  await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(tile(page, /Active bids/)).toContainText('13');            // widgets still there
  await expect(page.getByRole('alert').filter({ hasText: 'We couldn’t load this' })).toHaveCount(0); // no full-page error
  await evidence007(page, STORY, 'US1-14-stale-banner-with-data');
  await page.unroute('**/api/dashboard');
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toHaveCount(0);
  await expect(tile(page, /Active bids/)).toContainText('13');
  await evidence007(page, STORY, 'US1-14-recovered-after-retry');
});

test('US1-15: second org sees none of the first org\'s demo data', async ({ page, browser }) => {
  await demoOwner(page);
  const a = await getDash(page);
  expect(a.tiles.activeBids).toBe(13);
  const baseURL = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL, locale: 'en-IN', timezoneId: 'Asia/Kolkata', viewport: { width: 1440, height: 900 } });
  try {
    const p2 = await ctx.newPage();
    const userB = uniqueUser('orgb');
    const su = await p2.request.post('/api/auth/signup', { data: userB });
    expect(su.status(), await su.text()).toBe(201);
    const res = await p2.request.get('/api/dashboard');
    expect(res.status()).toBe(200);
    const b: Dash = await res.json();
    saveJson('US1-15-second-org-response', b);
    expect(b.tiles.activeBids).toBe(0);
    expect(b.closingSoon).toEqual([]);
    expect(b.recentMatches).toEqual([]);
    expect(b.activity.length).toBeGreaterThan(0);
    expect(b.activity.every((x) => x.action === 'org.created')).toBe(true);
    expect(b.activity).toHaveLength(1);
    expect(b.demo).toBe(false);
    await p2.goto('/dashboard');
    await expect(p2).toHaveURL(/\/onboarding/);
    await p2.goto('/dashboard');
    await expect(p2.getByText('Nothing closing this week')).toBeVisible();
    await evidence007(p2, STORY, 'US1-15-second-org-dashboard-empty');
  } finally { await ctx.close(); }
});

// ───────────── Go / No-Go donut regression ─────────────

test('Donut: Go / No-Go ring renders visible arcs proportional to verdict counts (not only the legend)', async ({ page }) => {
  await demoOwner(page);
  const d = await getDash(page);
  await page.goto('/dashboard');
  const ring = page.getByTestId('verdict-ring');
  await ring.scrollIntoViewIfNeeded();
  await expect(ring).toBeVisible();
  const box = await ring.boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);

  const arcs = await ring.locator('circle[data-verdict]').evaluateAll((els) => els.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const dash = (el.getAttribute('stroke-dasharray') ?? '').split(/[ ,]+/).map(Number);
    return { verdict: el.getAttribute('data-verdict')!, length: dash[0], circumference: dash[1], stroke: cs.stroke, strokeWidth: cs.strokeWidth, w: r.width, h: r.height };
  }));
  saveJson('Donut-arcs', { counts: d.verdicts, arcs });
  const expectedKeys = (['go', 'review', 'no_go'] as const).filter((k) => d.verdicts[k] > 0);
  expect(arcs.map((a) => a.verdict)).toEqual(expectedKeys);
  const total = d.verdicts.go + d.verdicts.review + d.verdicts.no_go;
  expect(total).toBe(20);
  const drawn = arcs.reduce((s, a) => s + a.length, 0);
  for (const a of arcs) {
    expect(a.length, `${a.verdict} arc length`).toBeGreaterThan(1);
    expect(a.stroke, `${a.verdict} stroke resolved`).toMatch(/^rgb/);
    expect(a.stroke).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(a.strokeWidth)).toBeGreaterThan(5);
    expect(a.w).toBeGreaterThan(80);
    expect(a.length / drawn).toBeCloseTo(d.verdicts[a.verdict as 'go'] / total, 2);
  }
  expect(new Set(arcs.map((a) => a.stroke)).size, 'arcs use distinct colours').toBe(arcs.length);
  // Pixel check: the ring's screenshot contains saturated (coloured) pixels, i.e. arcs were really painted.
  const png = await ring.screenshot();
  const painted = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < px.length; i += 4) { if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 60) n++; }
    return n;
  }, png.toString('base64'));
  expect(painted, 'saturated pixels in the ring').toBeGreaterThan(500);
  // Legend still shows the counts
  for (const [label, key] of [['Go', 'go'], ['Review', 'review'], ['No-Go', 'no_go']] as const) {
    await expect(page.locator('a[href^="/tenders?verdict="]').filter({ hasText: label }).first()).toContainText(String(d.verdicts[key]));
  }
  await evidence007(page, STORY, 'Donut-ring-arcs-visible');
  await png && (mkdirSync(EVID_DIR, { recursive: true }), writeFileSync(join(EVID_DIR, `Donut-ring-closeup-${PROJECT()}.png`), png));

  // Reduced motion must not hide the arcs either.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.getByTestId('verdict-ring').locator('circle[data-verdict]')).toHaveCount(expectedKeys.length);
  const len = await page.getByTestId('verdict-ring').locator('circle[data-verdict]').first().getAttribute('stroke-dasharray');
  expect(parseFloat(len!)).toBeGreaterThan(1);
});

// ───────────── SC-008: phone first viewport ─────────────

test('SC-008 [video] @mobile: greeting, summary line and >= 4 KPI tiles visible in the first 375x812 viewport', async ({ page }) => {
  await demoOwner(page);
  await atPhone(page);
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  const vh = 812;
  const h1Box = (await h1.boundingBox())!;
  expect(h1Box.y + h1Box.height).toBeLessThanOrEqual(vh);
  const summary = page.locator('header p').nth(1);
  await expect(summary).toContainText('·');
  const sBox = (await summary.boundingBox())!;
  expect(sBox.y + sBox.height).toBeLessThanOrEqual(vh);
  const tiles = await kpi(page).getByRole('link').all();
  expect(tiles).toHaveLength(6);
  const inView: string[] = [];
  for (const t of tiles) {
    const b = (await t.boundingBox())!;
    if (b.y >= 0 && b.y + b.height <= vh && b.x >= 0 && b.x + b.width <= 375) inView.push((await t.innerText()).split('\n')[0]);
  }
  saveJson(`SC-008-first-viewport-${PROJECT()}`, { viewport: '375x812', h1Bottom: h1Box.y + h1Box.height, summaryBottom: sBox.y + sBox.height, tilesFullyInView: inView });
  expect(inView.length, `tiles fully inside the first viewport: ${inView.join(', ')}`).toBeGreaterThanOrEqual(4);
  const m = await noHorizontalOverflow(page);
  expect(m.scrollWidth).toBeLessThanOrEqual(375);
  mkdirSync(EVID_DIR, { recursive: true });
  await page.screenshot({ path: join(EVID_DIR, `SC-008-first-viewport-375x812-${PROJECT()}.png`), fullPage: false });
  await evidence007(page, STORY, `SC-008-phone-full-page-${PROJECT()}`);
});

// ───────────── Observation only: accessibility (US7 scope; does not decide the US1 verdict) ─────────────

test('Observation: axe scan of the demo dashboard (recorded, non-gating for US1)', async ({ page }) => {
  await demoOwner(page);
  await page.goto('/dashboard');
  await expect(tile(page, /Active bids/)).toContainText('13');
  const res = await a11y(page, 'dashboard-demo').catch((e) => e); // record, do not fail US1 on a11y findings
  if (res instanceof Error) test.info().annotations.push({ type: 'a11y-observation', description: res.message.slice(0, 1500) });
});
