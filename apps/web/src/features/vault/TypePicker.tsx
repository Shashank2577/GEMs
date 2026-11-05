/** Searchable document-type picker with descriptions, grouped by category. */
import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { DOC_CATEGORIES, DOC_TYPES, docTypeInfo, type DocType } from '@tp/core/vault/status';
import { Badge, Input, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import { DocTypeIcon } from './doc-ui';

export function TypePicker({ value, onChange, id, 'aria-invalid': invalid, 'aria-describedby': describedBy }: {
  value: DocType; onChange: (t: DocType) => void; id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const info = docTypeInfo(value);
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = DOC_TYPES.filter((d) => !s || d.label.toLowerCase().includes(s) || d.description.toLowerCase().includes(s) || d.keywords.some((k) => k.includes(s)));
    return DOC_CATEGORIES.map((c) => ({ c, items: list.filter((d) => d.category === c) })).filter((g) => g.items.length);
  }, [q]);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <PopoverTrigger asChild>
        <button
          id={id} type="button" aria-invalid={invalid} aria-describedby={describedBy} aria-haspopup="listbox"
          className="flex h-11 w-full items-center gap-2.5 rounded-lg border border-input bg-card px-2.5 text-left text-sm shadow-xs hover:border-foreground/20 focus-ring aria-[invalid=true]:border-danger"
        >
          <DocTypeIcon type={value} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{info.label}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <div className="border-b p-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search document types…" className="h-8 text-[13px]" leading={<Search />} aria-label="Search document types" />
        </div>
        <div className="max-h-80 overflow-y-auto p-1 scrollbar-thin" role="listbox" aria-label="Document type">
          {groups.map((g) => (
            <div key={g.c} className="py-1">
              <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{g.c}</div>
              {g.items.map((d) => (
                <button
                  key={d.type} type="button" role="option" aria-selected={d.type === value}
                  onClick={() => { onChange(d.type); setOpen(false); setQ(''); }}
                  className={cn('flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted focus-ring', d.type === value && 'bg-primary-soft/60')}
                >
                  <DocTypeIcon type={d.type} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium">
                      {d.label}
                      {d.commonInBids && <Badge size="sm" tone="outline" className="font-normal">Common in bids</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{d.description}</span>
                  </span>
                  {d.type === value && <Check className="mt-1 size-4 shrink-0 text-primary" aria-hidden />}
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No matching type — use “Other document”.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
