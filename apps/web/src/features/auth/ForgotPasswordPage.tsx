import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Mail, MailCheck } from 'lucide-react';
import { resetTtlText } from '@tp/core/contracts/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api, ApiError, errorMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { FormAlert } from './FormAlert';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Neutral copy: never reveals whether an account exists (002/FR-011). */
export const RESET_SENT_MESSAGE = `If an account exists for that email, we’ve sent a reset link. It expires in ${resetTtlText()}.`;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) { setError('Enter a valid work email'); return; }
    setError(undefined);
    setFormError(null);
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: value });
      setSentTo(value);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setError('Enter a valid work email');
      else setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const backToLogin = <Link to="/login" className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><ArrowLeft className="size-3.5" /> Back to sign in</Link>;

  return (
    <AuthLayout
      docTitle="Forgot password"
      title="Reset your password"
      subtitle="Enter the email you sign in with and we’ll send you a link to set a new password."
      footer={backToLogin}
    >
      {sentTo ? (
        <div className="grid gap-5">
          <div role="status" className="flex items-start gap-3 rounded-xl border border-success/25 bg-success-soft/60 p-4 text-sm">
            <MailCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
            <p>{RESET_SENT_MESSAGE}</p>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Didn’t get it? Check your spam folder, or{' '}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setSentTo(null)}>try another email</button>.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field label="Work email" error={error}>
            <Input type="email" name="email" autoComplete="email" inputMode="email" placeholder="you@company.in" leading={<Mail />}
              value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" size="lg" block loading={loading}>
            Send reset link {!loading && <ArrowRight />}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
