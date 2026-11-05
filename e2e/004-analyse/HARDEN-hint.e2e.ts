/**
 * QA check for 004/HARDEN T096: experience "incorporated N years ago" hint on a failed experience factor.
 * Screenshots land in qa/evidence/004/HARDEN/.
 */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { SPEC, evidence, expect, setProfile, signupViaApi, test, uploadFixtureViaApi } from './support';

const STORY = 'HARDEN';
const ev = (page: Page, name: string) => evidence(page, SPEC, STORY, `${name}-${test.info().project.name}`);
const E2E_DB = process.env.E2E_DATABASE_URL || 'postgres://tp:tp@localhost:5433/tenderpilot_e2e';
const psql = (sql: string) => execFileSync('psql', [E2E_DB, '-tAqc', sql], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
const yearsAgo = (y: number, extraDays = 0) => new Date(Date.now() - (y * 365.25 + extraDays) * 86_400_000).toISOString().slice(0, 10);

test('T096: contracts give 2 years, incorporation 8 years, bid needs 5 -> fail with the incorporation hint', async ({ page }) => {
  await signupViaApi(page);
  await setProfile(page.request, { legalName: 'Hint Traders', incorporationDate: yearsAgo(8), financials: [{ fy: '2024-25', turnover: 9_000_000 }], maxEmdCapacity: 100_000 });
  const pc = await page.request.post('/api/past-contracts', { data: { buyer: 'IOCL', buyerType: 'central', title: 'Helpdesk support', value: 5_000_000, startDate: yearsAgo(2), endDate: yearsAgo(0) } });
  expect(pc.ok(), await pc.text()).toBeTruthy();
  const src = `qa-harden-${Date.now().toString(36)}`;
  const id = psql(`insert into tenders (source,bid_number,title,category,state,source_url,content_hash,status,end_at) values ('${src}','GEM/2026/B/6140019','IT Helpdesk Support Services',null,'Maharashtra','https://example.invalid/${src}','${src}-h','open', now() + interval '20 days') returning id;`);
  await uploadFixtureViaApi(page.request, id, 'nogo-experience');
  const res = await page.request.post(`/api/tenders/${id}/analyse`);
  expect(res.status(), await res.text()).toBe(201);
  const exp = ((await res.json()) as { factors: { key: string; status: string; detail: string }[] }).factors.find((f) => f.key === 'experience')!;
  console.log('EXPERIENCE_DETAIL', exp.status, exp.detail);
  expect(exp.status).toBe('fail');
  expect(exp.detail).toMatch(/^You have 2(\.\d)? years of experience; the bid needs 5 years\. \(incorporated 8(\.\d)? years ago — add older contracts as proof\)$/);

  await page.goto(`/tenders/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const row = page.locator('ul.divide-y > li').filter({ hasText: /^Years of experience/ }).first();
  await expect(row).toContainText('(incorporated 8');
  await expect(row).toContainText('add older contracts as proof)');
  await row.scrollIntoViewIfNeeded();
  await ev(page, 'hint');
});
