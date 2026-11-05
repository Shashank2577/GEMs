import { useNavigate } from 'react-router-dom';
import { AtSign, BellRing, CalendarClock, Info, Mail, MessageCircle, ShieldAlert, Sparkles, UserPlus, type LucideIcon } from 'lucide-react';
import type { NotificationDto } from '@tp/core/contracts/identify';
import { Tooltip } from '@/components/ui';
import { formatDateIST, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMarkRead } from './api';

const KIND: Record<NotificationDto['kind'], { icon: LucideIcon; cls: string; label: string }> = {
  tender_match: { icon: Sparkles, cls: 'bg-primary-soft text-primary', label: 'New match' },
  deadline: { icon: CalendarClock, cls: 'bg-warning-soft text-[hsl(32_90%_32%)] dark:text-warning', label: 'Deadline' },
  expiry: { icon: ShieldAlert, cls: 'bg-danger-soft text-danger', label: 'Document expiry' },
  assignment: { icon: UserPlus, cls: 'bg-info-soft text-info', label: 'Assignment' },
  mention: { icon: AtSign, cls: 'bg-info-soft text-info', label: 'Mention' },
  digest: { icon: BellRing, cls: 'bg-muted text-muted-foreground', label: 'Digest' },
  system: { icon: Info, cls: 'bg-muted text-muted-foreground', label: 'System' },
};

const DELIVERY_TEXT: Record<string, string> = {
  sent: 'delivered', pending: 'queued', skipped: 'not sent', failed: 'failed', read: 'delivered',
};

export function DeliveryChips({ n }: { n: NotificationDto }) {
  if (!n.deliveries.length) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {n.deliveries.map((d) => {
        const Icon = d.channel === 'email' ? Mail : MessageCircle;
        const tone = d.status === 'sent' ? 'text-success' : d.status === 'failed' ? 'text-danger' : 'text-muted-foreground';
        const label = `${d.channel === 'email' ? 'Email' : 'WhatsApp'} ${DELIVERY_TEXT[d.status] ?? d.status}`;
        return (
          <Tooltip key={d.channel} content={d.error ? `${label} — ${d.error}` : d.sentAt ? `${label} · ${formatDateIST(d.sentAt, { time: true })}` : label}>
            <span className={cn('inline-flex items-center gap-0.5 text-2xs', tone)} aria-label={label}>
              <Icon className="size-3" aria-hidden />{DELIVERY_TEXT[d.status] ?? d.status}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

export function NotificationItem({ n, compact, onNavigate }: { n: NotificationDto; compact?: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const k = KIND[n.kind] ?? KIND.system;
  const open = () => {
    if (!n.read) markRead.mutate(n.id);
    if (n.link) { navigate(n.link); onNavigate?.(); }
  };
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'group flex w-full items-start gap-3 text-left transition-colors focus-ring',
        compact ? 'px-4 py-3 hover:bg-muted/60' : 'rounded-xl border bg-card p-4 shadow-xs hover:border-foreground/15',
        !n.read && (compact ? 'bg-primary-soft/30' : 'border-primary/25'),
      )}
      aria-label={`${n.read ? '' : 'Unread: '}${n.title}`}
    >
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', k.cls)}><k.icon className="size-4" aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn('line-clamp-2 text-[13px] leading-snug', n.read ? 'font-medium text-foreground/85' : 'font-semibold')}>{n.title}</span>
          {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
        </span>
        <span className={cn('mt-0.5 block text-xs text-muted-foreground', compact ? 'line-clamp-2' : 'line-clamp-3')}>{n.body}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <Tooltip content={`${formatDateIST(n.createdAt, { time: true })} IST`}><span>{relativeTime(n.createdAt)}</span></Tooltip>
          {!compact && <span>{k.label}</span>}
          <DeliveryChips n={n} />
        </span>
      </span>
    </button>
  );
}
