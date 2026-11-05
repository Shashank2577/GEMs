import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Crown, FlaskConical, Sparkles } from 'lucide-react';
import { Badge, Button, Field, Input, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ROLE_LABEL } from '@/lib/types';
import { useSeedDemo } from '@/features/dashboard/api';
import { useUpdateOrg } from '../api';
import { Panel, fieldErrors } from './Panel';

const PLAN: Record<string, { label: string; tone: 'neutral' | 'primary' | 'accent' | 'success'; blurb: string }> = {
  trial: { label: 'Free trial', tone: 'accent', blurb: 'All Pro features for 14 days. No card needed.' },
  starter: { label: 'Starter', tone: 'neutral', blurb: '₹2,999/month · 3 users · 5 watchlists' },
  pro: { label: 'Pro', tone: 'primary', blurb: '₹7,999/month · 10 users · unlimited watchlists, WhatsApp alerts' },
  enterprise: { label: 'Enterprise', tone: 'success', blurb: 'Custom limits, SSO and a dedicated success manager' },
};

export default function OrganizationSection() {
  const { me, can } = useAuth();
  const update = useUpdateOrg();
  const seed = useSeedDemo();
  const [name, setName] = useState(me?.org.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setName(me?.org.name ?? ''), [me?.org.name]);
  if (!me) return null;
  const plan = PLAN[me.org.plan] ?? PLAN.trial!;
  const editable = can('bid_manager');
  const dirty = name.trim() !== me.org.name;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) { setErr('Use at least 2 characters'); return; }
    setErr(null);
    update.mutate({ name: name.trim() }, {
      onSuccess: () => toast.success('Organization renamed'),
      onError: (e2) => { setErr(fieldErrors(e2).name ?? null); toast.error(errorMessage(e2)); },
    });
  };

  return (
    <div className="grid gap-6">
      <form onSubmit={submit}>
        <Panel title="Organization" description="Shown to your team, on annexures you generate and in alert emails."
          footer={editable ? <Button type="submit" disabled={!dirty} loading={update.isPending}>Save changes</Button> : <span className="text-xs text-muted-foreground">Only Bid Managers and Owners can rename the organization.</span>}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Organization name" error={err} required>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} leading={<Building2 />} maxLength={160} autoComplete="organization" />
            </Field>
            <Field label="Workspace URL" hint="Used in invite links and the browser extension.">
              <Input value={me.org.slug} readOnly className="font-mono text-[13px] text-muted-foreground" />
            </Field>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Legal name, GSTIN, MSE and MII details live in the <Link to="/profile" className="font-medium text-primary hover:underline">company profile</Link>.
          </p>
        </Panel>
      </form>

      <Panel title="Plan" description="Billing is handled by your account manager during the early-access period."
        aside={<Badge tone={plan.tone} size="lg">{me.org.plan === 'enterprise' ? <Crown /> : <Sparkles />}{plan.label}</Badge>}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">{plan.blurb}</p>
            <p className="mt-1 text-xs text-muted-foreground">You are signed in as {ROLE_LABEL[me.role]}.</p>
          </div>
          <Button variant="secondary" asChild><a href="mailto:sales@tenderpilot.in?subject=TenderPilot%20plan">Talk to sales</a></Button>
        </div>
      </Panel>

      {can('bid_manager') && (
        <Panel title="Demo data" description="Load a realistic sample company (Aarav Technologies, Pune) with tenders, analyses, a full pipeline and vault documents. Safe to run more than once; your own profile is never overwritten.">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{me.org.onboardingState?.demo ? 'Demo data is loaded in this organization.' : 'Great for a walkthrough before live GeM data arrives.'}</p>
            <Button variant="secondary" loading={seed.isPending}
              onClick={() => seed.mutate(undefined, { onSuccess: () => toast.success('Demo data is ready'), onError: (e) => toast.error(errorMessage(e)) })}>
              {!seed.isPending && <FlaskConical />} {me.org.onboardingState?.demo ? 'Refresh demo data' : 'Load demo data'}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
