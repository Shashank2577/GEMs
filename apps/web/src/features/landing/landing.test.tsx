import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { GST_PERCENT, PLANS, PRICING_NOTE, TRIAL_DAYS, formatPlanPrice, planCtaHref, signupPlan, trialNote } from '@tp/core/contracts/plans';
import { TooltipProvider } from '@/components/ui/menu';
import { ThemeProvider } from '@/lib/theme';
import { planOffers, withPlanOffers } from '../../../vite/jsonld';
import LandingPage, { AUTH_LABELS, FAQ, LANDING_TITLE, NAV, PERSONAS } from './LandingPage';

const html = renderToStaticMarkup(<ThemeProvider><TooltipProvider><MemoryRouter><LandingPage /></MemoryRouter></TooltipProvider></ThemeProvider>);
const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const pricing = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="faq"'));
const pricingText = pricing.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('PLANS config (007/FR-086)', () => {
  it('defines Starter ₹2,999, Pro ₹7,999 (featured) and Enterprise Custom, once', () => {
    expect(PLANS.map((p) => [p.key, p.monthlyInr, p.featured])).toEqual([['starter', 2999, false], ['pro', 7999, true], ['enterprise', null, false]]);
    expect(PLANS.map(formatPlanPrice)).toEqual(['₹2,999', '₹7,999', 'Custom']);
    expect(PLANS.filter((p) => p.featured)).toHaveLength(1);
  });

  it('routes CTAs to /signup?plan=starter|pro and the Enterprise mailto', () => {
    expect(PLANS.map(planCtaHref)).toEqual(['/signup?plan=starter', '/signup?plan=pro', 'mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise']);
  });

  it('signupPlan accepts known trial plans only (007/FR-085)', () => {
    expect(signupPlan('pro')?.name).toBe('Pro');
    expect(signupPlan('Starter')?.name).toBe('Starter');
    for (const bad of [null, undefined, '', 'gold', 'enterprise', 'trial', '<script>', 'pro,starter']) expect(signupPlan(bad)).toBeNull();
    expect(trialNote(signupPlan('pro')!)).toBe('You’re starting a 14-day free trial of Pro — no card needed.');
  });
});

describe('Landing pricing renders from PLANS (007/FR-082, FR-086)', () => {
  it('shows each plan, price, features, Most popular and the GST/trial note', () => {
    expect(pricingText).toContain('₹2,999');
    expect(pricingText).toContain('₹7,999');
    expect(pricingText).toContain('Custom');
    expect(pricingText).toContain('/month');
    expect(pricingText).toContain('Most popular');
    // 008 review S6: the note names the enforced trial caps (PLAN_LIMITS.trial), not "a trial of Pro".
    expect(pricingText).toContain('Prices exclude 18% GST. Every plan starts with a 14-day free trial — 10 analyses and 1 GB of vault included.');
    expect(PRICING_NOTE).toBe(`Prices exclude ${GST_PERCENT}% GST. Every plan starts with a ${TRIAL_DAYS}-day free trial — 10 analyses and 1 GB of vault included.`);
    for (const p of PLANS) {
      expect(pricingText).toContain(p.name);
      for (const f of p.features) expect(pricingText).toContain(f.replace(/&/g, '&amp;'));
    }
  });

  it('links Starter/Pro to /signup?plan=… and Enterprise to the sales mailto', () => {
    expect(pricing).toContain('href="/signup?plan=starter"');
    expect(pricing).toContain('href="/signup?plan=pro"');
    expect(pricing).toContain('href="mailto:sales@tenderpilot.in?subject=TenderPilot%20Enterprise"');
    expect(pricingText).toContain('Talk to sales');
  });

  it('uses the full landing title (no "· TenderPilot" suffix source)', () => {
    expect(LANDING_TITLE).toBe('TenderPilot — GeM tender co-pilot for Indian sellers');
  });
});

describe('Landing copy guard (007/FR-083, Constitution I)', () => {
  const FORBIDDEN = /auto-?submit(s|ting)? (your )?bids|we submit|enter(s)? (your )?price/i;
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  // Copy that is NOT in the static markup: closed FAQ answers, inactive persona tab panels and the closed mobile menu.
  // They are exported from LandingPage and scanned here so a hidden panel can't carry a claim the guard never sees.
  const hiddenCopy = [
    ...FAQ.flatMap(([q, a]) => [q, a]),
    ...PERSONAS.flatMap((p) => [p.label, p.title, p.body, ...p.points]),
    ...NAV.map((n) => n.label),
    AUTH_LABELS.signIn, AUTH_LABELS.signUp,
  ];
  const corpus = norm([text, ...hiddenCopy].join(' '));
  const sentences = corpus.split(/(?<=[.!?])\s+/);

  /** Sentences that match FORBIDDEN but are negations / statements of what the seller does. Exact text, so a new
   *  claim cannot slip through a keyword like "no" or "human". Update deliberately if the copy is reworded. */
  const KNOWN_NEGATED: string[] = [];

  it('covers hidden copy: FAQ answers, inactive persona panels and the mobile menu', () => {
    expect(text).not.toContain('that’s deliberate');   // closed accordion: not in the static markup...
    expect(corpus).toContain('that’s deliberate');     // ...but is scanned
    expect(text).not.toContain('well-oiled');          // inactive persona tab
    expect(corpus).toContain('well-oiled');
    expect(FAQ.length).toBeGreaterThanOrEqual(6);
    expect(PERSONAS.map((p) => p.key)).toEqual(['owner', 'bm', 'an', 'co']);
    expect(NAV.length).toBeGreaterThanOrEqual(5);
    for (const n of NAV) expect(corpus).toContain(n.label);
    expect(corpus).toContain(AUTH_LABELS.signUp);
  });

  it('has no sentence that claims TenderPilot submits bids or enters prices, except the exact known negated ones', () => {
    const offenders = sentences.filter((s) => FORBIDDEN.test(s) && !KNOWN_NEGATED.includes(s));
    expect(offenders).toEqual([]);
  });

  it('every known negated sentence still exists verbatim (list cannot go stale)', () => {
    for (const k of KNOWN_NEGATED) expect(sentences).toContain(k);
    // Today the copy has no sentence matching FORBIDDEN at all; the human-in-the-loop promise is asserted positively below.
    expect(sentences.filter((s) => FORBIDDEN.test(s))).toEqual(KNOWN_NEGATED);
  });

  it('guard catches positive claims, including ones that contain "no"/"human" (self-check)', () => {
    for (const bad of ['We submit your bid for you.', 'TenderPilot auto-submits bids on GeM.', 'It enters your price automatically.',
      'No human needed: TenderPilot auto-submits bids.', 'We submit bids, not you.']) {
      expect(FORBIDDEN.test(bad) && !KNOWN_NEGATED.includes(bad)).toBe(true);
    }
  });

  it('keeps the human-in-the-loop promise visible', () => {
    expect(text).toContain('never auto-submits on GeM');
    expect(text).toMatch(/typed by you, on GeM/);
    expect(text).not.toMatch(/\b(handles?|automates?|bypass(es)?) (the )?(OTP|DSC|e-?Sign)/i);
    expect(corpus).not.toMatch(/\b(handles?|automates?|bypass(es)?) (the )?(OTP|DSC|e-?Sign)/i);
  });
});

describe('index.html: static hero shell and JSON-LD (007/NFR-003, FR-086)', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
  const shell = indexHtml.slice(indexHtml.indexOf('id="lp-shell"'), indexHtml.indexOf('id="root"'));
  const shellText = shell.replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  it('shell copy matches the real hero (headline, lead, CTAs, bullets) so the swap is invisible', () => {
    const hero = text.slice(text.indexOf('Account-safe'), text.indexOf('Built for'));
    for (const piece of ['Account-safe: never auto-submits on GeM', 'Win more GeM bids. Spend minutes, not nights, on each one.', 'You keep the price, OTP and DSC.',
      'Start free trial', 'See how it works', '14-day free trial', 'No card needed', 'Set up in 5 minutes']) {
      expect(shellText, piece).toContain(piece);
      expect(text, piece).toContain(piece);
    }
    expect(hero.length).toBeGreaterThan(0);
    expect(shell).toContain('href="/signup"');
    expect(shell).toContain('if (location.pathname !== \'/\')');
  });

  it('JSON-LD offers are derived from PLANS', () => {
    const ld = JSON.parse(indexHtml.match(/application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld.offers).toEqual(planOffers());
    expect(planOffers().map((o) => [o.name, o.price, o.url])).toEqual([
      ['Starter', '2999', 'https://tenderpilot.in/signup?plan=starter'], ['Pro', '7999', 'https://tenderpilot.in/signup?plan=pro'],
    ]);
    expect(withPlanOffers(indexHtml)).toContain(JSON.stringify(planOffers()));
  });
});
