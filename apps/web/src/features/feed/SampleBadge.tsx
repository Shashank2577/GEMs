import { FlaskConical } from 'lucide-react';
import { Badge, Tooltip } from '@/components/ui';

/** "Sample" marker for demo tenders (`isDemo`, from `tenders.raw.demo`) so they are never mistaken for live GeM bids (007/FR-067). */
export function SampleBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <Tooltip content="Sample tender from the demo data — not a live GeM bid.">
      <span><Badge size={size} tone="accent"><FlaskConical aria-hidden />Sample</Badge></span>
    </Tooltip>
  );
}
