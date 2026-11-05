import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { Check, Clock } from 'lucide-react';
import { cn, initials } from '@/lib/utils';
import { countdownParts, formatDateIST } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { Tooltip } from './menu';

// ─── Progress ───
export const Progress = forwardRef<
  ElementRef<typeof ProgressPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { tone?: 'primary' | 'success' | 'warning' | 'danger' | 'auto'; size?: 'sm' | 'md' }
>(({ className, value, tone = 'primary', size = 'md', ...props }, ref) => {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const t = tone === 'auto' ? (v >= 80 ? 'success' : v >= 50 ? 'warning' : 'danger') : tone;
  const bar = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' }[t];
  return (
    <ProgressPrimitive.Root ref={ref} value={v} className={cn('relative w-full overflow-hidden rounded-full bg-muted', size === 'sm' ? 'h-1.5' : 'h-2', className)} {...props}>
      <ProgressPrimitive.Indicator className={cn('h-full rounded-full transition-[width] duration-700 ease-out', bar)} style={{ width: `${v}%` }} />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = 'Progress';

// ─── Avatar ───
const avatarSizes = { xs: 'size-5 text-[9px]', sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-12 text-sm' } as const;
const hues = [243, 199, 158, 33, 330, 268, 12, 180];
function hueFor(s: string) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return hues[h % hues.length]; }

export function Avatar({ name, src, size = 'md', className }: { name?: string | null; src?: string | null; size?: keyof typeof avatarSizes; className?: string }) {
  const hue = hueFor(name ?? '?');
  return (
    <AvatarPrimitive.Root className={cn('relative inline-flex shrink-0 select-none overflow-hidden rounded-full ring-2 ring-background', avatarSizes[size], className)}>
      {src && <AvatarPrimitive.Image src={src} alt={name ?? ''} className="size-full object-cover" />}
      <AvatarPrimitive.Fallback
        className="flex size-full items-center justify-center font-semibold"
        style={{ background: `hsl(${hue} 70% 92%)`, color: `hsl(${hue} 60% 30%)` }}
        title={name ?? undefined}
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function AvatarGroup({ people, max = 4, size = 'sm' }: { people: { name: string; src?: string | null }[]; max?: number; size?: keyof typeof avatarSizes }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((p, i) => <Tooltip key={i} content={p.name}><span><Avatar name={p.name} src={p.src} size={size} /></span></Tooltip>)}
      {rest > 0 && (
        <span className={cn('inline-flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background', avatarSizes[size])}>+{rest}</span>
      )}
    </div>
  );
}

// ─── Kbd ───
export function Kbd({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-card px-1 font-sans text-[10px] font-medium text-muted-foreground', className)}
      {...p}
    />
  );
}

// ─── Countdown ───
/** "Closes in 2d 4h" — rose under 24h, amber under 3 days, "Closed" after. */
export function Countdown({ to, prefix = 'Closes in', className, compact }: { to: string | Date | null | undefined; prefix?: string; className?: string; compact?: boolean }) {
  const now = useNow(30_000);
  const p = countdownParts(to, now);
  if (!p) return <span className={cn('text-muted-foreground', className)}>—</span>;
  const cls = p.closed ? 'text-muted-foreground' : p.urgent ? 'text-danger' : p.soon ? 'text-[hsl(32_90%_36%)] dark:text-warning' : 'text-muted-foreground';
  return (
    <Tooltip content={formatDateIST(to, { time: true })}>
      <span className={cn('tabular inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', cls, className)}>
        <Clock className="size-3.5" aria-hidden />
        {p.closed ? 'Closed' : compact ? p.label : `${prefix} ${p.label}`}
        {p.urgent && <span className="relative ml-0.5 flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-danger" /></span>}
      </span>
    </Tooltip>
  );
}

// ─── Segmented control ───
export function Segmented<T extends string>({
  value, onChange, options, size = 'md', className, 'aria-label': ariaLabel,
}: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode }[];
  size?: 'sm' | 'md'; className?: string; 'aria-label'?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all focus-ring [&_svg]:size-3.5',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Stepper ───
export function Stepper({ steps, current, className, onStepClick }: { steps: { label: ReactNode; description?: ReactNode }[]; current: number; className?: string; onStepClick?: (i: number) => void }) {
  return (
    <ol className={cn('flex w-full items-start gap-2', className)}>
      {steps.map((s, i) => {
        const done = i < current, active = i === current;
        const clickable = onStepClick && i <= current;
        return (
          <li key={i} className="flex min-w-0 flex-1 flex-col gap-2">
            <div className={cn('h-1 rounded-full transition-colors duration-500', done || active ? 'bg-primary' : 'bg-muted')} />
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick?.(i)}
              aria-current={active ? 'step' : undefined}
              className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default focus-ring rounded"
            >
              <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                done ? 'bg-primary text-primary-foreground' : active ? 'border-2 border-primary text-primary' : 'border text-muted-foreground')}>
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn('hidden truncate text-xs font-medium sm:block', active ? 'text-foreground' : 'text-muted-foreground')}>{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" className={cn('shrink-0 bg-border', vertical ? 'h-full w-px' : 'h-px w-full', className)} />;
}
