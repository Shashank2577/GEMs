/** Rupee amount input: digits only, Indian grouping as you type, compact lakh/crore read-out. */
import { forwardRef, useEffect, useState } from 'react';
import { Input } from '@/components/ui';
import { formatINRCompact } from '@/lib/format';
import { cn } from '@/lib/utils';

const group = (n: number | null) => (n == null ? '' : new Intl.NumberFormat('en-IN').format(n));

export const RupeeInput = forwardRef<HTMLInputElement, {
  value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; className?: string; id?: string;
  allowNegative?: boolean; showCompact?: boolean; disabled?: boolean; 'aria-label'?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
}>(({ value, onChange, placeholder, className, allowNegative, showCompact = true, ...rest }, ref) => {
  const [text, setText] = useState(group(value ?? null));
  useEffect(() => {
    const parsed = text.replace(/[^\d-]/g, '');
    if ((parsed === '' ? null : Number(parsed)) !== (value ?? null)) setText(group(value ?? null));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative">
      <Input
        ref={ref} inputMode="numeric" autoComplete="off" value={text} placeholder={placeholder ?? '0'}
        leading={<span className="text-sm font-medium">₹</span>}
        className={cn('tabular', showCompact && 'pr-16', className)}
        onChange={(e) => {
          let raw = e.target.value.replace(allowNegative ? /[^\d-]/g : /[^\d]/g, '');
          if (allowNegative) raw = raw.replace(/(?!^)-/g, '');
          if (raw === '' || raw === '-') { setText(raw); onChange(null); return; }
          const n = Math.min(Number(raw), 1e15);
          setText(group(n));
          onChange(n);
        }}
        {...rest}
      />
      {showCompact && value != null && Math.abs(value) >= 1e5 && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">{formatINRCompact(value)}</span>
      )}
    </div>
  );
});
RupeeInput.displayName = 'RupeeInput';
