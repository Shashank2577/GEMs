/**
 * 005 hardening — T075 (#163; NFR-005): axe (WCAG 2.1 A/AA) on /profile and /vault, desktop and phone, with the
 * document drawer and every dialog open. Fails on any serious/critical violation; JSON reports are written to
 * qa/evidence/005/HARDEN/<name>-<project>.axe.json by the shared `a11y()` helper.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, signupViaApi, seedDemo, a11y, evidence005, addPastContract, makePdf } from '../support/fixtures';

const STORY = 'HARDEN';
/**
 * Whole page, shell included. The app-shell menu triggers (UserMenu, OrgSwitcher) were once excluded here for an
 * aria-label / visible-text mismatch; their names are now fixed (sr-only text), so nothing is excluded. They carry
 * stable data-testid hooks (`user-menu`, `org-switcher`) should an exclusion ever be needed again.
 */
const scan = (page: Page, name: string) => a11y(page, name, { spec: '005', story: STORY });
const shot = (page: Page, name: string) => evidence005(page, STORY, `${name}-${test.info().project.name}`);

/** Keyboard activation: on phones the sticky section bar, bottom-sheet dialogs and smooth scrolling make pointer clicks race the layout. */
const press = async (l: Locator) => { await l.focus(); await l.press('Enter'); };

/** Settle: no skeletons and no running CSS transitions (dialogs/sheets animate in). */
async function settle(page: Page) {
  await expect(page.locator('[data-skeleton], .animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  // Finite animations/transitions (dialogs and sheets sliding in) must be done before axe measures contrast.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
}

test.describe('005 a11y — /profile and /vault have no serious or critical axe violations (T075)', () => {
  test('profile: empty org, then demo data, contract dialog and delete confirmation @mobile', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settle(page);
    await scan(page, 'profile-empty');

    await seedDemo(page.request);
    await addPastContract(page.request, { buyer: 'NIC', title: 'Supply of 40 desktops', value: 2_400_000 });
    await page.goto('/profile');
    await expect(page.locator('section#sec-experience')).toBeVisible();
    await settle(page);
    await scan(page, 'profile-filled');
    await shot(page, 'profile-filled');

    const exp = page.locator('section#sec-experience');
    await press(exp.getByRole('button', { name: 'Add contract' }).first());
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await settle(page);
    await scan(page, 'profile-contract-dialog');
    await press(dialog.getByRole('button', { name: 'Cancel' }));
    await expect(dialog).toBeHidden();

    await press(exp.getByRole('button', { name: 'Actions for Supply of 40 desktops' }).first());
    await press(page.getByRole('menuitem', { name: 'Delete' }));
    await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toBeVisible();
    await settle(page);
    await scan(page, 'profile-contract-delete-confirm');
  });

  test('vault: onboarding, demo grid + list, upload dialog @mobile', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/vault');
    await expect(page.getByRole('heading', { level: 1, name: 'Document vault' })).toBeVisible();
    await settle(page);
    await scan(page, 'vault-empty');

    await seedDemo(page.request);
    await page.goto('/vault');
    await expect(page.getByRole('button', { name: /^Open / }).first()).toBeVisible();
    await settle(page);
    await scan(page, 'vault-grid');
    await shot(page, 'vault-grid');

    await page.getByRole('radio', { name: 'List' }).click();
    await settle(page);
    await scan(page, 'vault-list');

    await page.getByRole('button', { name: 'Upload document' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Add a document' })).toBeVisible();
    await settle(page);
    await scan(page, 'vault-upload-dialog');

    // US6 duplicate prompt: the same bytes as a stored document → "Open existing" / "Upload anyway".
    const existing = (await (await page.request.get('/api/vault')).json()).items[0] as { id: string };
    const bytes = await (await page.request.get(`/api/vault/${existing.id}/download`)).body();
    const upload = page.getByRole('dialog', { name: 'Add a document' });
    await upload.locator('input[type=file]').setInputFiles({ name: 'same-file.pdf', mimeType: 'application/pdf', buffer: bytes });
    await press(upload.getByRole('button', { name: 'Upload document' }));
    await expect(page.getByRole('button', { name: 'Upload anyway' })).toBeVisible();
    await settle(page);
    await scan(page, 'vault-duplicate-prompt');
  });

  test('vault: drawer (expired, expiring, valid, with versions), Renew dialog and the delete confirmation @mobile', async ({ page }) => {
    await signupViaApi(page);
    await seedDemo(page.request);
    const docs = (await (await page.request.get('/api/vault')).json()).items as { id: string; status: string; title: string }[];
    // Give the valid document a previous version so the drawer's Versions list renders (US6).
    const valid = docs.find((x) => x.status === 'valid')!;
    const renew = await page.request.put(`/api/vault/${valid.id}/file`, { multipart: { file: { name: 'renewed.pdf', mimeType: 'application/pdf', buffer: await makePdf(2, 'a11y renewal') } } });
    expect(renew.status(), await renew.text()).toBe(200);
    for (const status of ['expired', 'expiring', 'valid']) {
      const d = docs.find((x) => x.status === status);
      expect(d, `a demo document with status ${status}`).toBeTruthy();
      await page.goto(`/vault?doc=${d!.id}`);
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByRole('heading', { name: d!.title })).toBeVisible();
      if (status === 'valid') await expect(drawer.getByText(/Versions/).first()).toBeVisible();
      await settle(page);
      await scan(page, `vault-drawer-${status}`);
      if (status === 'expired') await shot(page, 'vault-drawer-expired');
    }
    await page.getByRole('dialog').getByRole('button', { name: 'Renew' }).click();
    await expect(page.getByRole('dialog', { name: /^Renew “/ })).toBeVisible();
    await settle(page);
    await scan(page, 'vault-renew-dialog');
    await press(page.getByRole('dialog', { name: /^Renew “/ }).getByRole('button', { name: 'Cancel' }));
    await expect(page.getByRole('dialog', { name: /^Renew “/ })).toBeHidden();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
    await expect(page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /delete/i }))).toBeVisible();
    await settle(page);
    await scan(page, 'vault-delete-confirm');
  });
});
