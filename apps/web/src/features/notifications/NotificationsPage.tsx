/** Notifications inbox (FR-005): all / unread, grouped by IST day, with email & WhatsApp delivery status. */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BellOff, CheckCheck, Inbox, Settings2 } from 'lucide-react';
import type { NotificationDto } from '@tp/core/contracts/identify';
import { Button, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, toast } from '@/components/ui';
import { formatDateIST, pluralize } from '@/lib/format';
import { useMarkAllRead, useNotificationList } from './api';
import { NotificationItem } from './NotificationItem';

const istDayKey = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

function dayLabel(key: string, now = new Date()) {
  const today = istDayKey(now.toISOString());
  const yesterday = istDayKey(new Date(now.getTime() - 86_400_000).toISOString());
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return formatDateIST(`${key}T06:30:00.000Z`);
}

function groupByDay(items: NotificationDto[]) {
  const groups: { key: string; items: NotificationDto[] }[] = [];
  for (const n of items) {
    const key = istDayKey(n.createdAt);
    const g = groups.at(-1);
    if (g && g.key === key) g.items.push(n);
    else groups.push({ key, items: [n] });
  }
  return groups;
}

export default function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'unread' ? 'unread' : 'all';
  const q = useNotificationList(tab === 'unread');
  const markAll = useMarkAllRead();
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const unread = q.data?.pages[0]?.unreadCount ?? 0;
  const groups = useMemo(() => groupByDay(items), [items]);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="New tender matches, corrigenda and reminders. Email and WhatsApp delivery is shown on each alert."
        actions={
          <>
            <Button variant="ghost" size="sm" asChild><Link to="/settings/notifications"><Settings2 />Alert settings</Link></Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!unread || markAll.isPending}
              onClick={() => markAll.mutate(undefined, { onSuccess: (r) => toast.success(`Marked ${pluralize(r.updated, 'notification')} as read`) })}
            >
              <CheckCheck />Mark all read
            </Button>
          </>
        }
      />

      <div className="mb-4 flex max-w-3xl items-center justify-between gap-3">
        <Segmented
          aria-label="Filter notifications"
          value={tab}
          onChange={(v) => setParams(v === 'unread' ? { tab: 'unread' } : {}, { replace: true })}
          options={[{ value: 'all', label: 'All' }, { value: 'unread', label: <>Unread{unread > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground tabular">{unread}</span>}</> }]}
        />
      </div>

      <div className="max-w-3xl">
        {q.isLoading ? (
          <div className="grid grid-cols-1 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isRefetching} />
        ) : items.length === 0 ? (
          tab === 'unread' ? (
            <EmptyState icon={CheckCheck} title="You’re all caught up" body="No unread notifications. New matches will appear here and in the bell." action={<Button variant="secondary" onClick={() => setParams({})}>See all notifications</Button>} />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No notifications yet"
              body="When a new GeM bid matches one of your watchlists, you’ll see it here — and on email or WhatsApp if you turn those on."
              action={<Button asChild><Link to="/watchlists">Set up watchlists</Link></Button>}
              secondaryAction={<Button variant="ghost" asChild><Link to="/settings/notifications"><BellOff />Alert settings</Link></Button>}
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-6">
            {groups.map((g) => (
              <section key={g.key} aria-labelledby={`day-${g.key}`}>
                <h2 id={`day-${g.key}`} className="sticky top-14 z-[1] mb-2 bg-background/85 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">{dayLabel(g.key)}</h2>
                <ul className="grid grid-cols-1 gap-2">
                  {g.items.map((n) => <li key={n.id}><NotificationItem n={n} /></li>)}
                </ul>
              </section>
            ))}
            {q.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load older</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
