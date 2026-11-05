/**
 * 008 / US6 — Operators are paged when ingestion, alerts or the API degrade, and can trace any request (story #361,
 * QA task T100 / #450). One test per acceptance scenario (specs/008-operations-scale/spec.md US6, scenarios 1–10).
 *
 * Needs the E2E API started with its stdout in a file (the test reads the JSON log lines from it):
 *   E2E_PORT=8793 E2E_GEM_PORT=4016 E2E_DATABASE_URL=postgres://…/tenderpilot_e2e_us6 e2e/support/start-api.sh > qa/.runs/us6-api.log 2>&1 &
 *   E2E_API_LOG=qa/.runs/us6-api.log pnpm exec playwright test e2e/008/US6*
 * The server runs WITHOUT SENTRY_DSN (scenario 8). DB manipulation goes through psql against the E2E database.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIResponse, type Page } from '@playwright/test';
import { test, expect, uniqueUser, evidence, collectRunArtifacts, atPhone, noHorizontalOverflow } from '../support/fixtures';

const SPEC = '008';
const STORY = 'US6';
const DIR = join('qa', 'evidence', SPEC, STORY);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e_us6';
const API_LOG = process.env.E2E_API_LOG || 'qa/.runs/us6-api.log';
const PROJECT = () => test.info().project.name;

test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

// ───────────── helpers ─────────────

function psql(sql: string): string {
  return execFileSync('psql', [E2E_DB, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}
const resetHealthState = () => { psql('delete from ingestion_runs'); psql('delete from notifications'); };
const insertRun = (status: string, finishedMinAgo: number | null, startedMinAgo = (finishedMinAgo ?? 0) + 1, trigger = 'cron') =>
  psql(`insert into ingestion_runs (trigger, status, started_at, finished_at) values ('${trigger}', '${status}', now() - interval '${startedMinAgo} minutes', ${finishedMinAgo == null ? 'null' : `now() - interval '${finishedMinAgo} minutes'`})`);

function logLines(): Record<string, unknown>[] {
  if (!existsSync(API_LOG)) return [];
  return readFileSync(API_LOG, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return { _unparsed: l }; } });
}
const rawLog = () => (existsSync(API_LOG) ? readFileSync(API_LOG, 'utf8') : '');
const RUN = Date.now().toString(36); // unique rids: the server log file outlives a test run
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the log until `pick` finds a line (stdout of the server process is flushed asynchronously). */
async function waitLog(pick: (l: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 40; i++) {
    const hit = logLines().filter(pick);
    if (hit.length) return hit;
    await sleep(150);
  }
  return [];
}

class Transcript {
  private lines: string[] = [];
  constructor(private name: string) { this.add(`# ${name} — project ${PROJECT()} — ${new Date().toISOString()}`); }
  add(line = '') { this.lines.push(line); }
  async http(label: string, res: APIResponse, reqNote: string, ms?: number) {
    this.add(`### ${label}`);
    this.add(`> ${reqNote}`);
    this.add(`< ${res.status()}${ms != null ? `  (${ms} ms)` : ''}`);
    for (const [k, v] of Object.entries(res.headers())) if (['cache-control', 'content-type', 'x-request-id'].includes(k)) this.add(`< ${k}: ${v}`);
    this.add((await res.text()).slice(0, 1200));
    this.add();
  }
  save() {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${this.name}-${PROJECT()}.txt`), this.lines.join('\n') + '\n');
  }
}

/** Screenshot evidence for an API-only criterion: render the captured JSON/text on a page. */
async function shot(page: Page, name: string, title: string, body: string) {
  const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:14px/1.5 ui-monospace,Menlo,monospace;background:#0f172a;color:#e2e8f0"><h1 style="margin:0;padding:12px 16px;font:600 15px system-ui;background:#1e293b">${title}</h1><pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-all">${esc}</pre></body>`);
  return evidence(page, SPEC, STORY, `${name}-${PROJECT()}`);
}

async function health(page: Page) {
  const t0 = Date.now();
  const res = await page.request.get('/api/health');
  return { res, ms: Date.now() - t0, body: await res.json() };
}

async function signedIn(page: Page) {
  const user = uniqueUser('obs');
  const res = await page.request.post('/api/auth/signup', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  return user;
}

// Each test starts from an empty ingestion/notification state (dedicated E2E database).
test.beforeEach(() => { resetHealthState(); });

// ───────────── scenarios ─────────────

test.describe('008/US6 observability', () => {
  test('SC1 healthy system → 200 with the full v2 shape and no-store (also after a real mock-gem sync)', async ({ page }) => {
    const tr = new Transcript('sc1-health-healthy');
    // (a) real sync against tools/mock-gem on a fresh stack
    const user = await signedIn(page);
    const sync = await page.request.post('/api/ingestion/run', { data: { pages: 1 } });
    await tr.http('Manual sync now (mock-gem)', sync, 'POST /api/ingestion/run {"pages":1}');
    expect(sync.status(), 'sync').toBe(200);
    const afterSync = await health(page);
    await tr.http('Health after real sync', afterSync.res, 'GET /api/health');
    expect(afterSync.res.status()).toBe(200);
    expect(afterSync.body.ingestion.state).toBe('ok');
    expect(afterSync.body.ingestion.lastStatus).toMatch(/success|partial/);
    expect(afterSync.body.ingestion.ageMinutes).toBeLessThanOrEqual(1);

    // (b) the exact scenario: last success 25 min ago, no old pending alerts
    resetHealthState();
    insertRun('success', 25);
    const { res, body, ms } = await health(page);
    await tr.http('Health, last success 25 min ago', res, 'GET /api/health', ms);
    tr.save();
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['alerts', 'db', 'ingestion', 'ok', 'reasons', 'version']);
    expect(body).toMatchObject({ ok: true, db: true, reasons: [], alerts: { pendingOlderThan30m: 0 } });
    expect(typeof body.version).toBe('string');
    expect(Object.keys(body.ingestion).sort()).toEqual(['ageMinutes', 'lastStatus', 'lastSuccessAt', 'state']);
    expect(body.ingestion).toMatchObject({ lastStatus: 'success', state: 'ok' });
    expect([25, 26]).toContain(body.ingestion.ageMinutes);
    expect(new Date(body.ingestion.lastSuccessAt).getTime()).toBeGreaterThan(Date.now() - 27 * 60_000);
    await shot(page, 'sc1-health-200', `SC1 · GET /api/health → ${res.status()} · cache-control: ${res.headers()['cache-control']} (user ${user.email})`, JSON.stringify(body, null, 2));
  });

  test('SC1b Settings → Sync health shows the healthy state (desktop)', async ({ page }) => {
    await signedIn(page);
    insertRun('success', 25);
    await page.goto('/settings/sync');
    await expect(page.getByText(/sync health/i).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await evidence(page, SPEC, STORY, `sc1-settings-sync-health-${PROJECT()}`);
  });

  test('SC1c Settings → Sync health at 375 px has no horizontal overflow @mobile', async ({ page }) => {
    await signedIn(page);
    insertRun('success', 25);
    await atPhone(page);
    await page.goto('/settings/sync');
    await page.waitForLoadState('networkidle');
    await noHorizontalOverflow(page);
    await evidence(page, SPEC, STORY, `sc1-settings-sync-health-375-${PROJECT()}`);
  });

  test('SC2 last success 3 h ago → 503 ingestion_stale, ageMinutes 180', async ({ page }) => {
    insertRun('success', 180);
    const tr = new Transcript('sc2-health-stale');
    const { res, body, ms } = await health(page);
    await tr.http('Health, last success 180 min ago', res, 'GET /api/health', ms);
    tr.save();
    expect(res.status()).toBe(503);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(body).toMatchObject({ ok: false, db: true, reasons: ['ingestion_stale'], ingestion: { state: 'stale', lastStatus: 'success' } });
    expect([180, 181]).toContain(body.ingestion.ageMinutes);
    await shot(page, 'sc2-health-503-stale', 'SC2 · GET /api/health → 503 ingestion_stale', JSON.stringify(body, null, 2));
  });

  test('SC3 fresh database, no runs ever → 200 state never, lastSuccessAt null', async ({ page }) => {
    const tr = new Transcript('sc3-health-never');
    expect(psql('select count(*) from ingestion_runs')).toBe('0');
    const { res, body, ms } = await health(page);
    await tr.http('Health on an empty ingestion_runs table', res, 'GET /api/health', ms);
    tr.save();
    expect(res.status()).toBe(200);
    expect(body).toMatchObject({ ok: true, db: true, reasons: [], ingestion: { lastSuccessAt: null, ageMinutes: null, lastStatus: null, state: 'never' } });
    await shot(page, 'sc3-health-never', 'SC3 · fresh DB: GET /api/health → 200 state "never"', JSON.stringify(body, null, 2));
  });

  test('SC4 three emails pending 45 min → 503 alerts_backlog (in-app and young rows are not counted)', async ({ page }) => {
    const user = await signedIn(page);
    insertRun('success', 5);
    const [org_id, id] = psql(`select m.org_id || '|' || m.user_id from memberships m join users u on u.id = m.user_id where u.email = '${user.email}'`).split('|');
    const ins = (channel: string, minAgo: number, key: string) =>
      psql(`insert into notifications (org_id, user_id, channel, kind, title, body, dedupe_key, status, created_at) values ('${org_id}', '${id}', '${channel}', 'deadline', 't', 'b', '${key}', 'pending', now() - interval '${minAgo} minutes')`);
    // control rows that must NOT count
    ins('in_app', 90, 'ctl-inapp'); ins('email', 10, 'ctl-young');
    const tr = new Transcript('sc4-health-alerts-backlog');
    const before = await health(page);
    await tr.http('Health with only control rows (in-app 90 min, email 10 min)', before.res, 'GET /api/health');
    expect(before.res.status()).toBe(200);
    expect(before.body.alerts.pendingOlderThan30m).toBe(0);
    for (const k of ['a', 'b', 'c']) ins('email', 45, `bk-${k}`);
    const { res, body, ms } = await health(page);
    await tr.http('Health with 3 email notifications pending 45 min', res, 'GET /api/health', ms);
    tr.save();
    expect(res.status()).toBe(503);
    expect(body).toMatchObject({ ok: false, reasons: ['alerts_backlog'], alerts: { pendingOlderThan30m: 3 }, ingestion: { state: 'ok' } });
    await shot(page, 'sc4-health-503-backlog', 'SC4 · GET /api/health → 503 alerts_backlog (3 pending emails, 45 min)', JSON.stringify(body, null, 2));
  });

  test('SC5 database not answering → 503 db:false reasons db_unreachable within ~3 s', async ({ page }) => {
    insertRun('success', 5);
    // Hold an ACCESS EXCLUSIVE lock on ingestion_runs for 9 s: health's queries block, the 3 s per-query timeout must fire.
    const holder = spawn('psql', [E2E_DB, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'begin; lock table ingestion_runs in access exclusive mode; select pg_sleep(9); commit;'], { stdio: 'ignore' });
    const done = new Promise<void>((r) => holder.on('exit', () => r()));
    try {
      for (let i = 0; i < 30 && psql(`select count(*) from pg_locks where mode = 'AccessExclusiveLock' and relation = 'ingestion_runs'::regclass`) === '0'; i++) await sleep(100);
      const tr = new Transcript('sc5-health-db-unreachable');
      const { res, body, ms } = await health(page);
      await tr.http('Health while the database does not answer (lock held 9 s)', res, 'GET /api/health', ms);
      tr.add(`elapsed ${ms} ms (requirement: within 3 s query timeout; allowing scheduling slack up to 4.5 s)`);
      tr.save();
      expect(res.status()).toBe(503);
      expect(body).toMatchObject({ ok: false, db: false, reasons: ['db_unreachable'] });
      expect(ms).toBeGreaterThanOrEqual(2800);
      expect(ms).toBeLessThanOrEqual(4500);
      expect(JSON.stringify(body)).not.toMatch(/postgres|ingestion_runs|select |timed out/i);
      await shot(page, 'sc5-health-503-db', `SC5 · DB hung: GET /api/health → 503 after ${ms} ms`, `${ms} ms\n` + JSON.stringify(body, null, 2));
    } finally {
      await done;
    }
    const recovered = await health(page);
    expect(recovered.res.status(), 'health recovers when the database does').toBe(200);
  });

  test('SC6 one JSON request line per request with rid/orgId/userId, no query string, no secrets', async ({ page }) => {
    const user = await signedIn(page);
    const marker = 'SECRETSEARCHTERM';
    const bearer = 'tp_abcdefghijklmnopqrstuvwxyz0123456789';
    const tr = new Transcript('sc6-request-log');
    const res = await page.request.get(`/api/tenders?q=${marker}&token=${bearer}`, { headers: { 'x-request-id': `us6-${RUN}-001` } });
    await tr.http('Signed-in request with query string', res, `GET /api/tenders?q=${marker}&token=… (x-request-id: us6-${RUN}-001)`);
    const rid = res.headers()['x-request-id'];
    expect(rid).toBe(`us6-${RUN}-001`);
    const hits = await waitLog((l) => l.rid === rid && l.msg === 'request');
    expect(hits, 'exactly one request line for this rid').toHaveLength(1);
    const line = hits[0]!;
    tr.add('--- the stdout line ---'); tr.add(JSON.stringify(line));
    expect(Object.keys(line).sort()).toEqual(['level', 'method', 'ms', 'msg', 'orgId', 'path', 'rid', 'status', 'ts', 'userId']);
    expect(line).toMatchObject({ level: 'info', msg: 'request', method: 'GET', path: '/api/tenders', status: res.status() });
    expect(typeof line.ms).toBe('number');
    expect(Number.isNaN(Date.parse(String(line.ts)))).toBe(false);
    expect(line.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(line.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(line)).not.toContain(marker);

    // A bearer-token request and a login must not leak either.
    const bad = await page.request.get('/api/tenders', { headers: { authorization: `Bearer ${bearer}`, 'x-request-id': `us6-${RUN}-002` }, failOnStatusCode: false });
    await tr.http('Request with an Authorization header', bad, 'GET /api/tenders (Authorization: Bearer tp_…)');
    const login = await page.request.post('/api/auth/login', { data: { email: user.email, password: user.password }, headers: { 'x-request-id': `us6-${RUN}-003` } });
    await tr.http('Login', login, 'POST /api/auth/login {email,password}');
    const cookies = (await page.context().cookies()).map((c) => c.value).filter((v) => v.length >= 12);
    await waitLog((l) => l.rid === `us6-${RUN}-003` && l.msg === 'request');
    const all = rawLog();
    tr.add(`log bytes scanned: ${all.length}; session cookie values checked: ${cookies.length}`);
    tr.save();
    for (const secret of [user.password, bearer, marker, ...cookies]) expect(all, `log must not contain ${secret.slice(0, 6)}…`).not.toContain(secret);
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    const badKeys = logLines().flatMap((l) => keys(l)).filter((k) => /password|cookie|authorization|token/i.test(k));
    expect(badKeys, 'no credential-named keys in any log line').toEqual([]);
    await shot(page, 'sc6-request-log-line', 'SC6 · stdout JSON line for the signed-in request (no query string, ids present)', JSON.stringify(line, null, 2) + '\n\n' + 'scanned the full server log: no password / bearer / cookie / query value / credential-named key');
  });

  test('SC7 unexpected route error → 500 internal_error with requestId; ERROR line has rid, orgId, stack', async ({ page }) => {
    const user = await signedIn(page);
    const tr = new Transcript('sc7-unhandled-error');
    psql('alter table tenders rename to tenders_us6_hold');
    let res: APIResponse;
    try {
      res = await page.request.get('/api/tenders', { headers: { 'x-request-id': `us6-${RUN}-500` }, failOnStatusCode: false });
      await tr.http('Route throws (tenders table unavailable → driver error)', res, `GET /api/tenders (x-request-id: us6-${RUN}-500)`);
    } finally {
      psql('alter table tenders_us6_hold rename to tenders');
    }
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
    expect(body.error.details.requestId).toBe(res.headers()['x-request-id']);
    expect(body.error.details.requestId).toBe(`us6-${RUN}-500`);
    expect(JSON.stringify(body)).not.toMatch(/tenders|relation|select|postgres|stack/i);
    const errs = await waitLog((l) => l.level === 'error' && l.rid === `us6-${RUN}-500`);
    expect(errs, 'one ERROR line for the rid').toHaveLength(1);
    const e = errs[0]!;
    tr.add('--- the stdout ERROR line ---'); tr.add(JSON.stringify(e));
    tr.add('Reporter: server runs without SENTRY_DSN → noop reporter; deps.errors.capture() called-once-with-same-rid is asserted by apps/api/test/health.test.ts ("captures unhandled errors with rid/orgId/userId/route…").');
    tr.save();
    expect(e).toMatchObject({ level: 'error', msg: 'unhandled error', rid: `us6-${RUN}-500`, path: '/api/tenders' });
    expect(e.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof e.stack).toBe('string');
    expect(String(e.stack).length).toBeGreaterThan(20);
    // the table is back: the same request now succeeds
    expect((await page.request.get('/api/tenders')).status()).toBe(200);
    await shot(page, 'sc7-500-and-error-log', `SC7 · 500 body + ERROR log line (user ${user.email})`, `HTTP 500  x-request-id: ${res.headers()['x-request-id']}\n${JSON.stringify(body, null, 2)}\n\n${JSON.stringify(e, null, 2)}`);
  });

  test('SC8 without SENTRY_DSN the reporter is a no-op: errors do not crash anything', async ({ page }) => {
    await signedIn(page);
    const tr = new Transcript('sc8-no-dsn-noop');
    const before = rawLog().length;
    psql('alter table tenders rename to tenders_us6_hold');
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 3; i++) statuses.push((await page.request.get('/api/tenders', { failOnStatusCode: false })).status());
    } finally {
      psql('alter table tenders_us6_hold rename to tenders');
    }
    tr.add(`three failing requests → ${statuses.join(', ')}`);
    expect(statuses).toEqual([500, 500, 500]);
    const after = await health(page);
    await tr.http('Health after the errors (server still up)', after.res, 'GET /api/health');
    const fresh = rawLog().slice(before);
    tr.add(`sentry mentions in the server log produced during the test: ${(fresh.match(/sentry/gi) ?? []).length}`);
    tr.save();
    expect(after.res.status()).toBe(200);
    expect(fresh).not.toMatch(/sentry/i);
    expect(await page.request.get('/api/tenders').then((r) => r.status())).toBe(200);
    await shot(page, 'sc8-noop-reporter', 'SC8 · SENTRY_DSN unset: 3× 500, then health 200 and tenders 200 again', `statuses: ${statuses.join(', ')}\nhealth: ${after.res.status()} ${JSON.stringify(after.body)}\nsentry mentions in log: 0\nSENTRY_DSN in server env: ${process.env.SENTRY_DSN ? 'set' : 'unset'}`);
  });

  test('SC9 scheduled run: alerts step throws → others still run, reported with job, JSON summary (API-suite evidence)', async ({ page }) => {
    // The Node e2e server cannot be made to throw inside its `alerts` step without product changes, so this scenario is
    // verified by the API suite (runScheduledJobs with an injected failing step). Here: the server's own scheduled
    // summary format is not triggered (CRON_INTERVAL_MS unset), so we record the suite's passing test names.
    const out = execFileSync('pnpm', ['--filter', '@tp/api', 'exec', 'vitest', 'run', 'test/health.test.ts', '-t', 'runScheduledJobs reports each failed step', '--reporter=verbose'],
      { encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_test_us6' } });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `sc9-scheduled-step-failure-api-${PROJECT()}.txt`), out);
    expect(out).toMatch(/runScheduledJobs reports each failed step with its job name/);
    expect(out).toMatch(/1 passed/);
    await shot(page, 'sc9-scheduled-api-test', 'SC9 · API test: runScheduledJobs reports each failed step with its job name', out.replace(/\u001b\[[0-9;]*m/g, ''));
  });

  test('SC10 docs/runbook.md has Monitors and First 10 minutes for every reason', async ({ page }) => {
    const md = readFileSync('docs/runbook.md', 'utf8');
    const heads = md.split('\n').filter((l) => /^#{2,3} /.test(l));
    const section = (title: string) => {
      const i = md.indexOf(`\n## ${title}`);
      if (i < 0) return '';
      const rest = md.slice(i + 1);
      const j = rest.slice(3).search(/\n## /);
      return j < 0 ? rest : rest.slice(0, j + 3);
    };
    const monitors = section('Monitors');
    const first10 = section('First 10 minutes');
    expect(monitors).toMatch(/\/api\/health/);
    expect(monitors).toMatch(/every 5 minutes/i);
    expect(monitors).toMatch(/2 consecutive/i);
    for (const h of ['`db_unreachable`', '`ingestion_stale`', '`alerts_backlog`', '5xx spike', 'GeM 403/429']) expect(first10, `First 10 minutes → ${h}`).toContain(`### ${h}`);
    const required = ['Monitors', 'First 10 minutes', 'Deploy & rollback', 'Restore drill', 'Secrets', 'Offboarding'];
    const present = required.map((r) => `${heads.some((h) => h.replace(/^#+ /, '').toLowerCase().startsWith(r.toLowerCase())) ? 'PRESENT' : 'ABSENT '}  ${r}`);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `sc10-runbook-sections-${PROJECT()}.txt`), `Headings in docs/runbook.md on this branch:\n${heads.join('\n')}\n\nSections named by scenario 10:\n${present.join('\n')}\n`);
    await shot(page, 'sc10-runbook-sections', 'SC10 · docs/runbook.md headings vs. scenario 10', `${heads.join('\n')}\n\n${present.join('\n')}`);
  });
});
