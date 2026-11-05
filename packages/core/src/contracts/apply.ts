/**
 * Apply-module API contracts (T063–T065; FR-023..FR-028). Bid workspace, readiness, annexures,
 * packets and the submission assistant. See specs/001-gem-tender-copilot/contracts/api.md (Apply).
 */
import { z } from 'zod';
import { PACKET_MAX_ITEMS } from './caps';
import type { ActivityItem } from './auth';
import type { AnalysisDto, ChecklistItem } from './analyse';
import type { Readiness, ReadinessItem, ReadinessState } from '../packet/mapping';
import type { AssistPayload, AssistField } from '../assist/allowlist';
import type { TemplateKey } from '../packet/templates';

export type { Readiness, ReadinessItem, ReadinessState, AssistPayload, AssistField, TemplateKey, ChecklistItem };

// ───────────── Stages ─────────────

export const STAGES = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost', 'dropped'] as const;
export const stageSchema = z.enum(STAGES);
export type StageName = z.infer<typeof stageSchema>;

export const STAGE_LABELS: Record<StageName, string> = {
  identified: 'Identified', analysing: 'Analysing', go: 'Go', preparing: 'Preparing', ready: 'Ready to submit',
  submitted: 'Submitted', won: 'Won', lost: 'Lost', dropped: 'Dropped',
};

/** Stages that require a recorded GeM submission first (FR-008). */
export const OUTCOME_STAGES: readonly StageName[] = ['won', 'lost'];
/** Stages from which a bid may be marked won or lost (submitted, or correcting an existing result) (FR-008). */
export const OUTCOME_ALLOWED_FROM: readonly StageName[] = ['submitted', 'won', 'lost'];
export const INVALID_TRANSITION_MESSAGE =
  'Record the submission on GeM first — a bid can only be won or lost after it was submitted.';

export type TransitionCheck = { ok: true } | { ok: false; code: 'invalid_transition'; message: string };

/**
 * Stage transition rules (T019; FR-008). Every move is allowed except reaching `won`/`lost` from a stage
 * other than `submitted`, `won` or `lost`. The `ready` guard (FR-005) needs readiness and lives in the API.
 */
export function canTransition(from: StageName, to: StageName): TransitionCheck {
  if (OUTCOME_STAGES.includes(to) && !OUTCOME_ALLOWED_FROM.includes(from)) {
    return { ok: false, code: 'invalid_transition', message: INVALID_TRANSITION_MESSAGE };
  }
  return { ok: true };
}

/**
 * The Go / No-Go decision (001 personas, 004 roles table: "Bid Manager owns the Go/No-Go decision"; 007/FR-072).
 * Moving a bid INTO one of these stages is Bid Manager+ at the API (#527 item 5); every other move stays Analyst+.
 * "Dropped" is the No-Go outcome ("Drop" on the dashboard's Awaiting-your-decision card).
 */
export const DECISION_STAGES: readonly StageName[] = ['go', 'dropped'];
export const DECISION_FORBIDDEN_MESSAGE = 'Only a Bid Manager or Owner can make the Go / No-Go decision.';

/** Active pipeline columns (Kanban), in order. */
export const PIPELINE_STAGES: StageName[] = ['identified', 'analysing', 'go', 'preparing', 'ready', 'submitted', 'won', 'lost'];

// ───────────── Inputs ─────────────

const uuid = z.string().uuid();

export const outcomeInputSchema = z.object({
  result: z.enum(['won', 'lost']),
  /** L1 (lowest) price disclosed by GeM after the bid — recorded for analytics, never entered on GeM. */
  l1Price: z.number().int().nonnegative().max(1e13).nullable().optional(),
  ourPrice: z.number().int().nonnegative().max(1e13).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type OutcomeInput = z.infer<typeof outcomeInputSchema>;

export const workspaceUpdateSchema = z.object({
  stage: stageSchema.optional(),
  ownerId: uuid.nullable().optional(),
  assigneeIds: z.array(uuid).max(20).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  position: z.number().finite().optional(),
  outcome: outcomeInputSchema.nullable().optional(),
}).strict();
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateSchema>;

/** itemId → vault document id, `null` = "not available", `"auto"` = let TenderPilot pick. */
export const mappingInputSchema = z.record(z.string().min(1).max(120), z.union([uuid, z.literal('auto')]).nullable());
export type MappingInput = z.infer<typeof mappingInputSchema>;

export const overrideInputSchema = z.object({
  itemId: z.string().min(1).max(120),
  reason: z.string().trim().min(5, 'Explain why in a few words (at least 5 characters)').max(500),
});
export type OverrideInput = z.infer<typeof overrideInputSchema>;

export const commentInputSchema = z.object({ body: z.string().trim().min(1, 'Write a comment').max(4000) });

export const annexureTemplateInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20, 'The template body is too short').max(20_000),
});
export type AnnexureTemplateInput = z.infer<typeof annexureTemplateInputSchema>;

export const PACKET_ITEM_KINDS = ['cover', 'annexure', 'vault', 'tender_doc'] as const;
export const packetItemSchema = z.object({
  kind: z.enum(PACKET_ITEM_KINDS),
  refId: z.string().max(120).optional(),
  title: z.string().trim().min(1).max(200),
  pages: z.number().int().nonnegative().optional(),
});
export type PacketItemInput = z.infer<typeof packetItemSchema>;

/** 008/FR-032: at most PACKET_MAX_ITEMS (40) items; the API answers 413 `packet_too_large` before this schema runs. */
export const packetBuildSchema = z.object({ items: z.array(packetItemSchema).max(PACKET_MAX_ITEMS).optional() });

export const assistValuesSchema = z.record(z.string().min(1).max(80), z.string().max(2000));

export const submittedInputSchema = z.object({
  submittedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(1000).optional(),
});

// ───────────── Responses ─────────────

export interface PersonRef { id: string; name: string; email?: string }

export interface WorkspaceOutcome { result: 'won' | 'lost'; l1Price?: number | null; ourPrice?: number | null; notes?: string | null; at: string }

export interface WorkspaceDto {
  id: string;
  tenderId: string;
  stage: StageName;
  owner: PersonRef | null;
  assignees: PersonRef[];
  dueAt: string | null;
  mapping: Record<string, string | null>;
  overrides: { itemId: string; reason: string; by: string; byName?: string | null; at: string }[];
  assistValues: Record<string, string>;
  outcome: WorkspaceOutcome | null;
  submittedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTender {
  id: string; bidNumber: string; title: string; bidType: string; category: string | null; quantity: number | null;
  ministry: string | null; department: string | null; organisation: string | null; buyerOffice: string | null;
  state: string | null; city: string | null; startAt: string | null; endAt: string | null;
  emdAmount: number | null; estimatedValue: number | null; status: string; sourceUrl: string; documentUrl: string | null;
  items: { name: string; quantity?: number; unit?: string }[];
}

export interface WorkspaceCard {
  id: string;
  stage: StageName;
  position: number;
  owner: PersonRef | null;
  assignees: PersonRef[];
  dueAt: string | null;
  updatedAt: string;
  submittedAt: string | null;
  outcome: WorkspaceOutcome | null;
  tender: Pick<WorkspaceTender, 'id' | 'bidNumber' | 'title' | 'organisation' | 'ministry' | 'state' | 'endAt' | 'emdAmount' | 'estimatedValue' | 'status'>;
  analysis: { id: string; score: number | null; verdict: 'go' | 'review' | 'no_go' | null; stale: boolean } | null;
  /** `analysed: false` (with percent 0) when the tender has no analysis yet (FR-009). */
  readiness: { percent: number; blockers: number; total: number; covered: number; analysed: boolean };
  commentCount: number;
}

export interface WorkspaceListResponse { items: WorkspaceCard[]; total: number; byStage: Partial<Record<StageName, number>> }

export interface CommentDto { id: string; body: string; user: PersonRef; createdAt: string }

export interface PacketDto {
  id: string;
  workspaceId: string;
  status: 'draft' | 'building' | 'ready' | 'failed';
  items: { kind: PacketItemInput['kind']; refId?: string; title: string; pages?: number; startPage?: number; included?: boolean }[];
  warnings: string[];
  sizeBytes: number | null;
  pageCount: number | null;
  createdBy: PersonRef | null;
  createdAt: string;
  downloadUrl: string | null;
}

export interface AnnexureTemplateDto {
  key: TemplateKey;
  title: string;
  description: string;
  body: string;
  /** True when the org has customised the system template. */
  custom: boolean;
  systemTitle: string;
  systemBody: string;
  placeholders: string[];
  updatedAt: string | null;
}

export interface WorkspaceAnnexure {
  key: TemplateKey;
  title: string;
  description: string;
  /** Checklist item that requires it (null when optional / always available). */
  itemId: string | null;
  required: boolean;
  /** Placeholders that will print blank — fill the profile to complete them. */
  missing: string[];
  pdfUrl: string;
}

export interface WorkspaceVaultDoc {
  id: string; type: string; title: string; fileName: string; mimeType: string; sizeBytes: number; pageCount: number | null;
  expiryDate: string | null; financialYear: string | null; tags: string[]; status: 'valid' | 'expiring' | 'expired';
  daysToExpiry: number | null; downloadUrl: string;
}

export interface WorkspaceTenderDoc { id: string; kind: string; fileName: string; pageCount: number | null; sizeBytes: number; downloadUrl: string }

export interface WorkspaceMember { id: string; name: string; email: string; role: string }

export interface WorkspaceDetail {
  workspace: WorkspaceDto;
  tender: WorkspaceTender;
  analysis: AnalysisDto | null;
  readiness: Readiness;
  annexures: WorkspaceAnnexure[];
  packets: PacketDto[];
  comments: CommentDto[];
  activity: ActivityItem[];
  vaultDocs: WorkspaceVaultDoc[];
  tenderDocs: WorkspaceTenderDoc[];
  members: WorkspaceMember[];
  /** Proposed order (006/FR-055): the last ready build's items (still-valid refs, newly required items appended), else the computed default. */
  defaultPacketItems: PacketItemInput[];
  /** The computed default order (006/FR-045) — what "Default order" resets to. */
  computedPacketItems: PacketItemInput[];
  /** Profile gaps that leave blanks in annexures. */
  profileGaps: string[];
}
