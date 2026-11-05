import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { FACTOR_KEYS, FACTOR_LABELS, type FactorKey } from '@tp/core/contracts/analyse';
import { Badge, Button, ErrorState, SkeletonList, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useSaveWeights, useWeights } from '../api';
import { Panel } from './Panel';

const HELP: Record<FactorKey, string> = {
  turnover: 'Your average turnover vs the bid’s minimum (MSE/Startup exemptions applied).',
  experience: 'Years of supplying similar goods/services vs the requirement.',
  similarWork: 'Your largest similar order vs the bid’s similar-work value.',
  emd: 'Earnest money — exempt for registered MSEs, or within your EMD capacity.',
  mii: 'Make in India class and local content vs the bid’s MII clause.',
  oem: 'A valid OEM authorisation (MAF) for the quoted make.',
  certificates: 'ISO, BIS and other certificates the bid asks for.',
  documents: 'Share of required documents already valid in your vault.',
  deliveryFeasibility: 'Delivery location and period vs where you operate.',
  timeToClose: 'Enough time left to prepare a complete packet.',
};

export default function ScoringSection() {
  const { can } = useAuth();
  const q = useWeights();
  const save = useSaveWeights();
  const [w, setW] = useState<Record<FactorKey, number> | null>(null);
  useEffect(() => { if (q.data) setW(q.data.weights); }, [q.data]);
  const total = useMemo(() => (w ? FACTOR_KEYS.reduce((a, k) => a + (w[k] ?? 0), 0) : 0), [w]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!w || !q.data) return <SkeletonList rows={6} />;
  const editable = can('bid_manager');
  const dirty = FACTOR_KEYS.some((k) => w[k] !== q.data!.weights[k]);
  const isDefault = FACTOR_KEYS.every((k) => w[k] === q.data!.defaults[k]);

  return (
    <Panel
      title="Scoring weights"
      description="How much each factor counts towards the 0–100 eligibility score. Weights are relative — the score is normalised, so they don’t have to add up to 100. Blocking failures (e.g. turnover below the minimum) always force No-Go."
      aside={<Badge tone={q.data.custom ? 'primary' : 'neutral'}>{q.data.custom ? 'Custom' : 'Default'} weights</Badge>}
      footer={editable ? (
        <>
          <Button variant="ghost" disabled={isDefault} onClick={() => setW(q.data!.defaults)}><RotateCcw /> Reset to default</Button>
          <Button disabled={!dirty || total === 0} loading={save.isPending}
            onClick={() => save.mutate(isDefault ? {} : w, { onSuccess: () => toast.success('Scoring weights saved', { description: 'New analyses use them; re-run an analysis to rescore it.' }), onError: (e) => toast.error(errorMessage(e)) })}>
            Save weights
          </Button>
        </>
      ) : <span className="text-xs text-muted-foreground">Only Bid Managers and Owners can change scoring weights.</span>}>
      <div className="mb-5 flex items-center justify-between rounded-lg bg-subtle px-4 py-3">
        <span className="text-sm font-medium">Total weight</span>
        <span className={cn('tabular text-lg font-semibold', total === 0 && 'text-danger')}>{total}</span>
      </div>
      <ul className="grid gap-5">
        {FACTOR_KEYS.map((k) => {
          const share = total ? Math.round((w[k] / total) * 100) : 0;
          const id = `w-${k}`;
          return (
            <li key={k} className="grid gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-sm font-medium">{FACTOR_LABELS[k]}</label>
                <span className="tabular shrink-0 text-xs text-muted-foreground"><span className="text-sm font-semibold text-foreground">{w[k]}</span> · {share}% of score</span>
              </div>
              <input id={id} type="range" min={0} max={50} step={1} value={w[k]} disabled={!editable}
                onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })}
                aria-describedby={`${id}-help`}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-60" />
              <p id={`${id}-help`} className="text-xs text-muted-foreground">
                {HELP[k]}{w[k] !== q.data!.defaults[k] && <span className="ml-1 text-primary">Default {q.data!.defaults[k]}.</span>}
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
