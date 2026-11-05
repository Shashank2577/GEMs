/**
 * TenderPilot database schema — single source of truth (see specs/001-gem-tender-copilot/data-model.md).
 * Every org-owned table carries org_id (Constitution IV).
 */
import { sql } from 'drizzle-orm';
import type { AnalysisWarning } from '@tp/core/contracts/analyse';
import type { EvaluationStatus, NotificationKind } from '@tp/core/contracts/identify';
import type { ResultBidder } from '@tp/core/gem/result';
import {
  pgTable, text, uuid, timestamp, integer, bigint, boolean, jsonb, real, date,
  uniqueIndex, index, primaryKey,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ───────────── Identity & tenancy ─────────────

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  phone: text('phone'), // E.164, for WhatsApp alerts
  // Org the user last worked in; survives sign-out so the next sign-in resumes there (002/FR-021, US2 scenario 14).
  lastOrgId: uuid('last_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => ({ emailUq: uniqueIndex('users_email_uq').on(t.email) }));

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  plan: text('plan').notNull().default('trial'), // trial | starter | pro | enterprise
  onboardingState: jsonb('onboarding_state').$type<Record<string, boolean>>().notNull().default({}),
  scoringWeights: jsonb('scoring_weights').$type<Record<string, number>>(),
  /** End of the free trial (008/FR-035): created + 14 days at sign-up; null for paid plans and pre-trial seeds. */
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({ slugUq: uniqueIndex('org_slug_uq').on(t.slug) }));

export type Role = 'owner' | 'bid_manager' | 'analyst' | 'viewer';

export const memberships = pgTable('memberships', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<Role>().notNull(),
  createdAt: createdAt(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.userId] }) }));

export const invitations = pgTable('invitations', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').$type<Role>().notNull(),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  activeOrgId: uuid('active_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  /** Raw User-Agent at sign-in (truncated), for "Where you're signed in" (002/FR-012). */
  userAgent: text('user_agent'),
  /** Refreshed at most every 5 minutes by resolveAuth (002/FR-012). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, (t) => ({ tokenUq: uniqueIndex('sessions_token_uq').on(t.tokenHash) }));

/** Failed-authentication counters for rate limiting (002/FR-010). key = normalised email or client IP. */
export const authAttempts = pgTable('auth_attempts', {
  key: text('key').notNull(),
  kind: text('kind').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.key, t.kind] }) }));

/**
 * Generic fixed-window request counters (008/FR-017): one row per (`<rule>:<subject>`, aligned window start).
 * Written by `apps/api/src/lib/rate-limiter.ts` with a single upsert; dead windows are pruned by the scheduler.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.key, t.windowStart] }),
  // Pruning deletes by window_start (lib/rate-limiter.ts#pruneRateLimits).
  windowIdx: index('rate_limits_window_idx').on(t.windowStart),
}));

/** Single-use password reset links (002/FR-011). Only the SHA-256 of the token is stored. */
export const passwordResets = pgTable('password_resets', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  tokenUq: uniqueIndex('password_resets_token_uq').on(t.tokenHash),
  userIdx: index('password_resets_user_idx').on(t.userId),
}));

/** Personal API tokens (browser extension). */
export const apiTokens = pgTable('api_tokens', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  /** Last 4 characters of the secret, shown in the list as `tp_…a1B2` (002/FR-037). Null for tokens created before it existed. */
  tokenHint: text('token_hint'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  /** Null = never expires (002/FR-037). Expired tokens are rejected by resolveAuth. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /**
   * 006/FR-074: `'read'` = "Extension (read-only)" — refused (403) on every non-GET request (middleware/auth.ts).
   * Fixed at creation; there is no route to change it. Existing rows default to `'full'`.
   */
  scope: text('scope').$type<'full' | 'read'>().notNull().default('full'),
  createdAt: createdAt(),
}, (t) => ({
  tokenUq: uniqueIndex('api_tokens_token_uq').on(t.tokenHash),
  orgUserIdx: index('api_tokens_org_user_idx').on(t.orgId, t.userId),
}));

export const notificationPrefs = pgTable('notification_prefs', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(true),
  whatsapp: boolean('whatsapp').notNull().default(false),
  frequency: text('frequency').$type<'instant' | 'daily'>().notNull().default('instant'),
  expiryReminders: boolean('expiry_reminders').notNull().default(true),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.userId] }) }));

// ───────────── Company profile ─────────────

export interface FinancialYear { fy: string; turnover: number; netWorth?: number; audited?: boolean }

export const companyProfiles = pgTable('company_profiles', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  legalName: text('legal_name').notNull().default(''),
  tradeName: text('trade_name'),
  gstin: text('gstin'),
  pan: text('pan'),
  cin: text('cin'),
  udyamNumber: text('udyam_number'),
  mseCategory: text('mse_category').$type<'micro' | 'small' | 'medium' | null>(),
  mseSocialCategory: text('mse_social_category').$type<'general' | 'sc_st' | 'women' | null>(),
  isStartup: boolean('is_startup').notNull().default(false),
  dpiitNumber: text('dpiit_number'),
  miiClass: text('mii_class').$type<'class_1' | 'class_2' | 'non_local' | null>(),
  localContentPct: real('local_content_pct'),
  incorporationDate: date('incorporation_date'),
  address: text('address'),
  state: text('state'),
  pincode: text('pincode'),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  signatoryName: text('signatory_name'),
  signatoryDesignation: text('signatory_designation'),
  financials: jsonb('financials').$type<FinancialYear[]>().notNull().default([]),
  categories: jsonb('categories').$type<string[]>().notNull().default([]),
  hsnCodes: jsonb('hsn_codes').$type<string[]>().notNull().default([]),
  operatingStates: jsonb('operating_states').$type<string[]>().notNull().default([]),
  oemAuthorizations: jsonb('oem_authorizations').$type<{ oem: string; products: string; validTill?: string | null; documentId?: string | null }[]>().notNull().default([]),
  certifications: jsonb('certifications').$type<string[]>().notNull().default([]), // e.g. ISO 9001, BIS
  maxEmdCapacity: bigint('max_emd_capacity', { mode: 'number' }),
  updatedAt: updatedAt(),
});

export const pastContracts = pgTable('past_contracts', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  buyer: text('buyer').notNull(),
  buyerType: text('buyer_type').$type<'central' | 'state' | 'psu' | 'private' | 'other'>().notNull().default('central'),
  title: text('title').notNull(),
  category: text('category'),
  value: bigint('value', { mode: 'number' }).notNull(), // rupees
  startDate: date('start_date'),
  endDate: date('end_date'),
  gemContractNo: text('gem_contract_no'),
  cracDocumentId: uuid('crac_document_id'),
  createdAt: createdAt(),
}, (t) => ({ orgIdx: index('past_contracts_org_idx').on(t.orgId) }));

// ───────────── Vault ─────────────

export type DocType =
  | 'gst' | 'pan' | 'udyam' | 'startup_dpiit' | 'incorporation' | 'balance_sheet' | 'itr'
  | 'ca_turnover_certificate' | 'oem_authorization' | 'crac' | 'work_order' | 'iso' | 'bis'
  | 'mii_certificate' | 'emd_exemption' | 'bank_details' | 'power_of_attorney' | 'product_catalogue'
  | 'test_report' | 'other';

export const vaultDocuments = pgTable('vault_documents', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  type: text('type').$type<DocType>().notNull(),
  title: text('title').notNull(),
  number: text('number'),
  issuer: text('issuer'),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  financialYear: text('financial_year'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  blobKey: text('blob_key').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageCount: integer('page_count'),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  lastReminderDays: integer('last_reminder_days'),
  /** Hex SHA-256 of the current file for duplicate detection (FR-067); null = unknown (pre-existing rows). */
  contentSha256: text('content_sha256'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  orgIdx: index('vault_org_idx').on(t.orgId), typeIdx: index('vault_org_type_idx').on(t.orgId, t.type),
  shaIdx: index('vault_org_sha_idx').on(t.orgId, t.contentSha256),
  // 005 T009 (NFR-004): the daily reminder scan filters on expiry_date across orgs.
  expiryIdx: index('vault_expiry_idx').on(t.expiryDate),
}));

/** Previous files of a vault document, kept on renewal/replace (FR-065; at most 5 per document). */
export const vaultDocumentVersions = pgTable('vault_document_versions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => vaultDocuments.id, { onDelete: 'cascade' }),
  blobKey: text('blob_key').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageCount: integer('page_count'),
  expiryDate: date('expiry_date'),
  replacedBy: uuid('replaced_by').references(() => users.id),
  replacedAt: timestamp('replaced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index('vault_versions_org_idx').on(t.orgId), docIdx: index('vault_versions_doc_idx').on(t.documentId, t.replacedAt.desc()) }));

// ───────────── Tenders (global, public GeM data) ─────────────

export const tenders = pgTable('tenders', {
  id: id(),
  source: text('source').notNull().default('gem'),
  bidNumber: text('bid_number').notNull(), // e.g. GEM/2026/B/1234567
  gemBidId: text('gem_bid_id'), // internal b_id used by /showbidDocument/{id}
  bidType: text('bid_type').$type<'bid' | 'ra' | 'bunch' | 'service'>().notNull().default('bid'),
  title: text('title').notNull(),
  items: jsonb('items').$type<{ name: string; quantity?: number; unit?: string }[]>().notNull().default([]),
  category: text('category'),
  quantity: integer('quantity'),
  ministry: text('ministry'),
  department: text('department'),
  organisation: text('organisation'),
  buyerOffice: text('buyer_office'),
  state: text('state'),
  city: text('city'),
  startAt: timestamp('start_at', { withTimezone: true }),
  endAt: timestamp('end_at', { withTimezone: true }),
  openingAt: timestamp('opening_at', { withTimezone: true }),
  emdAmount: bigint('emd_amount', { mode: 'number' }),
  estimatedValue: bigint('estimated_value', { mode: 'number' }),
  epbgPercent: real('epbg_percent'),
  hsnCodes: jsonb('hsn_codes').$type<string[]>().notNull().default([]),
  status: text('status').$type<'open' | 'closed' | 'cancelled' | 'awarded'>().notNull().default('open'),
  documentUrl: text('document_url'),
  sourceUrl: text('source_url').notNull(),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  contentHash: text('content_hash').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  // 008/FR-073: `tenders.search` (generated tsvector) + GIN `tenders_search_gin` and `tenders_bid_number_prefix_idx`
  // exist in the database but are deliberately NOT declared here: a declared column would be read by every
  // `select().from(tenders)` and leak into API responses. They are created by the hand-written non-transactional
  // migration `*_tenders_search.sql`; queries reach them through `lib/tender-search.ts`.
  bidUq: uniqueIndex('tenders_source_bid_uq').on(t.source, t.bidNumber),
  endIdx: index('tenders_end_idx').on(t.endAt),
  stateIdx: index('tenders_state_idx').on(t.state),
  // 008/FR-027: ~6 % of tenders are open and every feed/dashboard query filters on it. Built CONCURRENTLY by the
  // hand-edited non-transactional migration 0017 (`-- tp:non-transactional`, see migrate.ts).
  openCreatedIdx: index('tenders_open_created_idx').on(t.createdAt.desc().nullsFirst()).where(sql`status = 'open'`),
  // Closing-date sort (review S5): the feed's "still open" filter is `coalesce(end_at, 'infinity') >= now`, so the index
  // is on that expression — expired-but-not-yet-closed rows are skipped by the range, not read and filtered.
  // Replaces tenders_open_end_idx (end_at); built CONCURRENTLY by the hand-edited non-transactional migration 0018.
  openClosingIdx: index('tenders_open_closing_idx').on(sql`coalesce(${t.endAt}, 'infinity'::timestamptz)`).where(sql`status = 'open'`),
  // DESC NULLS LAST = the feed's "highest value" sort; also serves minValue/maxValue ranges.
  openValueIdx: index('tenders_open_value_idx').on(t.estimatedValue.desc().nullsLast()).where(sql`status = 'open'`),
  // `?state=X` (US4 scenario 4, PR #515 QA finding 1): equality on state, then the default sort (created_at DESC), then
  // the "still open" expression, so one index answers the page query in order (`state = X` and `coalesce(end_at, …)
  // >= now` are both Index Conds, no sort, LIMIT stops early) and the count/facet queries as a single bitmap scan.
  // With only (state) the planner preferred tenders_open_created_idx + filter for the page and a BitmapAnd of the
  // non-partial tenders_state_idx and tenders_open_closing_idx for count/facets (it estimates "still open" at the
  // default 1/3 because partial-index expression stats are not used). Rebuilt by migration 0019.
  openStateIdx: index('tenders_open_state_idx').on(t.state, t.createdAt.desc().nullsFirst(), sql`coalesce(${t.endAt}, 'infinity'::timestamptz)`).where(sql`status = 'open'`),
  openMinistryIdx: index('tenders_open_ministry_idx').on(t.ministry).where(sql`status = 'open'`),
  openCategoryIdx: index('tenders_open_category_idx').on(t.category).where(sql`status = 'open'`),
}));

export const tenderEvents = pgTable('tender_events', {
  id: id(),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'created' | 'updated' | 'corrigendum' | 'closed' | 'cancelled' | 'awarded' | 'technical_evaluated' | 'financial_evaluated'>().notNull(),
  changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => ({ tenderIdx: index('tender_events_tender_idx').on(t.tenderId) }));

/** Documents attached to a tender: fetched from GeM (org_id null) or uploaded by an org. */
export const tenderDocuments = pgTable('tender_documents', {
  id: id(),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'bid' | 'atc' | 'corrigendum' | 'boq' | 'other'>().notNull().default('bid'),
  fileName: text('file_name').notNull(),
  blobKey: text('blob_key').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageCount: integer('page_count'), // pages actually read (capped, 004/NFR-005)
  totalPages: integer('total_pages'), // the PDF's real page count; null for rows that predate the column
  text: text('text'), // extracted text, pages separated by \f
  sourceUrl: text('source_url'),
  textSource: text('text_source').$type<'pdf' | 'ocr'>().notNull().default('pdf'), // FR-052
  /**
   * 008/FR-072 shared extraction cache. Written and read ONLY for GeM-fetched documents (`org_id IS NULL`, public
   * data): one LLM extraction serves every org. An org's own upload never gets these columns set, so nothing derived
   * from one tenant's document can reach another (services/analyse.ts#cachedExtraction).
   */
  requirements: jsonb('requirements').$type<Requirement[]>(),
  extractorVersion: text('extractor_version'),
  extractedAt: timestamp('extracted_at', { withTimezone: true }),
  extractedMethod: text('extracted_method').$type<'LLM'>(),
  createdAt: createdAt(),
}, (t) => ({ tenderIdx: index('tender_docs_tender_idx').on(t.tenderId) }));

/**
 * Public GeM result per tender (003/US6, FR-061): evaluation status and the bidder table of the public result view.
 * Global like `tenders` (no org_id): one row per tender serves every org; org scoping happens where it is read
 * (routes/insights.ts only aggregates tenders the caller's org tracks). Written only by services/results.ts.
 * - `fetched_at`: last time GeM was read successfully (status, and bidders when published); null until then.
 * - `checked_at`: last completed check — GeM answered, readable or not; the daily refresh skips rows checked in the
 *   last 24 h. Null until one completes. A GeM outage (transport, 5xx, lease busy) or a bid missing from the
 *   submitted-bids search does not advance it, so the tender is asked again on the next run.
 * - `error`: why the last attempt failed (network, unreadable result page, bid not in the search); a failure never
 *   touches `evaluation_status`, `bidders`, `categories`, `source_url` or `fetched_at` (US6 scenario 6).
 * - `evaluation_status` only moves forward (not → technical → financial → awarded), never back.
 */
export const tenderResults = pgTable('tender_results', {
  tenderId: uuid('tender_id').primaryKey().references(() => tenders.id, { onDelete: 'cascade' }),
  evaluationStatus: text('evaluation_status').$type<EvaluationStatus>().notNull().default('not_evaluated'),
  /** `[{rank, seller, price (rupees), level, awarded}]` from parseBidResultHtml; [] until GeM publishes the result. */
  bidders: jsonb('bidders').$type<ResultBidder[]>().notNull().default([]),
  /** GeM categories named on the result page (`var categoris`). */
  categories: jsonb('categories').$type<string[]>().notNull().default([]),
  sourceUrl: text('source_url'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ingestionRuns = pgTable('ingestion_runs', {
  id: id(),
  /** `listing` = BidPlus listing ingestion (runIngestion); `results` = daily results refresh (services/results.ts). */
  kind: text('kind').$type<'listing' | 'results'>().notNull().default('listing'),
  trigger: text('trigger').$type<'cron' | 'manual' | 'seed'>().notNull(),
  status: text('status').$type<'running' | 'success' | 'partial' | 'failed'>().notNull().default('running'),
  pagesFetched: integer('pages_fetched').notNull().default(0),
  tendersSeen: integer('tenders_seen').notNull().default(0),
  tendersCreated: integer('tenders_created').notNull().default(0),
  tendersUpdated: integer('tenders_updated').notNull().default(0),
  matchesCreated: integer('matches_created').notNull().default(0),
  /**
   * Why the listing phase stopped (003/FR-011): `all_known` page reached, `end` of results, page `cap` used up,
   * `explicit` page count fetched, or `error`. Null for runs that never got that far (or predate the column).
   */
  listingStop: text('listing_stop').$type<'all_known' | 'end' | 'cap' | 'explicit' | 'error'>(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  // 008/FR-025: at most one running run per kind, cluster-wide (cron ticks, manual syncs, every isolate). Per kind
  // (003/US6) so the daily results refresh neither blocks nor is blocked by a listing sync; both share the GeM lease.
  oneRunningUq: uniqueIndex('ingestion_runs_one_running_uq').on(t.kind).where(sql`status = 'running'`),
}));

/**
 * Cluster-wide GeM request slots (008/FR-024, NFR-002). One row (`id = 'gem'`): each request atomically moves
 * `next_slot_at` forward by the minimum interval and sleeps until its own slot (`apps/api/src/lib/gem-lease.ts`).
 */
export const gemThrottle = pgTable('gem_throttle', {
  id: text('id').primaryKey(),
  nextSlotAt: timestamp('next_slot_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Once-per-day job claims (008/FR-070): the first scheduled tick after 02:00 IST inserts `(job, day)`; every other
 * tick that day — on any isolate — conflicts and skips. A failed run deletes its claim so the next tick retries.
 */
export const jobRuns = pgTable('job_runs', {
  job: text('job').notNull(),
  day: date('day').notNull(), // IST calendar day
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  summary: jsonb('summary').$type<Record<string, unknown>>(),
}, (t) => ({ pk: primaryKey({ columns: [t.job, t.day] }) }));

// ───────────── Identify: watchlists & matches ─────────────

export interface WatchlistCriteria {
  keywords: string[];
  excludeKeywords: string[];
  categories: string[];
  hsnCodes: string[];
  states: string[];
  ministries: string[]; // matches ministry, department or organisation
  minValue?: number | null;
  maxValue?: number | null;
  minDaysToClose?: number | null;
  bidTypes?: string[];
}

export const watchlists = pgTable('watchlists', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  criteria: jsonb('criteria').$type<WatchlistCriteria>().notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({ orgIdx: index('watchlists_org_idx').on(t.orgId) }));

/** Personal saved feed views (003/FR-035): URL-style params, scoped to (org, user). */
export const savedViews = pgTable('saved_views', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  params: jsonb('params').$type<Record<string, string[]>>().notNull(),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({ nameUq: uniqueIndex('saved_views_name_uq').on(t.orgId, t.userId, t.name) }));

export const tenderMatches = pgTable('tender_matches', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  watchlistId: uuid('watchlist_id').notNull().references(() => watchlists.id, { onDelete: 'cascade' }),
  reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
  relevance: real('relevance').notNull().default(0),
  seen: boolean('seen').notNull().default(false),
  dismissed: boolean('dismissed').notNull().default(false),
  createdAt: createdAt(),
}, (t) => ({
  uq: uniqueIndex('tender_matches_uq').on(t.orgId, t.tenderId, t.watchlistId),
  orgIdx: index('tender_matches_org_idx').on(t.orgId, t.createdAt),
}));

// ───────────── Analyse ─────────────

export interface Requirement {
  key: string; // turnover_min | experience_years | similar_work | emd | epbg | mii | mse_exemption | startup_exemption | oem_auth | document | delivery_days | bid_end | evaluation_method | estimated_value | other
  label: string;
  value?: string | number | boolean | null;
  numeric?: number | null; // normalised rupees / years / days / percent
  mandatory: boolean;
  source: { documentId?: string; fileName?: string; page?: number; quote?: string; ocr?: boolean };
  method: 'RULE' | 'LLM' | 'MANUAL';
  confidence: number; // 0..1
}

export interface ScoreFactor {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown' | 'exempt' | 'na';
  weight: number;
  blocking: boolean;
  detail: string; // human explanation, e.g. "Avg turnover ₹2.1 Cr ≥ required ₹50 L"
  requirementKey?: string;
  overridden?: { status: ScoreFactor['status']; reason: string; by: string; at: string };
}

export interface ChecklistItem {
  id: string;
  label: string;
  docType: DocType | null;
  mandatory: boolean;
  reason: string; // why required (bid clause)
  generated?: string; // annexure template key if it is generated, not uploaded
}

export type StaleReason =
  | 'corrigendum' | 'document_added' | 'document_removed' | 'profile_changed' | 'vault_changed' | 'weights_changed';

export const analyses = pgTable('analyses', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  status: text('status').$type<'pending' | 'running' | 'done' | 'failed'>().notNull().default('pending'),
  method: text('method').$type<'rules' | 'rules+llm'>().notNull().default('rules'),
  requirements: jsonb('requirements').$type<Requirement[]>().notNull().default([]),
  factors: jsonb('factors').$type<ScoreFactor[]>().notNull().default([]),
  checklist: jsonb('checklist').$type<ChecklistItem[]>().notNull().default([]),
  score: integer('score'),
  confidence: real('confidence'),
  verdict: text('verdict').$type<'go' | 'review' | 'no_go'>(),
  summary: text('summary'),
  error: text('error'),
  stale: boolean('stale').notNull().default(false), // inputs changed after analysis (FR-043)
  staleReason: text('stale_reason').$type<StaleReason>(),
  staleAt: timestamp('stale_at', { withTimezone: true }),
  notes: jsonb('notes').$type<string[]>().notNull().default([]), // FR-051
  /** Machine-readable caveats rendered by the web (008/FR-031: `llm_budget_exhausted`, `llm_quota_reached`). */
  warnings: jsonb('warnings').$type<AnalysisWarning[]>().notNull().default([]),
  /**
   * Inserted by the demo seeder (007/FR-065), not by a user. Only these rows are left out of the monthly analyses
   * quota (008/FR-036); anything a user runs counts, whatever the tender's source.
   */
  seeded: boolean('seeded').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  orgTenderIdx: index('analyses_org_tender_idx').on(t.orgId, t.tenderId),
  // 008/FR-027: "latest analysis per (org, tender)" lookups in the feed sort/decorate.
  orgTenderCreatedIdx: index('analyses_org_tender_created_idx').on(t.orgId, t.tenderId, t.createdAt.desc().nullsFirst()),
}));

/** 008/FR-031/FR-037 analysis warnings; one definition, in the core contract (review N1). */
export type { AnalysisWarning };

// ───────────── Apply: workspace & packet ─────────────

export type Stage = 'identified' | 'analysing' | 'go' | 'preparing' | 'ready' | 'submitted' | 'won' | 'lost' | 'dropped';

export const bidWorkspaces = pgTable('bid_workspaces', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  stage: text('stage').$type<Stage>().notNull().default('identified'),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  assigneeIds: jsonb('assignee_ids').$type<string[]>().notNull().default([]),
  dueAt: timestamp('due_at', { withTimezone: true }),
  /** checklist item id → vault document id (or null = missing) */
  docMapping: jsonb('doc_mapping').$type<Record<string, string | null>>().notNull().default({}),
  overrides: jsonb('overrides').$type<{ itemId: string; reason: string; by: string; at: string }[]>().notNull().default([]),
  /** Values the human will enter on GeM (non-financial only). */
  assistValues: jsonb('assist_values').$type<Record<string, string>>().notNull().default({}),
  outcome: jsonb('outcome').$type<{ result: 'won' | 'lost'; l1Price?: number; ourPrice?: number; notes?: string; at: string } | null>(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  position: real('position').notNull().default(0), // kanban order within stage
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uq: uniqueIndex('workspace_org_tender_uq').on(t.orgId, t.tenderId),
  /** Pipeline/dashboard stage aggregates (007/NFR-001). */
  orgStageIdx: index('bid_workspaces_org_stage_idx').on(t.orgId, t.stage),
}));

/**
 * Last parsed GeM bid-result hint per BidPlus `b_id` (007/T033, FR-030). Public data, not org-scoped: any org with a
 * workspace for the tender is served from here within the TTL instead of fetching GeM again.
 * `hint` is a `BidResultHint` from @tp/core/gem/award (available, or not published yet).
 */
export const gemResultHints = pgTable('gem_result_hints', {
  gemBidId: text('gem_bid_id').primaryKey(),
  hint: jsonb('hint').$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export const comments = pgTable('comments', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => bidWorkspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdAt: createdAt(),
}, (t) => ({
  /** Comment thread per workspace (006/NFR-001). */
  wsIdx: index('comments_ws_idx').on(t.workspaceId),
}));

export const annexureTemplates = pgTable('annexure_templates', {
  id: id(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = system template
  key: text('key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(), // {{placeholders}}
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  /** One override per (org, key) (006/FR-036). System templates (org_id NULL) are code, not rows. */
  orgKeyUq: uniqueIndex('annexure_templates_org_key_uq').on(t.orgId, t.key),
}));

export interface PacketItem {
  kind: 'cover' | 'annexure' | 'vault' | 'tender_doc';
  refId?: string; // vault doc id / annexure key
  title: string;
  pages?: number;
}

export const packets = pgTable('packets', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => bidWorkspaces.id, { onDelete: 'cascade' }),
  status: text('status').$type<'draft' | 'building' | 'ready' | 'failed'>().notNull().default('draft'),
  items: jsonb('items').$type<PacketItem[]>().notNull().default([]),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  blobKey: text('blob_key'),
  sizeBytes: integer('size_bytes'),
  pageCount: integer('page_count'),
  /** Snapshot of the computed default item uids (`kind:refId`) at build time (006/FR-055): items of a later
   *  computed default whose uid is not in here are "newly required" and appended to the proposed order.
   *  NULL = built before FR-055: append nothing. Never backfill with [] (that would re-append every item). */
  defaultUids: jsonb('default_uids').$type<string[]>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => ({ wsIdx: index('packets_ws_idx').on(t.workspaceId) }));

/**
 * One row per packet a user built (008/FR-036), written with the `packets` row and removed only when that build fails.
 * `packet_id` has no foreign key, so deleting the packet (e.g. with its demo workspace by `DELETE /demo`) does not give
 * the monthly packet back: `packetsPerMonth` counts this ledger, not `packets`.
 */
export const packetLedger = pgTable('packet_ledger', {
  packetId: uuid('packet_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => ({ orgIdx: index('packet_ledger_org_idx').on(t.orgId, t.createdAt) }));

// ───────────── Notifications & activity ─────────────

export const notifications = pgTable('notifications', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').$type<'in_app' | 'email' | 'whatsapp'>().notNull(),
  kind: text('kind').$type<NotificationKind>().notNull(), // derived from NOTIFICATION_KINDS in @tp/core
  title: text('title').notNull(),
  body: text('body').notNull(),
  link: text('link'),
  dedupeKey: text('dedupe_key'),
  status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped' | 'read'>().notNull().default('pending'),
  error: text('error'),
  /** Delivery attempts made so far (email / WhatsApp); FR-047 retries transient failures up to 3. */
  attempts: integer('attempts').notNull().default(0),
  /** Earliest time the dispatcher may (re)try this row; also the claim lease while a dispatcher holds it. */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index('notifications_user_idx').on(t.orgId, t.userId, t.createdAt),
  dedupeUq: uniqueIndex('notifications_dedupe_uq').on(t.userId, t.channel, t.dedupeKey),
  // 008/FR-029: the dispatcher's select of pending outbound alerts (built CONCURRENTLY in migration 0017).
  pendingIdx: index('notifications_pending_idx').on(t.createdAt).where(sql`status = 'pending' AND channel IN ('email','whatsapp')`),
}));

export const activityLog = pgTable('activity_log', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(), // e.g. tender.analysed, workspace.stage_changed, vault.uploaded
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => ({
  orgIdx: index('activity_org_idx').on(t.orgId, t.createdAt),
  orgTypeIdx: index('activity_org_type_idx').on(t.orgId, t.entityType, t.createdAt),
}));

// ───────────── Plans & metering (spec 008 US5) ─────────────

/** Plan changes made by TenderPilot staff via `POST /api/admin/orgs/:id/plan` (008/FR-042). */
export const subscriptions = pgTable('subscriptions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull(), // trial | starter | pro | enterprise
  status: text('status').$type<'active' | 'cancelled'>().notNull().default('active'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: createdAt(),
}, (t) => ({ orgIdx: index('subscriptions_org_idx').on(t.orgId, t.createdAt.desc()) }));

/** One row per LLM call (008/FR-039): tokens as reported by the provider. */
export const llmUsage = pgTable('llm_usage', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  analysisId: uuid('analysis_id').references(() => analyses.id, { onDelete: 'set null' }),
  /**
   * The analysis this row was metered for, with no foreign key so it survives the analysis being deleted (e.g. by
   * `DELETE /demo`). The monthly AI quota (008/FR-037) counts distinct values of this column, never `analysis_id`.
   */
  analysisRef: uuid('analysis_ref'),
  kind: text('kind').$type<'extract' | 'assist'>().notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  /**
   * A 0-token reservation of an analysis's AI slot not yet filled in by a metered call (review S1/NEW-B1). Lets the
   * timeout sweep release reservations a crashed run left behind without touching filled 0-token rows (aborted calls).
   */
  reserved: boolean('reserved').notNull().default(false),
  createdAt: createdAt(),
}, (t) => ({ orgIdx: index('llm_usage_org_idx').on(t.orgId, t.createdAt) }));
