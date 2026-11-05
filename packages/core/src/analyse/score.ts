/**
 * Deterministic Go/No-Go scoring engine (T044, FR-013, FR-014, Constitution III).
 *
 *   score      = round(100 × Σ(weight × value) / Σ weight) over applicable factors
 *                value: pass / exempt = 1, unknown = 0.5, fail = 0; `na` factors are excluded
 *   verdict    = No-Go on any blocking fail, else Go ≥ 70, Review 40–69, No-Go < 40
 *   confidence = share of applicable factors whose status is known (not `unknown`)
 *
 * MSE / Startup exemptions apply only when the bid allows them AND the company qualifies with a
 * valid (non-expired) Udyam / DPIIT certificate in the vault. EMD exemption for MSEs and Startups
 * follows GFR 2017 rule 170 and is always allowed. Overrides (FR-016) replace a factor's status
 * and are kept on the factor for audit.
 */
import type { DocType, Requirement, ScoreFactor } from './types';
import { buildChecklist, isMseProfile, isStartupProfile, type ChecklistProfile } from './checklist';
import { inr, plural, years } from './format';
import { certKey, isValidDoc, vaultHas, type ScoreVaultDoc } from './vault-match';

export { isValidDoc };
export type { ScoreVaultDoc };

export const FACTOR_KEYS = [
  'turnover', 'experience', 'similarWork', 'emd', 'mii', 'oem', 'certificates', 'documents', 'deliveryFeasibility', 'timeToClose',
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

export const FACTOR_LABELS: Record<FactorKey, string> = {
  turnover: 'Average annual turnover',
  experience: 'Years of experience',
  similarWork: 'Similar work value',
  emd: 'EMD (earnest money)',
  mii: 'Make in India',
  oem: 'OEM authorisation',
  certificates: 'Certificates',
  documents: 'Documents in vault',
  deliveryFeasibility: 'Delivery feasibility',
  timeToClose: 'Time to bid closing',
};

export const DEFAULT_WEIGHTS: Record<FactorKey, number> = {
  turnover: 20, experience: 18, similarWork: 12, emd: 10, mii: 6, oem: 10, certificates: 8, documents: 8, deliveryFeasibility: 4, timeToClose: 4,
};

export const VERDICT_THRESHOLDS = { go: 70, review: 40 } as const;

export type Verdict = 'go' | 'review' | 'no_go';
type Status = ScoreFactor['status'];

export interface ScoreProfile extends ChecklistProfile {
  financials?: { fy: string; turnover: number }[] | null;
  incorporationDate?: string | null;
  miiClass?: 'class_1' | 'class_2' | 'non_local' | null;
  localContentPct?: number | null;
  oemAuthorizations?: { oem: string; products?: string; validTill?: string | null }[] | null;
  certifications?: string[] | null;
  maxEmdCapacity?: number | null;
  operatingStates?: string[] | null;
}
export interface ScorePastContract { value: number; startDate?: string | null; endDate?: string | null; title?: string; category?: string | null }
export interface ScoreTender {
  endAt?: Date | string | null; state?: string | null; emdAmount?: number | null;
  title?: string | null; category?: string | null; items?: { name: string }[] | null;
}

export type FactorOverride = NonNullable<ScoreFactor['overridden']>;

export interface ScoreInput {
  requirements: Requirement[];
  profile: ScoreProfile | null;
  pastContracts?: ScorePastContract[];
  vaultDocs?: ScoreVaultDoc[];
  tender?: ScoreTender | null;
  weights?: Partial<Record<string, number>> | null;
  now: Date;
  overrides?: Record<string, FactorOverride>;
}

export interface ScoreResult {
  factors: ScoreFactor[];
  score: number;
  verdict: Verdict;
  confidence: number;
  summary: string;
}

const VALUE: Record<Status, number | null> = { pass: 1, exempt: 1, unknown: 0.5, fail: 0, na: null };

/** Normalise org weights: unknown keys dropped, missing keys default, clamped 0..100. */
export function resolveWeights(w?: Partial<Record<string, number>> | null): Record<FactorKey, number> {
  const out = { ...DEFAULT_WEIGHTS };
  if (w) for (const k of FACTOR_KEYS) {
    const v = w[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.min(100, v));
  }
  return out;
}

export const effectiveStatus = (f: ScoreFactor): Status => f.overridden?.status ?? f.status;

const DAY = 86_400_000;
const toDate = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d : new Date(d));

/** Average of the latest (up to) 3 financial years. */
export function averageTurnover(financials: ScoreProfile['financials']): { avg: number; years: number } | null {
  const list = (financials ?? []).filter((f) => Number.isFinite(f.turnover) && f.turnover > 0);
  if (!list.length) return null;
  const latest = [...list].sort((a, b) => b.fy.localeCompare(a.fy)).slice(0, 3);
  return { avg: latest.reduce((s, f) => s + f.turnover, 0) / latest.length, years: latest.length };
}

/** Years of experience from the earliest past contract (fallback: incorporation date). */
export function experienceYears(pcs: ScorePastContract[], profile: ScoreProfile | null, now: Date): { years: number; basis: 'contracts' | 'incorporation' } | null {
  const starts = pcs.map((p) => toDate(p.startDate ?? p.endDate)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  if (starts.length) {
    const earliest = Math.min(...starts.map((d) => d.getTime()));
    return { years: Math.max(0, (now.getTime() - earliest) / (365.25 * DAY)), basis: 'contracts' };
  }
  const inc = toDate(profile?.incorporationDate ?? null);
  if (inc && !Number.isNaN(inc.getTime())) return { years: Math.max(0, (now.getTime() - inc.getTime()) / (365.25 * DAY)), basis: 'incorporation' };
  return null;
}

/** Words too generic to prove an authorisation covers a product. */
const OEM_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'supply', 'supplies', 'purchase', 'procurement', 'installation', 'commissioning', 'maintenance',
  'service', 'services', 'item', 'items', 'product', 'products', 'equipment', 'equipments', 'system', 'systems', 'related', 'type', 'set',
  'new', 'various', 'other', 'others', 'gem', 'bid', 'tender', 'including', 'complete', 'unit', 'units', 'india', 'indian',
  'limited', 'ltd', 'pvt', 'private', 'authorised', 'authorized', 'authorisation', 'authorization', 'partner', 'reseller', 'channel',
]);

/** Lower-cased significant words (light plural stemming) of a text; used for the OEM product match (FR-030). */
export function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || OEM_STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return out;
}

export function scoreTender(input: ScoreInput): ScoreResult {
  const { requirements, profile, now } = input;
  const pcs = input.pastContracts ?? [];
  const vault = input.vaultDocs ?? [];
  const weights = resolveWeights(input.weights);
  const get = (k: string) => requirements.find((r) => r.key === k);
  const hasValid = (t: DocType) => vault.some((d) => d.type === t && isValidDoc(d, now));
  const hasExpired = (t: DocType) => vault.some((d) => d.type === t && !isValidDoc(d, now));

  const mseProfile = isMseProfile(profile);
  const startupProfile = isStartupProfile(profile);
  const mseQualified = mseProfile && hasValid('udyam');
  const startupQualified = startupProfile && hasValid('startup_dpiit');
  const mseAllowed = get('mse_exemption')?.value === true;
  const startupAllowed = get('startup_exemption')?.value === true;

  const exemptionFor = (): { label: string } | null => {
    if (mseAllowed && mseQualified) return { label: 'MSE' };
    if (startupAllowed && startupQualified) return { label: 'Startup' };
    return null;
  };
  const exemptionHint = (): string => {
    if (mseAllowed && mseProfile && !mseQualified) return hasExpired('udyam') ? ' Your Udyam certificate has expired — renew it to claim the MSE exemption.' : ' Upload your Udyam certificate to the vault to claim the MSE exemption.';
    if (startupAllowed && startupProfile && !startupQualified) return ' Upload your DPIIT recognition certificate to claim the Startup exemption.';
    return '';
  };

  const factors: ScoreFactor[] = [];
  const push = (key: FactorKey, status: Status, detail: string, opts: { blocking?: boolean; requirementKey?: string } = {}) => {
    factors.push({ key, label: FACTOR_LABELS[key], status, weight: weights[key], blocking: !!opts.blocking, detail, ...(opts.requirementKey ? { requirementKey: opts.requirementKey } : {}) });
  };

  // 1. Turnover (blocking)
  {
    const r = get('turnover_min');
    const req = r?.numeric ?? null;
    if (!r || req == null) push('turnover', 'na', 'No minimum turnover criterion found in the bid.');
    else if (req <= 0) push('turnover', 'pass', 'The bid sets no minimum turnover.', { requirementKey: 'turnover_min' });
    else {
      const avg = averageTurnover(profile?.financials);
      const ex = exemptionFor();
      if (avg && avg.avg >= req) push('turnover', 'pass', `Your average turnover of ${inr(avg.avg)} (last ${plural(avg.years, 'year')}) meets the required ${inr(req)}.`, { blocking: true, requirementKey: 'turnover_min' });
      else if (ex) push('turnover', 'exempt', `Exempt (${ex.label}): the bid waives the ${inr(req)} turnover criterion for ${ex.label === 'MSE' ? 'MSEs' : 'Startups'}${avg ? ` (your average is ${inr(avg.avg)})` : ''}.`, { blocking: true, requirementKey: 'turnover_min' });
      else if (!avg) push('turnover', 'unknown', `Bid needs ${inr(req)} average turnover, but your profile has no financial years yet. Add turnover to your company profile.`, { blocking: true, requirementKey: 'turnover_min' });
      else push('turnover', 'fail', `Your average turnover of ${inr(avg.avg)} is below the required ${inr(req)}.${exemptionHint()}`, { blocking: true, requirementKey: 'turnover_min' });
    }
  }

  // 2. Experience (blocking)
  {
    const r = get('experience_years');
    const req = r?.numeric ?? null;
    if (!r || req == null) push('experience', 'na', 'No minimum experience criterion found in the bid.');
    else {
      const exp = experienceYears(pcs, profile, now);
      const ex = exemptionFor();
      const basis = exp?.basis === 'incorporation' ? ' (based on your incorporation date — add past contracts as proof)' : '';
      if (exp && exp.years + 1e-9 >= req) push('experience', 'pass', `You have ${years(exp.years)} of experience${basis}; the bid needs ${years(req)}.`, { blocking: true, requirementKey: 'experience_years' });
      else if (ex) push('experience', 'exempt', `Exempt (${ex.label}): the bid waives the ${years(req)} experience criterion for ${ex.label === 'MSE' ? 'MSEs' : 'Startups'}.`, { blocking: true, requirementKey: 'experience_years' });
      else if (!exp) push('experience', 'unknown', `Bid needs ${years(req)} of experience; add past contracts or your incorporation date to your profile.`, { blocking: true, requirementKey: 'experience_years' });
      else push('experience', 'fail', `You have ${years(exp.years)} of experience${basis}; the bid needs ${years(req)}.${exemptionHint()}`, { blocking: true, requirementKey: 'experience_years' });
    }
  }

  // 3. Similar work
  {
    const r = get('similar_work');
    if (!r) push('similarWork', 'na', 'No similar-work value condition found in the bid.');
    else if (r.numeric == null) push('similarWork', 'unknown', `Bid asks for similar work (${String(r.value)}), but the estimated value is unknown — check manually.`, { requirementKey: 'similar_work' });
    else {
      const best = pcs.reduce<ScorePastContract | null>((b, p) => (!b || p.value > b.value ? p : b), null);
      const ex = exemptionFor();
      if (best && best.value >= r.numeric) push('similarWork', 'pass', `Your largest past contract (${inr(best.value)}${best.title ? `, ${best.title}` : ''}) meets the required ${inr(r.numeric)}.`, { requirementKey: 'similar_work' });
      else if (ex) push('similarWork', 'exempt', `Exempt (${ex.label}): experience criteria are waived for ${ex.label === 'MSE' ? 'MSEs' : 'Startups'}.`, { requirementKey: 'similar_work' });
      else if (!pcs.length) push('similarWork', 'unknown', `Bid needs one similar work of ${inr(r.numeric)}; add your past contracts to check.`, { requirementKey: 'similar_work' });
      else push('similarWork', 'fail', `Your largest past contract is ${inr(best!.value)}; the bid needs one similar work of at least ${inr(r.numeric)}.`, { requirementKey: 'similar_work' });
    }
  }

  // 4. EMD
  {
    const r = get('emd');
    const amount = r?.numeric ?? input.tender?.emdAmount ?? null;
    if (amount == null) push('emd', 'na', 'No EMD is mentioned in the bid.');
    else if (amount <= 0) push('emd', 'pass', 'No EMD is required for this bid.', { requirementKey: 'emd' });
    else if (mseQualified) push('emd', 'exempt', `Exempt (MSE): EMD of ${inr(amount)} is waived with your valid Udyam certificate.`, { requirementKey: 'emd' });
    else if (startupQualified) push('emd', 'exempt', `Exempt (Startup): EMD of ${inr(amount)} is waived with your DPIIT recognition.`, { requirementKey: 'emd' });
    else {
      const cap = profile?.maxEmdCapacity ?? null;
      const hint = mseProfile ? ' Upload your Udyam certificate to claim the MSE exemption.' : startupProfile ? ' Upload your DPIIT certificate to claim the Startup exemption.' : '';
      if (cap == null) push('emd', 'unknown', `EMD of ${inr(amount)} is required; set your maximum EMD capacity in the company profile.${hint}`, { requirementKey: 'emd' });
      else if (amount <= cap) push('emd', 'pass', `EMD of ${inr(amount)} is within your capacity of ${inr(cap)}.${hint}`, { requirementKey: 'emd' });
      else push('emd', 'fail', `EMD of ${inr(amount)} exceeds your capacity of ${inr(cap)}.${hint}`, { requirementKey: 'emd' });
    }
  }

  // 5. Make in India
  {
    const r = get('mii');
    if (!r || r.value !== true) push('mii', 'na', 'The bid does not require Make in India compliance.');
    else {
      const cls = profile?.miiClass ?? null;
      const lc = profile?.localContentPct;
      const lcText = lc != null ? ` with ${lc}% local content` : '';
      if (cls === 'class_1') push('mii', 'pass', `You are a Class-I local supplier${lcText} and get purchase preference.`, { requirementKey: 'mii' });
      else if (cls === 'class_2') push('mii', 'pass', `You are a Class-II local supplier${lcText}: eligible, but without purchase preference.`, { requirementKey: 'mii' });
      else if (cls === 'non_local') push('mii', 'fail', 'Non-local suppliers are not eligible under the Make in India order for this bid.', { requirementKey: 'mii' });
      else push('mii', 'unknown', 'The bid requires MII compliance; set your local-content class in the company profile.', { requirementKey: 'mii' });
    }
  }

  // 6. OEM authorisation (blocking when mandatory)
  {
    const r = get('oem_auth');
    if (!r || r.value === false) push('oem', 'na', 'No OEM authorisation is required.');
    else {
      const validAuth = (profile?.oemAuthorizations ?? []).filter((a) => !a.validTill || new Date(`${a.validTill.slice(0, 10)}T23:59:59+05:30`).getTime() >= now.getTime());
      const vaultAuth = vault.filter((d) => d.type === 'oem_authorization' && isValidDoc(d, now));
      if (validAuth.length || vaultAuth.length) {
        const names = validAuth.map((a) => a.oem).filter(Boolean);
        const t = input.tender;
        const subject = (t?.category || t?.title || '').trim();
        const tenderWords = significantWords([t?.category, t?.title, ...(t?.items ?? []).map((i) => i.name)].filter(Boolean).join(' '));
        // Only judge coverage when the tender text is known; otherwise keep the generic "confirm" pass.
        const authWords = significantWords([
          ...validAuth.flatMap((a) => [a.oem, a.products ?? '']),
          ...vaultAuth.flatMap((d) => [d.title ?? '', ...(d.tags ?? [])]),
        ].join(' '));
        const covers = !tenderWords.size || [...tenderWords].some((w) => authWords.has(w));
        if (!covers) {
          const listed = (names.length ? names : vaultAuth.map((d) => d.title ?? '').filter(Boolean)).slice(0, 3).join(', ');
          push('oem', 'unknown', `None of your valid OEM authorisations${listed ? ` (${listed})` : ''} mention ${subject} — confirm one covers this product.`, { blocking: r.mandatory, requirementKey: 'oem_auth' });
        } else push('oem', 'pass', `You hold a valid OEM authorisation${names.length ? ` (${names.slice(0, 3).join(', ')})` : ''}. Confirm it covers this bid's product.`, { blocking: r.mandatory, requirementKey: 'oem_auth' });
      } else if (!profile) push('oem', 'unknown', 'The bid needs an OEM authorisation; complete your company profile to check.', { blocking: r.mandatory, requirementKey: 'oem_auth' });
      else push('oem', 'fail', 'The bid needs an OEM authorisation (MAF) and none is on file. Request one from the OEM before bidding.', { blocking: r.mandatory, requirementKey: 'oem_auth' });
    }
  }

  // 7. Certificates
  {
    const certs = requirements.filter((r) => r.key === 'certificate');
    if (!certs.length) push('certificates', 'na', 'No specific certificates are requested.');
    else {
      const owned = new Set((profile?.certifications ?? []).map(certKey));
      const missing = certs.map((c) => String(c.value ?? c.label)).filter((n) => !owned.has(certKey(n)) && ![...owned].some((o) => o.includes(certKey(n))) && !vaultHas(n, vault, now));
      const names = certs.map((c) => String(c.value ?? c.label));
      if (!missing.length) push('certificates', 'pass', `You hold all requested certificates: ${names.join(', ')}.`, { requirementKey: 'certificate' });
      else push('certificates', 'fail', `Missing ${plural(missing.length, 'certificate')}: ${missing.join(', ')}.`, { requirementKey: 'certificate' });
    }
  }

  // 8. Documents in vault
  {
    const checklist = buildChecklist(requirements, profile);
    // Certificates are scored by their own factor; bid-specific "other" documents can't be
    // verified automatically, so they are mentioned but not counted.
    const mandatory = checklist.filter((i) => i.mandatory && i.docType && !i.generated && !i.id.startsWith('cert_'));
    const needed = mandatory.filter((i) => i.docType !== 'other');
    const manual = mandatory.length - needed.length;
    const manualNote = manual ? ` Also check ${plural(manual, 'bid-specific document')} listed in the ATC.` : '';
    if (!needed.length) push('documents', 'na', `No standard documents are required.${manualNote}`);
    else {
      const missing = needed.filter((i) => !hasValid(i.docType as DocType));
      const expired = missing.filter((i) => hasExpired(i.docType as DocType));
      const have = needed.length - missing.length;
      if (!missing.length) push('documents', 'pass', `All ${plural(needed.length, 'required document')} are in your vault and valid.${manualNote}`);
      else {
        const list = missing.slice(0, 4).map((i) => i.label.split(' — ')[0]).join('; ');
        push('documents', 'fail', `${have} of ${needed.length} required documents are ready. Missing: ${list}${missing.length > 4 ? '…' : ''}.${expired.length ? ` ${plural(expired.length, 'document')} expired.` : ''}${manualNote}`);
      }
    }
  }

  // 9. Delivery feasibility
  {
    const r = get('delivery_days');
    // The listing's state wins; otherwise the consignee's state read from the bid document (FR-019).
    const consignee = get('consignee_state');
    const state = input.tender?.state || (typeof consignee?.value === 'string' ? consignee.value : null);
    const opStates = (profile?.operatingStates ?? []).map((s) => s.toLowerCase());
    if (!r || r.numeric == null) push('deliveryFeasibility', 'na', 'No delivery period found in the bid.');
    else if (r.numeric < 7) push('deliveryFeasibility', 'fail', `Only ${plural(r.numeric, 'day')} to deliver — very tight.`, { requirementKey: 'delivery_days' });
    else if (state && opStates.length && !opStates.includes(state.toLowerCase())) push('deliveryFeasibility', 'unknown', `Delivery in ${r.numeric} days to ${state}, outside your operating states — check logistics.`, { requirementKey: 'delivery_days' });
    else push('deliveryFeasibility', 'pass', `Delivery period of ${r.numeric} days${state ? ` to ${state}` : ''} looks feasible.`, { requirementKey: 'delivery_days' });
  }

  // 10. Time to close
  {
    const endRaw = input.tender?.endAt ?? (get('bid_end')?.value as string | undefined) ?? null;
    const end = toDate(endRaw);
    if (!end || Number.isNaN(end.getTime())) push('timeToClose', 'na', 'Bid closing date is unknown.');
    else {
      const days = (end.getTime() - now.getTime()) / DAY;
      if (days <= 0) push('timeToClose', 'fail', 'This bid has already closed.', { blocking: true, requirementKey: 'bid_end' });
      else if (days < 1) push('timeToClose', 'fail', `Closes in ${Math.max(1, Math.round(days * 24))} hours — too little time to prepare a complete bid.`, { requirementKey: 'bid_end' });
      else if (days < 3) push('timeToClose', 'unknown', `Closes in ${plural(Math.floor(days), 'day')} — tight; start now.`, { requirementKey: 'bid_end' });
      else push('timeToClose', 'pass', `Closes in ${plural(Math.floor(days), 'day')} — enough time to prepare.`, { requirementKey: 'bid_end' });
    }
  }

  // Re-apply overrides (FR-016)
  if (input.overrides) {
    for (const f of factors) {
      const o = input.overrides[f.key];
      if (o && o.status !== f.status) f.overridden = o;
    }
  }

  return { factors, ...computeScore(factors) };
}

/** Score / verdict / confidence / summary from (possibly overridden) factors. */
export function computeScore(factors: ScoreFactor[]): Omit<ScoreResult, 'factors'> {
  let wSum = 0; let vSum = 0; let considered = 0; let known = 0;
  for (const f of factors) {
    const st = effectiveStatus(f);
    const v = VALUE[st];
    if (v === null) continue;
    considered += 1;
    if (st !== 'unknown') known += 1;
    wSum += f.weight;
    vSum += f.weight * v;
  }
  const score = wSum > 0 ? Math.round((100 * vSum) / wSum) : 50;
  const confidence = considered ? Math.round((known / considered) * 100) / 100 : 0;
  const blockers = factors.filter((f) => f.blocking && effectiveStatus(f) === 'fail');
  const verdict: Verdict = blockers.length ? 'no_go' : score >= VERDICT_THRESHOLDS.go ? 'go' : score >= VERDICT_THRESHOLDS.review ? 'review' : 'no_go';
  return { score, verdict, confidence, summary: summarise(factors, score, verdict, confidence, blockers) };
}

function summarise(factors: ScoreFactor[], score: number, verdict: Verdict, confidence: number, blockers: ScoreFactor[]): string {
  const by = (s: Status) => factors.filter((f) => effectiveStatus(f) === s);
  const names = (fs: ScoreFactor[]) => {
    const n = fs.map((f) => (/^[A-Z][a-z]/.test(f.label) ? f.label.charAt(0).toLowerCase() + f.label.slice(1) : f.label));
    return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const parts: string[] = [];
  const head = verdict === 'go' ? 'Go' : verdict === 'review' ? 'Review' : 'No-Go';
  parts.push(`${head} — ${score}/100 with ${Math.round(confidence * 100)}% confidence.`);
  if (blockers.length) parts.push(`Blocked by ${names(blockers)}: ${blockers[0].detail}`);
  const passes = by('pass');
  if (passes.length && !blockers.length) parts.push(`${cap(names(passes.slice(0, 3)))} ${passes.length === 1 ? 'is' : 'are'} in your favour.`);
  const exempt = by('exempt');
  if (exempt.length) parts.push(`${cap(names(exempt))} ${exempt.length === 1 ? 'is' : 'are'} exempt for you.`);
  const fails = by('fail').filter((f) => !blockers.includes(f));
  if (fails.length) parts.push(`Fix: ${names(fails)}.`);
  const unknown = by('unknown');
  if (unknown.length) parts.push(`Needs review: ${names(unknown)}.`);
  if (factors.some((f) => f.overridden)) parts.push(`${plural(factors.filter((f) => f.overridden).length, 'factor')} manually overridden.`);
  return parts.join(' ');
}
