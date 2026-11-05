import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Building2, Mail, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { safeNext, useAuth } from '@/lib/auth';
import { ApiError, errorMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { PasswordInput, StrengthMeter } from './PasswordInput';
import { FormAlert } from './FormAlert';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Errors = Partial<Record<'name' | 'email' | 'password' | 'orgName', string>>;

export default function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', password: '', orgName: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: Errors = {};
    if (form.name.trim().length < 2) errs.name = 'Tell us your name';
    if (!EMAIL_RE.test(form.email.trim())) errs.email = 'Enter a valid work email';
    if (form.password.length < 8) errs.password = 'Use at least 8 characters';
    if (form.orgName.trim().length < 2) errs.orgName = 'Enter your company name';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    setFormError(null);
    try {
      const me = await signup({ name: form.name.trim(), email: form.email.trim().toLowerCase(), password: form.password, orgName: form.orgName.trim() });
      toast.success(`Welcome to TenderPilot, ${me.user.name.split(' ')[0]}!`);
      navigate(safeNext(params.get('next'), '/onboarding'), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setErrors({ email: 'An account with this email already exists. Try signing in.' });
      else setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      docTitle="Create your account"
      title="Start winning more GeM bids"
      subtitle="Free 14-day trial. No card needed. Set up in under 5 minutes."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link></>}
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" error={errors.name}>
            <Input name="name" autoComplete="name" placeholder="Priya Sharma" leading={<UserRound />} value={form.name} onChange={set('name')} autoFocus />
          </Field>
          <Field label="Company name" error={errors.orgName}>
            <Input name="orgName" autoComplete="organization" placeholder="Sharma Infotech Pvt Ltd" leading={<Building2 />} value={form.orgName} onChange={set('orgName')} />
          </Field>
        </div>
        <Field label="Work email" error={errors.email}>
          <Input type="email" name="email" autoComplete="email" inputMode="email" placeholder="you@company.in" leading={<Mail />} value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" error={errors.password}>
          <PasswordInput name="password" autoComplete="new-password" placeholder="At least 8 characters" value={form.password} onChange={set('password')} />
        </Field>
        <StrengthMeter password={form.password} />
        <Button type="submit" size="lg" block loading={loading} className="mt-2">
          Create account {!loading && <ArrowRight />}
        </Button>
        <p className="text-center text-2xs leading-relaxed text-muted-foreground">
          By continuing you agree to our Terms and Privacy Policy. TenderPilot never logs into GeM or submits bids for you.
        </p>
      </form>
    </AuthLayout>
  );
}
