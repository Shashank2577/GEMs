import type { DashboardActivity } from '@tp/core/contracts/experience';
import { STAGE_LABEL, type Stage } from '@/lib/types';

const stage = (v: unknown) => (typeof v === 'string' && v in STAGE_LABEL ? STAGE_LABEL[v as Stage] : String(v ?? ''));

/** Plain-English sentence for an activity entry (without the actor and target). */
export function describeActivity(a: Pick<DashboardActivity, 'action' | 'meta'>): string {
  const m = a.meta ?? {};
  switch (a.action) {
    case 'workspace.stage_changed': return `moved a bid from ${stage(m.from)} to ${stage(m.to)}`;
    case 'workspace.created': return 'started a bid workspace for';
    case 'workspace.submitted': return 'marked as submitted on GeM';
    case 'workspace.outcome_recorded': return m.result === 'won' ? 'recorded a win on' : 'recorded a loss on';
    case 'workspace.commented': return 'commented on';
    case 'workspace.assigned': return 'changed the owner of';
    case 'workspace.item_overridden': return 'overrode a checklist item on';
    case 'workspace.mapping_changed': return 'mapped documents for';
    case 'workspace.due_changed': return 'changed the due date of';
    case 'workspace.assist_values_saved': return 'saved form values for';
    case 'packet.built': return `built a ${typeof m.pages === 'number' ? `${m.pages}-page ` : ''}bid packet for`;
    case 'tender.analysed': return `checked eligibility${typeof m.score === 'number' ? ` (score ${m.score})` : ''} for`;
    case 'tender.document_uploaded': case 'tender.document_fetched': return 'added a bid document to';
    case 'analysis.factor_overridden': return 'overrode a scoring factor on';
    case 'vault.uploaded': return 'uploaded';
    case 'vault.updated': return 'updated';
    case 'vault.file_replaced': return 'replaced the file of';
    case 'vault.deleted': return 'deleted';
    case 'watchlist.created': return 'created the watchlist';
    case 'watchlist.deleted': return 'deleted the watchlist';
    case 'profile.updated': return 'updated the';
    case 'profile.past_contract_added': return 'added a past contract to the';
    case 'member.invited': return 'invited';
    case 'member.joined': return 'joined the team';
    case 'member.role_changed': return 'changed the role of';
    case 'member.removed': return 'removed';
    case 'org.created': return 'created the organization';
    case 'org.updated': return 'updated organization settings';
    case 'org.scoring_weights_updated': return 'tuned the scoring weights';
    case 'ingestion.run': return 'synced tenders from GeM';
    case 'api_token.created': return 'created an API token';
    case 'api_token.revoked': return 'revoked an API token';
    case 'demo.seeded': return 'loaded the demo dataset';
    default: return a.action.replace(/[._]/g, ' ');
  }
}

/** Actions whose target should not be printed after the sentence. */
export const SELF_CONTAINED = new Set(['member.joined', 'org.created', 'org.updated', 'org.scoring_weights_updated', 'ingestion.run', 'api_token.created', 'api_token.revoked', 'demo.seeded']);
