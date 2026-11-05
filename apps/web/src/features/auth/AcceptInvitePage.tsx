import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, MailCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Avatar } from '@/components/ui/misc';
import { toast } from '@/components/ui/toaster';
import { useAuth } from '@/lib/auth';
import { ApiError, errorMessage } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/types';
import { AuthLayout } from './AuthLayout';
import { PasswordInput, StrengthMeter } from './PasswordInput';
import { FormAlert } from './FormAlert';

function inviteError(err: unknown) {
  if (err instanceof ApiError) {
    // 002/FR-010: "Too many attempts. Try again in N minutes." instead of a credentials error.
    if (err.status === 429) return err.message;
    if (err.status === 404 || err.code.includes('not_found')) return 'This invitation link is invalid. Ask your admin to send a new one.';
    if (err.status === 410 || err.code.includes('expired')) return 'This invitation has expired. Ask your admin to send a new one.';
    if (err.status === 409) return 'This invitation has already been used. Try signing in instead.';
  }
  return errorMessage(err);
}

export default function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { me, acceptInvite, logout } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function accept(body: { token: string; name?: string; password?: string }) {
    setLoading(true);
    setFormError(null);
    try {
      const m = await acceptInvite(body);
      toast.success(`You’ve joined ${m.org.name} as ${ROLE_LABEL[m.role]}`);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setFormError(inviteError(err));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (name.trim().length < 2) errs.name = 'Tell us your name';
    if (password.length < 8) errs.password = 'Use at least 8 characters';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void accept({ token, name: name.trim(), password });
  }

  return (
    <AuthLayout
      docTitle="Accept invitation"
      title={<span className="inline-flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><MailCheck className="size-5" /></span>You’re invited</span>}
      subtitle="Your team uses TenderPilot to find, qualify and prepare GeM bids together."
      footer={!me ? <>Already have an account? <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="font-medium text-primary hover:underline">Sign in to accept</Link></> : undefined}
    >
      {formError && <div className="mb-4"><FormAlert>{formError}</FormAlert></div>}
      {me ? (
        <div className="grid gap-4">
          <div className="flex items-center gap-3 rounded-xl border bg-subtle p-4">
            <Avatar name={me.user.name} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{me.user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
            </div>
          </div>
          <Button size="lg" block loading={loading} onClick={() => accept({ token })}>
            Accept & join team {!loading && <ArrowRight />}
          </Button>
          <Button variant="ghost" block onClick={async () => { await logout(); }}>Not you? Use a different account</Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <Field label="Your name" error={errors.name}>
            <Input name="name" autoComplete="name" placeholder="Priya Sharma" leading={<UserRound />} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Choose a password" error={errors.password}>
            <PasswordInput name="password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <StrengthMeter password={password} />
          <Button type="submit" size="lg" block loading={loading} className="mt-2">
            Join team {!loading && <ArrowRight />}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
