import { useEffect, useState, type FormEvent } from 'react';
import { Lock, Phone, UserRound } from 'lucide-react';
import { Button, Field, Input, toast } from '@/components/ui';
import { toE164IndianMobile } from '@tp/core/vault/validators';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PasswordInput } from '@/features/auth/PasswordInput';
import { useChangePassword, useUpdateMe } from '../api';
import { Panel, fieldErrors } from './Panel';

/** "+919822012345" → "98220 12345" for display. */
export const displayMobile = (e164: string | null | undefined) => (e164?.startsWith('+91') ? `${e164.slice(3, 8)} ${e164.slice(8)}` : e164 ?? '');

export default function AccountSection() {
  const { me } = useAuth();
  const update = useUpdateMe();
  const pw = useChangePassword();
  const [name, setName] = useState(me?.user.name ?? '');
  const [phone, setPhone] = useState(displayMobile(me?.user.phone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwErr, setPwErr] = useState<Record<string, string>>({});
  useEffect(() => { setName(me?.user.name ?? ''); setPhone(displayMobile(me?.user.phone)); }, [me?.user.name, me?.user.phone]);
  if (!me) return null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Required';
    const e164 = phone.trim() ? toE164IndianMobile(phone) : null;
    if (phone.trim() && !e164) errs.phone = 'Enter a 10-digit Indian mobile number starting with 6–9';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    update.mutate({ name: name.trim(), phone: e164 }, {
      onSuccess: () => toast.success('Profile saved'),
      onError: (e2) => { setErrors(fieldErrors(e2)); toast.error(errorMessage(e2)); },
    });
  };

  const changePw = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) { setPwErr({ newPassword: 'Use at least 8 characters' }); return; }
    setPwErr({});
    pw.mutate({ currentPassword: cur, newPassword: next }, {
      onSuccess: () => { setCur(''); setNext(''); toast.success('Password changed', { description: 'Other devices have been signed out.' }); },
      onError: (e2) => { setPwErr(fieldErrors(e2)); toast.error(errorMessage(e2)); },
    });
  };

  return (
    <div className="grid gap-6">
      <form onSubmit={save} noValidate>
        <Panel title="Your account" description="Your mobile number is used only for WhatsApp alerts you switch on."
          footer={<Button type="submit" loading={update.isPending}>Save</Button>}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Full name" error={errors.name} required>
              <Input value={name} onChange={(e) => setName(e.target.value)} leading={<UserRound />} autoComplete="name" />
            </Field>
            <Field label="Email" hint="Contact your org owner to change it.">
              <Input value={me.user.email} readOnly className="text-muted-foreground" />
            </Field>
            <Field label="Mobile (WhatsApp)" error={errors.phone} hint="Indian mobile, e.g. 98220 12345">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} leading={<Phone />} inputMode="tel" autoComplete="tel-national" placeholder="98220 12345" />
            </Field>
          </div>
        </Panel>
      </form>
      <form onSubmit={changePw} noValidate>
        <Panel title="Password" description="Changing your password signs you out everywhere else."
          footer={<Button type="submit" variant="secondary" loading={pw.isPending} disabled={!cur || !next}><Lock /> Change password</Button>}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Current password" error={pwErr.currentPassword}>
              <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password" error={pwErr.newPassword} hint="At least 8 characters">
              <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </Panel>
      </form>
    </div>
  );
}
