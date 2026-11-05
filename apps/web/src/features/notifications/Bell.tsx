/**
 * Notifications bell in the top bar (FR-005): unread badge, latest alerts, mark all read.
 * Default export with no props — rendered by the AppShell.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell as BellIcon, CheckCheck, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useBellNotifications, useMarkAllRead } from './api';
import { NotificationItem } from './NotificationItem';

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const q = useBellNotifications();
  const markAll = useMarkAllRead();
  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];

  // Gentle "ring" when the unread count goes up while the app is open.
  const prev = useRef(unread);
  const [ring, setRing] = useState(false);
  useEffect(() => {
    if (unread > prev.current) { setRing(true); const id = setTimeout(() => setRing(false), 1200); prev.current = unread; return () => clearTimeout(id); }
    prev.current = unread;
  }, [unread]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className="relative">
            <BellIcon className={cn(ring && 'animate-bounce')} />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-foreground ring-2 ring-background tabular" aria-hidden>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" sideOffset={8} className="w-[min(94vw,24rem)] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-2xs font-semibold text-primary tabular">{unread} new</span>}
          </div>
          {unread > 0 && (
            <Button variant="ghost" size="xs" onClick={() => markAll.mutate()} disabled={markAll.isPending} className="text-primary hover:text-primary">
              <CheckCheck />Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[min(70vh,28rem)] overflow-y-auto scrollbar-thin">
          {q.isLoading ? (
            <div className="grid gap-3 p-4">{[0, 1, 2].map((i) => <div key={i} className="flex gap-3"><Skeleton className="size-8 rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></div></div>)}</div>
          ) : q.isError ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">Couldn’t load notifications. <button className="text-primary hover:underline" onClick={() => q.refetch()}>Retry</button></p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success"><CheckCheck className="size-5" /></span>
              <p className="text-sm font-medium">You’re all caught up</p>
              <p className="text-xs text-muted-foreground">New tender matches and expiry reminders will show up here.</p>
            </div>
          ) : (
            <ul className="divide-y" aria-label="Latest notifications">
              {items.map((n) => <li key={n.id}><NotificationItem n={n} compact onNavigate={() => setOpen(false)} /></li>)}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t bg-subtle/60 px-4 py-2.5">
          <Link to="/notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-primary hover:underline focus-ring rounded">View all</Link>
          <Link to="/settings/notifications" onClick={() => setOpen(false)} className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-ring"><Settings2 className="size-3.5" />Alert settings</Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
