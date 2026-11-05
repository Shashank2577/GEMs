import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, CircleHelp, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STAGE_LABEL, VERDICT_LABEL, type Stage, type Verdict } from '@/lib/types';
import { Badge, type BadgeProps, type BadgeTone } from './badge';

export const verdictTone: Record<Verdict, BadgeTone> = { go: 'success', review: 'warning', no_go: 'danger' };
export const verdictColor: Record<Verdict, string> = {
  go: 'hsl(var(--success))', review: 'hsl(var(--warning))', no_go: 'hsl(var(--danger))',
};
/** Default thresholds: ≥70 Go, 45–69 Review, <45 No-Go (the scorer's verdict wins when provided). */
export function verdictFromScore(score: number): Verdict {
  return score >= 70 ? 'go' : score >= 45 ? 'review' : 'no_go';
}

export function VerdictBadge({ verdict, size = 'md', className, showIcon = true }: { verdict: Verdict; size?: BadgeProps['size']; className?: string; showIcon?: boolean }) {
  const Icon = verdict === 'go' ? CheckCircle2 : verdict === 'review' ? CircleHelp : XCircle;
  return (
    <Badge tone={verdictTone[verdict]} size={size} className={cn('font-semibold', className)}>
      {showIcon && <Icon aria-hidden />}
      {VERDICT_LABEL[verdict]}
    </Badge>
  );
}

const stageTone: Record<Stage, BadgeTone> = {
  identified: 'neutral', analysing: 'info', go: 'success', preparing: 'primary', ready: 'accent',
  submitted: 'primary', won: 'success', lost: 'danger', dropped: 'neutral',
};
export function StageBadge({ stage, size = 'md', className }: { stage: Stage; size?: BadgeProps['size']; className?: string }) {
  return <Badge tone={stageTone[stage]} size={size} dot className={className}>{STAGE_LABEL[stage]}</Badge>;
}

/** Animated SVG score ring (0–100), colored by verdict. */
export function ScoreRing({
  score, verdict, size = 64, stroke, label, className, animate = true,
}: {
  score: number | null | undefined; verdict?: Verdict; size?: number; stroke?: number; label?: string; className?: string; animate?: boolean;
}) {
  const reduce = useReducedMotion();
  const has = typeof score === 'number' && Number.isFinite(score);
  const value = has ? Math.max(0, Math.min(100, Math.round(score as number))) : 0;
  const v = verdict ?? (has ? verdictFromScore(value) : undefined);
  const sw = stroke ?? Math.max(4, Math.round(size / 11));
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(animate && !reduce ? 0 : value);
  useEffect(() => {
    if (!animate || reduce) { setShown(value); return; }
    let raf = 0; const start = performance.now(); const from = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (value - from) * e));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, animate, reduce]);
  const color = v ? verdictColor[v] : 'hsl(var(--muted-foreground))';
  return (
    <div
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={has ? `${label ?? 'Eligibility score'} ${value} of 100${v ? `, ${VERDICT_LABEL[v]}` : ''}` : 'Not scored yet'}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={sw} />
        {has && (
          <motion.circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: animate && !reduce ? c : c * (1 - value / 100) }}
            animate={{ strokeDashoffset: c * (1 - value / 100) }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="tabular font-semibold tracking-tight" style={{ fontSize: Math.max(11, size * 0.3), color: has ? undefined : 'hsl(var(--muted-foreground))' }}>
          {has ? shown : '–'}
        </span>
        {label && size >= 88 && <span className="mt-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>}
      </span>
    </div>
  );
}
