import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A settings card: title + description on top, body, optional footer with actions. */
export function Panel({ title, description, children, footer, className, aside }: {
  title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; aside?: ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border bg-card shadow-xs', className)}>
      <header className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </header>
      <div className="px-5 py-5">{children}</div>
      {footer && <footer className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t bg-subtle/60 px-5 py-3">{footer}</footer>}
    </section>
  );
}

export function fieldErrors(e: unknown): Record<string, string> {
  const d = (e as { details?: { fields?: Record<string, string> } } | null)?.details;
  return d?.fields ?? {};
}
