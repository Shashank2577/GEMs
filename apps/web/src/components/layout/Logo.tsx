import { useId } from 'react';
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  const gid = `tp-logo-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="hsl(243 80% 62%)" />
          <stop offset="1" stopColor="hsl(246 70% 34%)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${gid})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="none" stroke="white" strokeOpacity="0.16" />
      <path d="M9 21.5 16 8l7 13.5-7-3.2z" fill="white" />
      <path d="M16 18.3 23 21.5 16 24z" fill="hsl(36 98% 56%)" />
    </svg>
  );
}

export function Logo({ className, collapsed, size = 'md' }: { className?: string; collapsed?: boolean; size?: 'md' | 'lg' }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className={size === 'lg' ? 'size-9' : 'size-7'} />
      {!collapsed && (
        <span className={cn('font-semibold tracking-tight', size === 'lg' ? 'text-lg' : 'text-[15px]')}>
          Tender<span className="text-primary-ink">Pilot</span>
        </span>
      )}
    </span>
  );
}
