import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, LogIn, LogOut, Mail, MailCheck, UserRound } from 'lucide-react';
import type { InvitePreview } from '@tp/core/contracts/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Avatar } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { toast } from '@/components/ui/toaster';
import { ApiError } from '@/lib/api';
import { ME_KEY, useAuth, type Me } from '@/lib/auth';
import { formatDateIST } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/types';
import { AuthLayout } from './AuthLayout';
import { PasswordInput, StrengthMeter } from './PasswordInput';
import { FormAlert } from './FormAlert';
import {
  INVITE_INVALID_MESSAGE, acceptInviteError, acceptInviteFieldErrors, inviteMode, isInviteInvalid, isInviteMismatch, mismatchMessage, useInvitePreview,
} from './api';

const TITLE = (
  <span className="inline-flex items-center gap-3">
    <span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><MailCheck className="size-5" /></span>
    You’re invited
  </span>
);
const SUBTITLE = 'Your team uses TenderPilot to find, qualify and prepare GeM bids together.';

/** `/invite/:token` — preview the invitation, then join as a new, existing or signed-in user (002/FR-017..FR-019). */
export default function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { me, isLoading: meLoading } = useAuth();
  const preview = useInvitePreview(token);
  // Set when accepting reveals the link can no longer be used (e.g. revoked meanwhile).
  const [invalidated, setInvalidated] = useState(false);

  if (invalidated || (preview.isError && isInviteInvalid(preview.error))) return <InvalidInvite />;

  // A failed background refetch keeps showing the cached preview.
  if (preview.isError && !preview.data) {
    return (
      <AuthLayout docTitle="Accept invitation" title={TITLE} subtitle={SUBTITLE}>
        <ErrorState compact title="We couldn’t load this invitation" error={preview.error}
          onRetry={() => preview.refetch()} retrying={preview.isFetching} />
      </AuthLayout>
    );
  }

  if (meLoading || !preview.data) {
    return (
      <AuthLayout docTitle="Accept invitation" title={TITLE} subtitle={SUBTITLE}>
        <InviteSkeleton />
      </AuthLayout>
    );
  }

  return <InviteForm token={token} invite={preview.data} me={me} onInvalid={() => setInvalidated(true)} />;
}

function InvalidInvite() {
  return (
    <AuthLayout docTitle="Invitation link not valid" title="This invitation can’t be used"
      subtitle="Invitation links work once and expire after 7 days.">
      <div className="grid gap-5">
        <ErrorState compact title="Ask your admin for a new invitation"
          body={INVITE_INVALID_MESSAGE} />
        <Button asChild size="lg" block>
          <Link to="/login"><LogIn /> Go to sign in</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}

function InviteSkeleton() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading invitation">
      <div className="grid gap-2.5 rounded-xl border bg-subtle p-4">
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="mt-2 h-11 w-full rounded-lg" />
      <span className="sr-only">Loading invitation…</span>
    </div>
  );
}

/** "<Inviter> invited you to join <Org> as <Role> · Expires <date>". */
function InviteCard({ invite }: { invite: InvitePreview }) {
  return (
    <div className="rounded-xl border bg-subtle p-4" data-testid="invite-card">
      <p className="text-sm leading-relaxed">
        {invite.invitedBy ? <span className="font-medium">{invite.invitedBy}</span> : 'You’ve been'}
        {invite.invitedBy ? ' invited you to join ' : ' invited to join '}
        <strong className="font-semibold">{invite.orgName}</strong> as <strong className="font-semibold">{ROLE_LABEL[invite.role]}</strong>
      </p>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" aria-hidden /> Expires {formatDateIST(invite.expiresAt)}
      </p>
    </div>
  );
}

function SignedInAs({ me }: { me: Me }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border p-4">
      <Avatar name={me.user.name} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{me.user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
      </div>
    </div>
  );
}

function InviteForm({ token, invite, me, onInvalid }: { token: string; invite: InvitePreview; me: Me | null; onInvalid: () => void }) {
  const { acceptInvite, logout } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [serverMismatch, setServerMismatch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const mode = serverMismatch && me ? 'mismatch' : inviteMode(invite, me);

  async function accept(body: { token: string; name?: string; password?: string }) {
    setLoading(true);
    setFormError(null);
    try {
      const m = await acceptInvite(body);
      toast.success(`You’ve joined ${m.org.name} as ${ROLE_LABEL[m.role]}`);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (isInviteInvalid(err)) return onInvalid();
      if (isInviteMismatch(err)) { setServerMismatch(true); return; }
      const fields = acceptInviteFieldErrors(err);
      // Field errors only have a field to sit under in the signed-out forms; otherwise show them as a form error.
      const formShown = mode === 'existing' || mode === 'new';
      if (formShown && (fields.name || fields.password)) setErrors(fields);
      else setFormError(acceptInviteError(err));
      // Signed in here but the API saw no session (expired/revoked): refresh `me` so the signed-out form appears.
      if (!formShown && err instanceof ApiError && err.status === 401) void qc.invalidateQueries({ queryKey: ME_KEY });
    } finally {
      setLoading(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
      setServerMismatch(false);
      setFormError(null);
      setErrors({});
    } finally {
      setSigningOut(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (mode === 'existing') {
      if (!password) errs.password = 'Enter your password';
    } else {
      if (name.trim().length < 2) errs.name = 'Tell us your name';
      if (password.length < 8) errs.password = 'Use at least 8 characters';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void accept(mode === 'existing' ? { token, password } : { token, name: name.trim(), password });
  }

  const footer = mode === 'existing'
    ? <>Forgot your password? <Link to="/forgot-password" className="font-medium text-primary hover:underline">Reset it</Link></>
    : undefined;

  return (
    <AuthLayout docTitle="Accept invitation" title={TITLE} subtitle={SUBTITLE} footer={footer}>
      <div className="grid gap-4">
        <InviteCard invite={invite} />
        {formError && <FormAlert>{formError}</FormAlert>}

        {mode === 'mismatch' && me && (
          <>
            <SignedInAs me={me} />
            <FormAlert>{mismatchMessage(invite.email)}</FormAlert>
            <Button size="lg" block loading={signingOut} onClick={signOut}>
              {!signingOut && <LogOut />} Sign out
            </Button>
          </>
        )}

        {mode === 'signed-in' && me && (
          <>
            <SignedInAs me={me} />
            <Button size="lg" block loading={loading} onClick={() => accept({ token })}>
              Accept & join team {!loading && <ArrowRight />}
            </Button>
            <Button variant="ghost" block loading={signingOut} onClick={signOut}>Not you? Use a different account</Button>
          </>
        )}

        {(mode === 'existing' || mode === 'new') && (
          <form onSubmit={onSubmit} noValidate className="grid gap-4">
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" value={invite.email} readOnly leading={<Mail />}
                className="bg-subtle text-muted-foreground" />
            </Field>
            {mode === 'existing' ? (
              <>
                <p className="-mt-1 text-[13px] text-muted-foreground">You already have a TenderPilot account. Enter its password to join.</p>
                <Field label="Password" error={errors.password}>
                  <PasswordInput name="password" autoComplete="current-password" placeholder="Your password" value={password}
                    onChange={(e) => setPassword(e.target.value)} autoFocus />
                </Field>
                <Button type="submit" size="lg" block loading={loading} className="mt-2">
                  Sign in & join {!loading && <ArrowRight />}
                </Button>
              </>
            ) : (
              <>
                <Field label="Your name" error={errors.name}>
                  <Input name="name" autoComplete="name" placeholder="Priya Sharma" leading={<UserRound />} value={name}
                    onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field label="Choose a password" error={errors.password}>
                  <PasswordInput name="password" autoComplete="new-password" placeholder="At least 8 characters" value={password}
                    onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <StrengthMeter password={password} />
                <Button type="submit" size="lg" block loading={loading} className="mt-2">
                  Join team {!loading && <ArrowRight />}
                </Button>
              </>
            )}
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
