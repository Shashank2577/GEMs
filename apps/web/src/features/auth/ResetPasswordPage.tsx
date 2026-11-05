import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, LinkIcon } from 'lucide-react';
import type { Me } from '@tp/core/contracts/auth';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError, errorMessage, ME_KEY } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { PasswordInput, StrengthMeter } from './PasswordInput';
import { FormAlert } from './FormAlert';

/** `/reset-password/:token` — set a new password from the emailed link (002/FR-011). */
export default function ResetPasswordPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError('Use at least 8 characters'); return; }
    setError(undefined);
    setFormError(null);
    setLoading(true);
    try {
      const me = await api.post<Me>('/auth/reset-password', { token, newPassword: password });
      qc.clear();
      qc.setQueryData(ME_KEY, me);
      toast.success('Password updated', { description: 'You’re signed in. Other devices have been signed out.' });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reset_invalid') setInvalid(true);
      else if (err instanceof ApiError && err.status === 400) setError((err.details as { fields?: Record<string, string> } | undefined)?.fields?.newPassword ?? err.message);
      else setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (invalid) {
    return (
      <AuthLayout docTitle="Reset link expired" title="This link has expired"
        subtitle="Password reset links work once and expire after 1 hour."
        footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
        <div className="grid gap-5">
          <FormAlert>This password reset link is invalid, already used or has expired.</FormAlert>
          <Button asChild size="lg" block>
            <Link to="/forgot-password"><LinkIcon /> Request a new link</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout docTitle="Set a new password" title="Set a new password"
      subtitle="Choose a new password. You’ll be signed out everywhere else."
      footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Field label="New password" error={error}>
          <PasswordInput name="password" autoComplete="new-password" placeholder="At least 8 characters" value={password}
            onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <StrengthMeter password={password} />
        <Button type="submit" size="lg" block loading={loading} className="mt-2">
          Save and sign in {!loading && <ArrowRight />}
        </Button>
      </form>
    </AuthLayout>
  );
}
