import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, Search, X } from 'lucide-react';
import { Checkbox, Input, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Tag input: type and press Enter / comma to add; Backspace removes the last chip; paste a
 * comma/newline separated list to add many. Optional suggestions appear as you type.
 */
export function ChipInput({
  value, onChange, placeholder, suggestions = [], tone = 'primary', validate, id, 'aria-label': ariaLabel, max = 50,
  'aria-invalid': ariaInvalid, 'aria-describedby': describedBy,
}: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; tone?: 'primary' | 'danger' | 'neutral';
  validate?: (s: string) => string | null; id?: string; 'aria-label'?: string; max?: number; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const add = (raw: string) => {
    const parts = raw.split(/[,\n;]+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) {
      const err = validate?.(p) ?? null;
      if (err) { setError(err); continue; }
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase()) && next.length < max) next.push(p);
    }
    onChange(next);
    setText('');
  };

  const sugg = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t) return [];
    return suggestions.filter((s) => s.toLowerCase().includes(t) && !value.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 6);
  }, [text, suggestions, value]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const chipTone = {
    primary: 'border-primary/20 bg-primary-soft text-primary',
    danger: 'border-danger/20 bg-danger-soft text-danger',
    neutral: 'border-border bg-muted text-foreground',
  }[tone];

  return (
    <div className="relative">
      <div
        className={cn(
          'flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 shadow-xs transition-[border-color,box-shadow]',
          focused && 'border-ring ring-4 ring-ring/15',
          (error || ariaInvalid) && 'border-danger',
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((v) => (
          <span key={v} className={cn('inline-flex h-6 max-w-full items-center gap-1 rounded-md border pl-2 pr-1 text-xs font-medium', chipTone)}>
            <span className="truncate">{v}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== v)); }} className="rounded p-0.5 opacity-70 hover:bg-black/5 hover:opacity-100 focus-ring" aria-label={`Remove ${v}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); if (text.trim()) add(text); }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[,\n;]/.test(t)) { e.preventDefault(); add(t); }
          }}
          placeholder={value.length ? '' : placeholder}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid || !!error || undefined}
          aria-describedby={describedBy}
          aria-autocomplete="list"
          aria-controls={sugg.length ? listId : undefined}
          className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {sugg.length > 0 && focused && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
          {sugg.map((s) => (
            <li key={s} role="option" aria-selected={false}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); add(s); }} className="w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted">{s}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

/** Searchable multi-select in a popover (states, ministries). */
export function MultiSelect({
  options, value, onChange, placeholder, label, id,
}: { options: string[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; id?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const all = useMemo(() => [...new Set([...value, ...options])], [options, value]);
  const shown = q ? all.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : all;
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div className="grid gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs hover:border-foreground/20 focus-ring"
            aria-label={`${value.length ? `${value.length} selected` : placeholder}, ${label}`}
          >
            <span className={cn('truncate', !value.length && 'text-muted-foreground')}>
              {value.length ? `${value.length} selected` : placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0">
          <div className="border-b p-2">
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} className="h-8 text-[13px]" leading={<Search />} aria-label={`Search ${label}`} />
          </div>
          <ul className="max-h-64 overflow-y-auto p-1 scrollbar-thin" role="listbox" aria-multiselectable aria-label={label}>
            {shown.map((o) => {
              const on = value.includes(o);
              return (
                <li key={o} role="option" aria-selected={on}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
                    <Checkbox checked={on} onCheckedChange={() => toggle(o)} />
                    <span className="flex-1 truncate">{o}</span>
                    {on && <Check className="size-3.5 text-primary" />}
                  </label>
                </li>
              );
            })}
            {!shown.length && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                {q ? <button type="button" className="text-primary hover:underline" onClick={() => { toggle(q.trim()); setQ(''); }}>Add “{q.trim()}”</button> : 'No options'}
              </li>
            )}
          </ul>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <span key={v} className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted pl-2 pr-1 text-xs font-medium">
              {v}
              <button type="button" onClick={() => toggle(v)} className="rounded p-0.5 opacity-70 hover:opacity-100 focus-ring" aria-label={`Remove ${v}`}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
