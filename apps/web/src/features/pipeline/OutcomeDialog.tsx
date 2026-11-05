/**
 * "Record the result" (T031, T033; 007/FR-030): opens after a successful move to Won or Lost. L1 price, our price
 * (whole rupees) and notes (≤ 2000) are all optional; "Save" sends PATCH { outcome }, "Skip" keeps the stage-only
 * outcome the API already recorded. When GeM has published the result, a "Use L1 from GeM" link pre-fills the L1
 * field — a suggestion only; the user decides. Prices here are records for analytics and never go to GeM.
 */
import { useEffect, useState } from 'react';
import { Trophy, XCircle } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Textarea, toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { useRecordOutcome, useResultHint } from './api';
import { NOTES_MAX, outcomePayload, parseRupees, type OutcomeForm } from './moves';

export interface OutcomeTarget { id: string; tenderId: string; title: string; result: 'won' | 'lost' }

const EMPTY: OutcomeForm = { l1: '', ours: '', notes: '' };

export function OutcomeDialog({ target, onClose }: { target: OutcomeTarget | null; onClose: () => void }) {
  const [form, setForm] = useState<OutcomeForm>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof OutcomeForm, string>>>({});
  const save = useRecordOutcome();
  const hint = useResultHint(target?.tenderId ?? null);

  useEffect(() => { setForm(EMPTY); setErrors({}); }, [target?.id]);

  if (!target) return null;
  const won = target.result === 'won';
  const set = (k: keyof OutcomeForm) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const amountHint = (s: string) => { const n = parseRupees(s); return n !== null && Number.isFinite(n) ? formatINR(n) : undefined; };
  const gemL1 = hint.data?.available && hint.data.l1Price ? hint.data.l1Price : null;

  const submit = () => {
    const p = outcomePayload(target.result, form);
    if (!p.ok) { setErrors(p.errors); return; }
    save.mutate({ id: target.id, outcome: p.outcome }, {
      onSuccess: () => { toast.success('Result recorded', { description: won ? 'Congratulations on the win!' : 'Noted — the L1 price helps you price the next bid.' }); onClose(); },
      onError: (e) => toast.error('Couldn’t save the result', { description: errorMessage(e) }),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm" aria-describedby="outcome-desc">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {won ? <Trophy className="size-5 text-success" aria-hidden /> : <XCircle className="size-5 text-danger" aria-hidden />}
            Record the result
          </DialogTitle>
          <DialogDescription id="outcome-desc">
            {won ? 'Marked as won' : 'Marked as lost'}: “{target.title}”. All fields are optional — prices are for your records and win-rate insights only; TenderPilot never enters prices on GeM.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label="L1 price (₹)" error={errors.l1}
            hint={amountHint(form.l1) ?? 'The lowest price GeM disclosed after the bid'}
            labelAside={gemL1 ? (
              <button type="button" className="rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-ring"
                onClick={() => set('l1')(String(gemL1))}>
                Use L1 from GeM: {formatINR(gemL1)}
              </button>
            ) : undefined}>
            <Input inputMode="numeric" autoComplete="off" value={form.l1} onChange={(e) => set('l1')(e.target.value)} placeholder="29,50,000" />
          </Field>
          <Field label="Our price (₹)" error={errors.ours} hint={amountHint(form.ours)}>
            <Input inputMode="numeric" autoComplete="off" value={form.ours} onChange={(e) => set('ours')(e.target.value)} placeholder="30,10,000" />
          </Field>
          <Field label="Notes" error={errors.notes} hint={`${form.notes.length}/${NOTES_MAX}`}>
            <Textarea rows={3} value={form.notes} maxLength={NOTES_MAX} onChange={(e) => set('notes')(e.target.value)}
              placeholder={won ? 'e.g. Won on price; delivery in 30 days' : 'e.g. L1 was 4% below us; MII preference applied'} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Skip</Button>
            <Button type="submit" variant={won ? 'success' : 'primary'} loading={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
