import { useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Member } from '@tp/core/contracts/auth';
import { Button, ConfirmDialog, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLeaveOrg } from '../api';
import { Panel } from './Panel';

/** "Leave organization" danger zone (002/FR-027): any member may leave; the last Owner gets 409 `last_owner`. */
export function LeaveOrgPanel({ members }: { members: Member[] | undefined }) {
  const { me } = useAuth();
  const leave = useLeaveOrg();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const orgName = me.org.name;
  const soleOwner = me.role === 'owner' && !!members && members.filter((m) => m.role === 'owner').length <= 1;

  return (
    <>
      <Panel title="Leave organization" className="border-danger/30"
        description="Stop being a member of this organization. Your own account and your other organizations are not affected.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-[13px] text-muted-foreground">
            {soleOwner
              ? `You are the only Owner of ${orgName}. Make someone else an Owner before you leave.`
              : `You lose access to ${orgName}’s tenders, vault and bids immediately, and your API tokens for it are revoked.`}
          </p>
          <Button variant="danger" className="shrink-0" onClick={() => setOpen(true)}><LogOut /> Leave organization</Button>
        </div>
      </Panel>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={`Leave ${orgName}?`}
        description="You lose access immediately. To come back, an Owner or Bid Manager has to invite you again. Your past activity stays in the log."
        confirmLabel="Leave organization" loading={leave.isPending}
        onConfirm={() => leave.mutate(undefined, {
          onSuccess: () => setOpen(false), // toast + redirect: useLeaveOrg
          onError: (e) => { setOpen(false); toast.error(errorMessage(e)); },
        })} />
    </>
  );
}
