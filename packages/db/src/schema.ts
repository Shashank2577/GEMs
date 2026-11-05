/**
 * TenderPilot database schema — single source of truth (see specs/001-gem-tender-copilot/data-model.md).
 * Every org-owned table carries org_id (Constitution IV).
 */
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
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({ tokenUq: uniqueIndex('api_tokens_token_uq').on(t.tokenHash) }));

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({ orgIdx: index('vault_org_idx').on(t.orgId), typeIdx: index('vault_org_type_idx').on(t.orgId, t.type) }));

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
  bidUq: uniqueIndex('tenders_source_bid_uq').on(t.source, t.bidNumber),
  endIdx: index('tenders_end_idx').on(t.endAt),
  stateIdx: index('tenders_state_idx').on(t.state),
}));

export const tenderEvents = pgTable('tender_events', {
  id: id(),
  tenderId: uuid('tender_id').notNull().references(() => tenders.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'created' | 'updated' | 'corrigendum' | 'closed' | 'cancelled'>().notNull(),
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
  pageCount: integer('page_count'),
  text: text('text'), // extracted text, pages separated by \f
  sourceUrl: text('source_url'),
  textSource: text('text_source').$type<'pdf' | 'ocr'>().notNull().default('pdf'), // FR-052
  createdAt: createdAt(),
}, (t) => ({ tenderIdx: index('tender_docs_tender_idx').on(t.tenderId) }));

export const ingestionRuns = pgTable('ingestion_runs', {
  id: id(),
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
});

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
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({ orgTenderIdx: index('analyses_org_tender_idx').on(t.orgId, t.tenderId) }));

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
}, (t) => ({ uq: uniqueIndex('workspace_org_tender_uq').on(t.orgId, t.tenderId) }));

export const comments = pgTable('comments', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => bidWorkspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdAt: createdAt(),
});

export const annexureTemplates = pgTable('annexure_templates', {
  id: id(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = system template
  key: text('key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(), // {{placeholders}}
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => ({ wsIdx: index('packets_ws_idx').on(t.workspaceId) }));

// ───────────── Notifications & activity ─────────────

export const notifications = pgTable('notifications', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').$type<'in_app' | 'email' | 'whatsapp'>().notNull(),
  kind: text('kind').$type<'tender_match' | 'expiry' | 'deadline' | 'assignment' | 'mention' | 'digest' | 'system'>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  link: text('link'),
  dedupeKey: text('dedupe_key'),
  status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped' | 'read'>().notNull().default('pending'),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index('notifications_user_idx').on(t.orgId, t.userId, t.createdAt),
  dedupeUq: uniqueIndex('notifications_dedupe_uq').on(t.userId, t.channel, t.dedupeKey),
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
}, (t) => ({ orgIdx: index('activity_org_idx').on(t.orgId, t.createdAt) }));
