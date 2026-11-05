/** Shared presentational bits for vault documents: type icon, expiry badge, status copy. */
import {
  Award, BadgeCheck, Banknote, BookOpen, Building2, Calculator, ClipboardCheck, CreditCard, File, FileSpreadsheet, FileText, Flag,
  FlaskConical, Handshake, Landmark, PenLine, Percent, Receipt, Rocket, ShieldCheck, type LucideIcon,
} from 'lucide-react';
import type { DocStatus } from '@tp/core/vault/status';
import { docTypeInfo, type DocCategory } from '@tp/core/vault/status';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  Award, BadgeCheck, Banknote, BookOpen, Building2, Calculator, ClipboardCheck, CreditCard, File, FileSpreadsheet, FileText, Flag,
  FlaskConical, Handshake, Landmark, PenLine, Percent, Receipt, Rocket, ShieldCheck,
};

export const CATEGORY_TONE: Record<DocCategory, string> = {
  Statutory: 'bg-primary-soft text-primary',
  Financial: 'bg-success-soft text-success',
  Experience: 'bg-info-soft text-info',
  OEM: 'bg-accent-soft text-accent',
  Quality: 'bg-warning-soft text-warning',
  Other: 'bg-muted text-muted-foreground',
};

export function DocTypeIcon({ type, className, size = 'md' }: { type: string; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const info = docTypeInfo(type);
  const Icon = ICONS[info.icon] ?? File;
  const box = { sm: 'size-7 rounded-md [&_svg]:size-3.5', md: 'size-10 rounded-lg [&_svg]:size-[18px]', lg: 'size-12 rounded-xl [&_svg]:size-5' }[size];
  return (
    <span className={cn('flex shrink-0 items-center justify-center', box, CATEGORY_TONE[info.category], className)} aria-hidden>
      <Icon />
    </span>
  );
}

export function statusLabel(status: DocStatus, days: number | null): string {
  if (status === 'expired') return days != null ? `Expired ${Math.abs(days)}d ago` : 'Expired';
  if (status === 'expiring') return days === 0 ? 'Expires today' : `Expires in ${days}d`;
  return days == null ? 'No expiry' : 'Valid';
}

export function ExpiryBadge({ status, days, size = 'sm', className }: { status: DocStatus; days: number | null; size?: 'sm' | 'md'; className?: string }) {
  const tone = status === 'expired' ? 'danger' : status === 'expiring' ? 'warning' : 'success';
  return <Badge tone={tone} size={size} dot className={className}>{statusLabel(status, days)}</Badge>;
}

export const STATUS_LABEL: Record<DocStatus, string> = { valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired' };
