import { useMemo, useState } from 'react';
import { Bot, Cpu, ListChecks, PenLine, Search } from 'lucide-react';
import type { AnalysisDto, Requirement } from '@tp/core/contracts/analyse';
import { Badge, Card, EmptyState, Input, ResponsiveTable, Tooltip, type Column } from '@/components/ui';
import { cn } from '@/lib/utils';
import { PageChip } from './AnalysisPanel';
import { REQ_GROUPS, formatRequirementValue } from './labels';

function MethodBadge({ m }: { m: Requirement['method'] }) {
  if (m === 'LLM') return <Badge tone="accent" size="sm"><Bot aria-hidden /> AI</Badge>;
  if (m === 'MANUAL') return <Badge tone="primary" size="sm"><PenLine aria-hidden /> Manual</Badge>;
  return <Badge tone="neutral" size="sm"><Cpu aria-hidden /> Rule</Badge>;
}

function ConfidenceBar({ v }: { v: number }) {
  const pct = Math.round(v * 100);
  const tone = pct >= 85 ? 'bg-success' : pct >= 65 ? 'bg-warning' : 'bg-danger';
  return (
    <span className="inline-flex items-center gap-2" aria-label={`${pct}% confidence`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"><span className={cn('block h-full rounded-full', tone)} style={{ width: `${pct}%` }} /></span>
      <span className="tabular text-xs text-muted-foreground">{pct}%</span>
    </span>
  );
}

/** Every extracted requirement with value, provenance, method and confidence (FR-012). */
export function RequirementsTab({ analysis, tenderId }: { analysis: AnalysisDto | null; tenderId: string }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    if (!analysis) return [];
    const needle = q.trim().toLowerCase();
    const rows = analysis.requirements.filter((r) => !needle || `${r.label} ${String(r.value ?? '')} ${r.source.quote ?? ''}`.toLowerCase().includes(needle));
    const used = new Set<Requirement>();
    return REQ_GROUPS.map((g) => {
      const items = rows.filter((r) => !used.has(r) && g.match(r));
      items.forEach((r) => used.add(r));
      return { ...g, items };
    }).filter((g) => g.items.length);
  }, [analysis, q]);

  if (!analysis || analysis.status !== 'done') {
    return <EmptyState icon={ListChecks} title="No requirements yet" body="Run the analysis to extract eligibility criteria, EMD, ePBG, exemptions and the documents the buyer asks for." />;
  }

  const columns: Column<Requirement>[] = [
    {
      key: 'label', header: 'Requirement', primary: true, className: 'w-[34%]',
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium">
            {r.label}
            {r.mandatory && <Tooltip content="Mandatory for eligibility"><span className="size-1.5 rounded-full bg-danger" aria-label="mandatory" /></Tooltip>}
          </div>
          {r.source.quote && <p className="mt-0.5 line-clamp-1 text-xs font-normal text-muted-foreground md:max-w-[320px]" title={r.source.quote}>“{r.source.quote}”</p>}
        </div>
      ),
    },
    { key: 'value', header: 'Value', className: 'w-[26%]', cell: (r) => <span className="tabular font-medium">{formatRequirementValue(r)}</span> },
    { key: 'source', header: 'Source', className: 'w-[10%]', cell: (r) => (r.source.page ? <PageChip tenderId={tenderId} req={r} /> : <span className="text-xs text-muted-foreground">{r.source.quote ? 'Listing' : '—'}</span>) },
    { key: 'method', header: 'Method', className: 'w-[10%]', cell: (r) => <MethodBadge m={r.method} /> },
    { key: 'confidence', header: 'Confidence', className: 'w-[14%]', cell: (r) => <ConfidenceBar v={r.confidence} /> },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {analysis.requirements.length} requirements extracted · {analysis.requirements.filter((r) => r.method === 'RULE').length} by rules
          {analysis.requirements.some((r) => r.method === 'LLM') && ` · ${analysis.requirements.filter((r) => r.method === 'LLM').length} by AI`}
        </p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter requirements…" leading={<Search />} className="sm:w-64" aria-label="Filter requirements" />
      </div>
      {groups.length === 0 && <EmptyState compact icon={Search} title="Nothing matches" body={`No requirement mentions “${q}”.`} />}
      {groups.map((g) => (
        <section key={g.key} className="grid gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{g.label} <span className="tabular font-normal">({g.items.length})</span></h3>
          <Card className="overflow-hidden md:p-0">
            <ResponsiveTable columns={columns} rows={g.items} rowKey={(r) => `${r.key}:${String(r.value)}:${r.label}`} className="[&_ul]:p-2" />
          </Card>
        </section>
      ))}
    </div>
  );
}
