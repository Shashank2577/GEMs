/**
 * Indian statutory identifier validators and financial-year helpers (T050, FR-020).
 * Pure functions, shared by the API (zod refinements) and the web app (inline form errors).
 * Every validator returns `null` when the value is valid, or a plain-English message explaining
 * what is wrong — so the UI can show it next to the field.
 */

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Normalise free-typed identifiers: trim, upper-case, drop spaces. */
export const normalizeId = (v: string) => v.replace(/\s+/g, '').toUpperCase();

// ───────────── PAN ─────────────

/** 4th character of a PAN → holder type. */
export const PAN_ENTITY_TYPES: Record<string, string> = {
  P: 'Individual', C: 'Company', H: 'Hindu Undivided Family', F: 'Firm / LLP', A: 'Association of Persons',
  T: 'Trust', B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government',
};

export function validatePan(raw: string): string | null {
  const v = normalizeId(raw);
  if (v.length !== 10) return 'PAN has 10 characters, e.g. AAPCS1234K';
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return 'PAN format is 5 letters, 4 digits, 1 letter (e.g. AAPCS1234K)';
  if (!PAN_ENTITY_TYPES[v[3]!]) return `The 4th character "${v[3]}" is not a valid PAN holder type (P, C, H, F, A, T, B, L, J or G)`;
  return null;
}

/** Holder type implied by a PAN ("Company", "Firm / LLP"…), or null. */
export function panEntityType(raw: string): string | null {
  const v = normalizeId(raw);
  return validatePan(v) ? null : PAN_ENTITY_TYPES[v[3]!] ?? null;
}

// ───────────── GSTIN ─────────────

/** GST state codes → state / UT name. 97 = Other Territory, 99 = Centre Jurisdiction. */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Dadra and Nagar Haveli and Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

/** GSTIN check character (mod-36 Luhn variant) for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  const v = normalizeId(first14);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = B36.indexOf(v[i] ?? '');
    if (code < 0) return '?';
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36]!;
}

export function validateGstin(raw: string): string | null {
  const v = normalizeId(raw);
  if (v.length !== 15) return 'GSTIN has 15 characters, e.g. 27AAPCS1234K1Z2';
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) {
    return 'GSTIN format: 2-digit state code, 10-character PAN, entity number, "Z", check character';
  }
  if (!GST_STATE_CODES[v.slice(0, 2)]) return `"${v.slice(0, 2)}" is not a valid GST state code (01–38, 97 or 99)`;
  const panErr = validatePan(v.slice(2, 12));
  if (panErr) return `The PAN inside the GSTIN (characters 3–12) is invalid: ${panErr}`;
  const expected = gstinCheckChar(v.slice(0, 14));
  if (v[14] !== expected) return 'GSTIN check character does not match — please re-check for a typo';
  return null;
}

/** State implied by a GSTIN's first two digits, or null. */
export const gstinState = (raw: string): string | null => GST_STATE_CODES[normalizeId(raw).slice(0, 2)] ?? null;
/** PAN embedded in a GSTIN (characters 3–12). */
export const gstinPan = (raw: string): string => normalizeId(raw).slice(2, 12);

// ───────────── Udyam, CIN, IFSC, pincode ─────────────

/**
 * State / UT codes used in Udyam registration numbers (UDYAM-<code>-<district>-<serial>), FR-015:
 * 28 states + 8 union territories.
 */
export const UDYAM_STATE_CODES: Record<string, string> = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat',
  HR: 'Haryana', HP: 'Himachal Pradesh', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh',
  MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PB: 'Punjab',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand',
  WB: 'West Bengal',
  AN: 'Andaman and Nicobar Islands', CH: 'Chandigarh', DN: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi',
  JK: 'Jammu and Kashmir', LA: 'Ladakh', LD: 'Lakshadweep', PY: 'Puducherry',
};

/** Codes seen on older / alternate Udyam certificates → canonical code above. */
export const UDYAM_STATE_ALIASES: Record<string, string> = { DD: 'DN', TG: 'TS' };

/** Canonical state/UT name for a Udyam state code (aliases accepted), or null. */
export function udyamState(code: string): string | null {
  const c = code.toUpperCase();
  const canonical = Object.hasOwn(UDYAM_STATE_ALIASES, c) ? UDYAM_STATE_ALIASES[c]! : c;
  return Object.hasOwn(UDYAM_STATE_CODES, canonical) ? UDYAM_STATE_CODES[canonical]! : null;
}

export function validateUdyam(raw: string): string | null {
  const v = normalizeId(raw);
  if (!/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(v)) return 'Udyam number format is UDYAM-XX-00-0000000 (e.g. UDYAM-MH-26-0123456)';
  const state = v.slice(6, 8);
  if (!udyamState(state)) return `"${state}" is not a valid state code in a Udyam number`;
  return null;
}

/**
 * Company Identification Number: L/U + 5-digit industry + state + year + type + 6-digit number.
 * `now` bounds the incorporation year (≤ next year) and is injectable for deterministic tests (FR-015).
 */
export function validateCin(raw: string, now: Date = new Date()): string | null {
  const v = normalizeId(raw);
  if (v.length !== 21) return 'CIN has 21 characters, e.g. U72200MH2015PTC123456';
  if (!/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(v)) return 'CIN format: L/U, 5-digit industry code, state, year, company type, 6-digit number';
  const year = Number(v.slice(8, 12));
  if (year < 1850 || year > now.getUTCFullYear() + 1) return `Incorporation year ${year} in the CIN looks wrong`;
  return null;
}

export function validateIfsc(raw: string): string | null {
  const v = normalizeId(raw);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) return 'IFSC is 4 letters, a zero, then 6 letters or digits (e.g. HDFC0001234)';
  return null;
}

export function validatePincode(raw: string): string | null {
  const v = raw.replace(/\s+/g, '');
  if (!/^[1-9]\d{5}$/.test(v)) return 'PIN code is 6 digits and cannot start with 0';
  return null;
}

/** DPIIT startup recognition number, e.g. DIPP12345. Lenient: GeM shows several historical formats. */
export function validateDpiit(raw: string): string | null {
  const v = normalizeId(raw);
  if (!/^(DIPP|DPIIT)?\d{3,8}$/.test(v)) return 'DPIIT recognition number looks like DIPP12345';
  return null;
}

// ───────────── Phone ─────────────

/** Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX), or null when invalid. */
export function toE164IndianMobile(raw: string): string | null {
  let d = raw.replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return `+91${d}`;
}

export function validateIndianMobile(raw: string): string | null {
  return toE164IndianMobile(raw) ? null : 'Enter a 10-digit Indian mobile number starting with 6–9';
}

// ───────────── Financial years ─────────────

/** "2024-25" for any date in Apr 2024 – Mar 2025 (Indian FY). Uses IST calendar. */
export function fyLabelForDate(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return fyLabel(start);
}

/** FY label from its starting year: 2024 → "2024-25". */
export const fyLabel = (startYear: number) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** Starting year of a FY label. Accepts "2024-25", "FY 2024-25", "FY24-25", "2024-2025". null when unparseable. */
export function fyStartYear(label: string): number | null {
  const s = label.trim().toUpperCase().replace(/^FY\s*/, '');
  let m = s.match(/^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]!.length === 2 ? `${String(a + 1).slice(0, 2)}${m[2]}` : m[2]);
    return b === a + 1 ? a : null;
  }
  m = s.match(/^(\d{2})\s*[-–/]\s*(\d{2})$/);
  if (m) {
    const a = 2000 + Number(m[1]);
    return Number(m[2]) === (a + 1) % 100 ? a : null;
  }
  return null;
}

/** Canonical "2024-25" form of a FY label, or null. */
export function normalizeFy(label: string): string | null {
  const y = fyStartYear(label);
  return y == null ? null : fyLabel(y);
}

/** The last `n` *completed* FYs before `now`, newest first. In Nov 2026 → ["2025-26", "2024-25", "2023-24"]. */
export function lastCompletedFys(now: Date, n = 3): string[] {
  const current = fyStartYear(fyLabelForDate(now))!;
  return Array.from({ length: n }, (_, i) => fyLabel(current - 1 - i));
}

export interface FyAmount { fy: string; turnover: number }

/**
 * Average turnover of the latest `n` FYs that have figures (sorted by FY, newest first).
 * GeM ATCs usually say "average annual turnover of the last 3 financial years".
 */
export function averageTurnoverLastN(financials: readonly FyAmount[], n = 3): { avg: number; years: string[] } | null {
  const rows = financials
    .map((f) => ({ start: fyStartYear(f.fy), turnover: f.turnover }))
    .filter((f): f is { start: number; turnover: number } => f.start != null && Number.isFinite(f.turnover) && f.turnover >= 0)
    .sort((a, b) => b.start - a.start);
  const seen = new Set<number>();
  const uniq = rows.filter((r) => (seen.has(r.start) ? false : (seen.add(r.start), true))).slice(0, n);
  if (!uniq.length) return null;
  return { avg: Math.round(uniq.reduce((s, r) => s + r.turnover, 0) / uniq.length), years: uniq.map((r) => fyLabel(r.start)) };
}
