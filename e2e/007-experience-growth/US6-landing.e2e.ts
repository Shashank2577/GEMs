/**
 * 007 / US6 — Marketing landing page & pricing (story #297, QA task T072 / #346).
 *
 * One test per acceptance scenario US6-1 … US6-12 (specs/007-experience-growth/spec.md) plus FR-081 section order,
 * the static hero shell hand-over (#lp-shell must be gone after React paints, no duplicate landmarks, and the shell's
 * links must exist with JavaScript disabled) and the Constitution-I copy guard. UI scenarios go through the real UI,
 * head/robots/sitemap through real HTTP. Each test writes named screenshots to qa/evidence/007/US6/ and keeps its
 * video there (collectRunArtifacts). `@mobile` tests also run in the Pixel 7 project; on desktop they force 375 px.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, signupViaApi, uniqueUser, evidence007, collectRunArtifacts, noHorizontalOverflow, atPhone,
} from '../support/fixtures';

const STORY = 'US6';
const EVID_DIR = join('qa', 'evidence', '007', STORY);
const H1 = 'Win more GeM bids. Spend minutes, not nights, on each one.';
const TITLE = 'TenderPilot — GeM tender co-pilot for Indian sellers';
const MAILTO = 'mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise';
const NOTE = 'Prices exclude 18% GST. Every plan starts with a 14-day free trial — 10 analyses and 1 GB of vault included.'; // 008 review S6
const FAQ_Q = 'Will TenderPilot submit bids on GeM for me?';

test.afterEach(async ({ page }) => { await collectRunArtifacts('007', STORY, page); });

function saveText(name: string, text: string) {
  mkdirSync(EVID_DIR, { recursive: true });
  writeFileSync(join(EVID_DIR, name), text);
}

/** Open `/` signed-out and wait for React to paint (shell removed). */
async function openLanding(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.locator('#lp-shell')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const topOf = async (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);

// ───────────── US6-1 (FR-080) ─────────────

test('US6-1 signed-in users never see /, /login, /signup — they are redirected to /dashboard or a safe ?next=', async ({ page }) => {
  await signupViaApi(page); // owner session cookie on this context
  // A brand-new org is sent from /dashboard to /onboarding once per browser session (007/US3). Take that detour first so
  // the redirects below are not raced by it.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('tp:onboarding-redirected'))).not.toBeNull();
  const trace: Record<string, string> = {};
  const cases: [string, RegExp, string][] = [
    ['/', /\/dashboard$/, 'plain /'],
    ['/login', /\/dashboard$/, 'plain /login'],
    ['/signup', /\/dashboard$/, 'plain /signup'],
    ['/?next=/tenders', /\/tenders$/, '/ with safe same-origin next'],
    ['/login?next=/pipeline', /\/pipeline$/, '/login with safe next'],
    ['/signup?next=/vault', /\/vault$/, '/signup with safe next'],
    ['/?next=//evil.com', /\/dashboard$/, '// protocol-relative next ignored (/)'],
    ['/login?next=//evil.com', /\/dashboard$/, '// next ignored (/login)'],
    ['/signup?next=//evil.com/x', /\/dashboard$/, '// next ignored (/signup)'],
    ['/login?next=https://evil.com', /\/dashboard$/, 'absolute URL next ignored'],
    ['/login?next=/\\evil.com', /\/dashboard$/, 'backslash next ignored'],
  ];
  for (const [from, want, why] of cases) {
    await page.goto(from);
    await expect(page, `${from} (${why})`).toHaveURL(want);
    expect(new URL(page.url()).host, 'never leaves the origin').toBe(new URL(test.info().project.use.baseURL!).host);
    trace[from] = new URL(page.url()).pathname;
  }
  await expect(page.getByRole('heading', { level: 1, name: H1 })).toHaveCount(0);
  saveText('us6-1-redirects.json', JSON.stringify(trace, null, 2));
  await evidence007(page, STORY, 'us6-1-signed-in-lands-on-dashboard');
});

// ───────────── US6-2 (+ shell hand-over) ─────────────

test('US6-2 hero: h1, account-safe pill → #control, CTAs and ticks', async ({ page }) => {
  await openLanding(page);
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toHaveText(H1);
  await expect(page).toHaveTitle(TITLE);

  const pill = page.getByRole('link', { name: /Account-safe: never auto-submits on GeM/ });
  await expect(pill).toHaveAttribute('href', '#control');
  const main = page.getByRole('main');
  const cta = main.getByRole('link', { name: 'Start free trial' }).first();
  await expect(cta).toHaveAttribute('href', '/signup');
  const how = main.getByRole('link', { name: 'See how it works' });
  await expect(how).toHaveAttribute('href', '#how');
  for (const tick of ['14-day free trial', 'No card needed', 'Set up in 5 minutes']) {
    await expect(main.getByText(tick, { exact: true }).first()).toBeVisible();
  }
  await evidence007(page, STORY, 'us6-2-hero');

  await pill.click();
  await expect(page).toHaveURL(/#control$/);
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
  await expect(page).toHaveURL(/\/signup$/);
});

test('US6-2b static hero shell hands over cleanly: no #lp-shell, one h1/main/banner/contentinfo, no duplicate ids', async ({ page }) => {
  const shellSeen = await (async () => {
    // The shell is in the served HTML (that is what paints LCP); capture it before React replaces it.
    const html = await (await page.request.get('/')).text();
    return { inHtml: html.includes('id="lp-shell"'), h1InHtml: html.includes(H1.split('.')[0]) };
  })();
  expect(shellSeen.inHtml, 'served HTML contains #lp-shell').toBe(true);
  await openLanding(page);
  // Give any late removal a chance, then assert it is stable.
  await page.waitForTimeout(1000);
  await expect(page.locator('#lp-shell')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Account-safe: never auto-submits/ })).toHaveCount(1);
  const dupIds = await page.evaluate(() => {
    const seen = new Map<string, number>();
    document.querySelectorAll('[id]').forEach((e) => seen.set(e.id, (seen.get(e.id) ?? 0) + 1));
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  expect(dupIds, 'duplicate ids').toEqual([]);
  // The shell is an overlay: nothing may sit above the real page after hand-over (top element at hero CTA is the CTA).
  const covered = await page.getByRole('main').getByRole('link', { name: 'Start free trial' }).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && (el === hit || el.contains(hit)));
  });
  expect(covered, 'hero CTA is not covered by an overlay').toBe(false);
  saveText('us6-2b-shell-handover.json', JSON.stringify({ ...shellSeen, shellAfterLoad: 0 }, null, 2));
});

test('US6-2c with JavaScript disabled the static shell still renders its h1 and links', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL, viewport: { width: 375, height: 812 }, recordVideo: { dir: test.info().outputPath('nojs'), size: { width: 375, height: 812 } } });
  const page = await ctx.newPage();
  await page.goto('/');
  const shell = page.locator('#lp-shell');
  await expect(shell).toBeVisible();
  await expect(shell.getByRole('heading', { level: 1 })).toHaveText(H1);
  await expect(shell.getByRole('link', { name: 'Start free trial' })).toHaveAttribute('href', '/signup');
  await expect(shell.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '#how');
  await expect(shell.getByRole('link', { name: /Account-safe/ })).toHaveAttribute('href', '#control');
  await expect(page.locator('#root')).toBeEmpty();
  await evidence007(page, STORY, 'us6-2c-no-js-shell');
  await ctx.close();
});

// ───────────── FR-081 order ─────────────

test('FR-081 sections appear in order: nav, hero, built for, how, compliance, metrics, personas, pricing, faq, final CTA, footer', async ({ page }) => {
  await openLanding(page);
  const marks: [string, string][] = [
    ['nav', 'header'],
    ['hero', 'h1'],
    ['built-for', 'section[aria-label="Who it\'s for"]'],
    ['how', '#how'],
    ['control', '#control'],
    ['metrics', 'section[aria-label="Results"]'],
    ['teams', '#teams'],
    ['pricing', '#pricing'],
    ['faq', '#faq'],
    ['final-cta', 'h2:has-text("Your next GeM win is already published.")'],
    ['footer', 'footer'],
  ];
  const tops: Record<string, number> = {};
  for (const [k, sel] of marks) tops[k] = await topOf(page, sel);
  const order = Object.entries(tops).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  saveText('fr-081-section-order.json', JSON.stringify({ expected: marks.map(([k]) => k), observed: order, tops }, null, 2));
  expect(order).toEqual(marks.map(([k]) => k));
  await evidence007(page, STORY, 'fr-081-full-landing');
});

// ───────────── US6-3 ─────────────

test('US6-3 desktop nav links scroll to their sections and the heading clears the sticky nav', async ({ page }) => {
  await openLanding(page);
  const links: [string, string][] = [['How it works', '#how'], ['Compliance', '#control'], ['For teams', '#teams'], ['Pricing', '#pricing'], ['FAQ', '#faq']];
  const seen: Record<string, unknown> = {};
  for (const [label, hash] of links) {
    await nav(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await page.waitForTimeout(900); // smooth scroll settles
    const m = await page.evaluate((h) => {
      const sec = document.querySelector(h)!;
      const head = sec.querySelector('h2')!;
      const bar = document.querySelector('header')!.getBoundingClientRect();
      return { barBottom: Math.round(bar.bottom), headTop: Math.round(head.getBoundingClientRect().top), scMarginTop: getComputedStyle(sec).scrollMarginTop, sectionTop: Math.round(sec.getBoundingClientRect().top) };
    }, hash);
    seen[hash] = m;
    expect(m.headTop, `${hash} heading must sit below the sticky nav (${m.barBottom}px)`).toBeGreaterThanOrEqual(m.barBottom);
    expect(m.headTop, `${hash} heading must be on screen`).toBeLessThan(500);
    expect(parseFloat(m.scMarginTop), `${hash} scroll-margin-top`).toBeGreaterThan(0);
    if (hash === '#pricing') await evidence007(page, STORY, 'us6-3-pricing-anchor-clear-of-nav');
  }
  saveText('us6-3-anchors.json', JSON.stringify(seen, null, 2));
  const signIn = nav(page).locator('xpath=ancestor::header').getByRole('link', { name: 'Sign in' });
  await expect(signIn).toHaveAttribute('href', '/login');
  await expect(nav(page).locator('xpath=ancestor::header').getByRole('link', { name: 'Start free trial' })).toHaveAttribute('href', '/signup');
});

// ───────────── US6-4 ─────────────

test('US6-4 @mobile 375 px menu opens/closes, has the five links + Sign in + Start free trial, and a link closes it', async ({ page }) => {
  await atPhone(page);
  await openLanding(page);
  await noHorizontalOverflow(page);
  const open = page.getByRole('button', { name: 'Open menu' });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
  await open.click();
  const close = page.getByRole('button', { name: 'Close menu' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  const mobile = page.getByRole('navigation', { name: 'Mobile' });
  await expect(mobile).toBeVisible();
  for (const l of ['How it works', 'Compliance', 'For teams', 'Pricing', 'FAQ']) await expect(mobile.getByRole('link', { name: l, exact: true })).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: 'Sign in' }).last()).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: 'Start free trial' }).last()).toBeVisible();
  await evidence007(page, STORY, 'us6-4-mobile-menu-open');
  await mobile.getByRole('link', { name: 'Pricing', exact: true }).click();
  await expect(page).toHaveURL(/#pricing$/);
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(900);
  await expect(page.locator('#pricing h2')).toBeInViewport();
  mkdirSync(EVID_DIR, { recursive: true });
  await page.locator('#pricing').screenshot({ path: join(EVID_DIR, 'us6-4-mobile-pricing.png') }); // the section only (full-page phone shots are tens of thousands of px)
});

// ───────────── US6-5 ─────────────

test('US6-5 pricing: Starter ₹2,999, Pro ₹7,999 (Most popular), Enterprise Custom, GST note, CTA destinations', async ({ page }) => {
  await openLanding(page);
  const pricing = page.locator('#pricing');
  await pricing.scrollIntoViewIfNeeded();
  await expect(pricing.getByText(NOTE, { exact: true })).toBeVisible();
  const card = (name: string) => pricing.locator('div.rounded-2xl', { has: page.getByRole('heading', { name, exact: true }) });
  const texts: Record<string, string> = {};
  for (const [name, price, per] of [['Starter', '₹2,999', true], ['Pro', '₹7,999', true], ['Enterprise', 'Custom', false]] as const) {
    const c = card(name);
    await expect(c).toBeVisible();
    texts[name] = (await c.innerText()).replace(/\s+/g, ' ');
    await expect(c.getByText(price, { exact: true })).toBeVisible();
    if (per) await expect(c.getByText('/month', { exact: true })).toBeVisible(); else await expect(c.getByText('/month')).toHaveCount(0);
  }
  await expect(card('Pro').getByText('Most popular')).toBeVisible();
  await expect(card('Starter').getByText('Most popular')).toHaveCount(0);
  await expect(card('Enterprise').getByText('Most popular')).toHaveCount(0);
  await expect(pricing.getByText('Most popular')).toHaveCount(1);
  await expect(card('Starter').getByRole('link', { name: 'Start free trial' })).toHaveAttribute('href', '/signup?plan=starter');
  await expect(card('Pro').getByRole('link', { name: 'Start free trial' })).toHaveAttribute('href', '/signup?plan=pro');
  await expect(card('Enterprise').getByRole('link', { name: 'Talk to sales' })).toHaveAttribute('href', MAILTO);
  // US6-5: Starter/Pro CTAs go to /signup (plan param is US6-11)
  await card('Starter').getByRole('link', { name: 'Start free trial' }).click();
  await expect(page).toHaveURL(/\/signup(\?|$)/);
  saveText('us6-5-pricing-text.json', JSON.stringify({ note: NOTE, cards: texts }, null, 2));
  await page.goBack();
  await expect(page.locator('#pricing')).toBeVisible();
  await page.locator('#pricing').scrollIntoViewIfNeeded();
  await evidence007(page, STORY, 'us6-5-pricing-desktop');
});

test('US6-5 @mobile pricing stacks at 375 px without horizontal overflow', async ({ page }) => {
  await atPhone(page);
  await openLanding(page);
  await page.locator('#pricing').scrollIntoViewIfNeeded();
  for (const n of ['Starter', 'Pro', 'Enterprise']) await expect(page.locator('#pricing').getByRole('heading', { name: n, exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  mkdirSync(EVID_DIR, { recursive: true });
  await page.locator('#pricing').screenshot({ path: join(EVID_DIR, 'us6-5-pricing-mobile.png') }); // the section only (full-page phone shots are tens of thousands of px)
});

// ───────────── US6-6 ─────────────

test('US6-6 FAQ: keyboard user tabs to the trigger, Enter expands the answer, aria-expanded="true"', async ({ page }) => {
  await openLanding(page);
  const trigger = page.getByRole('button', { name: FAQ_Q });
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // Reach it by keyboard only: focus the element before it and press Tab, else walk Tab from the section.
  await page.locator('#faq h2').evaluate((h) => { (h as HTMLElement).setAttribute('tabindex', '-1'); (h as HTMLElement).focus(); });
  let tabs = 0;
  while (tabs < 5 && !(await trigger.evaluate((el) => el === document.activeElement))) { await page.keyboard.press('Tab'); tabs++; }
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const answer = page.getByText(/^No — and that’s deliberate\./);
  await expect(answer).toBeVisible();
  await evidence007(page, STORY, 'us6-6-faq-expanded');
  await page.keyboard.press('Space');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  saveText('us6-6-faq.json', JSON.stringify({ tabsFromHeading: tabs, answerStarts: 'No — and that’s deliberate.' }, null, 2));
});

// ───────────── US6-7 ─────────────

test('US6-7 persona tabs: arrow keys select Bid Manager and show its panel title', async ({ page }) => {
  await openLanding(page);
  const list = page.getByRole('tablist');
  await list.scrollIntoViewIfNeeded();
  await expect(list.getByRole('tab')).toHaveText(['Owner', 'Bid Manager', 'Analyst', 'Compliance']);
  const owner = list.getByRole('tab', { name: 'Owner' });
  await expect(owner).toHaveAttribute('aria-selected', 'true');
  await owner.focus();
  await page.keyboard.press('ArrowRight');
  const bm = list.getByRole('tab', { name: 'Bid Manager' });
  await expect(bm).toBeFocused();
  await expect(bm).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Run every bid like a well-oiled pipeline' })).toBeVisible();
  await evidence007(page, STORY, 'us6-7-bid-manager-tab');
  // Wrap-around and remaining tabs, as extra coverage.
  await page.keyboard.press('ArrowRight');
  await expect(list.getByRole('tab', { name: 'Analyst' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(list.getByRole('tab', { name: 'Compliance' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(list.getByRole('tab', { name: 'Analyst' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(bm).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(owner).toHaveAttribute('aria-selected', 'true');
});

// ───────────── US6-8 ─────────────

test('US6-8 prefers-reduced-motion: sections are visible with no slide/fade; without it they animate in', async ({ page }) => {
  const inlineAnim = (p: Page) => p.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('#pricing *, #faq *, #teams *, #control *')].filter((e) => e.style.opacity !== '' || e.style.transform !== '');
    return {
      animated: els.length,
      hidden: els.filter((e) => parseFloat(e.style.opacity || '1') < 1).length,
      shifted: els.filter((e) => e.style.transform && e.style.transform !== 'none' && !/translate\(0(px)?, 0(px)?\)|translateY\(0(px)?\)/.test(e.style.transform)).length,
    };
  });
  // Baseline: motion allowed → off-screen reveal wrappers start hidden/offset.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openLanding(page);
  const base = await inlineAnim(page);
  expect(base.hidden + base.shifted, 'baseline: below-the-fold sections start faded/offset').toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('#lp-shell')).toHaveCount(0);
  const reduced = await inlineAnim(page); // measured BEFORE scrolling anything into view
  expect(reduced.hidden, 'no faded wrappers').toBe(0);
  expect(reduced.shifted, 'no offset wrappers').toBe(0);
  await page.locator('#pricing').scrollIntoViewIfNeeded();
  const opacities = await page.locator('#pricing').evaluate((s) => [...s.querySelectorAll('h3')].map((h) => { let e: HTMLElement | null = h as HTMLElement; let o = 1; while (e && e !== s) { o *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement; } return o; }));
  expect(opacities.every((o) => o === 1)).toBe(true);
  saveText('us6-8-reduced-motion.json', JSON.stringify({ baseline: base, reduced, pricingCardOpacity: opacities }, null, 2));
  await evidence007(page, STORY, 'us6-8-reduced-motion-pricing');
});

// ───────────── US6-9 (FR-083) ─────────────

test('US6-9 copy upholds Constitution I: no claim of submitting bids / entering prices / OTP-DSC; price "typed by you, on GeM"', async ({ page }) => {
  await openLanding(page);
  // Expand every FAQ answer so their text is in the DOM.
  const qs = page.locator('#faq button[aria-expanded]');
  const n = await qs.count();
  const answers: string[] = [];
  for (let i = 0; i < n; i++) {
    await qs.nth(i).click();
    await expect(qs.nth(i)).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(350); // let the open animation render the panel
    answers.push(await page.locator('#faq [role="region"][data-state="open"]').innerText());
  }
  for (const tab of ['Owner', 'Bid Manager', 'Analyst', 'Compliance']) await page.getByRole('tab', { name: tab }).click();
  const all: string = (await page.evaluate(() => document.body.innerText)) + '\n' + answers.join('\n');
  const bad = /auto-?submit(s|ting)? (your )?bids|we submit|enters? (your )?price|we (enter|type) (the |your )?(price|OTP)|handles? (OTP|DSC|e-?sign)|we (handle|enter) (the )?(OTP|DSC)/i;
  const sentences = all.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = sentences.filter((s) => bad.test(s));
  saveText('us6-9-copy-guard.json', JSON.stringify({ sentencesScanned: sentences.length, faqAnswersExpanded: n, forbiddenHits: hits, patterns: String(bad) }, null, 2));
  expect(hits, 'forbidden claims').toEqual([]);
  // Positive statements.
  await expect(page.locator('#control').getByText('Your financial bid is typed by you, on GeM.', { exact: false })).toBeVisible();
  expect(all).toMatch(/typed by you, on GeM/);
  expect(all).toMatch(/never auto-submits/i);
  expect(answers.join(' ')).toMatch(/No — and that’s deliberate/);
  await page.locator('#control').scrollIntoViewIfNeeded();
  await evidence007(page, STORY, 'us6-9-compliance-section');
});

// ───────────── US6-10 (FR-084) ─────────────

test('US6-10 head meta in the served HTML (crawler view) and no doubled title after hydration', async ({ page, request }) => {
  const res = await request.get('/', { headers: { 'user-agent': 'WhatsApp/2.23 A' } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  const head = html.slice(html.indexOf('<head'), html.indexOf('</head>'));
  saveText('us6-10-head.html', head);
  const meta = (attr: 'name' | 'property', key: string) => new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`).exec(head)?.[1];
  expect(/<title>([^<]*)<\/title>/.exec(head)?.[1]).toBe(TITLE);
  expect(head.match(/<title>/g)).toHaveLength(1);
  expect(meta('name', 'description')).toMatch(/GeM/);
  expect(meta('name', 'description')!.length).toBeGreaterThan(50);
  expect(/<link\s+rel="canonical"\s+href="([^"]+)"/.exec(head)?.[1]).toBe('https://tenderpilot.in/');
  expect(meta('property', 'og:title')).toBe(TITLE);
  expect(meta('property', 'og:description')).toBeTruthy();
  expect(meta('property', 'og:image')).toBe('https://tenderpilot.in/og.png');
  expect(meta('property', 'og:image:width')).toBe('1200');
  expect(meta('property', 'og:image:height')).toBe('630');
  expect(meta('property', 'og:locale')).toBe('en_IN');
  expect(meta('name', 'twitter:card')).toBe('summary_large_image');
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head)![1]);
  expect(ld['@type']).toBe('SoftwareApplication');
  const offers = [ld.offers].flat();
  expect(offers).toHaveLength(2);
  expect(offers.every((o: { '@type': string; priceCurrency: string }) => o['@type'] === 'Offer' && o.priceCurrency === 'INR')).toBe(true);
  expect(offers.map((o: { price: string | number }) => Number(o.price)).sort((a: number, b: number) => a - b)).toEqual([2999, 7999]);
  // og.png is real, 1200×630.
  const og = await request.get('/og.png');
  expect(og.status()).toBe(200);
  expect(og.headers()['content-type']).toContain('image/png');
  const buf = await og.body();
  expect({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }).toEqual({ w: 1200, h: 630 });
  // After hydration the title is still exactly the same (not suffixed with "· TenderPilot").
  await openLanding(page);
  await expect(page).toHaveTitle(TITLE);
  expect(await page.title()).not.toMatch(/·\s*TenderPilot/);
  expect(await page.locator('head title').count()).toBe(1);
  await page.waitForTimeout(500);
  expect(await page.title()).toBe(TITLE);
  // /signup keeps the suffix convention, landing does not.
  await page.goto('/signup');
  expect((await page.title()).match(/TenderPilot/g)).toHaveLength(1);
  saveText('us6-10-head-summary.json', JSON.stringify({ title: TITLE, ogImage: { width: 1200, height: 630, bytes: buf.length }, offers: offers.map((o: { price: string | number; priceCurrency: string }) => ({ price: o.price, currency: o.priceCurrency })) }, null, 2));
});

// ───────────── US6-11 (FR-085) ─────────────

test('US6-11 Pro CTA → /signup?plan=pro shows the trial note; Starter passes ?plan=starter; unknown ignored; plan stays trial after sign-up', async ({ page }) => {
  await openLanding(page);
  const pro = page.locator('#pricing div.rounded-2xl', { has: page.getByRole('heading', { name: 'Pro', exact: true }) }).getByRole('link', { name: 'Start free trial' });
  await pro.scrollIntoViewIfNeeded();
  await pro.click();
  await expect(page).toHaveURL(/\/signup\?plan=pro$/);
  const note = page.getByTestId('plan-trial-note');
  await expect(note).toHaveText('You’re starting a 14-day free trial of Pro — no card needed. The trial includes 10 analyses and 1 GB of vault; Pro’s limits apply once you move to it.');
  await evidence007(page, STORY, 'us6-11-signup-pro-trial-note');

  // Starter
  await page.goto('/');
  await expect(page.locator('#lp-shell')).toHaveCount(0);
  await page.locator('#pricing div.rounded-2xl', { has: page.getByRole('heading', { name: 'Starter', exact: true }) }).getByRole('link', { name: 'Start free trial' }).click();
  await expect(page).toHaveURL(/\/signup\?plan=starter$/);
  await expect(page.getByTestId('plan-trial-note')).toHaveText('You’re starting a 14-day free trial of Starter — no card needed. The trial includes 10 analyses and 1 GB of vault; Starter’s limits apply once you move to it.');

  // Unknown / enterprise / empty are ignored.
  for (const v of ['gold', 'enterprise', '', '%3Cscript%3E', '__proto__']) {
    await page.goto(`/signup?plan=${v}`);
    await expect(page.getByRole('button', { name: /Create account/ })).toBeVisible();
    await expect(page.getByTestId('plan-trial-note'), `?plan=${v}`).toHaveCount(0);
  }
  await page.goto('/signup?plan=PRO');
  await expect(page.getByTestId('plan-trial-note')).toContainText('Pro'); // case-insensitive, matches signupPlan()

  // Sign up through the UI from ?plan=pro and confirm the org is still on the trial plan.
  const u = uniqueUser('plan');
  await page.goto('/signup?plan=pro');
  await page.getByLabel('Your name').fill(u.name);
  await page.getByLabel('Company name').fill(u.orgName);
  await page.getByLabel('Work email').fill(u.email);
  await page.getByLabel('Password', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: /Create account/ }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  const me = await (await page.request.get('/api/auth/me')).json();
  saveText('us6-11-me-plan.json', JSON.stringify({ org: { name: me.org?.name ?? me.user?.org, plan: me.org?.plan } }, null, 2));
  expect(me.org.plan).toBe('trial');
});

// ───────────── US6-12 (FR-087) ─────────────

test('US6-12 robots.txt allows / and disallows app routes; sitemap.xml lists /, /signup, /login', async ({ request }) => {
  const r = await request.get('/robots.txt');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('text/plain');
  const robots = await r.text();
  expect(robots).toMatch(/User-agent:\s*\*/);
  expect(robots).toMatch(/^Allow:\s*\/\s*$/m);
  for (const p of ['/dashboard', '/tenders', '/pipeline', '/vault', '/profile', '/settings', '/onboarding', '/workspaces', '/api/']) {
    expect(robots, `Disallow ${p}`).toMatch(new RegExp(`^Disallow:\\s*${p.replace(/\//g, '\\/')}\\s*$`, 'm'));
  }
  expect(robots).toMatch(/^Sitemap:\s*https:\/\/tenderpilot\.in\/sitemap\.xml/m);
  const s = await request.get('/sitemap.xml');
  expect(s.status()).toBe(200);
  expect(s.headers()['content-type']).toMatch(/xml/);
  const xml = await s.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs).toEqual(expect.arrayContaining(['https://tenderpilot.in/', 'https://tenderpilot.in/signup', 'https://tenderpilot.in/login']));
  expect(locs).toHaveLength(3);
  saveText('us6-12-robots.txt', robots);
  saveText('us6-12-sitemap.xml', xml);
});
