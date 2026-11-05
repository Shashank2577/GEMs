import { beforeAll, describe, expect, it } from 'vitest';
import { generateBidPdf, SAMPLE_BID_SPECS } from '../../src/analyse/sample-bid';
import { extractPages } from '../../src/analyse/pdf-text';
import { extractRequirementsRules } from '../../src/analyse/rules';
import {
  averageTurnover, computeScore, DEFAULT_WEIGHTS, FACTOR_KEYS, resolveWeights, scoreTender, type ScoreInput,
} from '../../src/analyse/score';
import type { Requirement, ScoreFactor } from '../../src/analyse/types';
import { baseProfile, basePastContracts, baseVault, NOW, sparseProfile } from './profiles';

const reqsByKey = new Map<string, Requirement[]>();
beforeAll(async () => {
  for (const s of SAMPLE_BID_SPECS) reqsByKey.set(s.key, extractRequirementsRules(await extractPages(await generateBidPdf(s))));
});

const f = (factors: ScoreFactor[], key: string) => factors.find((x) => x.key === key)!;
const base = (key: string, extra: Partial<ScoreInput> = {}) =>
  scoreTender({ requirements: reqsByKey.get(key)!, profile: baseProfile, pastContracts: basePastContracts, vaultDocs: baseVault, now: NOW, ...extra });

const R = (key: string, value: Requirement['value'], numeric: number | null = null, mandatory = true): Requirement => ({
  key, label: key, value, numeric, mandatory, source: { page: 1, quote: `${key} ${value}` }, method: 'RULE', confidence: 0.95,
});

describe('scoreTender on the sample bids', () => {
  it('go-it-services → Go with turnover passing and citing the bid (US2 #1)', () => {
    const r = base('go-it-services', { tender: { state: 'Delhi' } });
    expect(r.verdict).toBe('go');
    expect(r.score).toBeGreaterThanOrEqual(90);
    const t = f(r.factors, 'turnover');
    expect(t.status).toBe('pass');
    expect(t.detail).toBe('Your average turnover of ₹2 Cr (last 3 years) meets the required ₹50 L.');
    expect(t.requirementKey).toBe('turnover_min');
    expect(f(r.factors, 'emd')).toMatchObject({ status: 'exempt' });
    expect(f(r.factors, 'emd').detail).toMatch(/^Exempt \(MSE\)/);
    expect(f(r.factors, 'similarWork').status).toBe('pass');
    expect(f(r.factors, 'certificates').status).toBe('pass');
    expect(f(r.factors, 'documents').status).toBe('pass');
    expect(f(r.factors, 'oem').status).toBe('na');
    expect(f(r.factors, 'timeToClose').status).toBe('pass');
    expect(r.confidence).toBe(1);
    expect(r.summary).toMatch(/^Go — \d+\/100 with 100% confidence\./);
  });

  it('emd-exempt-mse → EMD exempt (MSE) with a valid Udyam (US2 #2)', () => {
    const r = base('emd-exempt-mse');
    expect(f(r.factors, 'emd').status).toBe('exempt');
    expect(f(r.factors, 'emd').detail).toContain('₹67,500');
    expect(f(r.factors, 'certificates').status).toBe('fail'); // BIS not held
    expect(r.verdict).toBe('go');
  });

  it('EMD is not exempt when the Udyam certificate is missing or expired', () => {
    const noUdyam = base('emd-exempt-mse', { vaultDocs: baseVault.filter((d) => d.type !== 'udyam') });
    expect(f(noUdyam.factors, 'emd').status).toBe('pass'); // within ₹5 L capacity
    expect(f(noUdyam.factors, 'emd').detail).toContain('Upload your Udyam certificate');
    const expired = base('emd-exempt-mse', { vaultDocs: baseVault.map((d) => (d.type === 'udyam' ? { ...d, expiryDate: '2026-01-01' } : d)) });
    expect(f(expired.factors, 'emd').status).not.toBe('exempt');
  });

  it('nogo-experience → No-Go with the blocking experience factor (US2 #3)', () => {
    const r = base('nogo-experience');
    const e = f(r.factors, 'experience');
    expect(e).toMatchObject({ status: 'fail', blocking: true });
    expect(e.detail).toMatch(/You have 4\.4 years of experience; the bid needs 5 years\./);
    expect(r.verdict).toBe('no_go');
    expect(r.score).toBeGreaterThanOrEqual(40); // the score alone would not be No-Go — the blocker is
    expect(r.summary).toContain('Blocked by years of experience');
  });

  it('review-hardware-oem with an incomplete profile → Review with unknowns lowering confidence (US2 #5)', () => {
    const r = scoreTender({ requirements: reqsByKey.get('review-hardware-oem')!, profile: sparseProfile, pastContracts: [], vaultDocs: [{ type: 'udyam' }], now: NOW });
    expect(f(r.factors, 'turnover').status).toBe('unknown');
    expect(f(r.factors, 'experience').status).toBe('unknown');
    expect(f(r.factors, 'oem').status).toBe('pass');
    expect(r.verdict).toBe('review');
    expect(r.score).toBe(60); // 53 / 88 applicable weight
    expect(r.confidence).toBeLessThan(1);
    expect(r.summary).toContain('Needs review');
  });

  it('OEM authorisation missing is a hard blocker', () => {
    const r = base('review-hardware-oem');
    expect(f(r.factors, 'oem')).toMatchObject({ status: 'fail', blocking: true });
    expect(r.verdict).toBe('no_go');
  });
});

describe('OEM product match (FR-030)', () => {
  const demoOems = [
    { oem: 'CP PLUS', products: 'IP cameras, NVRs' },
    { oem: 'D-Link India', products: 'Managed switches, Wi-Fi access points' },
  ];
  const profile = { ...baseProfile, oemAuthorizations: demoOems };
  const oemReqs = [R('oem_auth', true, null, true)];
  const run = (tender: ScoreInput['tender'], p = profile, vaultDocs = baseVault) =>
    f(scoreTender({ requirements: oemReqs, profile: p, pastContracts: basePastContracts, vaultDocs, tender, now: NOW }).factors, 'oem');

  it('unknown when no valid authorisation mentions the tender category', () => {
    const oem = run({ title: 'Supply of Desktop Computers', category: 'Desktop Computers', items: [{ name: 'Desktop Computer (Core i5)' }] });
    expect(oem).toMatchObject({ status: 'unknown', blocking: true });
    expect(oem.detail).toBe('None of your valid OEM authorisations (CP PLUS, D-Link India) mention Desktop Computers — confirm one covers this product.');
  });

  it('passes when an authorisation mentions the product (plural-insensitive, items and title count)', () => {
    expect(run({ title: 'CCTV Camera supply', category: 'CCTV Cameras' }).status).toBe('pass');
    expect(run({ title: 'Network upgrade', items: [{ name: 'Managed Switch 24 port' }] }).status).toBe('pass');
  });

  it('uses vault authorisation title/tags and ignores expired ones', () => {
    const none = { ...baseProfile, oemAuthorizations: [] };
    const vault = [...baseVault, { type: 'oem_authorization' as const, title: 'Dell authorisation', tags: ['Desktops'] }];
    expect(run({ category: 'Desktop Computers' }, none, vault).status).toBe('pass');
    const expired = { ...baseProfile, oemAuthorizations: [{ oem: 'Dell', products: 'Desktops', validTill: '2026-01-01' }, ...demoOems] };
    expect(run({ category: 'Desktop Computers' }, expired).status).toBe('unknown');
  });

  it('keeps the generic pass when the tender text is unknown', () => {
    expect(run(null).status).toBe('pass');
    expect(run({ endAt: null }).status).toBe('pass');
  });
});

describe('exemptions (FR-014)', () => {
  const reqs = (mse: boolean, startup: boolean) => [
    R('turnover_min', '1 Crore', 10_000_000), R('experience_years', '3 years', 3), R('mse_exemption', mse, null, false), R('startup_exemption', startup, null, false),
  ];
  const poor = { ...baseProfile, financials: [{ fy: '2025-26', turnover: 2_000_000 }] };
  const young = [{ value: 100_000, startDate: '2026-01-01' }];

  it('MSE exemption applies only when the bid allows it and the company has a valid Udyam', () => {
    const allowed = scoreTender({ requirements: reqs(true, false), profile: poor, pastContracts: young, vaultDocs: baseVault, now: NOW });
    expect(f(allowed.factors, 'turnover').status).toBe('exempt');
    expect(f(allowed.factors, 'experience').status).toBe('exempt');
    expect(allowed.verdict).not.toBe('no_go');

    const notAllowed = scoreTender({ requirements: reqs(false, false), profile: poor, pastContracts: young, vaultDocs: baseVault, now: NOW });
    expect(f(notAllowed.factors, 'turnover').status).toBe('fail');
    expect(notAllowed.verdict).toBe('no_go');

    const noDoc = scoreTender({ requirements: reqs(true, false), profile: poor, pastContracts: young, vaultDocs: [], now: NOW });
    expect(f(noDoc.factors, 'turnover').status).toBe('fail');
    expect(f(noDoc.factors, 'turnover').detail).toContain('Upload your Udyam certificate');
  });

  it('Startup exemption needs DPIIT recognition evidence', () => {
    const startup = { financials: [{ fy: '2025-26', turnover: 100_000 }], isStartup: true, dpiitNumber: 'DIPP12345' };
    const ok = scoreTender({ requirements: reqs(false, true), profile: startup, pastContracts: young, vaultDocs: [{ type: 'startup_dpiit' }], now: NOW });
    expect(f(ok.factors, 'turnover').detail).toMatch(/^Exempt \(Startup\)/);
    const no = scoreTender({ requirements: reqs(false, true), profile: startup, pastContracts: young, vaultDocs: [], now: NOW });
    expect(f(no.factors, 'turnover').status).toBe('fail');
  });
});

describe('edge cases', () => {
  it('rules-only with no requirements at all → neutral Review, zero confidence', () => {
    const r = scoreTender({ requirements: [], profile: null, now: NOW });
    expect(r.factors.every((x) => x.status === 'na' || x.key === 'documents')).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(['review', 'go', 'no_go']).toContain(r.verdict);
  });

  it('no profile → unknowns, never silent pass/fail (US2 #5)', () => {
    const r = scoreTender({ requirements: [R('turnover_min', '50 L', 5_000_000), R('experience_years', '3', 3)], profile: null, now: NOW });
    expect(f(r.factors, 'turnover').status).toBe('unknown');
    expect(f(r.factors, 'experience').status).toBe('unknown');
    expect(r.verdict).not.toBe('no_go');
    expect(r.confidence).toBeLessThan(1);
  });

  it('closed bids are blocked; tight deadlines are unknown', () => {
    const closed = scoreTender({ requirements: [], profile: baseProfile, tender: { endAt: '2026-11-01T10:00:00Z' }, now: NOW });
    expect(f(closed.factors, 'timeToClose')).toMatchObject({ status: 'fail', blocking: true });
    expect(closed.verdict).toBe('no_go');
    const tight = scoreTender({ requirements: [], profile: baseProfile, tender: { endAt: new Date(NOW.getTime() + 36 * 3600e3) }, now: NOW });
    expect(f(tight.factors, 'timeToClose').status).toBe('unknown');
  });

  it('EMD over capacity fails (non-blocking); unknown capacity is unknown', () => {
    const p = { ...baseProfile, mseCategory: null, udyamNumber: null };
    const over = scoreTender({ requirements: [R('emd', '6 L', 600_000)], profile: p, now: NOW });
    expect(f(over.factors, 'emd')).toMatchObject({ status: 'fail', blocking: false });
    const unk = scoreTender({ requirements: [R('emd', '6 L', 600_000)], profile: { ...p, maxEmdCapacity: null }, now: NOW });
    expect(f(unk.factors, 'emd').status).toBe('unknown');
  });

  it('MII: Class-II passes, non-local fails, unset is unknown', () => {
    const mii = [R('mii', true)];
    expect(f(scoreTender({ requirements: mii, profile: { miiClass: 'class_2' }, now: NOW }).factors, 'mii').status).toBe('pass');
    expect(f(scoreTender({ requirements: mii, profile: { miiClass: 'non_local' }, now: NOW }).factors, 'mii').status).toBe('fail');
    expect(f(scoreTender({ requirements: mii, profile: {}, now: NOW }).factors, 'mii').status).toBe('unknown');
  });

  it('delivery outside operating states is flagged', () => {
    const r = scoreTender({ requirements: [R('delivery_days', '30 days', 30)], profile: baseProfile, tender: { state: 'Kerala' }, now: NOW });
    expect(f(r.factors, 'deliveryFeasibility').status).toBe('unknown');
    expect(f(r.factors, 'deliveryFeasibility').detail).toContain('Kerala');
  });

  it('delivery falls back to the consignee state from the document when the listing has no state (FR-019)', () => {
    const reqs = [R('delivery_days', '30 days', 30), R('consignee_state', 'Kerala', null, false)];
    const fromDoc = scoreTender({ requirements: reqs, profile: baseProfile, tender: { state: null }, now: NOW });
    expect(f(fromDoc.factors, 'deliveryFeasibility')).toMatchObject({ status: 'unknown', requirementKey: 'delivery_days' });
    expect(f(fromDoc.factors, 'deliveryFeasibility').detail).toBe('Delivery in 30 days to Kerala, outside your operating states — check logistics.');
    // The listing state wins over the document.
    const listing = scoreTender({ requirements: reqs, profile: baseProfile, tender: { state: 'Delhi' }, now: NOW });
    expect(f(listing.factors, 'deliveryFeasibility')).toMatchObject({ status: 'pass', detail: 'Delivery period of 30 days to Delhi looks feasible.' });
    // Real sample bid: Haryana consignee is inside the operating states.
    const oem = base('review-hardware-oem');
    expect(f(oem.factors, 'deliveryFeasibility').detail).toBe('Delivery period of 45 days to Haryana looks feasible.');
  });

  it('averageTurnover uses the latest three financial years', () => {
    expect(averageTurnover(baseProfile.financials)).toEqual({ avg: 20_000_000, years: 3 });
    expect(averageTurnover([])).toBeNull();
  });
});

describe('weights, thresholds and overrides (FR-013, FR-016)', () => {
  it('resolveWeights keeps defaults, clamps and ignores unknown keys', () => {
    const w = resolveWeights({ turnover: 150, emd: -3, bogus: 9 } as Record<string, number>);
    expect(w.turnover).toBe(100);
    expect(w.emd).toBe(0);
    expect(Object.keys(w)).toEqual([...FACTOR_KEYS]);
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('thresholds: ≥70 Go, 40–69 Review, <40 No-Go, unknown counts 0.5', () => {
    const mk = (statuses: ScoreFactor['status'][]): ScoreFactor[] => statuses.map((s, i) => ({ key: `k${i}`, label: `K${i}`, status: s, weight: 10, blocking: false, detail: '' }));
    expect(computeScore(mk(['pass', 'pass', 'pass', 'fail'])).verdict).toBe('go'); // 75
    expect(computeScore(mk(['pass', 'pass', 'pass', 'fail', 'fail', 'fail', 'pass', 'fail', 'fail', 'pass'])).score).toBe(50);
    expect(computeScore(mk(['unknown', 'unknown'])).score).toBe(50);
    expect(computeScore(mk(['unknown', 'unknown'])).confidence).toBe(0);
    expect(computeScore(mk(['fail', 'fail', 'pass'])).verdict).toBe('no_go'); // 33
    expect(computeScore(mk(['pass', 'pass', 'na', 'exempt'])).score).toBe(100);
    expect(computeScore(mk(['pass', 'unknown', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail'])).verdict).toBe('go'); // 85
  });

  it('org weights change the score', () => {
    const r1 = base('emd-exempt-mse');
    const r2 = base('emd-exempt-mse', { weights: { certificates: 100 } });
    expect(r2.score).toBeLessThan(r1.score);
    expect(f(r2.factors, 'certificates').weight).toBe(100);
  });

  it('an override replaces the effective status, is kept for audit and can lift a blocker', () => {
    const at = '2026-11-04T05:00:00.000Z';
    const r = base('nogo-experience', { overrides: { experience: { status: 'pass', reason: 'JV partner has 10 years', by: 'Asha', at } } });
    expect(f(r.factors, 'experience').status).toBe('fail');
    expect(f(r.factors, 'experience').overridden).toEqual({ status: 'pass', reason: 'JV partner has 10 years', by: 'Asha', at });
    expect(r.verdict).toBe('go');
    expect(r.summary).toContain('1 factor manually overridden');
  });
});
