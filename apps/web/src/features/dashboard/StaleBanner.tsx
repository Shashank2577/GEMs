/**
 * Stale-data banner (T022; FR-012, US1-14) — shown when a background refresh failed but cached dashboard data exists.
 * Non-blocking: the widgets stay visible; the full-page ErrorState is reserved for "no data at all".
 */
import { CloudOff, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui';
import { istTime } from './summary';

export function StaleBanner({ generatedAt, onRetry, retrying }: { generatedAt: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm">
      <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-foreground">
        Couldn’t refresh — showing data from <time dateTime={generatedAt} className="tabular font-medium">{istTime(generatedAt)} IST</time>
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying}>
        {!retrying && <RotateCw />} Retry
      </Button>
    </div>
  );
}
