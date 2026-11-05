import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RotateCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api';
import { Button } from './button';

export function EmptyState({
  icon: Icon = Inbox, title, body, action, secondaryAction, className, compact,
}: {
  icon?: LucideIcon; title: ReactNode; body?: ReactNode; action?: ReactNode; secondaryAction?: ReactNode; className?: string; compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed bg-subtle text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      <div className="relative mb-4">
        <div className="absolute inset-0 -m-3 rounded-full bg-primary/10 blur-xl" aria-hidden />
        <div className="relative flex size-12 items-center justify-center rounded-xl border bg-card shadow-sm">
          <Icon className="size-5 text-primary" aria-hidden />
        </div>
      </div>
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      {body && <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{body}</p>}
      {(action || secondaryAction) && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}{secondaryAction}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'We couldn’t load this', error, body, onRetry, retrying, className, compact,
}: {
  title?: ReactNode; error?: unknown; body?: ReactNode; onRetry?: () => void; retrying?: boolean; className?: string; compact?: boolean;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center rounded-xl border border-danger/20 bg-danger-soft/50 text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-danger/20 bg-card shadow-sm">
        <AlertTriangle className="size-5 text-danger" aria-hidden />
      </div>
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{body ?? (error ? errorMessage(error) : 'Please try again in a moment.')}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry} loading={retrying}>
          {!retrying && <RotateCw />} Try again
        </Button>
      )}
    </div>
  );
}
