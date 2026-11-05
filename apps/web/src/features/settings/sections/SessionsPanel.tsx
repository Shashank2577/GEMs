import { useState } from 'react';
import { LogOut, Monitor, MonitorSmartphone, Smartphone } from 'lucide-react';
import type { SessionSummary } from '@tp/core/contracts/auth';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, SkeletonList, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useRevokeOtherSessions, useRevokeSession, useSessions } from '../api';
import { Panel } from './Panel';

const isMobile = (s: SessionSummary) => /iOS|Android/.test(s.device);

/** "Where you’re signed in" — list and revoke your sessions (002/FR-012). */
export function SessionsPanel() {
  const q = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [revoking, setRevoking] = useState<SessionSummary | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const items = q.data?.items ?? [];
  const others = items.filter((s) => !s.current).length;

  return (
    <Panel
      title="Where you’re signed in"
      description="Devices and browsers signed in to your TenderPilot account. Sign out of any you don’t recognise."
      aside={others > 0 ? <Button variant="secondary" onClick={() => setConfirmAll(true)}><LogOut /> Sign out of all other devices</Button> : undefined}
    >
      {q.isLoading ? <SkeletonList rows={2} /> : q.isError ? <ErrorState compact error={q.error} onRetry={() => q.refetch()} /> : items.length === 0 ? (
        <EmptyState compact icon={MonitorSmartphone} title="No active sessions" />
      ) : (
        <ul className="divide-y" aria-label="Signed-in devices">
          {items.map((s) => {
            const Icon = isMobile(s) ? Smartphone : Monitor;
            return (
              <li key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium" title={s.userAgent ?? undefined}>{s.device}</span>
                    {s.current && <Badge tone="success" size="sm">This device</Badge>}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Signed in {formatDateIST(s.createdAt)} · {s.current ? 'Active now' : `Last active ${relativeTime(s.lastSeenAt ?? s.createdAt)}`}
                  </span>
                </span>
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(s)} aria-label={`Sign out ${s.device}`}><LogOut /> Sign out</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}
        title={`Sign out ${revoking?.device ?? 'this device'}?`}
        description="That browser will need to sign in again on its next request." confirmLabel="Sign out" loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id, {
          onSuccess: () => { toast.success(`Signed out ${revoking.device}`); setRevoking(null); },
          onError: (e) => toast.error(errorMessage(e)),
        })}
      />
      <ConfirmDialog
        open={confirmAll} onOpenChange={setConfirmAll}
        title="Sign out of all other devices?"
        description={`You’ll stay signed in here. ${others} other ${others === 1 ? 'session' : 'sessions'} will be signed out.`}
        confirmLabel="Sign out others" loading={revokeOthers.isPending}
        onConfirm={() => revokeOthers.mutate(undefined, {
          onSuccess: (r) => { toast.success(r.revoked === 1 ? 'Signed out 1 other device' : `Signed out ${r.revoked} other devices`); setConfirmAll(false); },
          onError: (e) => toast.error(errorMessage(e)),
        })}
      />
    </Panel>
  );
}
