import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDocumentTitle } from '@/lib/hooks';

export interface Crumb { label: ReactNode; to?: string }

export function PageHeader({
  title, description, actions, breadcrumbs, eyebrow, className, docTitle,
}: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: Crumb[]; eyebrow?: ReactNode; className?: string;
  /** Browser tab title; defaults to `title` when it is a string. */
  docTitle?: string;
}) {
  useDocumentTitle(docTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className={cn('mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
              {breadcrumbs.map((c, i) => (
                <Fragment key={i}>
                  {i > 0 && <ChevronRight className="size-3.5 opacity-60" aria-hidden />}
                  <li className="truncate">
                    {c.to ? <Link to={c.to} className="rounded hover:text-foreground focus-ring">{c.label}</Link> : <span aria-current="page" className="text-foreground/80">{c.label}</span>}
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
        )}
        {eyebrow && <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-primary">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3', className)}>
      {(title || actions) && (
        <div className="flex items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
