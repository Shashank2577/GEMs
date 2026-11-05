import type { ChecklistReadiness } from '@tp/core/analyse/checklist';

export type ReadinessIcon = 'ok' | 'warn' | 'bad' | 'missing';
export interface ReadinessChip { label: string; tone: 'success' | 'warning' | 'danger'; icon: ReadinessIcon }

/** Chip for a checklist row's vault readiness (FR-040); null = no chip (n/a). Text and icon carry the meaning, not colour alone (NFR-006). */
export function readinessChip(r: ChecklistReadiness | undefined): ReadinessChip | null {
  if (!r) return null;
  switch (r.status) {
    case 'ready': return { label: 'In vault', tone: 'success', icon: 'ok' };
    case 'expiring': return { label: r.days <= 0 ? 'Expires today' : `Expires in ${r.days} ${r.days === 1 ? 'day' : 'days'}`, tone: 'warning', icon: 'warn' };
    case 'expired': return { label: 'Expired', tone: 'danger', icon: 'bad' };
    case 'missing': return { label: 'Missing', tone: 'danger', icon: 'missing' };
    default: return null;
  }
}
