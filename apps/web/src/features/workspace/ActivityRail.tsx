import { useState } from 'react';
import { MessageSquare, MoreHorizontal, Send, Trash2 } from 'lucide-react';
import type { WorkspaceDetail } from '@tp/core/contracts/apply';
import { Avatar, Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Kbd, Textarea, toast } from '@/components/ui';
import { RoleGate, useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useComment, useDeleteComment } from './api';
import { describeActivity } from './labels';

export function ActivityRail({ data }: { data: WorkspaceDetail }) {
  const [body, setBody] = useState('');
  const comment = useComment(data.workspace.id);
  const del = useDeleteComment(data.workspace.id);
  const { me, can } = useAuth();
  const [deleting, setDeleting] = useState<string | null>(null);
  const post = () => {
    const b = body.trim();
    if (!b) return;
    comment.mutate(b, { onSuccess: () => setBody(''), onError: (e) => toast.error(errorMessage(e)) });
  };
  return (
    <div className="grid grid-cols-1 gap-5">
      <section aria-labelledby="ws-comments">
        <h2 id="ws-comments" className="mb-3 flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4 text-muted-foreground" aria-hidden /> Discussion <span className="text-muted-foreground">{data.comments.length || ''}</span></h2>
        <ol className="grid grid-cols-1 gap-3">
          {data.comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.user.name} size="sm" />
              <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border bg-card px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold">{c.user.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <time dateTime={c.createdAt} title={formatDateIST(c.createdAt, { time: true })} className="text-2xs text-muted-foreground">{relativeTime(c.createdAt)}</time>
                    {(c.user.id === me?.user.id || can('bid_manager')) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Comment actions for ${c.user.name}`} className="-my-1 size-6"><MoreHorizontal /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem destructive onSelect={() => setDeleting(c.id)}><Trash2 />Delete comment</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{c.body}</p>
              </div>
            </li>
          ))}
          {!data.comments.length && <li className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No comments yet. Coordinate who is chasing which document.</li>}
        </ol>
        <RoleGate min="analyst">
          <div className="mt-3 rounded-xl border bg-card p-2 focus-within:ring-2 focus-within:ring-ring">
            <Textarea
              value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Write a comment…" aria-label="Write a comment"
              className="min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}
            />
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="hidden text-2xs text-muted-foreground sm:inline"><Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send</span>
              <Button size="xs" onClick={post} loading={comment.isPending} disabled={!body.trim()} className="ml-auto"><Send /> Comment</Button>
            </div>
          </div>
        </RoleGate>
        <ConfirmDialog
          open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} loading={del.isPending} confirmLabel="Delete comment"
          title="Delete this comment?" description="It will be removed from the discussion for everyone on this bid."
          onConfirm={() => deleting && del.mutate(deleting, { onSuccess: () => { toast.success('Comment deleted'); setDeleting(null); }, onError: (e) => toast.error(errorMessage(e)) })}
        />
      </section>

      <section aria-labelledby="ws-activity">
        <h2 id="ws-activity" className="mb-3 text-sm font-semibold">Activity</h2>
        <ol className="relative grid gap-3 border-l pl-4">
          {data.activity.filter((a) => a.action !== 'workspace.commented').slice(0, 30).map((a) => (
            <li key={a.id} className="relative text-[13px]">
              <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary/70" aria-hidden />
              <span className="font-medium">{a.user?.name ?? 'TenderPilot'}</span> <span className="text-muted-foreground">{describeActivity(a)}</span>
              <div className="text-2xs text-muted-foreground" title={formatDateIST(a.createdAt, { time: true })}>{relativeTime(a.createdAt)}</div>
            </li>
          ))}
          {!data.activity.length && <li className="text-xs text-muted-foreground">Nothing yet.</li>}
        </ol>
      </section>
    </div>
  );
}
