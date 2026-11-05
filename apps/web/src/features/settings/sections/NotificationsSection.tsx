import { useEffect, useState, type ReactNode } from 'react';
import { BellRing, CalendarClock, Mail, MessageCircle, Phone } from 'lucide-react';
import type { NotificationPrefs } from '@tp/core/contracts/auth';
import { toE164IndianMobile } from '@tp/core/vault/validators';
import { Button, ErrorState, Field, Input, Segmented, SkeletonList, Switch, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrefs, useSavePrefs, useUpdateMe } from '../api';
import { displayMobile } from './AccountSection';
import { Panel } from './Panel';

function Row({ icon, title, description, children, htmlFor }: { icon: ReactNode; title: string; description: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm font-medium">{title}</label>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0 pt-1">{children}</div>
    </div>
  );
}

export default function NotificationsSection() {
  const { me } = useAuth();
  const q = usePrefs();
  const save = useSavePrefs();
  const updateMe = useUpdateMe();
  const [p, setP] = useState<NotificationPrefs | null>(null);
  const [phone, setPhone] = useState(displayMobile(me?.user.phone));
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  useEffect(() => { if (q.data) setP(q.data); }, [q.data]);
  useEffect(() => setPhone(displayMobile(me?.user.phone)), [me?.user.phone]);

  if (q.isLoading || !p) return q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <SkeletonList rows={4} />;
  const set = <K extends keyof NotificationPrefs>(k: K, v: NotificationPrefs[K]) => setP({ ...p, [k]: v });
  const phoneE164 = phone.trim() ? toE164IndianMobile(phone) : null;
  const dirty = JSON.stringify(p) !== JSON.stringify(q.data) || (phoneE164 ?? null) !== (me?.user.phone ?? null);

  const submit = async () => {
    if (p.whatsapp && !phoneE164) { setPhoneErr('Add a valid 10-digit mobile number to get WhatsApp alerts'); return; }
    if (phone.trim() && !phoneE164) { setPhoneErr('Enter a 10-digit Indian mobile number starting with 6–9'); return; }
    setPhoneErr(null);
    try {
      if ((phoneE164 ?? null) !== (me?.user.phone ?? null)) await updateMe.mutateAsync({ phone: phoneE164 });
      await save.mutateAsync(p);
      toast.success('Notification preferences saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Panel title="Notifications" description="Choose how TenderPilot tells you about new matches, deadlines and expiring documents. These settings are personal."
      footer={<Button onClick={submit} disabled={!dirty} loading={save.isPending || updateMe.isPending}>Save preferences</Button>}>
      <div className="divide-y">
        <Row htmlFor="n-inapp" icon={<BellRing />} title="In-app" description="The bell in the top bar and the Notifications page.">
          <Switch id="n-inapp" checked={p.inApp} onCheckedChange={(v) => set('inApp', v)} />
        </Row>
        <Row htmlFor="n-email" icon={<Mail />} title="Email" description={<>To {me?.user.email}. Instant alerts or one tidy daily digest.</>}>
          <Switch id="n-email" checked={p.email} onCheckedChange={(v) => set('email', v)} />
        </Row>
        <div className="py-4">
          <div className="flex items-start gap-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success"><MessageCircle className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <label htmlFor="n-wa" className="text-sm font-medium">WhatsApp</label>
              <p className="mt-0.5 text-[13px] text-muted-foreground">Bid-closing reminders and high-relevance matches on your phone. Perfect for owners on the move.</p>
            </div>
            <div className="shrink-0 pt-1"><Switch id="n-wa" checked={p.whatsapp} onCheckedChange={(v) => { set('whatsapp', v); setPhoneErr(null); }} /></div>
          </div>
          {(p.whatsapp || phone) && (
            <div className="mt-3 sm:pl-[52px]">
              <Field label="WhatsApp number" error={phoneErr} hint={phoneE164 ? `We’ll message ${phoneE164}` : 'Indian mobile, e.g. 98220 12345'}>
                <Input value={phone} onChange={(e) => { setPhone(e.target.value); setPhoneErr(null); }} leading={<Phone />} inputMode="tel" placeholder="98220 12345" className="sm:max-w-xs" />
              </Field>
            </div>
          )}
        </div>
        <Row htmlFor="n-freq" icon={<CalendarClock />} title="Match alerts" description="Instant sends each new match as it’s found. Daily digest sends one summary at 8 AM IST.">
          <Segmented aria-label="Alert frequency" size="sm" value={p.frequency} onChange={(v) => set('frequency', v)}
            options={[{ value: 'instant', label: 'Instant' }, { value: 'daily', label: 'Daily' }]} />
        </Row>
        <Row htmlFor="n-exp" icon={<CalendarClock />} title="Expiry reminders" description="30, 7 and 1 day before a vault document (GST, ISO, OEM authorisation…) expires.">
          <Switch id="n-exp" checked={p.expiryReminders} onCheckedChange={(v) => set('expiryReminders', v)} />
        </Row>
      </div>
    </Panel>
  );
}
