import { useState, type FormEvent } from 'react';
import { Check, Copy, Mail, MailPlus, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import type { CreatedInvitation, Member } from '@tp/core/contracts/auth';
import {
  Avatar, Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState,
  ErrorState, Field, Input, ResponsiveTable, Select, SkeletonList, toast, type Column,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateIST, relativeTime } from '@/lib/format';
import { ROLE_LABEL, type Role } from '@/lib/types';
import { copyText, useChangeRole, useInvite, useMembers, useRemoveMember, useRevokeInvite } from '../api';
import { LeaveOrgPanel } from './LeaveOrgPanel';
import { Panel, fieldErrors } from './Panel';

export const ROLE_INFO: Record<Role, string> = {
  owner: 'Everything, including billing, roles and removing members.',
  bid_manager: 'Approves bids, overrides checklist items, invites teammates, tunes scoring.',
  analyst: 'Analyses tenders, uploads documents and prepares packets.',
  viewer: 'Read-only — ideal for compliance reviewers and promoters on the go.',
};

export default function TeamSection() {
  const { me, can } = useAuth();
  const q = useMembers();
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const revoke = useRevokeInvite();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const isOwner = can('owner');

  const columns: Column<Member>[] = [
    {
      key: 'name', header: 'Member', primary: true,
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={m.name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{m.name}{m.userId === me?.user.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</span>
            <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'role', header: 'Role',
      cell: (m) => isOwner && m.userId !== me?.user.id ? (
        <Select aria-label={`Role for ${m.name}`} value={m.role} className="h-8 w-40"
          onValueChange={(role) => changeRole.mutate({ userId: m.userId, role }, {
            onSuccess: () => toast.success(`${m.name} is now ${ROLE_LABEL[role as Role]}`),
            onError: (e) => toast.error(errorMessage(e)),
          })}
          options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      ) : <Badge tone={m.role === 'owner' ? 'primary' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>,
    },
    { key: 'joined', header: 'Joined', hideOnMobile: true, cell: (m) => <span className="text-muted-foreground">{formatDateIST(m.joinedAt)}</span> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'w-12 text-right',
      cell: (m) => isOwner && m.userId !== me?.user.id ? (
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={(e) => { e.stopPropagation(); setRemoving(m); }}><Trash2 /></Button>
      ) : null,
    },
  ];

  return (
    <div className="grid gap-6">
      <Panel title="Team & roles" description="Everyone works in the same pipeline. Roles are enforced on the server."
        aside={can('bid_manager') ? <Button onClick={() => setInviteOpen(true)}><UserPlus /> Invite teammate</Button> : undefined}>
        {q.isLoading ? <SkeletonList rows={3} /> : q.isError ? <ErrorState compact error={q.error} onRetry={() => q.refetch()} /> : (
          <ResponsiveTable columns={columns} rows={q.data!.items} rowKey={(m) => m.userId}
            empty={<EmptyState compact icon={Users} title="Just you so far" body="Invite a bid manager or analyst to share the work." />} />
        )}
      </Panel>

      {q.data && q.data.invitations.length > 0 && (
        <Panel title="Pending invitations" description="Invitations expire after 7 days. Revoke one to invalidate its link.">
          <ul className="divide-y">
            {q.data.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground"><Mail className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.email}</span>
                  <span className="block text-xs text-muted-foreground">{ROLE_LABEL[i.role]} · invited {relativeTime(i.createdAt)}{i.invitedBy ? ` by ${i.invitedBy.name}` : ''} · expires {formatDateIST(i.expiresAt)}</span>
                </span>
                {can('bid_manager') && (
                  <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === i.id}
                    onClick={() => revoke.mutate(i.id, { onSuccess: () => toast.success('Invitation revoked'), onError: (e) => toast.error(errorMessage(e)) })}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="What each role can do" description="Pick the least access someone needs.">
        <dl className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
            <div key={r} className="rounded-lg border bg-subtle/60 p-3">
              <dt className="flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="size-4 text-primary" />{ROLE_LABEL[r]}</dt>
              <dd className="mt-1 text-[13px] text-muted-foreground">{ROLE_INFO[r]}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <LeaveOrgPanel members={q.data?.items} />

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} allowOwner={isOwner} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.name}?`}
        description="They lose access immediately, and their API tokens for this organization are revoked. Their past activity stays in the log."
        confirmLabel="Remove member" loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId, {
          onSuccess: () => { toast.success(`${removing.name} was removed`); setRemoving(null); },
          onError: (e) => toast.error(errorMessage(e)),
        })} />
    </div>
  );
}

function InviteDialog({ open, onOpenChange, allowOwner }: { open: boolean; onOpenChange: (o: boolean) => void; allowOwner: boolean }) {
  const invite = useInvite();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('analyst');
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setTimeout(() => { setEmail(''); setRole('analyst'); setErr(null); setCreated(null); setCopied(false); invite.reset(); }, 200);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr('Enter a valid email address'); return; }
    setErr(null);
    invite.mutate({ email: email.trim(), role }, {
      onSuccess: (inv) => setCreated(inv),
      onError: (e2) => setErr(fieldErrors(e2).email ?? errorMessage(e2)),
    });
  };
  const roles = (Object.keys(ROLE_LABEL) as Role[]).filter((r) => allowOwner || r !== 'owner');
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        {created ? (
          <>
            <DialogHeader>
              <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-success-soft text-success"><MailPlus className="size-5" /></span>
              <DialogTitle>Invitation sent to {created.email}</DialogTitle>
              <DialogDescription>We emailed the link. You can also share it directly — it works once and expires {formatDateIST(created.expiresAt)}.</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={created.inviteUrl} aria-label="Invite link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={async () => { if (await copyText(created.inviteUrl)) { setCopied(true); toast.success('Invite link copied'); } }}>
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <DialogFooter><Button onClick={() => close(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Invite a teammate</DialogTitle>
              <DialogDescription>They’ll join your organization with the role you choose.</DialogDescription>
            </DialogHeader>
            <Field label="Work email" error={err} required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="priya@yourcompany.in" autoFocus leading={<Mail />} />
            </Field>
            <Field label="Role" hint={ROLE_INFO[role]}>
              <Select value={role} onValueChange={(v) => setRole(v as Role)} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" loading={invite.isPending}>Send invitation</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
