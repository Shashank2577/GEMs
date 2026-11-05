#!/usr/bin/env node
/**
 * Lighthouse check for the marketing landing page (007/T071, NFR-003, SC-006).
 *
 * Runs Lighthouse (mobile emulation, the Lighthouse default) against `/` N times, takes the per-category MEDIAN,
 * writes `summary.json` and the HTML report of the median-performance run to qa/evidence/007/US6/lighthouse/, and
 * exits 1 if any median is below its threshold (Performance >= 85, Accessibility >= 95, Best Practices >= 90, SEO >= 90)
 * or if the median LCP is not < 2500 ms or the median CLS is not < 0.1 (NFR-003 / SC-006).
 *
 * Usage:  node scripts/lighthouse-landing.mjs [--url http://localhost:8788/] [--runs 3] [--out <dir>]
 * Needs a running server that serves the built SPA (pnpm --filter @tp/web build, then the Node API server) and the
 * Chromium that Playwright ships (PLAYWRIGHT_BROWSERS_PATH / `pnpm exec playwright install chromium`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

export const THRESHOLDS = { performance: 85, accessibility: 95, 'best-practices': 90, seo: 90 };
/** NFR-003 / SC-006 (mobile simulation, median of runs): LCP < 2.5 s and CLS < 0.1. Upper bounds, exclusive. */
export const METRIC_LIMITS = { lcpMs: 2500, cls: 0.1 };

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function main() {
  const url = arg('url', 'http://localhost:8788/');
  const runs = Number(arg('runs', '3'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(root, arg('out', 'qa/evidence/007/US6/lighthouse'));
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch({ args: ['--remote-debugging-port=9223'] });
  const results = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const r = await lighthouse(url, { port: 9223, output: 'html', logLevel: 'error', onlyCategories: Object.keys(THRESHOLDS) });
      const scores = Object.fromEntries(Object.entries(r.lhr.categories).map(([k, v]) => [k, Math.round((v.score ?? 0) * 100)]));
      const a = r.lhr.audits;
      results.push({
        run: i, scores, report: r.report,
        metrics: { lcpMs: Math.round(a['largest-contentful-paint'].numericValue), tbtMs: Math.round(a['total-blocking-time'].numericValue), cls: Number(a['cumulative-layout-shift'].numericValue.toFixed(3)), fcpMs: Math.round(a['first-contentful-paint'].numericValue) },
        failedAudits: Object.values(a).filter((x) => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== 'informative' && x.scoreDisplayMode !== 'notApplicable').map((x) => `${x.id}: ${x.score}`),
        formFactor: r.lhr.configSettings.formFactor, lighthouseVersion: r.lhr.lighthouseVersion,
      });
      console.log(`run ${i}/${runs}`, JSON.stringify(scores));
    }
  } finally {
    await browser.close();
  }

  const medians = Object.fromEntries(Object.keys(THRESHOLDS).map((k) => [k, median(results.map((r) => r.scores[k]))]));
  const checks = Object.fromEntries(Object.entries(THRESHOLDS).map(([k, min]) => [k, { median: medians[k], min, pass: medians[k] >= min }]));
  const metricChecks = {
    lcpMs: { median: median(results.map((r) => r.metrics.lcpMs)), max: METRIC_LIMITS.lcpMs },
    cls: { median: Number(median(results.map((r) => r.metrics.cls)).toFixed(3)), max: METRIC_LIMITS.cls },
  };
  for (const c of Object.values(metricChecks)) c.pass = c.median < c.max;
  const pass = Object.values(checks).every((c) => c.pass) && Object.values(metricChecks).every((c) => c.pass);
  const sorted = [...results].sort((a, b) => a.scores.performance - b.scores.performance);
  const medianRun = sorted[sorted.length >> 1];

  const summary = {
    url, formFactor: results[0].formFactor, lighthouseVersion: results[0].lighthouseVersion, runs,
    generatedAt: new Date().toISOString(), pass, checks, metricChecks,
    perRun: results.map(({ run, scores, metrics, failedAudits }) => ({ run, scores, metrics, failedAudits })),
    htmlReport: 'report.html (the median-performance run)',
  };
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(resolve(out, 'report.html'), medianRun.report);
  console.log(JSON.stringify({ checks, metricChecks }, null, 2));
  console.log(pass ? 'PASS' : 'FAIL: a median score or metric (LCP / CLS) misses its threshold');
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
