/**
 * Demo banner (T055; 007/FR-066, US4-12) — shown on the dashboard while the org holds sample data. bid_manager+ get
 * "Remove demo data", which asks for confirmation first; the mutation refreshes every query so the dashboard empties.
 */
import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Button, Card, ConfirmDialog, toast } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { useRemoveDemo } from './api';

export const DEMO_BANNER_TEXT = 'You’re exploring sample data for Aarav Technologies Pvt Ltd.';
export const DEMO_REMOVE_CONFIRM = 'Remove all demo data? Your own watchlists, documents and bids stay.';

export function DemoBanner() {
  const { can } = useAuth();
  const remove = useRemoveDemo();
  const [open, setOpen] = useState(false);
  return (
    <Card role="status" className="border-info/30 bg-info-soft">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex min-w-0 items-start gap-3 text-sm font-medium text-foreground">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
          <span>{DEMO_BANNER_TEXT}</span>
        </p>
        {can('bid_manager') && (
          <Button variant="secondary" size="sm" className="shrink-0 self-start sm:self-auto" onClick={() => setOpen(true)}>Remove demo data</Button>
        )}
      </div>
      <ConfirmDialog
        open={open} onOpenChange={setOpen} loading={remove.isPending} title={DEMO_REMOVE_CONFIRM} confirmLabel="Remove demo data"
        onConfirm={() => remove.mutate(undefined, {
          onSuccess: () => { setOpen(false); toast.success('Demo data removed'); },
          onError: (e) => toast.error(errorMessage(e)),
        })}
      />
    </Card>
  );
}
