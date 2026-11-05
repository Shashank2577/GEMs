import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, FileSignature, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import type { ActivityItem } from '@tp/core/contracts/auth';
import type { ReadinessState } from '@tp/core/contracts/apply';
import { TEMPLATE_PLACEHOLDERS } from '@tp/core/packet/placeholders';
import { Badge, type BadgeTone } from '@/components/ui';
import { STAGE_LABEL, type Stage } from '@/lib/types';
import { formatINR } from '@/lib/format';
import { cn } from '@/lib/utils';

export const STATE_META: Record<ReadinessState, { label: string; tone: BadgeTone; icon: LucideIcon; ring: string }> = {
  ready: { label: 'Ready', tone: 'success', icon: CheckCircle2, ring: 'text-success' },
  expiring: { label: 'Expiring soon', tone: 'warning', icon: Clock3, ring: 'text-warning' },
  generated: { label: 'Generated', tone: 'primary', icon: FileSignature, ring: 'text-primary' },
  overridden: { label: 'Overridden', tone: 'info', icon: ShieldCheck, ring: 'text-info' },
  missing: { label: 'Missing', tone: 'danger', icon: CircleDashed, ring: 'text-danger' },
  expired: { label: 'Expired', tone: 'danger', icon: XCircle, ring: 'text-danger' },
};

export function StateChip({ state, className }: { state: ReadinessState; className?: string }) {
  const m = STATE_META[state];
  const Icon = m.icon;
  return (
    <Badge tone={m.tone} className={cn('font-semibold', className)}>
      <Icon aria-hidden /> {m.label}
    </Badge>
  );
}

export function BlockerIcon() {
  return <AlertTriangle className="size-4 text-danger" aria-hidden />;
}

/** Friendly names for template placeholders (shown when a value is missing). */
export const PLACEHOLDER_LABEL: Record<string, { label: string; href: string }> = {
  'company.legalName': { label: 'Legal name', href: '/profile' },
  'company.gstin': { label: 'GSTIN', href: '/profile' },
  'company.pan': { label: 'PAN', href: '/profile' },
  'company.cin': { label: 'CIN', href: '/profile' },
  'company.address': { label: 'Registered address', href: '/profile' },
  'company.udyamNumber': { label: 'Udyam number', href: '/profile' },
  'company.mseCategory': { label: 'MSE category', href: '/profile' },
  'company.mseSocialCategory': { label: 'MSE social category', href: '/profile' },
  'company.miiClass': { label: 'Make in India class', href: '/profile' },
  'company.localContentPct': { label: 'Local content %', href: '/profile' },
  'company.contactName': { label: 'Contact person', href: '/profile' },
  'company.contactEmail': { label: 'Contact email', href: '/profile' },
  'company.contactPhone': { label: 'Contact phone', href: '/profile' },
  'signatory.name': { label: 'Signatory name', href: '/profile' },
  'signatory.designation': { label: 'Signatory designation', href: '/profile' },
  'oem.name': { label: 'OEM name', href: '/profile' },
  'emd.basis': { label: 'MSE / Startup registration', href: '/profile' },
  'offer.make': { label: 'Make (Submit step)', href: '?step=submit' },
  'offer.model': { label: 'Model (Submit step)', href: '?step=submit' },
  'offer.deliveryPeriod': { label: 'Delivery period (Submit step)', href: '?step=submit' },
  'offer.warranty': { label: 'Warranty (Submit step)', href: '?step=submit' },
  'offer.countryOfOrigin': { label: 'Country of origin (Submit step)', href: '?step=submit' },
  'tender.buyerOffice': { label: 'Buyer office (from GeM)', href: '' },
};

const CORE_LABEL: Record<string, string> = Object.fromEntries(TEMPLATE_PLACEHOLDERS.map((p) => [p.path, p.label]));

export const placeholderLabel = (p: string) => PLACEHOLDER_LABEL[p]?.label ?? CORE_LABEL[p] ?? p;

/** Placeholders users can insert in the template editor: exactly the supported context paths (FR-041). */
export const INSERTABLE_PLACEHOLDERS = TEMPLATE_PLACEHOLDERS;

const stage = (s: unknown) => (typeof s === 'string' && s in STAGE_LABEL ? STAGE_LABEL[s as Stage] : String(s ?? ''));

/** One-line, human description of an activity entry. */
export function describeActivity(a: ActivityItem): string {
  const m = a.meta ?? {};
  switch (a.action) {
    case 'workspace.created': return 'started this bid';
    case 'workspace.stage_changed': return `moved it ${m.from ? `from ${stage(m.from)} ` : ''}to ${stage(m.to)}${m.auto ? ' (after building the packet)' : ''}`;
    case 'workspace.assigned': return 'updated the owner and assignees';
    case 'workspace.due_changed': return 'changed the internal due date';
    case 'workspace.mapping_changed': return `changed the document for ${Object.keys((m.mapping as object) ?? {}).length || 1} checklist item(s)`;
    case 'workspace.item_overridden': return `overrode “${m.label ?? m.itemId}”: ${m.reason ?? ''}`;
    case 'workspace.override_removed': return 'removed an override';
    case 'workspace.commented': return 'commented';
    case 'workspace.packet_built': return `built the packet (${m.pageCount ?? '?'} pages)`;
    case 'workspace.packet_failed': return 'tried to build the packet (failed)';
    case 'workspace.assist_values_saved': return 'updated the submission values';
    case 'workspace.submitted': return 'marked the bid as submitted on GeM';
    case 'workspace.outcome_recorded': return `recorded the result: ${m.result === 'won' ? 'Won' : 'Lost'}${m.l1Price ? ` (L1 ${formatINR(m.l1Price as number)})` : ''}`;
    case 'tender.analysed': return 'analysed the tender';
    case 'analysis.overridden': case 'analysis.factor_overridden': return 'overrode a scoring factor';
    default: return a.action.replace(/^[a-z]+\./, '').replace(/_/g, ' ');
  }
}
