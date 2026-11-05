/**
 * Onboarding wizard (T074; US7): company basics → what you sell → first watchlist → key documents → done.
 * Gets a new seller to a matched feed in under 5 minutes. Every step saves as you go (PUT /profile,
 * POST /watchlists, POST /vault) and ticks org.onboardingState via PATCH /org, so leaving and coming back
 * resumes where you were; skipped steps stay on the dashboard's setup checklist.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, BadgeCheck, Building2, Check, CheckCircle2, FileCheck2, FileUp, FlaskConical, Loader2, MapPin, Plus, Radar,
  ShieldCheck, Sparkles, Store, UploadCloud, X,
} from 'lucide-react';
import { INDIAN_STATES } from '@tp/core/gem/states';
import { gstinState, normalizeId, validateGstin } from '@tp/core/vault/validators';
import type { DocType } from '@tp/core/vault/status';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Badge, Button, Field, Input, Select, Stepper, Switch, toast } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatINRCompact, formatNumberIN, pluralize } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useSeedDemo } from '@/features/dashboard/api';
import { useProfile, useSaveProfile } from '@/features/profile/api';
import { useUpdateOrg } from '@/features/settings/api';
import { useCreateWatchlist, useWatchlistPreview } from '@/features/watchlists/api';
import { ChipInput, MultiSelect } from '@/features/watchlists/ChipInput';
import { useUploadVault, useVault } from '@/features/vault/api';
import { POPULAR_CATEGORIES, STEPS, initialStep, keywordsFor } from './steps';

type MseCat = 'micro' | 'small' | 'medium' | null;

export default function OnboardingPage() {
  useDocumentTitle('Set up TenderPilot');
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const profile = useProfile();
  const updateOrg = useUpdateOrg();
  const reduce = useReducedMotion();
  const state = me?.org.onboardingState ?? {};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => initialStep(state), []);
  const [step, setStep] = useState(initial);
  const [dir, setDir] = useState(1);

  // Shared wizard data (prefilled from the profile when present).
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState('');
  const [homeState, setHomeState] = useState('');
  const [mse, setMse] = useState<MseCat>(null);
  const [startup, setStartup] = useState(false);
  const [mii, setMii] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [hsn, setHsn] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [watchlistDone, setWatchlistDone] = useState(() => !!me?.org.onboardingState?.watchlist);
  useEffect(() => {
    if (hydrated || !profile.data) return;
    const p = profile.data.profile;
    setLegalName(p.legalName || me?.org.name || '');
    setGstin(p.gstin ?? '');
    setHomeState(p.state ?? '');
    setMse(p.mseCategory ?? null);
    setStartup(p.isStartup);
    setMii(p.miiClass === 'class_1');
    setCategories(p.categories);
    setHsn(p.hsnCodes);
    setStates(p.operatingStates.length ? p.operatingStates : p.state ? [p.state] : []);
    setHydrated(true);
  }, [profile.data, hydrated, me?.org.name]);

  const go = (to: number) => { setDir(to > step ? 1 : -1); setStep(to); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); };
  // FR-050: retry once after 1 s on network/5xx errors (never on 4xx: it would fail again), then tell the user without blocking navigation.
  const tick = async (keys: Record<string, boolean>) => {
    const toastFail = () => toast.error('Couldn’t save your progress — your data is saved, but setup may restart at this step');
    try { await updateOrg.mutateAsync({ onboardingState: keys }); return; } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) { toastFail(); return; }
    }
    await new Promise((r) => setTimeout(r, 1000));
    try { await updateOrg.mutateAsync({ onboardingState: keys }); } catch { toastFail(); }
  };

  if (me && !can('bid_manager')) {
    return (
      <Shell step={-1} onSkip={() => navigate('/dashboard')}>
        <div className="mx-auto max-w-md py-16 text-center">
          <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary"><ShieldCheck className="size-6" /></span>
          <h1 className="text-2xl font-semibold tracking-tight">You’re all set</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your organization’s owners handle setup. Jump straight into the tenders your team is tracking.</p>
          <Button className="mt-6" asChild><Link to="/dashboard">Go to dashboard <ArrowRight /></Link></Button>
        </div>
      </Shell>
    );
  }

  const skip = async () => { await tick({ skipped: true }); navigate('/dashboard'); };

  return (
    <Shell step={step} onSkip={skip} onStepClick={(i) => i < step && go(i)}>
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div key={step} custom={dir}
          initial={reduce ? false : { opacity: 0, x: dir * 24 }} animate={{ opacity: 1, x: 0 }} exit={reduce ? undefined : { opacity: 0, x: dir * -24 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
          {step === 0 && (
            <CompanyStep loading={profile.isLoading} {...{ legalName, setLegalName, gstin, setGstin, homeState, setHomeState, mse, setMse, startup, setStartup, mii, setMii }}
              onNext={async () => { await tick({ company: true }); if (homeState && !states.length) setStates([homeState]); go(1); }} />
          )}
          {step === 1 && (
            <CategoriesStep {...{ categories, setCategories, hsn, setHsn, states, setStates }} onBack={() => go(0)}
              onNext={async () => { await tick({ categories: true }); go(2); }} />
          )}
          {step === 2 && (
            <WatchlistStep categories={categories} states={states} hsn={hsn} onBack={() => go(1)} already={watchlistDone}
              onNext={async () => { setWatchlistDone(true); await tick({ watchlist: true }); go(3); }} />
          )}
          {step === 3 && (
            <DocumentsStep onBack={() => go(2)} onNext={async (uploaded) => { await tick({ documents: uploaded > 0 }); go(4); }} />
          )}
          {step === 4 && <DoneStep onFinish={() => tick({ completed: true })} />}
        </motion.div>
      </AnimatePresence>
    </Shell>
  );
}

// ───────────── Layout ─────────────

function Shell({ step, children, onSkip, onStepClick }: { step: number; children: ReactNode; onSkip: () => void; onStepClick?: (i: number) => void }) {
  return (
    <div className="relative min-h-dvh bg-background">
      <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-80 [mask-image:linear-gradient(to_bottom,black,transparent)]" aria-hidden />
      <header className="relative mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Link to="/dashboard" className="rounded-md focus-ring" aria-label="TenderPilot dashboard"><Logo /></Link>
        <div className="flex items-center gap-1">
          {step >= 0 && step < STEPS.length - 1 && <Button variant="ghost" size="sm" onClick={onSkip}>Skip for now</Button>}
          <ThemeToggle />
        </div>
      </header>
      <main className="relative mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6">
        {step >= 0 && (
          <div className="mb-8">
            <Stepper steps={STEPS.map((s) => ({ label: s.label }))} current={step} onStepClick={onStepClick} />
            <p className="mt-3 text-xs text-muted-foreground sm:hidden">Step {Math.min(step + 1, STEPS.length)} of {STEPS.length} · {STEPS[step]?.label}</p>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

function StepHeader({ eyebrow, title, body }: { eyebrow: string; title: string; body: ReactNode }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
      <h1 className="mt-1.5 text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function Footer({ onBack, next, nextLabel = 'Continue', loading, disabled, extra }: { onBack?: () => void; next: () => void; nextLabel?: string; loading?: boolean; disabled?: boolean; extra?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex items-center justify-between gap-3 border-t bg-background/90 px-4 py-3 backdrop-blur safe-bottom sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      {onBack ? <Button variant="ghost" onClick={onBack}><ArrowLeft /> Back</Button> : <span />}
      <div className="flex items-center gap-2">
        {extra}
        <Button onClick={next} loading={loading} disabled={disabled} size="lg">{nextLabel} {!loading && <ArrowRight />}</Button>
      </div>
    </div>
  );
}

function Toggle({ id, title, body, checked, onChange, children }: { id: string; title: string; body: string; checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className={cn('rounded-xl border bg-card p-4 transition-colors', checked && 'border-primary/40 bg-primary-soft/40')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="text-sm font-medium">{title}</label>
          <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
      {checked && children && <div className="mt-3">{children}</div>}
    </div>
  );
}

// ───────────── Step 1: company ─────────────

function CompanyStep(p: {
  loading: boolean; legalName: string; setLegalName: (v: string) => void; gstin: string; setGstin: (v: string) => void;
  homeState: string; setHomeState: (v: string) => void; mse: MseCat; setMse: (v: MseCat) => void; startup: boolean; setStartup: (v: boolean) => void;
  mii: boolean; setMii: (v: boolean) => void; onNext: () => Promise<void>;
}) {
  const save = useSaveProfile();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const gstNorm = normalizeId(p.gstin);
  const gstErr = gstNorm ? validateGstin(gstNorm) : null;
  const gstOk = !!gstNorm && !gstErr;
  const derivedState = gstOk ? gstinState(gstNorm) : null;
  useEffect(() => {
    if (derivedState && (INDIAN_STATES as readonly string[]).includes(derivedState) && !p.homeState) p.setHomeState(derivedState);
  }, [derivedState]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = async () => {
    const errs: Record<string, string> = {};
    if (!p.legalName.trim()) errs.legalName = 'Enter your registered company name';
    if (gstNorm && gstErr) errs.gstin = gstErr;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    try {
      await save.mutateAsync({
        legalName: p.legalName.trim(),
        gstin: gstNorm || null,
        ...(gstOk ? { pan: gstNorm.slice(2, 12) } : {}),
        state: p.homeState || null,
        mseCategory: p.mse,
        isStartup: p.startup,
        ...(p.mii ? { miiClass: 'class_1' as const } : {}),
      });
      await p.onNext();
    } catch (e) {
      const f = (e as { details?: { fields?: Record<string, string> } }).details?.fields ?? {};
      setErrors(f);
      toast.error(errorMessage(e));
    }
  };

  return (
    <section>
      <StepHeader eyebrow="Step 1 · about 1 minute" title="Tell us about your company"
        body="We use this to check eligibility (turnover, MSE and Make in India preferences) and to fill annexures for you." />
      <div className="grid gap-5 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <Field label="Registered company name" error={errors.legalName} required>
          <Input value={p.legalName} onChange={(e) => p.setLegalName(e.target.value)} placeholder="e.g. Aarav Technologies Pvt Ltd" leading={<Building2 />} autoComplete="organization" autoFocus disabled={p.loading} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="GSTIN" error={errors.gstin ?? (gstNorm.length >= 15 ? gstErr : null)}
            hint={gstOk ? <span className="inline-flex items-center gap-1 text-success"><BadgeCheck className="size-3.5" /> Valid · {derivedState} · PAN {gstNorm.slice(2, 12)}</span> : '15 characters, e.g. 27AAJCA4721K1ZK'}>
            <Input value={p.gstin} onChange={(e) => p.setGstin(e.target.value.toUpperCase())} maxLength={15} placeholder="27AAJCA4721K1ZK"
              className="font-mono uppercase tracking-wide" autoCapitalize="characters" spellCheck={false}
              trailing={gstOk ? <CheckCircle2 className="text-success" /> : undefined} />
          </Field>
          <Field label="Home state" hint="Where your principal place of business is.">
            <Select value={p.homeState || undefined} onValueChange={p.setHomeState} placeholder="Choose a state"
              options={INDIAN_STATES.map((s) => ({ value: s, label: s }))} />
          </Field>
        </div>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold">Preferences you can claim</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Toggle id="ob-mse" title="Registered MSE (Udyam)" body="EMD exemption and purchase preference on most bids." checked={p.mse !== null} onChange={(v) => p.setMse(v ? 'micro' : null)}>
          <Select aria-label="MSE category" value={p.mse ?? 'micro'} onValueChange={(v) => p.setMse(v as MseCat)}
            options={[{ value: 'micro', label: 'Micro' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }]} />
        </Toggle>
        <Toggle id="ob-startup" title="DPIIT Startup" body="Exemption from experience and turnover criteria where allowed." checked={p.startup} onChange={p.setStartup} />
        <Toggle id="ob-mii" title="Make in India Class-I" body="50%+ local content — first right to match L1." checked={p.mii} onChange={p.setMii} />
      </div>
      <Footer next={next} loading={save.isPending} />
    </section>
  );
}

// ───────────── Step 2: categories ─────────────

function CategoriesStep(p: {
  categories: string[]; setCategories: (v: string[]) => void; hsn: string[]; setHsn: (v: string[]) => void;
  states: string[]; setStates: (v: string[]) => void; onBack: () => void; onNext: () => Promise<void>;
}) {
  const save = useSaveProfile();
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const toggle = (c: string) => p.setCategories(p.categories.includes(c) ? p.categories.filter((x) => x !== c) : [...p.categories, c]);
  const addCustom = () => {
    const v = custom.trim().replace(/\s+/g, ' ');
    if (v && !p.categories.some((c) => c.toLowerCase() === v.toLowerCase())) p.setCategories([...p.categories, v]);
    setCustom('');
  };
  const customs = p.categories.filter((c) => !POPULAR_CATEGORIES.some((x) => x.label === c));
  const next = async () => {
    if (!p.categories.length) { setErr('Pick at least one category so we can find matching bids'); return; }
    setErr(null);
    try {
      await save.mutateAsync({ categories: p.categories, hsnCodes: p.hsn, operatingStates: p.states });
      await p.onNext();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <section>
      <StepHeader eyebrow="Step 2 · about 1 minute" title="What do you sell on GeM?"
        body="Pick everything that applies. We’ll turn it into keywords that find the right bids — you can fine-tune later." />
      <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <div role="group" aria-label="Popular GeM categories" className="flex flex-wrap gap-2">
          {POPULAR_CATEGORIES.map((c) => {
            const on = p.categories.includes(c.label);
            return (
              <button key={c.label} type="button" aria-pressed={on} onClick={() => toggle(c.label)}
                className={cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-all focus-ring',
                  on ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'bg-card hover:border-foreground/25 hover:bg-muted')}>
                {on ? <Check className="size-3.5" /> : <Plus className="size-3.5 text-muted-foreground" />}{c.label}
              </button>
            );
          })}
          {customs.map((c) => (
            <span key={c} className="inline-flex h-9 items-center gap-1 rounded-full border border-primary bg-primary pl-3.5 pr-1.5 text-[13px] font-medium text-primary-foreground">
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => toggle(c)} className="rounded-full p-1 hover:bg-white/20 focus-ring"><X className="size-3" /></button>
            </span>
          ))}
        </div>
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); addCustom(); }}>
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Something else? e.g. Biometric devices" aria-label="Add a custom category" leading={<Store />} />
          <Button type="submit" variant="secondary" disabled={!custom.trim()}>Add</Button>
        </form>
        {err && <p className="mt-2 text-xs text-danger" role="alert">{err}</p>}
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Field label="States you supply to" hint="Leave empty to see bids from all of India.">
          <MultiSelect label="States you supply to" placeholder="All of India" options={[...INDIAN_STATES]} value={p.states} onChange={p.setStates} />
        </Field>
        <Field label={<>HSN / SAC codes <span className="font-normal text-muted-foreground">(optional)</span></>} hint="4–8 digits, e.g. 8471 for computers">
          <ChipInput value={p.hsn} onChange={p.setHsn} placeholder="8471, 8525…" aria-label="HSN codes" validate={(s) => (/^\d{4}(\d{2}){0,2}$/.test(s) ? null : 'HSN/SAC codes have 4, 6 or 8 digits')} />
        </Field>
      </div>
      <Footer onBack={p.onBack} next={next} loading={save.isPending} />
    </section>
  );
}

// ───────────── Step 3: watchlist ─────────────

function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function WatchlistStep({ categories, states, hsn, onBack, onNext, already }: { categories: string[]; states: string[]; hsn: string[]; onBack: () => void; onNext: () => Promise<void>; already: boolean }) {
  const create = useCreateWatchlist();
  const [name, setName] = useState(() => (categories.length ? `${categories.slice(0, 2).join(' & ')}${states.length === 1 ? ` – ${states[0]}` : ''}` : 'My first watchlist').slice(0, 80));
  const [keywords, setKeywords] = useState(() => keywordsFor(categories));
  const [wlStates, setWlStates] = useState(states);
  const criteria = useMemo(() => ({ keywords, states: wlStates, hsnCodes: [] as string[], categories: [] as string[] }), [keywords, wlStates]);
  const debounced = useDebounced(criteria);
  const preview = useWatchlistPreview(debounced, keywords.length > 0 || wlStates.length > 0);
  const [err, setErr] = useState<string | null>(null);

  const next = async () => {
    if (already) { await onNext(); return; }
    if (!keywords.length && !wlStates.length) { setErr('Add at least one keyword'); return; }
    try {
      await create.mutateAsync({ name: name.trim() || 'My first watchlist', criteria: { ...criteria, excludeKeywords: [], ministries: [], bidTypes: [] } });
      toast.success('Watchlist created', { description: 'We’ll alert you the moment a matching bid is published.' });
      await onNext();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const count = preview.data?.count;
  return (
    <section>
      <StepHeader eyebrow="Step 3 · 30 seconds" title="Your first watchlist"
        body={<>We pre-filled it from your categories{hsn.length ? ' and HSN codes' : ''}. Every new GeM bid is checked against it, and matches land in your feed with the reasons.</>} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid gap-5 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <Field label="Watchlist name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} leading={<Radar />} /></Field>
          <Field label="Keywords" hint="Any of these in the bid title or items. Press Enter to add." error={err}>
            <ChipInput value={keywords} onChange={(v) => { setKeywords(v); setErr(null); }} placeholder="Add a keyword" aria-label="Keywords" />
          </Field>
          <Field label="States" hint="Buyer’s state. Empty = all India.">
            <MultiSelect label="States" placeholder="All of India" options={[...INDIAN_STATES]} value={wlStates} onChange={setWlStates} />
          </Field>
        </div>
        <aside aria-live="polite" className="flex flex-col rounded-2xl border bg-gradient-to-b from-primary-soft/70 to-card p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Live preview</p>
          <div className="mt-2 flex items-baseline gap-2">
            {preview.isFetching && count === undefined ? <Loader2 className="size-6 animate-spin text-muted-foreground" />
              : <span className="tabular text-4xl font-semibold tracking-tight">{formatNumberIN(count ?? 0)}</span>}
            <span className="text-sm text-muted-foreground">open {(count ?? 0) === 1 ? 'bid matches' : 'bids match'} today</span>
          </div>
          <ul className="mt-4 grid gap-2">
            {(preview.data?.sample ?? []).slice(0, 3).map((t) => (
              <li key={t.id} className="rounded-lg border bg-card p-2.5">
                <p className="line-clamp-2 text-xs font-medium">{t.title}</p>
                <p className="mt-1 truncate text-2xs text-muted-foreground">{t.organisation ?? t.ministry}{t.estimatedValue ? ` · ${formatINRCompact(t.estimatedValue)}` : ''}</p>
              </li>
            ))}
          </ul>
          {count === 0 && <p className="mt-3 text-xs text-muted-foreground">No open bids right now — that’s fine. You’ll be alerted as soon as one appears.</p>}
        </aside>
      </div>
      <Footer onBack={onBack} next={next} nextLabel={already ? 'Continue' : 'Create watchlist'} loading={create.isPending} />
    </section>
  );
}

// ───────────── Step 4: documents ─────────────

const KEY_DOCS: { type: DocType; title: string; body: string }[] = [
  { type: 'gst', title: 'GST certificate', body: 'Form GST REG-06' },
  { type: 'pan', title: 'PAN card', body: 'Company PAN' },
  { type: 'udyam', title: 'Udyam certificate', body: 'For MSE exemptions' },
];

function DocumentsStep({ onBack, onNext }: { onBack: () => void; onNext: (uploaded: number) => Promise<void> }) {
  const upload = useUploadVault();
  const [uploadedNow, setDone] = useState<Partial<Record<DocType, string>>>({});
  // FR-051: documents already in the vault are pre-marked (showing their vault title) and counted.
  const gst = useVault({ type: 'gst' }), pan = useVault({ type: 'pan' }), udyam = useVault({ type: 'udyam' });
  const inVault: Partial<Record<DocType, string>> = {};
  for (const [t, q] of [['gst', gst], ['pan', pan], ['udyam', udyam]] as const) {
    const first = q.data?.items?.[0];
    if (first) inVault[t] = first.title;
  }
  const done: Partial<Record<DocType, string>> = { ...inVault, ...uploadedNow };
  const [busy, setBusy] = useState<DocType | null>(null);
  const [moving, setMoving] = useState(false);
  const pick = async (type: DocType, title: string, file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast.error('That file is larger than 20 MB'); return; }
    setBusy(type);
    try {
      await upload.mutateAsync({ file, fields: { type, title } });
      setDone((d) => ({ ...d, [type]: file.name }));
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const n = Object.keys(done).length;
  const finish = async () => { setMoving(true); try { await onNext(n); } finally { setMoving(false); } };
  return (
    <section>
      <StepHeader eyebrow="Step 4 · optional" title="Add your key documents"
        body="Almost every bid asks for these. Upload once — we track expiry and attach them to every packet automatically. PDF, JPG or PNG up to 20 MB." />
      <div className="grid gap-3 sm:grid-cols-3">
        {KEY_DOCS.map((d) => {
          const uploaded = done[d.type];
          const id = `ob-doc-${d.type}`;
          return (
            <label key={d.type} htmlFor={id}
              className={cn('group relative flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed bg-card p-6 text-center transition-colors focus-within:ring-2 focus-within:ring-ring',
                uploaded ? 'border-success/50 bg-success-soft/40' : 'hover:border-primary/50 hover:bg-primary-soft/30')}>
              <input id={id} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="sr-only"
                onChange={(e) => pick(d.type, d.title, e.target.files?.[0])} disabled={busy !== null} />
              <span className={cn('mb-3 flex size-11 items-center justify-center rounded-xl', uploaded ? 'bg-success text-success-foreground' : 'bg-primary-soft text-primary')}>
                {busy === d.type ? <Loader2 className="size-5 animate-spin" /> : uploaded ? <FileCheck2 className="size-5" /> : <UploadCloud className="size-5" />}
              </span>
              <span className="text-sm font-semibold">{d.title}</span>
              <span className="mt-0.5 max-w-full truncate text-xs text-muted-foreground">{uploaded ?? d.body}</span>
              <span className="mt-3 text-xs font-medium text-primary">{uploaded ? 'Replace' : busy === d.type ? 'Uploading…' : 'Choose file'}</span>
            </label>
          );
        })}
      </div>
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 text-success" /> Stored privately for your organization and shared only through short-lived links.</p>
      <Footer onBack={onBack} next={finish} loading={moving} nextLabel={n ? 'Continue' : 'Skip for now'}
        extra={n ? <Badge tone="success" size="lg"><Check /> {n} uploaded</Badge> : undefined} />
    </section>
  );
}

// ───────────── Done ─────────────

const CONFETTI_COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

function Confetti() {
  const reduce = useReducedMotion();
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    left: (i * 37) % 100, delay: (i % 9) * 0.07, rot: (i * 47) % 360, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!, w: 6 + (i % 3) * 2, drift: ((i % 7) - 3) * 14,
  })), []);
  if (reduce) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 -top-4 h-72 overflow-hidden" aria-hidden>
      {pieces.map((p, i) => (
        <motion.span key={i} className="absolute top-0 block rounded-[2px]" style={{ left: `${p.left}%`, width: p.w, height: p.w * 0.45, background: p.color }}
          initial={{ y: -20, opacity: 0, rotate: p.rot }} animate={{ y: 260, x: p.drift, opacity: [0, 1, 1, 0], rotate: p.rot + 220 }}
          transition={{ duration: 1.8, delay: p.delay, ease: 'easeOut' }} />
      ))}
    </div>
  );
}

function DoneStep({ onFinish }: { onFinish: () => Promise<unknown> }) {
  const navigate = useNavigate();
  const seed = useSeedDemo();
  const { can } = useAuth();
  useEffect(() => { void onFinish(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="relative text-center">
      <Confetti />
      <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className="relative mx-auto mt-6 flex size-16 items-center justify-center rounded-2xl bg-success text-success-foreground shadow-lg">
        <Sparkles className="size-8" />
      </motion.span>
      <h1 className="relative mt-6 text-3xl font-semibold tracking-tight">You’re ready to win more bids</h1>
      <p className="relative mx-auto mt-3 max-w-md text-sm text-muted-foreground">
        TenderPilot is now watching GeM for you. New matches arrive in your feed and inbox — check eligibility in one click and build the packet when you decide to bid.
      </p>
      <div className="relative mx-auto mt-8 grid max-w-xl gap-3 text-left sm:grid-cols-3">
        {[
          { icon: Radar, t: 'Identify', b: 'Matches every 30 minutes' },
          { icon: BadgeCheck, t: 'Analyse', b: 'Go / No-Go with reasons' },
          { icon: FileUp, t: 'Apply', b: 'Packet ready, you submit' },
        ].map((x) => (
          <div key={x.t} className="rounded-xl border bg-card p-3">
            <x.icon className="size-4 text-primary" />
            <p className="mt-2 text-sm font-semibold">{x.t}</p>
            <p className="text-xs text-muted-foreground">{x.b}</p>
          </div>
        ))}
      </div>
      <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button size="lg" onClick={() => navigate('/tenders?matched=1')}>Go to my feed <ArrowRight /></Button>
        {can('bid_manager') && (
          <Button size="lg" variant="secondary" loading={seed.isPending}
            onClick={() => seed.mutate(undefined, {
              onSuccess: () => { toast.success('Demo data loaded', { description: 'Explore a full pipeline for Aarav Technologies.' }); navigate('/dashboard'); },
              onError: (e) => toast.error(errorMessage(e)),
            })}>
            {!seed.isPending && <FlaskConical />} Explore with demo data
          </Button>
        )}
      </div>
      <p className="relative mt-4 text-xs text-muted-foreground"><MapPin className="mr-1 inline size-3" />You can change anything later in Company profile and Watchlists.</p>
    </section>
  );
}
