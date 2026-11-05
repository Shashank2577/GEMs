/**
 * Submission-assist allow-list (T064; FR-026, FR-027, Constitution I).
 *
 * The browser extension and the web "Submission assistant" may only pre-fill NON-FINANCIAL fields
 * that are on this allow-list, and only after a user click. Anything that looks like a price,
 * an amount, a CAPTCHA, an OTP, DSC / e-Sign / Aadhaar authentication, a password, or a
 * submit / final-submit control is FORBIDDEN — `isFieldAllowed` always returns false for it,
 * even if it also matches an allowed field (forbidden wins).
 */

export type AssistGroup = 'product' | 'offer' | 'compliance' | 'declaration';

export interface AssistFieldDef {
  key: string;
  label: string;
  group: AssistGroup;
  /** Help text shown in the assistant. */
  help: string;
  /**
   * Regex sources (case-insensitive) matched against a normalised field descriptor
   * (name, id, label, placeholder, aria-label). Sent to the extension in the assist payload.
   */
  selectorHints: string[];
  /** Kind of control the value usually goes into. */
  input: 'text' | 'number' | 'select' | 'textarea';
}

export const FIELD_CATALOG: readonly AssistFieldDef[] = [
  { key: 'make', label: 'Make', group: 'product', input: 'text', help: 'Manufacturer of the offered product.', selectorHints: ['\\bmake\\b', '\\bmanufacturer\\b'] },
  { key: 'brand', label: 'Brand', group: 'product', input: 'text', help: 'Brand name as on the OEM authorisation.', selectorHints: ['\\bbrand\\b'] },
  { key: 'model', label: 'Model', group: 'product', input: 'text', help: 'Model number / name of the offered product.', selectorHints: ['\\bmodel\\b'] },
  { key: 'oem_name', label: 'OEM name', group: 'product', input: 'text', help: 'Original Equipment Manufacturer you are authorised by.', selectorHints: ['\\boem\\b', 'original equipment manufacturer'] },
  { key: 'product_description', label: 'Product description', group: 'product', input: 'textarea', help: 'Short description of the offered product or service.', selectorHints: ['\\bdescription\\b', 'product details', 'item details'] },
  { key: 'hsn_code', label: 'HSN / SAC code', group: 'product', input: 'text', help: 'HSN (goods) or SAC (services) code.', selectorHints: ['\\bhsn\\b', '\\bsac\\b'] },
  { key: 'offered_quantity', label: 'Offered quantity', group: 'offer', input: 'number', help: 'Quantity you are offering against the bid.', selectorHints: ['\\boffered quantity\\b', '\\bquantity offered\\b', '\\bqty\\b', '\\bquantity\\b'] },
  { key: 'delivery_period_days', label: 'Delivery period (days)', group: 'offer', input: 'number', help: 'Delivery period you commit to, in days.', selectorHints: ['\\bdelivery (period|days|time|schedule)\\b', '\\bdelivery\\b'] },
  { key: 'warranty_months', label: 'Warranty (months)', group: 'offer', input: 'number', help: 'Warranty period offered, in months.', selectorHints: ['\\bwarranty\\b', '\\bguarantee period\\b'] },
  { key: 'country_of_origin', label: 'Country of origin', group: 'compliance', input: 'select', help: 'Country where the product is manufactured.', selectorHints: ['country of origin', '\\borigin\\b'] },
  { key: 'local_content_pct', label: 'Local content (%)', group: 'compliance', input: 'number', help: 'Make in India local content percentage (Class-I ≥ 50%, Class-II ≥ 20%).', selectorHints: ['local content', '\\bmii\\b', 'make in india'] },
  { key: 'specs_compliance', label: 'Specification compliance', group: 'compliance', input: 'select', help: 'Whether the offer complies with the bid specifications.', selectorHints: ['\\bcompl(y|iance|ied)\\b', 'specification', '\\bspecs?\\b'] },
  { key: 'mse_claim', label: 'MSE preference claimed', group: 'declaration', input: 'select', help: 'Claim MSE purchase preference / exemptions (needs a valid Udyam certificate).', selectorHints: ['\\bmse\\b', '\\bmsme\\b', 'micro (and|&) small', '\\budyam\\b'] },
  { key: 'startup_claim', label: 'Startup exemption claimed', group: 'declaration', input: 'select', help: 'Claim DPIIT Startup exemptions.', selectorHints: ['\\bstart ?up\\b', '\\bdpiit\\b'] },
];

export const FIELD_BY_KEY: ReadonlyMap<string, AssistFieldDef> = new Map(FIELD_CATALOG.map((f) => [f.key, f]));
export const ALLOWED_KEYS = FIELD_CATALOG.map((f) => f.key);

/**
 * Forbidden patterns, matched against the normalised descriptor (lower-case, camelCase / snake_case /
 * kebab-case split into words). Order is irrelevant: any hit forbids the field.
 */
export const FORBIDDEN_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: /\bprices?\b|\bpricing\b/, reason: 'price' },
  { re: /\brates?\b/, reason: 'rate' },
  { re: /\bamounts?\b|\bamt\b/, reason: 'amount' },
  { re: /\bunit (price|cost|rate)\b/, reason: 'unit price' },
  { re: /\b(total|bid|contract|order|quoted?|offer(ed)?|estimated|gross|net|basic|landed) values?\b/, reason: 'bid value' },
  { re: /\bcosts?\b|\btariffs?\b|\bdiscounts?\b|\btax(es)?\b|\bgst amount\b|\bfinancial\b|\bboq value\b/, reason: 'financial' },
  { re: /₹|\binr\b|\brs\b|\brupees?\b/, reason: 'currency' },
  { re: /\bcaptcha\b|\brecaptcha\b|\bh ?captcha\b|\bsecurity code\b|\bverification code\b/, reason: 'captcha' },
  { re: /\botp\b|\bone time pass(word|code)\b/, reason: 'otp' },
  { re: /\bdsc\b|\bdigital signature\b|\bdigitally sign/, reason: 'dsc' },
  { re: /\be ?sign\b|\besignature\b/, reason: 'e-sign' },
  { re: /\baadha+r\b|\buid(ai)?\b/, reason: 'aadhaar' },
  { re: /\bpass(word|code|phrase)?\b|\bpwd\b|\bpin\b/, reason: 'password' },
  { re: /\bsubmit\b|\bsubmission\b|\bfinal\b|\bconfirm bid\b|\bplace bid\b/, reason: 'submit' },
];

/** Input types that are never filled. */
export const FORBIDDEN_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'submit', 'button', 'reset', 'image', 'file', 'hidden', 'checkbox', 'radio']);

export interface FieldDescriptor {
  tagName?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  label?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  /** Free text near the field (e.g. table cell header). */
  context?: string | null;
}

/** "unitPrice" / "unit_price" / "Unit-Price" → "unit price". */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-.:/\\[\]()#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function descriptorText(d: FieldDescriptor): string {
  return [d.name, d.id, d.label, d.placeholder, d.ariaLabel, d.context].map(normalizeText).filter(Boolean).join(' | ');
}

/** Why a field is forbidden, or null when it is not. */
export function forbiddenReason(d: FieldDescriptor | string): string | null {
  if (typeof d !== 'string') {
    const type = (d.type ?? '').toLowerCase();
    if (FORBIDDEN_INPUT_TYPES.has(type)) return `input type "${type}"`;
    const tag = (d.tagName ?? '').toLowerCase();
    if (tag === 'button') return 'button';
  }
  const t = typeof d === 'string' ? normalizeText(d) : descriptorText(d);
  for (const p of FORBIDDEN_PATTERNS) if (p.re.test(t)) return p.reason;
  return null;
}

/** True when the key / label looks like a price, OTP, captcha, submit … (used to reject assist values). */
export function isForbiddenKey(key: string): boolean {
  return forbiddenReason(key) !== null;
}

/** The allow-listed field a descriptor corresponds to, or null (forbidden or unknown). */
export function matchField(d: FieldDescriptor, catalog: readonly Pick<AssistFieldDef, 'key' | 'selectorHints'>[] = FIELD_CATALOG): string | null {
  if (forbiddenReason(d)) return null;
  const t = descriptorText(d);
  if (!t) return null;
  // Prefer the most specific (longest) hint that matches.
  let best: { key: string; len: number } | null = null;
  for (const f of catalog) {
    for (const h of f.selectorHints) {
      let re: RegExp;
      try { re = new RegExp(h, 'i'); } catch { continue; }
      if (re.test(t) && (!best || h.length > best.len)) best = { key: f.key, len: h.length };
    }
  }
  return best?.key ?? null;
}

/** Never true for forbidden fields; true only for fields that match the allow-list. */
export function isFieldAllowed(d: FieldDescriptor): boolean {
  return matchField(d) !== null;
}

// ───────────── Payload ─────────────

export const HUMAN_STEPS: readonly { key: string; title: string; detail: string }[] = [
  { key: 'price', title: 'Enter your price on GeM', detail: 'Type the unit price / total value yourself in the GeM price schedule. TenderPilot never sees or fills prices.' },
  { key: 'upload', title: 'Upload the documents', detail: 'Attach the packet and documents listed below in the GeM upload slots and check each preview.' },
  { key: 'auth', title: 'Authenticate with OTP / DSC / e-Sign', detail: 'Complete Aadhaar OTP, e-Sign or your Digital Signature Certificate on GeM. Only you can do this.' },
  { key: 'submit', title: 'Click Final Submit', detail: 'Review the bid summary on GeM and press Final Submit yourself, then record it here.' },
];

export interface AssistProfile {
  mseCategory?: string | null; udyamNumber?: string | null; isStartup?: boolean | null; dpiitNumber?: string | null;
  miiClass?: string | null; localContentPct?: number | null; hsnCodes?: string[] | null;
  oemAuthorizations?: { oem: string; products?: string | null }[] | null;
}
export interface AssistTender { bidNumber: string; title: string; quantity?: number | null; hsnCodes?: string[] | null; items?: { name: string }[] | null }
export interface AssistDocument { title: string; fileName: string; url: string; kind?: string; pages?: number | null }

export interface AssistField {
  key: string;
  label: string;
  group: AssistGroup;
  help: string;
  value: string;
  /** Where the value came from. */
  source: 'saved' | 'profile' | 'tender' | 'analysis' | 'empty';
  selectorHints: string[];
  input: AssistFieldDef['input'];
}

export interface AssistPayload {
  workspaceId: string;
  tender: { bidNumber: string; title: string };
  fields: AssistField[];
  documents: AssistDocument[];
  humanSteps: typeof HUMAN_STEPS;
  /** Always true — reminds clients the payload never contains prices. */
  noFinancials: true;
}

/** Default values derived from the profile / tender / analysis. */
export function deriveAssistDefaults(profile: AssistProfile | null | undefined, tender: AssistTender, extra: { deliveryDays?: number | null } = {}): Record<string, { value: string; source: AssistField['source'] }> {
  const p = profile ?? {};
  const out: Record<string, { value: string; source: AssistField['source'] }> = {};
  const oem = (p.oemAuthorizations ?? [])[0];
  if (oem?.oem) {
    out.make = { value: oem.oem, source: 'profile' };
    out.brand = { value: oem.oem, source: 'profile' };
    out.oem_name = { value: oem.oem, source: 'profile' };
  }
  if (tender.quantity != null) out.offered_quantity = { value: String(tender.quantity), source: 'tender' };
  if (extra.deliveryDays != null) out.delivery_period_days = { value: String(extra.deliveryDays), source: 'analysis' };
  if (p.miiClass === 'class_1' || p.miiClass === 'class_2') out.country_of_origin = { value: 'India', source: 'profile' };
  if (p.localContentPct != null) out.local_content_pct = { value: String(p.localContentPct), source: 'profile' };
  const hsn = tender.hsnCodes?.[0] ?? p.hsnCodes?.[0];
  if (hsn) out.hsn_code = { value: hsn, source: tender.hsnCodes?.[0] ? 'tender' : 'profile' };
  out.specs_compliance = { value: 'Yes', source: 'profile' };
  out.mse_claim = { value: p.mseCategory || p.udyamNumber ? 'Yes' : 'No', source: 'profile' };
  out.startup_claim = { value: p.isStartup || p.dpiitNumber ? 'Yes' : 'No', source: 'profile' };
  const item = tender.items?.[0]?.name;
  if (item) out.product_description = { value: item, source: 'tender' };
  return out;
}

/**
 * Build the assist payload: allow-listed fields only (saved workspace values override derived
 * defaults), document names in upload order, and the human-only steps. Forbidden keys can never
 * appear, even if they were somehow stored.
 */
export function assistPayload(input: {
  workspace: { id: string; assistValues?: Record<string, string> | null };
  tender: AssistTender;
  profile: AssistProfile | null | undefined;
  documents: AssistDocument[];
  deliveryDays?: number | null;
}): AssistPayload {
  const defaults = deriveAssistDefaults(input.profile, input.tender, { deliveryDays: input.deliveryDays });
  const saved = input.workspace.assistValues ?? {};
  const fields: AssistField[] = FIELD_CATALOG.filter((f) => !isForbiddenKey(f.key)).map((f) => {
    const s = saved[f.key];
    const d = defaults[f.key];
    const value = s != null && s !== '' ? s : d?.value ?? '';
    return {
      key: f.key, label: f.label, group: f.group, help: f.help, input: f.input, selectorHints: [...f.selectorHints], value,
      source: s != null && s !== '' ? 'saved' : d ? d.source : 'empty',
    };
  });
  return {
    workspaceId: input.workspace.id,
    tender: { bidNumber: input.tender.bidNumber, title: input.tender.title },
    fields,
    documents: input.documents,
    humanSteps: HUMAN_STEPS,
    noFinancials: true,
  };
}

/** Validate assist values from a client: returns per-key errors (empty object = ok). */
export function validateAssistValues(values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const reason = forbiddenReason(k);
    if (reason) { errors[k] = `"${k}" looks like a ${reason} field. TenderPilot never stores or fills prices, OTP, CAPTCHA, DSC/e-Sign or submit actions.`; continue; }
    if (!FIELD_BY_KEY.has(k)) { errors[k] = `"${k}" is not an allow-listed field`; continue; }
    if (v != null && typeof v !== 'string') { errors[k] = 'Must be text'; continue; }
    if (typeof v === 'string' && v.length > 2000) errors[k] = 'Keep it under 2000 characters';
  }
  return errors;
}
