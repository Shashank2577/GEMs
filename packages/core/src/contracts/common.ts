/**
 * Shared, area-agnostic API contract pieces (see specs/001-gem-tender-copilot/contracts/api.md).
 * Used by the API (validation) and the web app (typing / client-side validation).
 */
import { z } from 'zod';

// ───────────── Errors ─────────────

/** Every non-2xx API response has this body. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Well-known error codes. Feature teams may use other snake_case codes. */
export const ERROR_CODES = [
  'bad_request', 'validation_error', 'unauthorized', 'forbidden', 'not_found', 'conflict',
  'invalid_credentials', 'no_organization', 'payload_too_large', 'unsupported_media_type',
  'rate_limited', 'internal_error', 'service_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ───────────── Roles ─────────────

export const ROLES = ['owner', 'bid_manager', 'analyst', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type RoleName = z.infer<typeof roleSchema>;

/** Higher = more privileges. owner > bid_manager > analyst > viewer. */
export const ROLE_RANK: Record<RoleName, number> = { owner: 40, bid_manager: 30, analyst: 20, viewer: 10 };

export const ROLE_LABELS: Record<RoleName, string> = {
  owner: 'Owner', bid_manager: 'Bid Manager', analyst: 'Analyst', viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  owner: 'Full control including billing, members and roles.',
  bid_manager: 'Runs bids end to end: invites people, overrides checklist items, runs ingestion.',
  analyst: 'Analyses tenders, maintains the vault and prepares packets.',
  viewer: 'Read-only access to tenders, analyses and bids.',
};

export function roleAtLeast(role: RoleName | null | undefined, min: RoleName): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

// ───────────── Pagination & lists ─────────────

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query-string pagination (`page` is 1-based). Strings are coerced. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface ListResponse<T> { items: T[]; total: number }

export const listResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int() });

// ───────────── Primitives ─────────────

export const uuidSchema = z.string().uuid();
export const idParamSchema = z.object({ id: uuidSchema });

/** ISO-8601 timestamp string (as produced by JSON.stringify(Date)). */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Integer rupees. */
export const rupeesSchema = z.number().int().nonnegative();

/** E.164 phone number, e.g. +919812345678. */
export const phoneE164Schema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919812345678');

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const healthResponseSchema = z.object({ ok: z.boolean(), db: z.boolean(), version: z.string() });
export type HealthResponse = z.infer<typeof healthResponseSchema>;
