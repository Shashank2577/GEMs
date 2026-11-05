/**
 * Company-profile completeness (T052; FR-020). A weighted checklist of what GeM bids usually need,
 * producing a 0–100 score and actionable issues the UI links to the right form section.
 */
import { docStatus, reminderCopy } from './status';
import { fyStartYear, lastCompletedFys } from './validators';

export type ProfileSection = 'identity' | 'registrations' | 'financials' | 'experience' | 'oem' | 'categories' | 'contact' | 'vault';

export interface CompletenessIssue {
  field: string;
  section: ProfileSection;
  message: string;
  /** error = blocks scoring/packets; warning = weakens bids; info = nice to have. */
  severity: 'error' | 'warning' | 'info';
}

export interface CompletenessProfile {
  legalName?: string | null; gstin?: string | null; pan?: string | null; address?: string | null; state?: string | null;
  pincode?: string | null; incorporationDate?: string | null; udyamNumber?: string | null; mseCategory?: string | null;
  isStartup?: boolean | null; dpiitNumber?: string | null; miiClass?: string | null;
  financials?: { fy: string; turnover: number; netWorth?: number | null }[] | null;
  categories?: string[] | null; hsnCodes?: string[] | null; operatingStates?: string[] | null;
  oemAuthorizations?: { oem: string; validTill?: string | null; documentId?: string | null }[] | null;
  signatoryName?: string | null; signatoryDesignation?: string | null; contactEmail?: string | null; contactPhone?: string | null;
}

export interface CompletenessDoc { type: string; expiryDate?: string | null; title?: string }

export interface CompletenessResult { percent: number; issues: CompletenessIssue[] }

const present = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '');

export function profileCompleteness(
  profile: CompletenessProfile | null | undefined,
  pastContracts: readonly unknown[] = [],
  docs: readonly CompletenessDoc[] = [],
  now: Date = new Date(),
): CompletenessResult {
  const p = profile ?? {};
  const issues: CompletenessIssue[] = [];
  let total = 0;
  let earned = 0;
  const has = (t: string) => docs.some((d) => d.type === t && docStatus(d.expiryDate ?? null, now).status !== 'expired');

  /** Award `weight` when `ok`, else record the issue. `partial` (0..1) awards part of the weight. */
  const check = (weight: number, ok: boolean | number, issue: Omit<CompletenessIssue, 'severity'> & { severity?: CompletenessIssue['severity'] }) => {
    total += weight;
    const frac = typeof ok === 'number' ? Math.max(0, Math.min(1, ok)) : ok ? 1 : 0;
    earned += weight * frac;
    if (frac < 1) issues.push({ severity: 'warning', ...issue });
  };

  // Identity
  check(8, present(p.legalName), { field: 'legalName', section: 'identity', severity: 'error', message: 'Add your legal company name exactly as registered on GeM.' });
  check(10, present(p.gstin), { field: 'gstin', section: 'identity', severity: 'error', message: 'Add your GSTIN — almost every GeM bid asks for it.' });
  check(8, present(p.pan), { field: 'pan', section: 'identity', severity: 'error', message: 'Add the PAN of the bidding entity.' });
  check(5, [p.address, p.state, p.pincode].filter(present).length / 3, { field: 'address', section: 'identity', message: 'Complete the registered address (address, state and PIN code).' });
  check(3, present(p.incorporationDate), { field: 'incorporationDate', section: 'identity', message: 'Add the incorporation date — some bids ask for years in business.', severity: 'info' });

  // Registrations
  if (present(p.mseCategory) || present(p.udyamNumber)) {
    check(6, present(p.udyamNumber) && present(p.mseCategory), { field: 'udyamNumber', section: 'registrations', message: 'Add both the Udyam number and MSE category to claim EMD exemption and purchase preference.' });
  }
  if (p.isStartup) {
    check(4, present(p.dpiitNumber), { field: 'dpiitNumber', section: 'registrations', message: 'Add your DPIIT recognition number to use startup relaxations.' });
  }
  check(6, present(p.miiClass), { field: 'miiClass', section: 'registrations', message: 'Choose your Make in India class — many bids are restricted to Class-I/II local suppliers.' });

  // Financials
  const wanted = lastCompletedFys(now, 3);
  const haveFys = new Set((p.financials ?? []).map((f) => fyStartYear(f.fy)).filter((y): y is number => y != null));
  const covered = wanted.filter((fy) => haveFys.has(fyStartYear(fy)!)).length;
  const missing = wanted.filter((fy) => !haveFys.has(fyStartYear(fy)!));
  check(12, covered / 3, {
    field: 'financials', section: 'financials', severity: covered === 0 ? 'error' : 'warning',
    message: covered === 0 ? `Add turnover for the last 3 financial years (${[...wanted].reverse().join(', ')}) — used for turnover criteria.`
      : `Add turnover for ${missing.join(', ')} so the 3-year average is accurate.`,
  });
  const hasNetWorth = (p.financials ?? []).some((f) => f.netWorth != null);
  check(2, hasNetWorth, { field: 'financials', section: 'financials', severity: 'info', message: 'Add net worth for the latest year — some bids require a positive net worth.' });

  // Experience
  check(10, Math.min(pastContracts.length, 3) / 3, {
    field: 'pastContracts', section: 'experience', severity: pastContracts.length ? 'info' : 'warning',
    message: pastContracts.length ? 'Add at least 3 past contracts to match more experience criteria.' : 'Add past contracts (with values) — bids often require similar work worth 40–80% of the estimate.',
  });

  // Categories & reach
  check(6, present(p.categories), { field: 'categories', section: 'categories', message: 'Add the product/service categories you sell on GeM.' });
  check(3, present(p.hsnCodes), { field: 'hsnCodes', section: 'categories', severity: 'info', message: 'Add HSN/SAC codes to improve tender matching.' });
  check(3, present(p.operatingStates), { field: 'operatingStates', section: 'categories', severity: 'info', message: 'Choose the states where you can deliver or serve.' });

  // Signatory & contact
  check(5, [p.signatoryName, p.signatoryDesignation].filter(present).length / 2, { field: 'signatoryName', section: 'contact', message: 'Add the authorised signatory name and designation — used on undertakings and annexures.' });
  check(4, [p.contactEmail, p.contactPhone].filter(present).length / 2, { field: 'contactEmail', section: 'contact', message: 'Add a contact email and mobile number.' });

  // OEM authorisations — warnings/info only, no weight (FR-017, FR-020).
  (p.oemAuthorizations ?? []).forEach((o, i) => {
    const st = o.validTill ? docStatus(o.validTill, now) : null;
    if (st?.status === 'expired') {
      issues.push({ field: 'oemAuthorizations', section: 'oem', severity: 'warning', message: `OEM authorisation from ${o.oem} has expired — request a fresh one.` });
    } else if (st?.status === 'expiring' && st.daysToExpiry != null) {
      issues.push({ field: `oemAuthorizations.${i}.validTill`, section: 'oem', severity: 'info', message: `OEM authorisation from ${o.oem} ${reminderCopy(1, st.daysToExpiry)} — ask for a renewed MAF.` });
    }
    if (!present(o.documentId)) {
      issues.push({ field: `oemAuthorizations.${i}.documentId`, section: 'oem', severity: 'info', message: `Link the ${o.oem} authorisation letter from the vault so packets can attach it.` });
    }
  });

  // Vault documents that back the profile
  check(5, has('gst'), { field: 'vault.gst', section: 'vault', message: 'Upload your GST registration certificate to the vault.' });
  check(4, has('pan'), { field: 'vault.pan', section: 'vault', message: 'Upload your PAN card to the vault.' });
  check(4, has('ca_turnover_certificate') || has('balance_sheet'), { field: 'vault.financials', section: 'vault', message: 'Upload a CA turnover certificate or audited balance sheets.' });
  if (present(p.udyamNumber)) check(3, has('udyam'), { field: 'vault.udyam', section: 'vault', message: 'Upload your Udyam certificate — required to claim the MSE EMD exemption.' });
  if (p.isStartup) check(3, has('startup_dpiit'), { field: 'vault.startup_dpiit', section: 'vault', message: 'Upload your DPIIT recognition certificate.' });

  const expired = docs.filter((d) => docStatus(d.expiryDate ?? null, now).status === 'expired');
  if (expired.length) {
    issues.push({
      field: 'vault.expired', section: 'vault', severity: 'warning',
      message: expired.length === 1 ? `"${expired[0]!.title ?? expired[0]!.type}" in the vault has expired — upload the renewed copy.` : `${expired.length} vault documents have expired — upload renewed copies.`,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { percent: total ? Math.round((earned / total) * 100) : 0, issues };
}
