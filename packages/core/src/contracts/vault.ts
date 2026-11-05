/**
 * Profile & Vault API contracts (T052; FR-020, FR-021). Shared by the API (validation) and the web
 * app (types + client-side validation). See specs/001-gem-tender-copilot/contracts/api.md.
 */
import { z } from 'zod';
import { DOC_CATEGORIES, DOC_TYPE_VALUES, type DocCategory, type DocStatus, type DocType } from '../vault/status';
import {
  normalizeFy, normalizeId, toE164IndianMobile, validateCin, validateDpiit, validateGstin, validatePan, validatePincode, validateUdyam,
} from '../vault/validators';
import type { CompletenessIssue } from '../vault/completeness';

export type { DocType, DocStatus, DocCategory, CompletenessIssue };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** '' / whitespace → null; otherwise trimmed. */
const blankToNull = (v: unknown) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v);

const optText = (max = 200) => z.preprocess(blankToNull, z.string().max(max, `Keep it under ${max} characters`).nullable().optional());

/** Optional identifier: normalised (upper-case, no spaces) and checked by a validator. */
const optId = (validate: (v: string) => string | null) =>
  z.preprocess(
    (v) => { const b = blankToNull(v); return typeof b === 'string' ? normalizeId(b) : b; },
    z.string().nullable().optional().superRefine((v, ctx) => {
      if (!v) return;
      const msg = validate(v);
      if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    }),
  );

/** Round-trip check: `Date.parse` rolls 2029-02-30 over to 2 March instead of rejecting it. */
const isRealDate = (s: string) => { const t = Date.parse(`${s}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
export const isoDateSchema = z.string().regex(ISO_DATE, 'Use a date like 2025-03-31').refine(isRealDate, 'Not a real date');
const optDate = z.preprocess(blankToNull, isoDateSchema.nullable().optional());

const listOf = (item: z.ZodTypeAny, max = 200) => z.array(item).max(max).optional();

export const financialYearSchema = z.object({
  fy: z.string().transform((v, ctx) => {
    const n = normalizeFy(v);
    if (!n) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a financial year like 2024-25' }); return z.NEVER; }
    return n;
  }),
  turnover: z.coerce.number({ invalid_type_error: 'Enter the turnover in rupees' }).int('Whole rupees only').nonnegative('Turnover cannot be negative').max(1e15),
  netWorth: z.coerce.number().int('Whole rupees only').min(-1e15).max(1e15).nullable().optional(),
  audited: z.boolean().optional(),
});
export type FinancialYearInput = z.input<typeof financialYearSchema>;

export const oemAuthorizationSchema = z.object({
  oem: z.string().trim().min(1, 'OEM name is required').max(120),
  products: z.string().trim().max(500).default(''),
  validTill: optDate,
  documentId: z.preprocess(blankToNull, z.string().uuid().nullable().optional()),
});

export const MSE_CATEGORIES = ['micro', 'small', 'medium'] as const;
export const MSE_SOCIAL_CATEGORIES = ['general', 'sc_st', 'women'] as const;
export const MII_CLASSES = ['class_1', 'class_2', 'non_local'] as const;

export const MII_CLASS_INFO: Record<(typeof MII_CLASSES)[number], { label: string; short: string; description: string }> = {
  class_1: { label: 'Class-I local supplier', short: 'Class-I', description: 'Local content of 50% or more. Gets purchase preference under the PPP-MII Order 2017.' },
  class_2: { label: 'Class-II local supplier', short: 'Class-II', description: 'Local content of 20% or more but under 50%. Can bid in most tenders, without preference.' },
  non_local: { label: 'Non-local supplier', short: 'Non-local', description: 'Local content under 20%. Barred from many tenders below ₹200 crore.' },
};

export const profileInputSchema = z.object({
  legalName: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().max(200).optional()),
  tradeName: optText(),
  gstin: optId(validateGstin),
  pan: optId(validatePan),
  // Explicit wrapper so the CIN year bound always uses the real clock here (validateCin(raw, now), FR-015).
  cin: optId((v) => validateCin(v)),
  udyamNumber: optId(validateUdyam),
  mseCategory: z.preprocess(blankToNull, z.enum(MSE_CATEGORIES).nullable().optional()),
  mseSocialCategory: z.preprocess(blankToNull, z.enum(MSE_SOCIAL_CATEGORIES).nullable().optional()),
  isStartup: z.boolean().optional(),
  dpiitNumber: optId(validateDpiit),
  miiClass: z.preprocess(blankToNull, z.enum(MII_CLASSES).nullable().optional()),
  localContentPct: z.preprocess(blankToNull, z.coerce.number().min(0, '0–100%').max(100, '0–100%').nullable().optional()),
  incorporationDate: optDate,
  address: optText(500),
  state: optText(80),
  pincode: z.preprocess(blankToNull, z.string().nullable().optional().superRefine((v, ctx) => {
    const m = v ? validatePincode(v) : null;
    if (m) ctx.addIssue({ code: z.ZodIssueCode.custom, message: m });
  })),
  contactName: optText(),
  contactEmail: z.preprocess(blankToNull, z.string().toLowerCase().email('Enter a valid email address').max(254).nullable().optional()),
  contactPhone: z.preprocess(blankToNull, z.string().nullable().optional().transform((v, ctx) => {
    if (!v) return v;
    const e = toE164IndianMobile(v);
    if (!e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a 10-digit Indian mobile number starting with 6–9' }); return z.NEVER; }
    return e;
  })),
  signatoryName: optText(),
  signatoryDesignation: optText(),
  financials: listOf(financialYearSchema, 30),
  categories: listOf(z.string().trim().min(1).max(120), 100),
  hsnCodes: listOf(z.string().trim().regex(/^\d{4}(\d{2}){0,2}$/, 'HSN/SAC codes have 4, 6 or 8 digits'), 200),
  operatingStates: listOf(z.string().trim().min(1).max(80), 40),
  oemAuthorizations: listOf(oemAuthorizationSchema, 100),
  certifications: listOf(z.string().trim().min(1).max(120), 50),
  maxEmdCapacity: z.preprocess(blankToNull, z.coerce.number().int().nonnegative().nullable().optional()),
  /**
   * Optimistic concurrency (FR-014): the `updatedAt` the client last loaded (null = no profile saved yet).
   * Not a profile field — the API compares it with the stored `updated_at` and answers 409 on mismatch.
   */
  expectedUpdatedAt: z.string().datetime({ offset: true, message: 'Use an ISO timestamp' }).nullable().optional(),
}).superRefine((p, ctx) => {
  if (p.gstin && p.pan && !validateGstin(p.gstin) && !validatePan(p.pan) && p.gstin.slice(2, 12) !== p.pan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gstin'], message: `This GSTIN belongs to PAN ${p.gstin.slice(2, 12)}, not ${p.pan}` });
  }
  if (p.financials) {
    const seen = new Set<string>();
    p.financials.forEach((f, i) => {
      if (seen.has(f.fy)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['financials', i, 'fy'], message: `${f.fy} is listed twice` });
      seen.add(f.fy);
    });
  }
  if (p.miiClass === 'class_1' && p.localContentPct != null && p.localContentPct < 50) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['localContentPct'], message: 'Class-I needs at least 50% local content' });
  }
  if (p.miiClass === 'class_2' && p.localContentPct != null && (p.localContentPct < 20 || p.localContentPct >= 50)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['localContentPct'], message: 'Class-II means 20% to under 50% local content' });
  }
});
export type ProfileInput = z.input<typeof profileInputSchema>;
export type ProfileParsed = z.output<typeof profileInputSchema>;

export interface FinancialYearDto { fy: string; turnover: number; netWorth?: number | null; audited?: boolean }
export interface OemAuthorizationDto { oem: string; products: string; validTill?: string | null; documentId?: string | null }

export interface CompanyProfileDto {
  legalName: string; tradeName: string | null; gstin: string | null; pan: string | null; cin: string | null;
  udyamNumber: string | null; mseCategory: (typeof MSE_CATEGORIES)[number] | null;
  mseSocialCategory: (typeof MSE_SOCIAL_CATEGORIES)[number] | null; isStartup: boolean; dpiitNumber: string | null;
  miiClass: (typeof MII_CLASSES)[number] | null; localContentPct: number | null; incorporationDate: string | null;
  address: string | null; state: string | null; pincode: string | null; contactName: string | null;
  contactEmail: string | null; contactPhone: string | null; signatoryName: string | null; signatoryDesignation: string | null;
  financials: FinancialYearDto[]; categories: string[]; hsnCodes: string[]; operatingStates: string[];
  oemAuthorizations: OemAuthorizationDto[]; certifications: string[]; maxEmdCapacity: number | null;
  updatedAt: string | null;
}

export interface ProfileResponse {
  profile: CompanyProfileDto;
  /** 0..100 */
  completeness: number;
  issues: CompletenessIssue[];
  /** Average turnover of the latest 3 FYs with figures, or null. */
  averageTurnover: { avg: number; years: string[] } | null;
}

// ───────────── Past contracts ─────────────

export const BUYER_TYPES = ['central', 'state', 'psu', 'private', 'other'] as const;
export const BUYER_TYPE_LABELS: Record<(typeof BUYER_TYPES)[number], string> = {
  central: 'Central Govt', state: 'State Govt', psu: 'PSU', private: 'Private', other: 'Other',
};

const pastContractFields = {
  buyer: z.string().trim().min(1, 'Buyer is required').max(200),
  buyerType: z.enum(BUYER_TYPES).default('central'),
  title: z.string().trim().min(1, 'Describe the work or supply').max(300),
  category: optText(120),
  value: z.coerce.number({ invalid_type_error: 'Enter the contract value in rupees' }).int('Whole rupees only').positive('Contract value must be more than ₹0').max(1e15),
  startDate: optDate,
  endDate: optDate,
  gemContractNo: optText(80),
  cracDocumentId: z.preprocess(blankToNull, z.string().uuid().nullable().optional()),
};
const datesInOrder = (p: { startDate?: string | null; endDate?: string | null }, ctx: z.RefinementCtx) => {
  if (p.startDate && p.endDate && p.endDate < p.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date is before the start date' });
};
export const pastContractCreateSchema = z.object(pastContractFields).superRefine(datesInOrder);
export const pastContractUpdateSchema = z.object(pastContractFields).partial().superRefine(datesInOrder);
export type PastContractInput = z.input<typeof pastContractCreateSchema>;

export interface PastContractDto {
  id: string; buyer: string; buyerType: (typeof BUYER_TYPES)[number]; title: string; category: string | null; value: number;
  startDate: string | null; endDate: string | null; gemContractNo: string | null; cracDocumentId: string | null; createdAt: string;
}

// ───────────── Vault ─────────────

export const docTypeSchema = z.enum(DOC_TYPE_VALUES);
export const docStatusSchema = z.enum(['valid', 'expiring', 'expired']);

/** 20 MB upload limit (FR-021). */
export const VAULT_MAX_BYTES = 20 * 1024 * 1024;
export const VAULT_ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const VAULT_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

const tagsSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { return JSON.parse(s); } catch { return s.split(',').map((t) => t.trim()).filter(Boolean); }
  }
  return v;
}, z.array(z.string().trim().min(1).max(40)).max(20, 'At most 20 tags'));

const fySchema = z.preprocess(blankToNull, z.string().nullable().optional().transform((v, ctx) => {
  if (!v) return v ?? null;
  const n = normalizeFy(v);
  if (!n) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a financial year like 2024-25' }); return z.NEVER; }
  return n;
}));

const vaultMetaFields = {
  type: docTypeSchema,
  title: z.string().trim().min(1, 'Give the document a title').max(200),
  number: optText(100),
  issuer: optText(200),
  issueDate: optDate,
  expiryDate: optDate,
  financialYear: fySchema,
  tags: tagsSchema.optional(),
};
const issueBeforeExpiry = (p: { issueDate?: string | null; expiryDate?: string | null }, ctx: z.RefinementCtx) => {
  if (p.issueDate && p.expiryDate && p.expiryDate < p.issueDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryDate'], message: 'Expiry date is before the issue date' });
};
/** Multipart fields of POST /vault (title defaults to the file name server-side). */
export const vaultUploadFieldsSchema = z.object({ ...vaultMetaFields, title: vaultMetaFields.title.optional() }).superRefine(issueBeforeExpiry);
export const vaultUpdateSchema = z.object(vaultMetaFields).partial().superRefine(issueBeforeExpiry);
export type VaultUpdateInput = z.input<typeof vaultUpdateSchema>;

export const vaultQuerySchema = z.object({
  type: z.preprocess(blankToNull, docTypeSchema.nullable().optional()),
  status: z.preprocess(blankToNull, docStatusSchema.nullable().optional()),
  category: z.preprocess(blankToNull, z.enum(DOC_CATEGORIES as [DocCategory, ...DocCategory[]]).nullable().optional()),
  q: z.preprocess(blankToNull, z.string().max(100).nullable().optional()),
  sort: z.enum(['recent', 'expiry', 'title', 'type']).default('recent'),
});

export interface VaultDocumentDto {
  id: string; type: DocType; title: string; number: string | null; issuer: string | null;
  issueDate: string | null; expiryDate: string | null; financialYear: string | null; tags: string[];
  fileName: string; mimeType: string; sizeBytes: number; pageCount: number | null;
  uploadedBy: { id: string; name: string } | null; createdAt: string; updatedAt: string;
  status: DocStatus; daysToExpiry: number | null;
  /**
   * Next reminder to be sent (FR-053): `days` = threshold before expiry (30/7/1) or 0 for the post-expiry notice,
   * `date` = IST calendar day it goes out. null = no expiry date or all reminders sent.
   */
  nextReminder: { days: number; date: string } | null;
  /** Relative API path for download (`?inline=1` for preview). */
  downloadUrl: string;
}

/** A previous file of a vault document, kept on renewal/replace (FR-065, FR-066). Newest first, at most 5. */
export interface VaultVersionDto {
  id: string; fileName: string; mimeType: string; sizeBytes: number; pageCount: number | null;
  /** Expiry date the document had while this file was current. */
  expiryDate: string | null;
  replacedBy: { id: string; name: string } | null;
  replacedAt: string;
  /** Relative API path for download (`?inline=1` for preview). */
  downloadUrl: string;
}

/** Versions kept per document (FR-065). */
export const VAULT_MAX_VERSIONS = 5;

export interface VaultSummary {
  total: number; valid: number; expiring: number; expired: number;
  byType: Partial<Record<DocType, number>>;
  /** Upcoming (and recently expired, ≤ 30 days ago) expiries, soonest first. */
  nextExpiries: { id: string; type: DocType; title: string; expiryDate: string; daysToExpiry: number; status: DocStatus }[];
  /** Common bid documents not yet in the vault. */
  missingCommon: DocType[];
}
