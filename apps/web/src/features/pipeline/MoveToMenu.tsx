/**
 * "Move to…" menu on every pipeline card (T030; 007/FR-029, NFR-004 / WCAG 2.2 2.5.7): a single-pointer and
 * keyboard alternative to dragging. Radix dropdown (arrow keys, Enter/Space, Escape, touch). Choosing a stage
 * calls the same move handler as drag-and-drop (same PATCH, toasts and error handling).
 */
import { Fragment } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { StageName } from '@tp/core/contracts/apply';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import { moveTargets } from './moves';

export function MoveToMenu({ title, stage, onMove, className }: { title: string; stage: StageName; onMove: (to: StageName) => void; className?: string }) {
  const targets = moveTargets(stage);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Move to… (${title})`}
        title="Move to…"
        className={cn('flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-ring data-[state=open]:bg-muted data-[state=open]:text-foreground', className)}>
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuLabel>Move to…</DropdownMenuLabel>
        {targets.map((t) => (
          <Fragment key={t.stage}>
            {t.stage === 'dropped' && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={t.disabled} destructive={t.stage === 'dropped'} onSelect={() => onMove(t.stage)}>
              {t.label}
              {t.hint && <span className="ml-auto text-2xs text-muted-foreground">{t.hint}</span>}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
