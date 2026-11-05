import { forwardRef, type HTMLAttributes, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }>(
  ({ className, wrapperClassName, ...props }, ref) => (
    <div className={cn('scrollbar-thin relative w-full overflow-x-auto rounded-xl border bg-card', wrapperClassName)}>
      <table ref={ref} className={cn('w-full caption-bottom border-collapse text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = ({ className, ...p }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-subtle [&_tr]:border-b', className)} {...p} />
);
export const TableBody = ({ className, ...p }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('[&_tr:last-child]:border-0', className)} {...p} />
);
export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }>(
  ({ className, interactive, ...p }, ref) => (
    <tr ref={ref} className={cn('border-b transition-colors data-[state=selected]:bg-primary-soft', interactive && 'cursor-pointer hover:bg-muted/50', className)} {...p} />
  ),
);
TableRow.displayName = 'TableRow';
export const TableHead = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-10 whitespace-nowrap px-4 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground', className)} {...p} />
);
export const TableCell = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-4 py-3 align-middle', className)} {...p} />
);

/**
 * Responsive helper: a real table from `md` up, stacked cards below.
 * `columns[].primary` marks the field shown as the card title on mobile.
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hidden in the mobile card view */
  hideOnMobile?: boolean;
  /** Card title on mobile. Its cell is wrapped in a button there, so it must be non-interactive phrasing content (no links/buttons/inputs). */
  primary?: boolean;
}

export function ResponsiveTable<T>({
  columns, rows, rowKey, onRowClick, className, empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  className?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  return (
    <div className={className}>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>{columns.map((c) => <TableHead key={c.key} className={c.className}>{c.header}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={rowKey(r)}
                interactive={!!onRowClick}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
              >
                {columns.map((c) => <TableCell key={c.key} className={c.className}>{c.cell(r)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid gap-2 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            {/*
              The card itself is not a button: cells may hold their own controls (e.g. a row-actions menu), and an
              interactive element inside role=button is an axe `nested-interactive` violation (#493). Keyboard and
              screen-reader users get a real <button> on the card title; its click (mouse, Enter or Space) bubbles to
              the card's handler, which also keeps "tap anywhere on the card" working. Controls inside cells keep
              stopping propagation as before.
            */}
            <div
              data-row-card=""
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn('rounded-xl border bg-card p-4 shadow-xs', onRowClick && 'cursor-pointer active:bg-muted/50')}
            >
              {onRowClick ? (
                <button type="button" data-row-open="" className="block w-full min-w-0 rounded-md text-left font-medium focus-ring">{primary.cell(r)}</button>
              ) : (
                <div className="font-medium">{primary.cell(r)}</div>
              )}
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {columns.filter((c) => c !== primary && !c.hideOnMobile).map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{c.header}</dt>
                    <dd className="mt-0.5 truncate">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
