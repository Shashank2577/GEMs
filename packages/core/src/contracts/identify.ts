/**
 * Identify-module API contracts (contracts/api.md § Identify): tenders feed, watchlists,
 * ingestion runs, notifications. Shared by the API (validation) and the web app (types).
 */
import { z } from 'zod';

// ───────────── Watchlists ─────────────

const strList = (max = 50) =>
  z.array(z.string().trim().min(1).max(120)).max(max).default([])
    .transform((xs) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ')))]);

export const BID_TYPES = ['bid', 'ra', 'bunch', 'service'] as const;
export const bidTypeSchema = z.enum(BID_TYPES);
export type BidType = z.infer<typeof bidTypeSchema>;
export const BID_TYPE_LABEL: Record<BidType, string> = { bid: 'Bid', ra: 'Reverse auction', bunch: 'Bunch bid', service: 'Service' };

export const watchlistCriteriaSchema = z.object({
  keywords: strList(),
  excludeKeywords: strList(),
  categories: strList(),
  hsnCodes: z.array(z.string().trim().regex(/^\d{2,8}$/, 'HSN codes are 2–8 digits')).max(50).default([]),
  states: strList(40),
  ministries: strList(),
  minValue: z.number().int().nonnegative().nullable().optional(),
  maxValue: z.number().int().nonnegative().nullable().optional(),
  minDaysToClose: z.number().int().min(0).max(365).nullable().optional(),
  bidTypes: z.array(bidTypeSchema).max(4).default([]),
}).superRefine((c, ctx) => {
  if (c.minValue != null && c.maxValue != null && c.minValue > c.maxValue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxValue'], message: 'Maximum value must be at least the minimum' });
  }
});
export type WatchlistCriteriaInput = z.input<typeof watchlistCriteriaSchema>;
export type WatchlistCriteriaDto = z.output<typeof watchlistCriteriaSchema>;

/** True when at least one positive criterion is set (a watchlist must narrow something). */
export function criteriaIsEmpty(c: WatchlistCriteriaDto): boolean {
  return !c.keywords.length && !c.categories.length && !c.hsnCodes.length && !c.states.length && !c.ministries.length
    && c.minValue == null && c.maxValue == null && !c.bidTypes.length;
}

export const watchlistCreateSchema = z.object({
  name: z.string().trim().min(1, 'Give the watchlist a name').max(80),
  criteria: watchlistCriteriaSchema,
  active: z.boolean().optional(),
});
export type WatchlistCreateInput = z.input<typeof watchlistCreateSchema>;

export const watchlistUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  criteria: watchlistCriteriaSchema.optional(),
  active: z.boolean().optional(),
});
export type WatchlistUpdateInput = z.input<typeof watchlistUpdateSchema>;

export const watchlistPreviewSchema = z.object({ criteria: watchlistCriteriaSchema });

export interface WatchlistDto {
  id: string;
  name: string;
  criteria: WatchlistCriteriaDto;
  active: boolean;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Total matches recorded for this watchlist. */
  matchCount: number;
  /** Matches recorded in the last 7 days. */
  newThisWeek: number;
  /** Matches for tenders that are still open. */
  openCount: number;
  lastMatchAt: string | null;
}

// ───────────── Tenders ─────────────

export const TENDER_SORTS = ['endAt', '-endAt', '-createdAt', 'score', '-score', 'value', '-value', 'relevance'] as const;
export type TenderSort = (typeof TENDER_SORTS)[number];

const csv = z.union([z.string(), z.array(z.string())]).optional()
  .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((s) => s.split('|')).map((s) => s.trim()).filter(Boolean)));
const optNum = z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : v), z.coerce.number().nonnegative().optional());
const flag = z.preprocess((v) => (v === '1' || v === 'true' || v === true ? true : v === '0' || v === 'false' || v === false ? false : undefined), z.boolean().optional());

/**
 * GET /tenders query. Multi-value filters accept repeated keys (`state=A&state=B`) or `|`-separated values.
 */
export const tenderQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  state: csv,
  ministry: csv,
  category: csv,
  status: z.enum(['open', 'closed', 'cancelled', 'awarded', 'all']).optional(),
  closingWithinDays: optNum,
  minValue: optNum,
  maxValue: optNum,
  matched: flag,
  watchlistId: z.string().uuid().optional(),
  verdict: csv.pipe(z.array(z.enum(['go', 'review', 'no_go', 'none']))),
  stage: csv,
  bidType: csv.pipe(z.array(bidTypeSchema)),
  unseen: flag,
  includeDismissed: flag,
  sort: z.enum(TENDER_SORTS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type TenderQuery = z.output<typeof tenderQuerySchema>;

export interface TenderMatchDto { watchlistId: string; watchlistName: string; reasons: string[]; relevance: number; createdAt: string }

export interface TenderCore {
  id: string;
  /** True for sample tenders loaded by the demo seed (`tenders.raw.demo`); the web shows a "Sample" badge (007/FR-067). */
  isDemo: boolean;
  source: string;
  bidNumber: string;
  gemBidId: string | null;
  bidType: BidType;
  title: string;
  items: { name: string; quantity?: number; unit?: string }[];
  category: string | null;
  quantity: number | null;
  ministry: string | null;
  department: string | null;
  organisation: string | null;
  buyerOffice: string | null;
  state: string | null;
  city: string | null;
  startAt: string | null;
  endAt: string | null;
  openingAt: string | null;
  emdAmount: number | null;
  estimatedValue: number | null;
  epbgPercent: number | null;
  hsnCodes: string[];
  status: 'open' | 'closed' | 'cancelled' | 'awarded';
  documentUrl: string | null;
  sourceUrl: string;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenderListItem extends TenderCore {
  matches: TenderMatchDto[];
  analysis: { id: string; score: number | null; verdict: 'go' | 'review' | 'no_go' | null; stale: boolean } | null;
  workspace: { id: string; stage: string } | null;
  /** Seen by this org (any match marked seen) — tenders without matches count as seen. */
  seen: boolean;
  /** Matched for this org and not yet seen. */
  isNew: boolean;
  dismissed: boolean;
  /** Corrigendum recorded in the last 7 days. */
  hasCorrigendum: boolean;
}

export interface Facet { value: string; count: number }
export interface TenderListResponse {
  items: TenderListItem[];
  total: number;
  facets: { states: Facet[]; ministries: Facet[]; categories: Facet[] };
}

export interface TenderEventDto { id: string; kind: 'created' | 'updated' | 'corrigendum' | 'closed' | 'cancelled'; changes: Record<string, { from: unknown; to: unknown }>; createdAt: string }
export interface TenderDocumentDto { id: string; kind: string; fileName: string; sizeBytes: number; pageCount: number | null; sourceUrl: string | null; orgOwned: boolean; createdAt: string }

export interface TenderDetail extends TenderListItem {
  events: TenderEventDto[];
  documents: TenderDocumentDto[];
  /** Full latest analysis for the org (shape owned by the Analyse module). */
  analysisDetail: Record<string, unknown> | null;
}

// ───────────── Ingestion ─────────────

export const ingestionRunInputSchema = z.object({
  pages: z.number().int().min(1).max(20).optional(),
  search: z.string().trim().max(100).optional(),
});

export interface IngestionRunDto {
  id: string;
  trigger: 'cron' | 'manual' | 'seed';
  status: 'running' | 'success' | 'partial' | 'failed';
  pagesFetched: number;
  tendersSeen: number;
  tendersCreated: number;
  tendersUpdated: number;
  matchesCreated: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface IngestionRunsResponse {
  items: IngestionRunDto[];
  lastSuccessAt: string | null;
  lastRun: IngestionRunDto | null;
  totalTenders: number;
  openTenders: number;
}

// ───────────── Notifications ─────────────

/** Notification kinds; must equal the `notifications.kind` union in @tp/db (type-checked in apps/api routes/notifications.ts). */
export const NOTIFICATION_KINDS = ['tender_match', 'expiry', 'deadline', 'assignment', 'mention', 'digest', 'system'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notificationsQuerySchema = z.object({
  unread: flag,
  kind: z.enum(NOTIFICATION_KINDS).optional(), // 003/FR-049
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
  /** Delivery status of the email / WhatsApp copies of this alert (same dedupe key). */
  deliveries: { channel: 'email' | 'whatsapp'; status: 'pending' | 'sent' | 'failed' | 'skipped' | 'read'; error: string | null; sentAt: string | null }[];
}

export interface NotificationsResponse { items: NotificationDto[]; unreadCount: number; total: number }

// ───────────── Saved feed views (003/FR-035) ─────────────

export const SAVED_VIEW_LIMIT = 20;
export const SAVED_VIEW_NAME_MAX = 40;

/** Feed URL params as `key -> values` (repeated keys keep several values). */
export const savedViewParamsSchema = z.record(z.string().min(1).max(40), z.array(z.string().max(200)).max(50)).refine((p) => Object.keys(p).length <= 30, 'Too many parameters')
  .refine((p) => JSON.stringify(p).length <= 4096, 'Parameters are too large');

const savedViewName = z.string().trim().min(1, 'Give the view a name').max(SAVED_VIEW_NAME_MAX, `Use at most ${SAVED_VIEW_NAME_MAX} characters`);

export const savedViewCreateSchema = z.object({ name: savedViewName, params: savedViewParamsSchema });
export type SavedViewCreateInput = z.input<typeof savedViewCreateSchema>;

export const savedViewUpdateSchema = z.object({ name: savedViewName.optional(), params: savedViewParamsSchema.optional() });
export type SavedViewUpdateInput = z.input<typeof savedViewUpdateSchema>;

export interface SavedViewDto {
  id: string;
  name: string;
  params: Record<string, string[]>;
  position: number;
  createdAt: string;
  updatedAt: string;
}
