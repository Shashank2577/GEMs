import { test, expect, signupViaApi, seedDemo, evidence, collectRunArtifacts } from '../support/fixtures';

test.afterEach(async ({ page }) => { await collectRunArtifacts('000-smoke', 'smoke', page); });

test('health, signup, demo seed and dashboard render @mobile', async ({ page }) => {
  const health = await page.request.get('/api/health');
  expect(health.ok()).toBeTruthy();

  await signupViaApi(page);
  await seedDemo(page.request);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await evidence(page, '000-smoke', 'smoke', `dashboard-${test.info().project.name}`);

  await page.goto('/tenders');
  await expect(page.getByText(/GEM\/20\d\d\/B\//).first()).toBeVisible();
  await evidence(page, '000-smoke', 'smoke', `feed-${test.info().project.name}`);
});
