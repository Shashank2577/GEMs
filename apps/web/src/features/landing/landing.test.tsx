import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { GST_PERCENT, PLANS, PRICING_NOTE, TRIAL_DAYS, formatPlanPrice, planCtaHref, signupPlan, trialNote } from '@tp/core/contracts/plans';
import { TooltipProvider } from '@/components/ui/menu';
import { ThemeProvider } from '@/lib/theme';
import LandingPage, { LANDING_TITLE } from './LandingPage';

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
    expect(pricingText).toContain('Prices exclude 18% GST. Every plan starts with a 14-day free trial of Pro.');
    expect(PRICING_NOTE).toBe(`Prices exclude ${GST_PERCENT}% GST. Every plan starts with a ${TRIAL_DAYS}-day free trial of Pro.`);
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
  const NEGATION = /\b(never|not|no|nor|n't|don't|doesn't|without|deliberate|typed by you|you (type|enter|submit)|stay(s)? with you|human)\b|’t\b/i;
  const sentences = text.split(/(?<=[.!?])\s+/);

  it('has no sentence that claims TenderPilot submits bids or enters prices, except negated ones', () => {
    const offenders = sentences.filter((s) => FORBIDDEN.test(s) && !NEGATION.test(s));
    expect(offenders).toEqual([]);
  });

  it('guard regex catches a positive claim (self-check)', () => {
    for (const bad of ['We submit your bid for you.', 'TenderPilot auto-submits bids on GeM.', 'It enters your price automatically.']) {
      expect(FORBIDDEN.test(bad) && !NEGATION.test(bad)).toBe(true);
    }
  });

  it('keeps the human-in-the-loop promise visible', () => {
    expect(text).toContain('never auto-submits on GeM');
    expect(text).toMatch(/typed by you, on GeM/);
    expect(text).not.toMatch(/\b(handles?|automates?|bypass(es)?) (the )?(OTP|DSC|e-?Sign)/i);
  });
});
