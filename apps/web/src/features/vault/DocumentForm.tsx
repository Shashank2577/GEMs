/** Metadata form shared by the upload dialog and the preview drawer. */
import { useMemo } from 'react';
import { CalendarClock, Sparkles } from 'lucide-react';
import { docTypeInfo, suggestExpiry, type DocType } from '@tp/core/vault/status';
import { fyLabelForDate, fyStartYear, fyLabel } from '@tp/core/vault/validators';
import { Button, Field, Input, Select } from '@/components/ui';
import { formatDateIST } from '@/lib/format';
import { ChipInput } from '@/features/watchlists/ChipInput';
import { TypePicker } from './TypePicker';

export interface DocDraft {
  type: DocType; title: string; number: string; issuer: string; issueDate: string; expiryDate: string; financialYear: string; tags: string[];
}

export const emptyDraft = (type: DocType = 'other'): DocDraft => ({ type, title: '', number: '', issuer: '', issueDate: '', expiryDate: '', financialYear: '', tags: [] });

const NUMBER_LABEL: Partial<Record<DocType, string>> = {
  gst: 'GSTIN', pan: 'PAN', udyam: 'Udyam number', startup_dpiit: 'DPIIT number', incorporation: 'CIN / registration no.',
  iso: 'Certificate number', bis: 'Licence number', oem_authorization: 'Reference no.', crac: 'CRAC / contract no.', work_order: 'Order number',
  ca_turnover_certificate: 'UDIN',
};

/** Client-side checks mirroring the API (server errors are merged in by the caller). */
export function validateDraft(d: DocDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.title.trim()) e.title = 'Give the document a title';
  if (d.issueDate && d.expiryDate && d.expiryDate < d.issueDate) e.expiryDate = 'Expiry date is before the issue date';
  return e;
}

export function DocumentForm({ draft, onChange, errors, compact }: {
  draft: DocDraft; onChange: (d: DocDraft) => void; errors: Record<string, string>; compact?: boolean;
}) {
  const info = docTypeInfo(draft.type);
  const set = <K extends keyof DocDraft>(k: K, v: DocDraft[K]) => onChange({ ...draft, [k]: v });
  const suggestion = !draft.expiryDate ? suggestExpiry(draft.type, draft.issueDate || null) : null;
  const fyOptions = useMemo(() => {
    const cur = fyStartYear(fyLabelForDate(new Date()))!;
    const list = Array.from({ length: 7 }, (_, i) => fyLabel(cur - i));
    if (draft.financialYear && !list.includes(draft.financialYear)) list.push(draft.financialYear);
    return [{ value: '__none', label: 'Not applicable' }, ...list.map((fy) => ({ value: fy, label: `FY ${fy}` }))];
  }, [draft.financialYear]);

  return (
    <div className="grid gap-4">
      <Field label="Document type" required error={errors.type} hint={info.description}>
        <TypePicker value={draft.type} onChange={(t) => set('type', t)} />
      </Field>
      <Field label="Title" required error={errors.title}>
        <Input value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder={`e.g. ${info.label}`} maxLength={200} />
      </Field>
      <div className={compact ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}>
        <Field label={NUMBER_LABEL[draft.type] ?? 'Document number'} error={errors.number}>
          <Input value={draft.number} onChange={(e) => set('number', e.target.value)} placeholder="Optional" className="font-mono text-[13px]" />
        </Field>
        <Field label="Issued by" error={errors.issuer}>
          <Input value={draft.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="e.g. GSTN, TÜV, Dell India" />
        </Field>
        <Field label="Issue date" error={errors.issueDate}>
          <Input type="date" value={draft.issueDate} onChange={(e) => set('issueDate', e.target.value)} max="2100-12-31" />
        </Field>
        <Field
          label="Expiry date"
          error={errors.expiryDate}
          hint={info.expires ? (draft.expiryDate ? undefined : 'This type usually expires — add the date to get reminders 30, 7 and 1 day before.') : 'Leave empty if it never expires.'}
        >
          <Input type="date" value={draft.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} min={draft.issueDate || undefined} max="2100-12-31" />
        </Field>
      </div>
      {suggestion && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary-soft/50 px-3 py-2 text-xs">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          <span className="flex-1">{info.label}s are typically valid for {info.typicalValidityMonths! >= 12 ? `${info.typicalValidityMonths! / 12} year${info.typicalValidityMonths! > 12 ? 's' : ''}` : `${info.typicalValidityMonths} months`}.</span>
          <Button type="button" size="xs" variant="secondary" onClick={() => set('expiryDate', suggestion)}><CalendarClock />Use {formatDateIST(suggestion)}</Button>
        </div>
      )}
      <div className={compact ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}>
        {(info.perFinancialYear || draft.financialYear) && (
          <Field label="Financial year" error={errors.financialYear} hint="Balance sheets, ITRs and CA certificates belong to a year.">
            <Select value={draft.financialYear || '__none'} onValueChange={(v) => set('financialYear', v === '__none' ? '' : v)} options={fyOptions} />
          </Field>
        )}
        <Field label="Tags" error={errors.tags} hint="Press Enter to add" className={info.perFinancialYear || draft.financialYear ? '' : 'sm:col-span-2'}>
          <ChipInput value={draft.tags} onChange={(t) => set('tags', t)} placeholder="e.g. Dell, laptops" tone="neutral" max={20} />
        </Field>
      </div>
    </div>
  );
}
