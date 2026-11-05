import { useNavigate } from 'react-router-dom';
import type { TenderListItem } from '@tp/core/contracts/identify';
import { Badge, Countdown, ScoreRing, StageBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, VerdictBadge } from '@/components/ui';
import { formatINR, formatNumberIN } from '@/lib/format';
import type { Stage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarkSeen } from './api';
import { buyerLine, locationLine, reasonChips } from './TenderCard';

/** Dense table view for Bid Managers / Analysts on desktop (cards are used below md). */
export function TenderTable({ items }: { items: TenderListItem[] }) {
  const navigate = useNavigate();
  const markSeen = useMarkSeen();
  const open = (t: TenderListItem) => {
    if (t.isNew) markSeen.mutate(t.id);
    navigate(`/tenders/${t.id}`);
  };
  return (
    <Table wrapperClassName="rounded-xl border bg-card shadow-xs">
      <TableHeader>
        <TableRow className="bg-subtle hover:bg-subtle">
          <TableHead className="w-[42%]">Tender</TableHead>
          <TableHead>Buyer</TableHead>
          <TableHead className="text-right">EMD</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead>Closes</TableHead>
          <TableHead className="text-center">Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((t) => {
          const buyer = buyerLine(t);
          const { chips } = reasonChips(t, 2);
          return (
            <TableRow
              key={t.id}
              interactive
              tabIndex={0}
              onClick={() => open(t)}
              onKeyDown={(e) => { if (e.key === 'Enter') open(t); }}
              className={cn(t.isNew && 'bg-primary-soft/40')}
              aria-label={`${t.title}, ${t.bidNumber}`}
            >
              <TableCell className="max-w-0">
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  {t.isNew && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />}
                  <span className="font-mono text-[11.5px]">{t.bidNumber}</span>
                  {t.hasCorrigendum && <Badge size="sm" tone="warning">Corrigendum</Badge>}
                  {t.workspace && <StageBadge stage={t.workspace.stage as Stage} size="sm" />}
                </div>
                <p className="mt-0.5 truncate font-medium">{t.title}</p>
                {chips.length > 0 && <p className="truncate text-2xs text-primary">{chips.join(' · ')}</p>}
              </TableCell>
              <TableCell className="max-w-[220px]">
                <p className="truncate text-[13px]">{buyer.primary}</p>
                <p className="truncate text-2xs text-muted-foreground">{locationLine(t) ?? buyer.secondary ?? '—'}</p>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular text-[13px]">{t.emdAmount === 0 ? 'Nil' : formatINR(t.emdAmount, { compact: true })}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular text-[13px]">{formatINR(t.estimatedValue, { compact: true })}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular text-[13px]">{formatNumberIN(t.quantity)}</TableCell>
              <TableCell className="whitespace-nowrap"><Countdown to={t.endAt} compact className="text-[13px]" /></TableCell>
              <TableCell>
                <div className="flex items-center justify-center gap-2">
                  {t.analysis?.score != null ? (
                    <>
                      <ScoreRing score={t.analysis.score} verdict={t.analysis.verdict ?? undefined} size={30} animate={false} />
                      {t.analysis.verdict && <VerdictBadge verdict={t.analysis.verdict} size="sm" showIcon={false} />}
                    </>
                  ) : <span className="text-2xs text-muted-foreground">—</span>}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
