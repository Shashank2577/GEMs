/**
 * 007 / US7 — Accessibility & responsiveness sweep (story #298, task T073 / #347; FR-094, NFR-004, SC-003, SC-004).
 *
 * The 11 core pages (landing, login, signup, onboarding, dashboard, tenders, pipeline, vault, profile, settings,
 * notifications) at 375×812 and 1440×900, in light and dark. Each combination runs axe (WCAG 2.1 A/AA — serious or
 * critical violations fail, JSON saved to qa/evidence/007/US7/axe/), asserts no horizontal page scroll, and checks the
 * WCAG 2.5.8 target size (≥ 24×24 CSS px for buttons/links/form controls, ≥ 44×44 for the mobile tab bar).
 * Signed-in pages use a demo-seeded org so lists, charts and the Kanban board are populated.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, signupViaApi, seedDemo, noHorizontalOverflow, a11y } from '../support/fixtures';

const STORY = 'US7';
const AXE_DIR = join('qa', 'evidence', '007', STORY, 'axe');

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

interface CorePage { name: string; path: string; auth: boolean; ready: (page: Page) => Promise<void> }

const heading = (page: Page, re?: RegExp) => (re ? page.getByRole('heading', { name: re }).first() : page.getByRole('heading').first());

const PAGES: CorePage[] = [
  { name: 'landing', path: '/', auth: false, ready: async (p) => { await expect(p.locator('#lp-shell')).toHaveCount(0); await expect(p.getByRole('heading', { level: 1 })).toBeVisible(); } },
  { name: 'login', path: '/login', auth: false, ready: async (p) => { await expect(p.getByLabel(/email/i)).toBeVisible(); } },
  { name: 'signup', path: '/signup', auth: false, ready: async (p) => { await expect(p.getByLabel(/email/i).first()).toBeVisible(); } },
  { name: 'onboarding', path: '/onboarding', auth: true, ready: async (p) => { await expect(heading(p)).toBeVisible(); } },
  { name: 'dashboard', path: '/dashboard', auth: true, ready: async (p) => { await expect(p.locator('#main')).toBeVisible(); await expect(heading(p)).toBeVisible(); } },
  { name: 'tenders', path: '/tenders', auth: true, ready: async (p) => { await expect(heading(p, /tenders/i)).toBeVisible(); } },
  { name: 'pipeline', path: '/pipeline', auth: true, ready: async (p) => { await expect(heading(p, /pipeline/i)).toBeVisible(); } },
  { name: 'vault', path: '/vault', auth: true, ready: async (p) => { await expect(heading(p, /vault/i)).toBeVisible(); } },
  { name: 'profile', path: '/profile', auth: true, ready: async (p) => { await expect(heading(p, /profile/i)).toBeVisible(); } },
  { name: 'settings', path: '/settings', auth: true, ready: async (p) => { await expect(heading(p, /settings/i)).toBeVisible(); } },
  { name: 'notifications', path: '/notifications', auth: true, ready: async (p) => { await expect(heading(p, /notifications/i)).toBeVisible(); } },
];

// eslint-disable-next-line no-control-regex
const flat = (e: unknown) => String((e as Error).message).replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').slice(0, 1200);

interface SmallTarget { selector: string; text: string; width: number; height: number; min: number }

/**
 * Interactive targets smaller than the minimum. 24×24 for everything visible and interactive, 44×44 inside the tab bar.
 * Exempt (WCAG 2.5.8): inline links inside a sentence, visually-hidden elements, and disabled controls.
 */
async function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate(() => {
    const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=combobox], [tabindex]:not([tabindex="-1"])';
    const out: { selector: string; text: string; width: number; height: number; min: number }[] = [];
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
      return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true } as never)) continue;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // visually hidden (sr-only skip link / checkbox inputs overlaid by their styled box): 1px clip boxes
      if (r.width <= 1 || r.height <= 1) continue;
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue;
      if (el.closest('[data-sonner-toaster]')) continue;
      // inline link within running text is exempt
      if (el.tagName === 'A' && cs.display === 'inline') {
        const p = el.parentElement;
        if (p && /\S/.test((p.textContent ?? '').replace(el.textContent ?? '', ''))) continue;
      }
      // Pointer target can be a wrapping label (custom checkbox / switch): measure the largest of self and label
      let w = r.width, h = r.height;
      const label = el.closest('label');
      if (label) { const lr = label.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); }
      const inTabBar = !!el.closest('nav[aria-label="Primary"]');
      const min = inTabBar ? 44 : 24;
      if (w + 0.5 < min || h + 0.5 < min) {
        out.push({ selector: describe(el), text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), width: Math.round(w * 10) / 10, height: Math.round(h * 10) / 10, min });
      }
    }
    return out;
  });
}

test.beforeAll(() => { mkdirSync(AXE_DIR, { recursive: true }); });

const SUMMARY: Record<string, unknown> = {};
test.afterAll(() => {
  mkdirSync(AXE_DIR, { recursive: true });
  writeFileSync(join(AXE_DIR, 'summary.json'), JSON.stringify(SUMMARY, null, 2));
});

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    for (const pg of PAGES) {
      test(`US7-8/9 ${pg.name} @ ${vp.name}px ${theme}: axe, no horizontal overflow, target sizes`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.addInitScript((t) => {
          try { localStorage.setItem('tp-theme', t); sessionStorage.setItem('tp:onboarding-redirected', '1'); } catch { /* ignore */ }
        }, theme);
        if (pg.auth) {
          await signupViaApi(page);
          await seedDemo(page.request);
        }
        await page.goto(pg.path);
        await pg.ready(page);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
        // let entry animations finish so contrast is measured on settled colours
        await page.waitForTimeout(400);

        const name = `${pg.name}-${vp.name}-${theme}`;
        // Collect every finding for the page (axe, overflow, target sizes) so one run lists them all, then assert once.
        const problems: unknown[] = [];
        SUMMARY[name] = { axeFailed: true };
        try {
          const results = await a11y(page, name, { story: `${STORY}/axe`, spec: '007' });
          SUMMARY[name] = { violations: results.violations.length, serious: results.violations.filter((v) => v.impact === 'serious').length };
        } catch (e) {
          problems.push({ axe: flat(e) });
        }
        try { await noHorizontalOverflow(page); } catch (e) { problems.push({ overflow: flat(e) }); }

        const small = await smallTargets(page);
        if (small.length) problems.push({ smallTargets: small });

        if (vp.width < 768 && pg.auth && pg.name !== 'onboarding') {
          const tabs = page.locator('nav[aria-label="Primary"] a, nav[aria-label="Primary"] button');
          expect(await tabs.count()).toBeGreaterThanOrEqual(5);
          for (const box of await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
            if (box.width < 44 || box.height < 44) problems.push({ tabBarTarget: box });
          }
        }
        expect(problems, `a11y / responsiveness findings on ${name}`).toEqual([]);
      });
    }
  }
}
