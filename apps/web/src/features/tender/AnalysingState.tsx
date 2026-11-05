import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, FileSearch, ListChecks, Loader2, Scale, Sparkles, type LucideIcon } from 'lucide-react';
import { Card, Progress } from '@/components/ui';
import { cn } from '@/lib/utils';

const STEPS: { label: string; detail: string; icon: LucideIcon }[] = [
  { label: 'Reading bid document', detail: 'Extracting text page by page from the GeM PDF', icon: FileSearch },
  { label: 'Extracting eligibility', detail: 'Turnover, experience, EMD, MII, documents and ATC clauses', icon: ListChecks },
  { label: 'Comparing with your profile', detail: 'Financials, past contracts, exemptions and your vault', icon: Scale },
  { label: 'Scoring', detail: 'Weighing every factor into a Go / No-Go verdict', icon: Sparkles },
];

/** Engaging, honest progress animation shown while POST /analyse runs (≥ ~2.4 s). */
export function AnalysingState({ withAi }: { withAi?: boolean }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 650);
    return () => clearInterval(t);
  }, []);
  const pct = Math.round(((step + 0.6) / STEPS.length) * 100);

  return (
    <Card className="relative overflow-hidden" aria-live="polite" aria-busy="true">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" aria-hidden />
      <div className="relative grid gap-6 p-6 sm:p-8 md:grid-cols-[180px_1fr] md:items-center">
        <div className="mx-auto flex size-40 items-center justify-center">
          <div className="relative size-36">
            {!reduce && (
              <>
                <motion.span className="absolute inset-0 rounded-full border-2 border-primary/30" animate={{ scale: [1, 1.18], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
                <motion.span className="absolute inset-0 rounded-full border-2 border-primary/20" animate={{ scale: [1, 1.18], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay: 0.8 }} />
              </>
            )}
            <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r="44" fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
              <motion.circle
                cx="50" cy="50" r="44" fill="none" stroke="hsl(var(--primary))" strokeWidth="8" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 44}
                animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - pct / 100) }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.span
                  key={step}
                  initial={reduce ? false : { opacity: 0, y: 6, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.9 }}
                  className="flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary"
                >
                  {(() => { const I = STEPS[step].icon; return <I className="size-5" aria-hidden />; })()}
                </motion.span>
              </AnimatePresence>
              <span className="tabular mt-2 text-xs font-medium text-muted-foreground">{pct}%</span>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight">Analysing this tender…</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {withAi ? 'Deterministic rules first, then AI reads the ATC for anything the rules missed.' : 'Deterministic rules read the standard GeM fields — no AI key needed.'}
          </p>
          <ol className="mt-5 grid gap-3">
            {STEPS.map((s, i) => {
              const done = i < step;
              const active = i === step;
              return (
                <li key={s.label} className={cn('flex items-start gap-3 transition-opacity duration-300', !done && !active && 'opacity-45')}>
                  <span className={cn(
                    'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
                    done && 'border-success bg-success text-white',
                    active && 'border-primary bg-primary-soft text-primary',
                  )}>
                    {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : active ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className={cn('text-sm font-medium', active && 'text-foreground')}>{s.label}{active ? '…' : ''}</div>
                    <div className="text-xs text-muted-foreground">{s.detail}</div>
                  </div>
                </li>
              );
            })}
          </ol>
          <Progress value={pct} size="sm" className="mt-5" aria-label="Analysis progress" />
        </div>
      </div>
    </Card>
  );
}
