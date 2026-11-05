/**
 * Company profile (US3, FR-020): everything the eligibility engine and annexure generator need.
 * Sectioned form with sticky section nav, live inline validation (the same zod schema the API uses),
 * a live completeness meter, and a save bar that appears when there are unsaved changes.
 * Past contracts save immediately through their own endpoints.
 * Leaving with unsaved edits is guarded both for tab close (beforeunload) and in-app navigation (useBlocker, FR-013);
 * saves carry `expectedUpdatedAt` so a newer save by someone else returns 409 instead of being overwritten (FR-014).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, BadgeCheck, Briefcase, Building2, Eye, Flag, Handshake, HelpCircle, IndianRupee, Info, Layers, RefreshCw, Rocket, RotateCcw, Save, UserRoundPen, Wand2,
} from 'lucide-react';
import {
  MII_CLASSES, MII_CLASS_INFO, MSE_CATEGORIES, MSE_SOCIAL_CATEGORIES, profileInputSchema, type CompanyProfileDto, type ProfileInput,
} from '@tp/core/contracts/vault';
import { profileCompleteness } from '@tp/core/vault/completeness';
import { INDIAN_STATES } from '@tp/core/gem/states';
import { gstinPan, gstinState, panEntityType, validateGstin } from '@tp/core/vault/validators';
import {
  Badge, Button, Card, ConfirmDialog, ErrorState, Field, Input, PageHeader, Segmented, Select, Skeleton, Switch, Textarea, Tooltip, toast,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChipInput, MultiSelect } from '@/features/watchlists/ChipInput';
import { useVault } from '@/features/vault/api';
import { usePastContracts, useProfile, useSaveProfile } from './api';
import { CompletenessCard, Ring } from './CompletenessCard';
import { FinancialsEditor } from './FinancialsEditor';
import { OemEditor } from './OemEditor';
import { PastContracts } from './PastContracts';
import { RupeeInput } from './RupeeInput';

type Draft = Omit<CompanyProfileDto, 'updatedAt'>;

const SECTIONS = [
  { id: 'identity', label: 'Company identity', icon: Building2 },
  { id: 'registrations', label: 'Registrations & status', icon: BadgeCheck },
  { id: 'financials', label: 'Financials', icon: IndianRupee },
  { id: 'experience', label: 'Experience', icon: Briefcase },
  { id: 'oem', label: 'OEM authorisations', icon: Handshake },
  { id: 'categories', label: 'Categories & reach', icon: Layers },
  { id: 'contact', label: 'Signatory & contact', icon: UserRoundPen },
] as const;

const CERT_SUGGESTIONS = ['ISO 9001:2015', 'ISO 14001:2015', 'ISO 27001:2022', 'ISO 45001:2018', 'BIS', 'CMMI Level 3', 'NSIC', 'BEE Star Rating', 'CE', 'RoHS'];
const CATEGORY_SUGGESTIONS = ['Desktop Computers', 'Laptop - Notebook', 'Multifunction Machines', 'CCTV Cameras', 'Servers', 'Network Switches', 'UPS', 'LED Lights',
  'Office Chairs', 'Manpower Outsourcing Services', 'Security Manpower Service', 'Facility Management Services', 'Cloud Services', 'Solar PV Systems'];

const stripMeta = (p: CompanyProfileDto): Draft => { const { updatedAt: _u, ...rest } = p; return rest; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** zod issues → { "gstin": msg, "financials.1.fy": msg } */
function validate(d: Draft): Record<string, string> {
  const r = profileInputSchema.safeParse(d as unknown as ProfileInput);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) { const k = i.path.join('.'); if (!(k in out)) out[k] = i.message; }
  return out;
}

function SectionCard({ id, title, description, icon: Icon, children, aside }: { id: string; title: string; description: string; icon: typeof Building2; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={`sec-${id}`} aria-labelledby={`sec-${id}-title`} className="scroll-mt-24">
      <Card className="overflow-visible">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon className="size-4" aria-hidden /></span>
            <div>
              <h2 id={`sec-${id}-title`} className="text-[15px] font-semibold tracking-tight">{title}</h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
            </div>
          </div>
          {aside}
        </header>
        <div className="px-4 py-5 sm:px-6">{children}</div>
      </Card>
    </section>
  );
}

function Explain({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Tooltip content={<span className="block max-w-xs text-xs leading-relaxed">{children}</span>}>
      <button type="button" className="inline-flex rounded text-muted-foreground hover:text-foreground focus-ring" aria-label={`What is ${label}?`}><HelpCircle className="size-3.5" /></button>
    </Tooltip>
  );
}

function ChoiceCard({ selected, onSelect, title, badge, children, disabled }: { selected: boolean; onSelect: () => void; title: ReactNode; badge?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className={cn('flex h-full flex-col gap-1 rounded-xl border p-3.5 text-left transition-all focus-ring disabled:cursor-not-allowed',
        selected ? 'border-primary bg-primary-soft/50 shadow-[0_0_0_1px_hsl(var(--primary))]' : 'bg-card hover:border-foreground/20')}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className={cn('flex size-4 items-center justify-center rounded-full border-2', selected ? 'border-primary' : 'border-muted-foreground/40')}>
          {selected && <span className="size-2 rounded-full bg-primary" />}
        </span>
      </span>
      {badge}
      <span className="text-xs leading-relaxed text-muted-foreground">{children}</span>
    </button>
  );
}

function ProfileSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_1fr] xl:grid-cols-[13rem_1fr_19rem]">
      <div className="hidden space-y-2 lg:block">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      <div className="space-y-6">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-72 w-full rounded-xl" />)}</div>
      <Skeleton className="hidden h-64 rounded-xl xl:block" />
    </div>
  );
}

export default function ProfilePage() {
  const profile = useProfile();
  const contracts = usePastContracts();
  const vault = useVault({});
  const save = useSaveProfile();
  const { can } = useAuth();
  const navigate = useNavigate();
  const readOnly = !can('analyst');

  const saved = useMemo(() => (profile.data ? stripMeta(profile.data.profile) : null), [profile.data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [blurred, setBlurred] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [active, setActive] = useState<string>('identity');
  /** 409 message from a save that lost a race with someone else's save (FR-014). The draft is kept until Reload. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  // Adopt fresh server data unless the user has unsaved edits (e.g. a past-contract change refetches the profile).
  const prevSaved = useRef<Draft | null>(null);
  useEffect(() => {
    if (!saved) return;
    setDraft((d) => (!d || !prevSaved.current || same(d, prevSaved.current) ? saved : d));
    prevSaved.current = saved;
  }, [saved]);

  const dirty = !!draft && !!saved && !same(draft, saved);
  const clientErrors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(clientErrors)) {
      const top = k.split('.')[0]!;
      const changed = draft && saved && !same((draft as unknown as Record<string, unknown>)[top], (saved as unknown as Record<string, unknown>)[top]);
      if (submitted || blurred.has(top) || (changed && !['legalName', 'tradeName', 'gstin', 'pan', 'cin', 'udyamNumber', 'dpiitNumber', 'pincode', 'contactEmail', 'contactPhone', 'localContentPct'].includes(top))) out[k] = v;
    }
    return { ...out, ...serverErrors };
  }, [clientErrors, serverErrors, submitted, blurred, draft, saved]);

  const live = useMemo(() => draft ? profileCompleteness(draft, contracts.data?.items ?? [], vault.data?.items ?? [], new Date()) : null, [draft, contracts.data, vault.data]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  // …and before in-app navigation to another page (FR-013). Query-string changes on /profile are not "leaving".
  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) => dirty && currentLocation.pathname !== nextLocation.pathname,
    [dirty],
  ));

  // Section scroll-spy
  useEffect(() => {
    if (!draft) return;
    const obs = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id.replace('sec-', ''));
    }, { rootMargin: '-80px 0px -60% 0px' });
    SECTIONS.forEach((s) => { const el = document.getElementById(`sec-${s.id}`); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const jump = useCallback((section: string, field?: string) => {
    if (section === 'vault') {
      const t = field?.startsWith('vault.') ? field.slice(6) : '';
      navigate(t === 'expired' ? '/vault?status=expired' : t && t !== 'financials' ? `/vault?upload=1&uploadType=${t}` : '/vault?upload=1');
      return;
    }
    const el = document.getElementById(`sec-${section}`);
    el?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    if (field) setTimeout(() => (document.getElementById(`f-${field}`) as HTMLElement | null)?.focus({ preventScroll: true }), 450);
  }, [navigate]);

  if (profile.isError) return <><PageHeader title="Company profile" /><ErrorState error={profile.error} onRetry={() => profile.refetch()} /></>;
  if (!draft || !saved) return <><PageHeader title="Company profile" description="Statutory details, registrations, financials and experience used to score every tender." /><ProfileSkeleton /></>;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setServerErrors((e) => { const n = { ...e }; Object.keys(n).filter((x) => x.split('.')[0] === k).forEach((x) => delete n[x]); return n; }); };
  const onBlur = (e: React.FocusEvent) => { const id = (e.target as HTMLElement).id; if (id?.startsWith('f-')) setBlurred((b) => (b.has(id.slice(2)) ? b : new Set(b).add(id.slice(2)))); };
  const txt = (k: keyof Draft) => ((draft[k] as string | null) ?? '');

  const submit = () => {
    setSubmitted(true);
    const errs = validate(draft);
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0]!;
      toast.error('Please fix the highlighted fields', { description: errs[first] });
      jump(sectionOf(first), first.split('.')[0]);
      return;
    }
    save.mutate({ ...draft, expectedUpdatedAt: profile.data!.profile.updatedAt } as unknown as ProfileInput, {
      onSuccess: (r) => {
        setDraft(stripMeta(r.profile)); setSubmitted(false); setBlurred(new Set()); setServerErrors({}); setConflict(null);
        toast.success('Profile saved', { description: `${r.completeness}% complete${r.issues[0] ? ` · next: ${r.issues[0].message}` : ''}` });
      },
      onError: (e) => {
        if (e instanceof ApiError && e.isConflict) { setConflict(e.message); toast.error(e.message); return; }
        if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'fields' in e.details) setServerErrors((e.details as { fields: Record<string, string> }).fields);
        toast.error(errorMessage(e));
      },
    });
  };
  const discard = () => { setDraft(saved); setSubmitted(false); setBlurred(new Set()); setServerErrors({}); };
  // Replace the (stale) draft with the latest saved profile only when the user asks to (FR-014).
  const reload = async () => {
    setReloading(true);
    const r = await profile.refetch();
    setReloading(false);
    if (!r.data) { toast.error(errorMessage(r.error)); return; }
    const fresh = stripMeta(r.data.profile);
    prevSaved.current = fresh;
    setDraft(fresh); setSubmitted(false); setBlurred(new Set()); setServerErrors({}); setConflict(null);
  };

  // Smart helpers from GSTIN
  const gstOk = !!draft.gstin && !validateGstin(draft.gstin);
  const gstPan = gstOk ? gstinPan(draft.gstin!) : null;
  const gstStateName = gstOk ? gstinState(draft.gstin!) : null;
  const canAutofill = gstOk && ((!draft.pan && gstPan) || (!draft.state && gstStateName && (INDIAN_STATES as readonly string[]).includes(gstStateName)));
  const autofill = () => setDraft((d) => d && ({ ...d, pan: d.pan || gstPan, state: d.state || (gstStateName && (INDIAN_STATES as readonly string[]).includes(gstStateName) ? gstStateName : d.state) }));
  const panType = draft.pan ? panEntityType(draft.pan) : null;
  const isMse = draft.mseCategory != null || !!draft.udyamNumber;
  const percent = live?.percent ?? profile.data!.completeness;

  return (
    <div onBlurCapture={onBlur}>
      <PageHeader
        title="Company profile"
        description="Statutory details, registrations, financials and experience — used to score every tender and fill your annexures."
        actions={
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">{profile.data!.profile.updatedAt ? `Saved ${relativeTime(profile.data!.profile.updatedAt)}` : 'Not saved yet'}</span>
            {!readOnly && <Button onClick={submit} loading={save.isPending} disabled={!dirty}><Save />Save profile</Button>}
          </div>
        }
      />

      {conflict && !readOnly && (
        <div role="alert" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-danger/40 bg-danger-soft/60 px-4 py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1">{conflict}</span>
          <Button size="sm" variant="secondary" onClick={reload} loading={reloading}><RefreshCw />Reload</Button>
        </div>
      )}

      {readOnly && (
        <div className="mb-6 flex items-center gap-2.5 rounded-xl border bg-info-soft/60 px-4 py-3 text-sm"><Eye className="size-4 shrink-0 text-info" aria-hidden />You have view-only access. Ask an owner or bid manager to make changes.</div>
      )}

      {/* Phone/tablet: section pills + compact meter */}
      <div className="sticky top-14 z-10 -mx-4 mb-4 border-b bg-background/90 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:hidden">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => jump('identity')} className="flex shrink-0 items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-xs font-semibold focus-ring" aria-label={`Profile ${percent}% complete`}>
            <span className="scale-[0.42] -m-[22px]"><Ring value={percent} /></span>{percent}%
          </button>
          <nav aria-label="Profile sections" className="-mr-4 flex gap-1.5 overflow-x-auto pr-4 scrollbar-thin">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => jump(s.id)} aria-current={active === s.id ? 'true' : undefined}
                className={cn('h-7 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-ring', active === s.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                {s.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_19rem]">
        {/* Desktop section nav */}
        <nav aria-label="Profile sections" className="hidden lg:block">
          <ul className="sticky top-20 grid gap-0.5">
            {SECTIONS.map((s) => {
              const n = live?.issues.filter((i) => i.section === s.id && i.severity !== 'info').length ?? 0;
              const hasErr = Object.keys(errors).some((k) => sectionOf(k) === s.id);
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => jump(s.id)} aria-current={active === s.id ? 'true' : undefined}
                    className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors focus-ring',
                      active === s.id ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <s.icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{s.label}</span>
                    {hasErr ? <span className="size-2 rounded-full bg-danger" aria-label="has errors" /> : n > 0 ? <span className="text-2xs tabular text-muted-foreground">{n}</span> : null}
                  </button>
                </li>
              );
            })}
            <li className="mt-4 xl:hidden"><CompletenessCard percent={percent} issues={live?.issues ?? []} onJump={jump} className="p-3" /></li>
          </ul>
        </nav>

        <fieldset disabled={readOnly} className="grid min-w-0 gap-6">
          <legend className="sr-only">Company profile</legend>

          <SectionCard id="identity" icon={Building2} title="Company identity" description="Exactly as registered on GeM and in your GST certificate."
            aside={canAutofill && !readOnly ? <Button type="button" size="sm" variant="secondary" onClick={autofill}><Wand2 />Fill from GSTIN</Button> : undefined}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Legal name" required error={errors.legalName} className="sm:col-span-2">
                <Input id="f-legalName" value={draft.legalName} onChange={(e) => set('legalName', e.target.value)} placeholder="e.g. Sharma Infotech Private Limited" autoComplete="organization" />
              </Field>
              <Field label="Trade name" error={errors.tradeName} hint="If different from the legal name">
                <Input id="f-tradeName" value={txt('tradeName')} onChange={(e) => set('tradeName', e.target.value)} />
              </Field>
              <Field label="Incorporation date" error={errors.incorporationDate}>
                <Input id="f-incorporationDate" type="date" value={txt('incorporationDate')} onChange={(e) => set('incorporationDate', e.target.value || null)} max={new Date().toISOString().slice(0, 10)} />
              </Field>
              <Field label="GSTIN" error={errors.gstin} hint={gstOk ? <span className="text-success">✓ Valid · {gstStateName} · PAN {gstPan}</span> : '15 characters, e.g. 27AAPCS1234K1Z2'}>
                <Input id="f-gstin" value={txt('gstin')} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} className="font-mono uppercase tracking-wider" placeholder="27AAPCS1234K1Z2" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="PAN" error={errors.pan} hint={panType && !errors.pan ? <span className="text-success">✓ {panType}</span> : '10 characters, e.g. AAPCS1234K'}>
                <Input id="f-pan" value={txt('pan')} onChange={(e) => set('pan', e.target.value.toUpperCase())} maxLength={10} className="font-mono uppercase tracking-wider" placeholder="AAPCS1234K" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="CIN" error={errors.cin} hint="Companies and LLPs only (LLPIN not required)">
                <Input id="f-cin" value={txt('cin')} onChange={(e) => set('cin', e.target.value.toUpperCase())} maxLength={21} className="font-mono uppercase tracking-wider" placeholder="U72200MH2015PTC123456" spellCheck={false} />
              </Field>
              <Field label="Max EMD you can furnish" error={errors.maxEmdCapacity} hint="Bids above this need an EMD exemption or a bank guarantee">
                <RupeeInput id="f-maxEmdCapacity" value={draft.maxEmdCapacity} onChange={(v) => set('maxEmdCapacity', v)} placeholder="Optional" />
              </Field>
              <Field label="Registered address" error={errors.address} className="sm:col-span-2">
                <Textarea id="f-address" value={txt('address')} onChange={(e) => set('address', e.target.value)} rows={2} autoComplete="street-address" />
              </Field>
              <Field label="State" error={errors.state}>
                <Select id="f-state" value={draft.state ?? undefined} onValueChange={(v) => set('state', v)} placeholder="Choose a state / UT" options={INDIAN_STATES.map((s) => ({ value: s, label: s }))} />
              </Field>
              <Field label="PIN code" error={errors.pincode}>
                <Input id="f-pincode" value={txt('pincode')} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="411001" autoComplete="postal-code" />
              </Field>
            </div>
          </SectionCard>

          <SectionCard id="registrations" icon={BadgeCheck} title="Registrations & status" description="Unlocks EMD exemptions, purchase preference and relaxed eligibility criteria.">
            <div className="grid gap-6">
              <div className="grid gap-4 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold">Micro & Small Enterprise (MSE)
                      <Explain label="MSE">Udyam-registered Micro and Small Enterprises are exempt from EMD and get 15% purchase preference under the Public Procurement Policy for MSEs, 2012. Medium enterprises are not eligible for these benefits.</Explain>
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">Registered on the Udyam portal</p>
                  </div>
                  <Switch checked={isMse} aria-label="We are a registered MSE" onCheckedChange={(on) => setDraft((d) => d && ({ ...d, mseCategory: on ? (d.mseCategory ?? 'small') : null, udyamNumber: on ? d.udyamNumber : null, mseSocialCategory: on ? d.mseSocialCategory : null }))} />
                </div>
                {isMse && (
                  <div className="grid gap-4 animate-fade-in sm:grid-cols-2">
                    <Field label="Udyam registration number" error={errors.udyamNumber} className="sm:col-span-2">
                      <Input id="f-udyamNumber" value={txt('udyamNumber')} onChange={(e) => set('udyamNumber', e.target.value.toUpperCase())} className="font-mono uppercase tracking-wider" placeholder="UDYAM-MH-26-0123456" maxLength={19} spellCheck={false} />
                    </Field>
                    <Field label="Enterprise category" error={errors.mseCategory}>
                      <Segmented aria-label="Enterprise category" value={draft.mseCategory ?? 'small'} onChange={(v) => set('mseCategory', v)} options={MSE_CATEGORIES.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))} />
                    </Field>
                    <Field label="Owner category" error={errors.mseSocialCategory} hint="SC/ST and women-owned MSEs have reserved procurement targets">
                      <Select id="f-mseSocialCategory" value={draft.mseSocialCategory ?? 'general'} onValueChange={(v) => set('mseSocialCategory', v as Draft['mseSocialCategory'])} options={MSE_SOCIAL_CATEGORIES.map((c) => ({ value: c, label: c === 'sc_st' ? 'SC / ST' : c === 'women' ? 'Women-owned' : 'General' }))} />
                    </Field>
                    {draft.mseCategory === 'medium' && <p className="flex items-start gap-2 text-xs text-warning sm:col-span-2"><Info className="mt-0.5 size-3.5 shrink-0" />Medium enterprises don’t get EMD exemption or MSE purchase preference.</p>}
                  </div>
                )}
              </div>

              <div className="grid gap-4 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Rocket className="size-4 text-accent" aria-hidden />Startup (DPIIT recognised)
                      <Explain label="DPIIT startup">DPIIT-recognised startups are exempt from EMD and, where the buyer allows it, from prior turnover and experience criteria in GeM bids.</Explain>
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">Recognised by the Department for Promotion of Industry and Internal Trade</p>
                  </div>
                  <Switch checked={draft.isStartup} aria-label="We are a DPIIT-recognised startup" onCheckedChange={(on) => set('isStartup', on)} />
                </div>
                {draft.isStartup && (
                  <Field label="DPIIT recognition number" error={errors.dpiitNumber} className="animate-fade-in sm:max-w-sm">
                    <Input id="f-dpiitNumber" value={txt('dpiitNumber')} onChange={(e) => set('dpiitNumber', e.target.value.toUpperCase())} className="font-mono uppercase" placeholder="DIPP12345" />
                  </Field>
                )}
              </div>

              <div className="grid gap-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Flag className="size-4 text-accent" aria-hidden />Make in India (MII) class
                  <Explain label="Make in India class">Under the Public Procurement (Preference to Make in India) Order 2017, Class-I local suppliers (≥ 50% local content) get purchase preference; Class-II (≥ 20%) can participate; Non-local suppliers (&lt; 20%) are barred from many bids under ₹200 crore.</Explain>
                </h3>
                <div role="radiogroup" aria-label="Make in India class" className="grid gap-3 sm:grid-cols-3">
                  {MII_CLASSES.map((c) => (
                    <ChoiceCard key={c} selected={draft.miiClass === c} disabled={readOnly} onSelect={() => set('miiClass', c)} title={MII_CLASS_INFO[c].short}
                      badge={<Badge size="sm" tone={c === 'class_1' ? 'success' : c === 'class_2' ? 'info' : 'neutral'} className="w-fit">{c === 'class_1' ? '≥ 50% local content' : c === 'class_2' ? '20% – 50% local content' : '< 20% local content'}</Badge>}>
                      {MII_CLASS_INFO[c].description}
                    </ChoiceCard>
                  ))}
                </div>
                {draft.miiClass && draft.miiClass !== 'non_local' && (
                  <Field label="Local content (%)" error={errors.localContentPct} hint="As declared in your MII self-certificate" className="sm:max-w-[14rem]">
                    <Input id="f-localContentPct" type="number" min={0} max={100} step="0.1" value={draft.localContentPct ?? ''} onChange={(e) => set('localContentPct', e.target.value === '' ? null : Number(e.target.value))} trailing={<span className="text-xs">%</span>} />
                  </Field>
                )}
              </div>

              <Field label="Quality certifications" error={errors.certifications} hint="Press Enter to add · upload the certificates to the vault for expiry tracking">
                <ChipInput id="f-certifications" value={draft.certifications} onChange={(v) => set('certifications', v)} suggestions={CERT_SUGGESTIONS} placeholder="e.g. ISO 9001:2015" tone="neutral" />
              </Field>
            </div>
          </SectionCard>

          <SectionCard id="financials" icon={IndianRupee} title="Financials" description="Turnover per financial year (April–March), from audited statements. Bids usually check the last 3 years’ average.">
            <FinancialsEditor value={draft.financials} onChange={(v) => set('financials', v)} errors={errors} disabled={readOnly} />
          </SectionCard>

          <SectionCard id="experience" icon={Briefcase} title="Experience" description="Completed orders with values. Matched against “similar work” criteria in every bid. Saved instantly.">
            <PastContracts />
          </SectionCard>

          <SectionCard id="oem" icon={Handshake} title="OEM authorisations" description="Manufacturer authorisation forms (MAF) for brands you resell.">
            <OemEditor value={draft.oemAuthorizations} onChange={(v) => set('oemAuthorizations', v)} errors={errors} disabled={readOnly} />
          </SectionCard>

          <SectionCard id="categories" icon={Layers} title="Categories & reach" description="What you sell and where — used to match tenders and score location fit.">
            <div className="grid gap-5">
              <Field label="GeM categories / products" error={errors.categories} hint="Press Enter to add">
                <ChipInput id="f-categories" value={draft.categories} onChange={(v) => set('categories', v)} suggestions={CATEGORY_SUGGESTIONS} placeholder="e.g. Desktop Computers" />
              </Field>
              <Field label="HSN / SAC codes" error={errors.hsnCodes ?? Object.entries(errors).find(([k]) => k.startsWith('hsnCodes.'))?.[1]} hint="4, 6 or 8 digits">
                <ChipInput id="f-hsnCodes" value={draft.hsnCodes} onChange={(v) => set('hsnCodes', v)} placeholder="e.g. 8471" tone="neutral" validate={(s) => (/^\d{4}(\d{2}){0,2}$/.test(s) ? null : 'HSN/SAC codes have 4, 6 or 8 digits')} />
              </Field>
              <Field label="States you can deliver or serve in" error={errors.operatingStates}
                labelAside={!readOnly ? (
                  <span className="flex gap-2 text-xs">
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => set('operatingStates', [...INDIAN_STATES])}>All India</button>
                    {draft.operatingStates.length > 0 && <button type="button" className="text-muted-foreground hover:underline" onClick={() => set('operatingStates', [])}>Clear</button>}
                  </span>
                ) : undefined}>
                <div id="f-operatingStates">
                  {draft.operatingStates.length === INDIAN_STATES.length ? (
                    <Badge tone="primary" size="lg">All India · {INDIAN_STATES.length} states & UTs</Badge>
                  ) : (
                    <MultiSelect options={[...INDIAN_STATES]} value={draft.operatingStates} onChange={(v) => set('operatingStates', v)} placeholder="Choose states & union territories" label="States" />
                  )}
                </div>
              </Field>
            </div>
          </SectionCard>

          <SectionCard id="contact" icon={UserRoundPen} title="Signatory & contact" description="Printed on undertakings and annexures. The signatory still signs on GeM with their own DSC / e-Sign.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Authorised signatory" error={errors.signatoryName}>
                <Input id="f-signatoryName" value={txt('signatoryName')} onChange={(e) => set('signatoryName', e.target.value)} placeholder="Full name" autoComplete="name" />
              </Field>
              <Field label="Designation" error={errors.signatoryDesignation}>
                <Input id="f-signatoryDesignation" value={txt('signatoryDesignation')} onChange={(e) => set('signatoryDesignation', e.target.value)} placeholder="e.g. Director" />
              </Field>
              <Field label="Contact person" error={errors.contactName}>
                <Input id="f-contactName" value={txt('contactName')} onChange={(e) => set('contactName', e.target.value)} />
              </Field>
              <Field label="Contact email" error={errors.contactEmail}>
                <Input id="f-contactEmail" type="email" value={txt('contactEmail')} onChange={(e) => set('contactEmail', e.target.value)} placeholder="bids@company.in" autoComplete="email" />
              </Field>
              <Field label="Mobile number" error={errors.contactPhone} hint="Indian mobile; saved as +91…">
                <Input id="f-contactPhone" type="tel" value={txt('contactPhone')} onChange={(e) => set('contactPhone', e.target.value)} placeholder="98123 45678" autoComplete="tel" leading={<span className="text-xs font-medium">🇮🇳</span>} />
              </Field>
            </div>
          </SectionCard>

          <p className="text-center text-xs text-muted-foreground">
            Documents backing this profile live in the <Link to="/vault" className="font-medium text-primary hover:underline">document vault</Link>.
          </p>
        </fieldset>

        <aside className="hidden xl:block">
          <div className="sticky top-20"><CompletenessCard percent={percent} issues={live?.issues ?? []} onJump={jump} /></div>
        </aside>
      </div>

      {!readOnly && createPortal(
        <div
          className={cn('fixed inset-x-0 z-30 flex justify-center px-4 transition-all duration-300 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] md:bottom-5',
            dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-6 opacity-0')}
          aria-hidden={!dirty}
        >
          <div role="region" aria-label="Unsaved changes" className="flex w-full max-w-xl items-center gap-3 rounded-2xl border bg-popover/95 py-2 pl-4 pr-2 shadow-xl backdrop-blur-xl md:ml-[248px]">
            <span className="relative flex size-2.5 shrink-0"><span className="absolute inset-0 animate-ping rounded-full bg-accent/60" /><span className="relative size-2.5 rounded-full bg-accent" /></span>
            <p className="min-w-0 flex-1 truncate text-sm font-medium">Unsaved changes{Object.keys(clientErrors).length ? <span className="ml-1 text-xs font-normal text-danger">· {Object.keys(clientErrors).length} to fix</span> : null}</p>
            <Button variant="ghost" size="sm" onClick={discard} tabIndex={dirty ? 0 : -1}><RotateCcw />Discard</Button>
            <Button size="sm" onClick={submit} loading={save.isPending} tabIndex={dirty ? 0 : -1}><Save />Save</Button>
          </div>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => { if (!o && blocker.state === 'blocked') blocker.reset(); }}
        title="Discard unsaved changes?"
        description="Your edits to the company profile have not been saved."
        cancelLabel="Stay"
        confirmLabel="Discard and leave"
        onConfirm={() => { if (blocker.state === 'blocked') blocker.proceed(); }}
      />
    </div>
  );
}

function sectionOf(key: string): string {
  const top = key.split('.')[0]!;
  if (top === 'financials') return 'financials';
  if (top === 'oemAuthorizations') return 'oem';
  if (['categories', 'hsnCodes', 'operatingStates'].includes(top)) return 'categories';
  if (['signatoryName', 'signatoryDesignation', 'contactName', 'contactEmail', 'contactPhone'].includes(top)) return 'contact';
  if (['udyamNumber', 'mseCategory', 'mseSocialCategory', 'isStartup', 'dpiitNumber', 'miiClass', 'localContentPct', 'certifications'].includes(top)) return 'registrations';
  return 'identity';
}
