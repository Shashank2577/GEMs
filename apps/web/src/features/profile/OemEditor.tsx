/** OEM / manufacturer authorisations (MAF) — each optionally linked to a vault document. */
import { Handshake, Plus, Trash2 } from 'lucide-react';
import type { OemAuthorizationDto } from '@tp/core/contracts/vault';
import { docStatus } from '@tp/core/vault/status';
import { Button, Field, Input, Select } from '@/components/ui';
import { useVault } from '@/features/vault/api';
import { ExpiryBadge } from '@/features/vault/doc-ui';

export function OemEditor({ value, onChange, errors, disabled }: {
  value: OemAuthorizationDto[]; onChange: (v: OemAuthorizationDto[]) => void; errors: Record<string, string>; disabled?: boolean;
}) {
  const docs = useVault({ type: 'oem_authorization' });
  const options = [{ value: '__none', label: 'Not linked' }, ...(docs.data?.items ?? []).map((d) => ({ value: d.id, label: d.title }))];
  const update = (i: number, patch: Partial<OemAuthorizationDto>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const now = new Date();
  return (
    <div className="grid gap-3">
      {value.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed bg-subtle px-4 py-4 text-sm text-muted-foreground">
          <Handshake className="size-5 shrink-0 text-primary" aria-hidden />
          <p>Reselling branded products? Add each manufacturer authorisation — bids for OEM items usually require a valid MAF.</p>
        </div>
      )}
      {value.map((r, i) => {
        const st = r.validTill ? docStatus(r.validTill, now) : null;
        return (
          <div key={i} className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_10rem_1fr_2.5rem] lg:items-end">
            <Field label="OEM" required error={errors[`oemAuthorizations.${i}.oem`]}>
              <Input value={r.oem} disabled={disabled} onChange={(e) => update(i, { oem: e.target.value })} placeholder="e.g. Dell India" />
            </Field>
            <Field label="Products covered" error={errors[`oemAuthorizations.${i}.products`]}>
              <Input value={r.products} disabled={disabled} onChange={(e) => update(i, { products: e.target.value })} placeholder="e.g. Latitude laptops, OptiPlex desktops" />
            </Field>
            <Field label="Valid till" id={`f-oemAuthorizations.${i}.validTill`} error={errors[`oemAuthorizations.${i}.validTill`]} hint={st ? <ExpiryBadge status={st.status} days={st.daysToExpiry} /> : undefined}>
              <Input type="date" value={r.validTill ?? ''} disabled={disabled} onChange={(e) => update(i, { validTill: e.target.value || null })} />
            </Field>
            <Field label="Vault document" id={`f-oemAuthorizations.${i}.documentId`}>
              <Select value={r.documentId ?? '__none'} disabled={disabled} onValueChange={(v) => update(i, { documentId: v === '__none' ? null : v })} options={options} />
            </Field>
            <div className="flex justify-end lg:pb-0.5">
              {!disabled && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${r.oem || 'authorisation'}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 /></Button>}
            </div>
          </div>
        );
      })}
      {!disabled && (
        <div><Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { oem: '', products: '', validTill: null, documentId: null }])}><Plus />Add OEM authorisation</Button></div>
      )}
    </div>
  );
}
