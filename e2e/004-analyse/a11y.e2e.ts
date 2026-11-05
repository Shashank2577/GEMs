/**
 * Accessibility sweep for spec 004 (T053; FR-056, NFR-006): axe (WCAG 2.1 A/AA) on the tender page's
 * Analysis, Requirements, Documents and History tabs and the Override dialog, light + dark, at 375 and
 * 1440 px. Fails on any serious/critical violation (all combinations are scanned before failing).
 * Axe JSON per scan: qa/evidence/004/US3/a11y-*.axe.json.
 */
import type { Page } from '@playwright/test';
import { a11y } from '../support/fixtures';
import { SPEC, analyse, collectRunArtifacts, expect, openTargetTender, setProfile, signupViaApi, test, uploadFixtureViaApi } from './support';

const STORY = 'US3';
test.afterEach(async ({ page }) => { await collectRunArtifacts(SPEC, STORY, page); });

const VIEWPORTS = [{ name: '375', width: 375, height: 800 }, { name: '1440', width: 1440, height: 900 }] as const;
const THEMES = ['light', 'dark'] as const;
const TABS = ['analysis', 'requirements', 'documents', 'history'] as const;

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => localStorage.setItem('tp-theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /(^|\s)dark(\s|$)/ : /^(?!.*\bdark\b).*$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(400); // theme-switching transition + entry animations settle before axe measures contrast
}

test('axe: Analysis, Requirements, Documents, History tabs and Override dialog, light/dark, 375/1440 px', async ({ page }) => {
  test.setTimeout(420_000);
  await signupViaApi(page);
  await setProfile(page.request, { legalName: 'Sharma Infotech Pvt Ltd', mseCategory: 'small', miiClass: 'class_1', maxEmdCapacity: 500_000 });
  const t = await openTargetTender(page);
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  await analyse(page.request, t.id);

  const failures: string[] = [];
  const scan = async (name: string) => {
    try { await a11y(page, name, { spec: SPEC, story: STORY }); } catch (e) { failures.push(`${name}: ${String((e as Error).message).slice(0, 1500)}`); }
  };

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const theme of THEMES) {
      const tag = `${theme}-${vp.name}`;
      for (const tab of TABS) {
        await page.goto(`/tenders/${t.id}${tab === 'analysis' ? '' : `?tab=${tab}`}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await setTheme(page, theme);
        await expect(page.locator('[role="tabpanel"][data-state="active"]')).toBeVisible();
        await scan(`a11y-${tab}-${tag}`);
      }
      await page.goto(`/tenders/${t.id}`);
      await setTheme(page, theme);
      await page.getByRole('button', { name: /^Override/ }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(400);
      await scan(`a11y-override-dialog-${tag}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
    }
  }
  expect(failures, failures.join('\n\n')).toEqual([]);
});

test('axe: failed re-analysis warning, truncation note and in-progress banner (routed API states), light/dark', async ({ page }) => {
  test.setTimeout(240_000);
  await signupViaApi(page);
  await setProfile(page.request, { legalName: 'Sharma Infotech Pvt Ltd', mseCategory: 'small', miiClass: 'class_1', maxEmdCapacity: 500_000 });
  const t = await openTargetTender(page);
  await uploadFixtureViaApi(page.request, t.id, 'go-it-services');
  const real = await analyse(page.request, t.id);
  const at = new Date().toISOString();
  // The server states are covered by API tests; here the real result is served with a failed/running lastAttempt and a capped document.
  let attempt: { status: 'failed' | 'running'; error: string | null; at: string } = { status: 'failed', error: 'ECONNREFUSED 10.0.0.4:5432', at };
  await page.route(`**/api/tenders/${t.id}/analysis`, (route) => route.fulfill({
    json: { ...real, documents: (real.documents ?? []).map((d) => ({ ...d, pageCount: 150, totalPages: 320 })), lastAttempt: attempt },
  }));

  const failures: string[] = [];
  const scan = async (name: string) => {
    try { await a11y(page, name, { spec: SPEC, story: STORY }); } catch (e) { failures.push(`${name}: ${String((e as Error).message).slice(0, 1500)}`); }
  };
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const theme of THEMES) {
      const tag = `${theme}-${vp.name}`;
      attempt = { status: 'failed', error: 'ECONNREFUSED 10.0.0.4:5432', at };
      await page.goto(`/tenders/${t.id}`);
      await setTheme(page, theme);
      const warning = page.getByRole('status').filter({ hasText: 'The last re-analysis failed' });
      await expect(warning).toBeVisible();
      await expect(warning).not.toContainText('ECONNREFUSED'); // S6: raw errors never reach the page
      await expect(page.getByTestId('truncated-note')).toContainText('only the first 150 of 320 pages were read');
      await scan(`a11y-failed-warning-${tag}`);
      attempt = { status: 'running', error: null, at };
      await page.goto(`/tenders/${t.id}`);
      await setTheme(page, theme);
      await expect(page.getByText('Analysis in progress…')).toBeVisible();
      await scan(`a11y-in-progress-${tag}`);
    }
  }
  expect(failures, failures.join('\n\n')).toEqual([]);
});
