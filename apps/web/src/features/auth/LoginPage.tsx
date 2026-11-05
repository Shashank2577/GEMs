import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { safeNext, useAuth } from '@/lib/auth';
import { ApiError, errorMessage, tooManyAttemptsMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { PasswordInput } from './PasswordInput';
import { FormAlert } from './FormAlert';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 429 → the server's "Too many attempts. Try again in N minutes." (002/FR-010); 400/401 → generic mismatch. */
function loginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return tooManyAttemptsMessage(err)!;
    if (err.status === 401 || err.status === 400) return 'That email and password don’t match. Please try again.';
  }
  return errorMessage(err);
}

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!EMAIL_RE.test(email.trim())) errs.email = 'Enter a valid work email';
    if (!password) errs.password = 'Enter your password';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    setFormError(null);
    try {
      const me = await login({ email: email.trim().toLowerCase(), password });
      toast.success(`Welcome back, ${me.user.name.split(' ')[0]}`);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setFormError(loginError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      docTitle="Sign in"
      title="Welcome back"
      subtitle="Sign in to see today’s GeM matches and your bid pipeline."
      footer={<>New to TenderPilot? <Link to={`/signup${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`} className="font-medium text-primary hover:underline">Create an account</Link></>}
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Field label="Work email" error={errors.email}>
          <Input type="email" name="email" autoComplete="email" inputMode="email" placeholder="you@company.in" leading={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field
          label="Password"
          error={errors.password}
          labelAside={<Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">Forgot password?</Link>}
        >
          <PasswordInput name="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" size="lg" block loading={loading}>
          Sign in {!loading && <ArrowRight />}
        </Button>
      </form>
    </AuthLayout>
  );
}
