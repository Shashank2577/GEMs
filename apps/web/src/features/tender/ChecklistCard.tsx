import { useState } from 'react';
import { ChevronDown, FileCheck2, Sparkles, Upload } from 'lucide-react';
import type { ChecklistItem } from '@tp/core/contracts/analyse';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';
import { DOC_TYPE_LABEL, docTypeIcon } from './labels';

/** "Required documents" checklist produced by the analysis (FR-015). */
export function ChecklistCard({ items, hasWorkspace }: { items: ChecklistItem[]; hasWorkspace: boolean }) {
  const [showOptional, setShowOptional] = useState(false);
  const mandatory = items.filter((i) => i.mandatory);
  const optional = items.filter((i) => !i.mandatory);
  const generated = items.filter((i) => i.generated).length;

  return (
    <Card className="xl:sticky xl:top-20">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2"><FileCheck2 className="size-4 text-primary" aria-hidden /> Required documents</CardTitle>
          <Badge tone="neutral" size="sm" className="tabular">{mandatory.length}</Badge>
        </div>
        <CardDescription>
          {mandatory.length} to submit · {generated} we generate for you.{' '}
          {hasWorkspace ? 'Map them to your vault in the bid workspace.' : 'Start a bid to auto-match them with your vault.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="px-5 pb-5"><EmptyState compact title="No documents identified" body="Re-analyse after uploading the ATC or corrigendum." /></div>
        ) : (
          <>
            <ul className="divide-y border-t">
              {mandatory.map((i) => <Row key={i.id} item={i} />)}
            </ul>
            {optional.length > 0 && (
              <div className="border-t">
                <button type="button" onClick={() => setShowOptional((o) => !o)} aria-expanded={showOptional} className="flex w-full items-center justify-between px-5 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 focus-ring">
                  Optional & informational ({optional.length})
                  <ChevronDown className={cn('size-3.5 transition-transform', showOptional && 'rotate-180')} aria-hidden />
                </button>
                {showOptional && <ul className="divide-y border-t">{optional.map((i) => <Row key={i.id} item={i} />)}</ul>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ item }: { item: ChecklistItem }) {
  const Icon = docTypeIcon(item.docType, item.generated);
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', item.generated ? 'bg-accent-soft text-[hsl(26_90%_38%)] dark:text-accent' : 'bg-primary-soft text-primary')}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-snug">{item.label}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.reason}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {item.generated ? (
            <Tooltip content="TenderPilot fills this annexure from your company profile — review and sign it.">
              <span><Badge tone="accent" size="sm"><Sparkles aria-hidden /> Generated</Badge></span>
            </Tooltip>
          ) : item.docType ? (
            <Badge tone="outline" size="sm"><Upload aria-hidden /> {DOC_TYPE_LABEL[item.docType] ?? item.docType}</Badge>
          ) : (
            <Badge tone="neutral" size="sm">Action on GeM</Badge>
          )}
          {!item.mandatory && <Badge tone="neutral" size="sm">Optional</Badge>}
        </div>
      </div>
    </li>
  );
}
