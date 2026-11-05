/** Completeness meter: animated ring + actionable issues that jump to the right section. */
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { CompletenessIssue } from '@tp/core/vault/completeness';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';

export function Ring({ value, size = 76 }: { value: number; size?: number }) {
  const sw = 7, r = (size - sw) / 2, c = 2 * Math.PI * r;
  const tone = value >= 85 ? 'text-success' : value >= 55 ? 'text-warning' : 'text-danger';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Profile ${value}% complete`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw} className="stroke-muted" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw} strokeLinecap="round" stroke="currentColor"
          className={cn(tone, 'transition-[stroke-dashoffset] duration-700 ease-out')} strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular tracking-tight">{value}<span className="text-xs text-muted-foreground">%</span></span>
    </div>
  );
}

const ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;
const TONE = { error: 'text-danger', warning: 'text-warning', info: 'text-info' } as const;

export function CompletenessCard({ percent, issues, onJump, className }: {
  percent: number; issues: CompletenessIssue[]; onJump: (section: string, field: string) => void; className?: string;
}) {
  const shown = issues.slice(0, 6);
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-center gap-4">
        <Ring value={percent} />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{percent >= 100 ? 'Bid-ready profile' : percent >= 85 ? 'Almost there' : percent >= 55 ? 'Good progress' : 'Let’s complete your profile'}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">A complete profile gives more accurate Go/No-Go scores and auto-filled annexures.</p>
        </div>
      </div>
      {shown.length > 0 ? (
        <ul className="mt-4 grid gap-1 border-t pt-3">
          {shown.map((i, k) => {
            const Icon = ICON[i.severity];
            return (
              <li key={k}>
                <button type="button" onClick={() => onJump(i.section, i.field)} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] leading-snug hover:bg-muted focus-ring">
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', TONE[i.severity])} aria-hidden />
                  <span>{i.message}</span>
                </button>
              </li>
            );
          })}
          {issues.length > shown.length && <li className="px-1.5 pt-1 text-xs text-muted-foreground">+{issues.length - shown.length} more suggestions</li>}
        </ul>
      ) : (
        <p className="mt-4 flex items-center gap-2 border-t pt-3 text-[13px] text-[hsl(158_72%_27%)] dark:text-success"><CheckCircle2 className="size-4" aria-hidden />Everything bids usually ask for is in place.</p>
      )}
    </Card>
  );
}
