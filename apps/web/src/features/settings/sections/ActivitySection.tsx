import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import { Avatar, Button, EmptyState, ErrorState, Label, Select, SkeletonList, Tooltip } from '@/components/ui';
import { formatDateIST, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { describeActivity, SELF_CONTAINED } from '@/features/dashboard/activity';
import { useActivity, useMembers } from '../api';
import { activityObject, activityParams, ACTIVITY_PAGE_SIZE, ACTIVITY_TYPES, ALL, pageCount, rangeLabel } from '../activity-log';
import { Panel } from './Panel';

/** Org audit trail (002/FR-043, FR-044): newest first, filter by member and type, 25 per page. */
export default function ActivitySection() {
  const now = useNow(30_000);
  const [page, setPage] = useState(1);
  const [member, setMember] = useState(ALL);
  const [type, setType] = useState(ALL);
  const members = useMembers();
  const lastPage = useRef(1);
  const q = useActivity(activityParams({ page, member, type }));
  const filtered = member !== ALL || type !== ALL;
  const total = q.data?.total ?? 0;
  // While the next page loads (keepPreviousData) the list still belongs to the previous page.
  const shownPage = q.isPlaceholderData ? lastPage.current : page;
  if (!q.isPlaceholderData) lastPage.current = page;
  const pages = pageCount(total);

  const change = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };
  const memberOptions = [{ value: ALL, label: 'Everyone' }, ...(members.data?.items ?? []).map((m) => ({ value: m.userId, label: m.name }))];

  return (
    <Panel title="Activity log" description="Who changed what in your organization, newest first. Times are shown in IST."
      aside={
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="grid gap-1">
            <Label htmlFor="activity-member">Member</Label>
            <Select id="activity-member" className="sm:w-44" value={member} onValueChange={change(setMember)} options={memberOptions} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="activity-type">Type</Label>
            <Select id="activity-type" className="sm:w-48" value={type} onValueChange={change(setType)} options={ACTIVITY_TYPES} />
          </div>
        </div>
      }
      footer={q.data ? (
        <>
          <span className="mr-auto text-[13px] text-muted-foreground" aria-live="polite">{rangeLabel(shownPage, q.data.items.length, total)}</span>
          {total > 0 && (
            <>
              <Button variant="secondary" size="sm" disabled={page <= 1 || q.isPlaceholderData} onClick={() => setPage(page - 1)}><ChevronLeft /> Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= pages || q.isPlaceholderData} onClick={() => setPage(page + 1)}>Next <ChevronRight /></Button>
            </>
          )}
        </>
      ) : undefined}>
      {q.isError ? <ErrorState compact error={q.error} onRetry={() => q.refetch()} />
        : !q.data ? <SkeletonList rows={6} />
        : q.data.items.length === 0 ? (
          <EmptyState compact icon={History} title="No activity yet"
            body={filtered ? 'Nothing matches these filters.' : 'Changes made by your team will appear here.'} />
        ) : (
          <ol className={`grid divide-y transition-opacity ${q.isPlaceholderData ? 'opacity-60' : ''}`} aria-busy={q.isPlaceholderData} aria-label={`Activity, page ${shownPage} of ${pages}, ${ACTIVITY_PAGE_SIZE} per page`}>
            {q.data.items.map((a) => {
              const obj = SELF_CONTAINED.has(a.action) ? null : activityObject(a);
              return (
                <li key={a.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <Avatar name={a.user?.name ?? 'TenderPilot'} size="sm" />
                  <div className="min-w-0 flex-1 text-[13px] leading-snug">
                    <p className="break-words text-muted-foreground">
                      <span className="font-medium text-foreground">{a.user?.name ?? 'TenderPilot'}</span>{' '}
                      {describeActivity(a)}
                      {obj && <>{' '}<span className="font-medium text-foreground">{obj}</span></>}
                    </p>
                    <Tooltip content={formatDateIST(a.createdAt, { time: true })}>
                      <time tabIndex={0} title={formatDateIST(a.createdAt, { time: true })} className="rounded-sm text-2xs text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" dateTime={a.createdAt}>{relativeTime(a.createdAt, now)}</time>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
    </Panel>
  );
}
