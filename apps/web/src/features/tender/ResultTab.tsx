/** Result tab (003/US6, FR-062): GeM evaluation status, bidder table with the L1 row highlighted, and the winner-not-lowest note. */
import { ExternalLink, Hourglass, TriangleAlert, Trophy } from 'lucide-react';
import type { ResultBidderDto, TenderResultDto } from '@tp/core/contracts/identify';
import { Badge, Card, CardContent, EmptyState, ErrorState, SkeletonList } from '@/components/ui';
import { formatDateIST, formatINR } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTenderResult } from './api';
import { anomalyNote, checkWindowCopy, EVALUATION_TONE, isPublished, lastCheckFailedCopy, NOT_PUBLISHED_COPY } from './result';

export function ResultTab({ tenderId }: { tenderId: string }) {
  const q = useTenderResult(tenderId);
  if (q.isLoading) return <div aria-busy="true" aria-label="Loading result"><SkeletonList rows={4} /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const r = q.data!;
  const failed = lastCheckFailedCopy(r);
  const published = isPublished(r);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-base font-semibold tracking-tight">Evaluation status</h2>
        <Badge tone={EVALUATION_TONE[r.evaluationStatus]} size="lg" data-testid="evaluation-status">{r.evaluationLabel}</Badge>
        {r.fetchedAt && <span className="text-xs text-muted-foreground">Read from GeM {formatDateIST(r.fetchedAt, { time: true })}</span>}
      </div>

      {failed && (
        <div role="status" data-testid="result-check-failed" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft/60 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[hsl(32_90%_36%)] dark:text-warning" aria-hidden />
          <p>{failed}</p>
        </div>
      )}

      {published ? <Published r={r} /> : (
        <EmptyState
          icon={Hourglass}
          title="Result not published yet"
          body={<><span data-testid="result-pending">{NOT_PUBLISHED_COPY}</span>{checkWindowCopy(r.checkUntil) && <span className="mt-1 block">{checkWindowCopy(r.checkUntil)}</span>}</>}
        />
      )}
    </div>
  );
}

function Published({ r }: { r: TenderResultDto }) {
  const note = anomalyNote(r);
  return (
    <>
      {note && (
        <div role="note" data-testid="result-anomaly" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft/60 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[hsl(32_90%_36%)] dark:text-warning" aria-hidden />
          <p>{note}</p>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          <div className="hidden md:block">
            <table className="w-full border-collapse text-sm">
              <caption className="px-4 py-3 text-left text-sm font-semibold">
                Bidders ({r.bidders.length}) <span className="font-normal text-muted-foreground">· in GeM’s rank order</span>
              </caption>
              <thead className="bg-subtle">
                <tr className="border-y text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="h-10 px-4">Rank</th>
                  <th scope="col" className="h-10 px-4">Seller</th>
                  <th scope="col" className="h-10 px-4 text-right">Quoted price</th>
                  <th scope="col" className="h-10 px-4">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {r.bidders.map((b) => (
                  <tr key={`${b.rank}-${b.seller}`} data-l1={b.level === 'L1' || undefined} data-awarded={b.awarded || undefined} className={cn('border-b last:border-0', rowTone(b))}>
                    <td className="px-4 py-3 align-middle"><LevelBadge b={b} /></td>
                    <th scope="row" className="px-4 py-3 text-left align-middle font-medium">{b.seller}</th>
                    <td className="tabular px-4 py-3 text-right align-middle">{formatINR(b.price)}</td>
                    <td className="px-4 py-3 align-middle"><Outcome b={b} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="md:hidden">
            <h3 className="px-4 py-3 text-sm font-semibold">Bidders ({r.bidders.length})</h3>
            <ul className="grid grid-cols-1 border-t">
              {r.bidders.map((b) => (
                <li key={`${b.rank}-${b.seller}`} data-l1={b.level === 'L1' || undefined} data-awarded={b.awarded || undefined} className={cn('grid gap-1.5 border-b px-4 py-3 last:border-0', rowTone(b))}>
                  <div className="flex flex-wrap items-center gap-2"><LevelBadge b={b} /><Outcome b={b} /></div>
                  <div className="break-words font-medium">{b.seller}</div>
                  <div className="tabular text-sm"><span className="text-muted-foreground">Quoted price </span>{formatINR(b.price)}</div>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
      {r.sourceUrl && (
        <p className="text-sm">
          {/* Visible text is the accessible name (WCAG 2.5.3); the new-tab hint is decorative. */}
          <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded font-medium text-primary-ink underline-offset-4 hover:underline focus-ring">
            View the result on GeM <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </p>
      )}
    </>
  );
}

const rowTone = (b: ResultBidderDto) => (b.awarded ? 'bg-success-soft/50' : b.level === 'L1' ? 'bg-primary-soft/50' : '');

function LevelBadge({ b }: { b: ResultBidderDto }) {
  return <Badge tone={b.level === 'L1' ? 'primary' : 'neutral'} size="md">{b.level}</Badge>;
}

function Outcome({ b }: { b: ResultBidderDto }) {
  return b.awarded
    ? <Badge tone="success"><Trophy /> Awarded</Badge>
    : <span className="text-muted-foreground">—</span>;
}
