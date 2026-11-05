/**
 * Global plan dialog (spec 008 FR-041b, NFR-011). Opened by any 402 from the API (`lib/api.ts` → `showPlanLimit`) and by
 * write actions while the trial is expired. Centred 480 px dialog on desktop, bottom sheet with stacked full-width
 * buttons (primary on top) on phones. Focus moves to the title; Esc/Close return focus to the button that triggered it.
 */
import { useEffect, useRef } from 'react';
import { Gauge, Lock } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { DialogContent, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { useMediaQuery } from '@/lib/hooks';
import { SALES_MAILTO, closePlanLimit, usePlanLimitDialog } from '@/lib/plan-limit';
import { cn } from '@/lib/utils';

/** The last button/link the user activated — where focus returns when the dialog closes. */
function useLastTrigger() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button, a, [role="button"], input[type="file"]');
      if (el instanceof HTMLElement && !el.closest('[data-plan-dialog]')) ref.current = el;
    };
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('keydown', remember, true);
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('keydown', remember, true);
    };
  }, []);
  return ref;
}

export function PlanLimitDialog() {
  const live = usePlanLimitDialog();
  // Keep the last content while the close animation runs.
  const last = useRef(live);
  if (live) last.current = live;
  const state = live ?? last.current;
  const wide = useMediaQuery('(min-width: 640px)');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const trigger = useLastTrigger();
  const open = live !== null;

  const focusTitle = (e: Event) => { e.preventDefault(); titleRef.current?.focus(); };
  const returnFocus = (e: Event) => {
    e.preventDefault();
    const el = trigger.current;
    if (el && el.isConnected) el.focus();
  };
  const Icon = state?.code === 'plan_expired' ? Lock : Gauge;

  const body = state && (
    <>
      <div className="flex items-start gap-3">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl',
          state.code === 'plan_expired' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-[hsl(32_90%_32%)] dark:text-warning')}>
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 pr-6">
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">{state.title}</DialogTitle>
          <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">{state.message}</DialogDescription>
          {state.usage && <p className="mt-2 text-[13px] font-medium tabular-nums text-foreground" data-testid="plan-limit-usage">{state.usage}</p>}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
        <Button asChild className="w-full sm:w-auto"><a href={SALES_MAILTO}>Talk to sales</a></Button>
        <Button variant="secondary" className="w-full sm:w-auto" onClick={closePlanLimit}>Close</Button>
      </div>
    </>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) closePlanLimit(); }}>
      {state && (wide ? (
        <DialogContent data-plan-dialog className="max-w-[480px] gap-5" hideClose={false}
          onOpenAutoFocus={focusTitle} onCloseAutoFocus={returnFocus}>
          {body}
        </DialogContent>
      ) : (
        <SheetContent data-plan-dialog side="bottom" className="gap-5 px-5 pb-6 pt-3"
          onOpenAutoFocus={focusTitle} onCloseAutoFocus={returnFocus}>
          {body}
        </SheetContent>
      ))}
    </DialogPrimitive.Root>
  );
}
