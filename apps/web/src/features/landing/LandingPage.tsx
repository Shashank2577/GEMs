/**
 * Marketing landing page (T076) at "/" for signed-out visitors: hero with a crafted product mock, who it's for,
 * Identify / Analyse / Apply, the human-in-the-loop compliance promise, metrics, persona tabs, pricing, FAQ.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import * as Accordion from '@radix-ui/react-accordion';
import {
  ArrowRight, BadgeCheck, BellRing, Briefcase, Building2, Check, CheckCircle2, ChevronDown, Clock, Cpu, FileCheck2, FileSearch, FileStack,
  Fingerprint, Gauge, Hand, IndianRupee, KeyRound, Layers, Lock, Menu, MessageCircle, Radar, ScanText, ShieldCheck, Smartphone, Sparkles,
  Users, X,
} from 'lucide-react';
import { dropLandingShell } from './shell';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Badge, Button, Countdown, Progress, ScoreRing, Tabs, TabsContent, TabsList, TabsTrigger, VerdictBadge } from '@/components/ui';
import { PLANS, PRICING_NOTE, formatPlanPrice, planCtaHref } from '@tp/core/contracts/plans';
import { useDocumentTitle } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export const LANDING_TITLE = 'TenderPilot — GeM tender co-pilot for Indian sellers';

/** Labels for the sign-in / sign-up buttons in the nav bar and the mobile menu. */
export const AUTH_LABELS = { signIn: 'Sign in', signUp: 'Start free trial' } as const;

export const NAV = [
  { href: '#how', label: 'How it works' },
  { href: '#control', label: 'Compliance' },
  { href: '#teams', label: 'For teams' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} initial={reduce ? false : { opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }} transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}>
      {children}
    </motion.div>
  );
}

function SectionHead({ eyebrow, title, body, center = true }: { eyebrow: string; title: ReactNode; body?: ReactNode; center?: boolean }) {
  return (
    <Reveal className={cn('max-w-2xl', center && 'mx-auto text-center')}>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base text-muted-foreground sm:text-lg">{body}</p>}
    </Reveal>
  );
}

export default function LandingPage() {
  useDocumentTitle(LANDING_TITLE, { raw: true });
  useEffect(dropLandingShell, []);
  return (
    <div className="min-h-dvh overflow-x-hidden bg-background text-foreground">
      <SiteNav />
      <main>
        <Hero />
        <BuiltFor />
        <HowItWorks />
        <Control />
        <Metrics />
        <Personas />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

// ───────────── Nav ─────────────

function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={cn('sticky top-0 z-40 transition-[background-color,border-color,box-shadow] duration-200',
      scrolled || open ? 'border-b bg-background/85 shadow-xs backdrop-blur-md' : 'border-b border-transparent')}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" className="rounded-md focus-ring" aria-label="TenderPilot home"><Logo /></Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => <a key={n.href} href={n.href} className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-ring">{n.label}</a>)}
        </nav>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <Button variant="ghost" className="hidden sm:inline-flex" asChild><Link to="/login">{AUTH_LABELS.signIn}</Link></Button>
          <Button className="hidden sm:inline-flex" asChild><Link to="/signup">{AUTH_LABELS.signUp}</Link></Button>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <X /> : <Menu />}
          </Button>
        </div>
      </div>
      {open && (
        <nav aria-label="Mobile" className="border-t px-4 pb-4 pt-2 md:hidden">
          <ul className="grid gap-1">
            {NAV.map((n) => <li key={n.href}><a href={n.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted focus-ring">{n.label}</a></li>)}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="secondary" asChild><Link to="/login">{AUTH_LABELS.signIn}</Link></Button>
            <Button asChild><Link to="/signup">{AUTH_LABELS.signUp}</Link></Button>
          </div>
        </nav>
      )}
    </header>
  );
}

// ───────────── Hero ─────────────

function Hero() {
  const closing = new Date(Date.now() + (2 * 24 + 5) * 3_600_000);
  return (
    <section className="relative">
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" aria-hidden />
      <div className="pointer-events-none absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-24">
        <div>
          <a href="#control" className="inline-flex items-center gap-2 rounded-full border bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur hover:text-foreground focus-ring">
            <ShieldCheck className="size-3.5 text-success" /> Account-safe: never auto-submits on GeM <ArrowRight className="size-3" />
          </a>
          <h1 className="mt-6 text-[40px] font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Win more GeM bids. <span className="text-gradient">Spend minutes, not nights,</span> on each one.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">
            TenderPilot watches BidPlus for the bids you can win, checks your eligibility against every clause, and assembles the exact
            document packet GeM asks for. You keep the price, OTP and DSC.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button size="lg" asChild><Link to="/signup">Start free trial <ArrowRight /></Link></Button>
            <Button size="lg" variant="secondary" asChild><a href="#how">See how it works</a></Button>
          </div>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
            {['14-day free trial', 'No card needed', 'Set up in 5 minutes'].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-success" />{t}</li>
            ))}
          </ul>
        </div>
        {/* Above the fold: no opacity-0 entrance animation, so the hero paints (LCP) without waiting on motion/JS (007/NFR-003). */}
        <div><ProductMock closing={closing} /></div>
      </div>
    </section>
  );
}

function ProductMock({ closing }: { closing: Date }) {
  return (
    <div className="relative mx-auto w-full max-w-[520px] lg:mt-8" aria-label="Product preview" role="img">
      {/* Tender feed card */}
      <div className="rounded-2xl border bg-card p-4 shadow-xl sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <Badge tone="primary" size="sm"><Radar /> New match · CCTV & surveillance</Badge>
          <Countdown to={closing} compact />
        </div>
        <p className="mt-3 text-[15px] font-semibold leading-snug">CCTV Camera – IP Bullet 4 MP with IR, PoE (MII compliant) — 240 nos</p>
        <p className="mt-1 text-xs text-muted-foreground"><span className="font-mono">GEM/2026/B/6431012</span> · CRPF, Gandhinagar, Gujarat</p>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-3 text-xs">
          {[['Est. value', '₹17.9 L'], ['EMD', '₹35,800'], ['Bid type', 'Bid']].map(([k, v]) => (
            <div key={k}><p className="text-2xs uppercase tracking-wider text-muted-foreground">{k}</p><p className="mt-0.5 font-semibold tabular">{v}</p></div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {['Keyword “cctv”', 'State: Gujarat', 'Value ₹17.9 L'].map((r) => <Badge key={r} tone="outline" size="sm">{r}</Badge>)}
        </div>
      </div>
      {/* Score card */}
      <div className="relative -mt-2 ml-6 rounded-2xl border bg-card p-4 shadow-xl sm:ml-16 sm:p-5">
        <div className="flex items-center gap-4">
          <ScoreRing score={82} verdict="go" size={76} />
          <div className="min-w-0">
            <div className="flex items-center gap-2"><p className="text-sm font-semibold">Eligibility</p><VerdictBadge verdict="go" size="sm" /></div>
            <ul className="mt-2 grid gap-1 text-xs">
              {[
                ['pass', 'Avg turnover ₹2.49 Cr ≥ ₹1.1 Cr'],
                ['pass', 'EMD exempt — micro enterprise'],
                ['warn', 'ISO 9001 renews in 10 days'],
              ].map(([s, t]) => (
                <li key={t} className="flex items-center gap-1.5">
                  {s === 'pass' ? <CheckCircle2 className="size-3.5 shrink-0 text-success" /> : <Clock className="size-3.5 shrink-0 text-warning" />}
                  <span className="truncate text-muted-foreground">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      {/* Packet checklist */}
      <div className="relative -mt-4 mr-4 rounded-2xl border bg-card p-4 shadow-xl sm:mr-10 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold"><FileStack className="size-4 text-primary" /> Bid packet</p>
          <span className="text-xs font-medium tabular text-muted-foreground">9 / 10 ready</span>
        </div>
        <Progress value={90} tone="success" size="sm" className="mt-2" />
        <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {['GST certificate', 'Balance sheets ×3', 'CRAC – PMC CCTV', 'MII self-certificate', 'EMD exemption', 'OEM authorisation'].map((d, i) => (
            <li key={d} className="flex items-center gap-1.5 truncate">
              {i === 5 ? <Clock className="size-3.5 shrink-0 text-warning" /> : <Check className="size-3.5 shrink-0 text-success" />}<span className="truncate">{d}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-2xs text-muted-foreground">
          <Hand className="size-3.5 shrink-0 text-primary" /> Price, OTP & DSC: you, on GeM.
        </div>
      </div>
      {/* WhatsApp toast */}
      <div className="absolute -right-2 -top-14 hidden w-56 rounded-xl border bg-card p-3 shadow-lg sm:block lg:-right-8">
        <p className="flex items-center gap-1.5 text-2xs font-semibold text-success"><MessageCircle className="size-3.5" /> WhatsApp · now</p>
        <p className="mt-1 text-xs leading-snug">Closes in 6 h: NVR for Pune Police. Packet is ready — submit on GeM.</p>
      </div>
    </div>
  );
}

// ───────────── Built for ─────────────

function BuiltFor() {
  const items = [
    { icon: Building2, label: 'MSMEs & Udyam sellers' },
    { icon: Cpu, label: 'OEMs & authorised resellers' },
    { icon: Layers, label: 'System integrators' },
    { icon: Briefcase, label: 'Service providers' },
    { icon: Users, label: 'Bid consultants' },
  ];
  return (
    <section aria-label="Who it's for" className="border-y bg-subtle/60">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Built for MSMEs, OEMs and resellers on GeM</p>
        <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
          {items.map((i) => (
            <li key={i.label} className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><i.icon className="size-4" />{i.label}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ───────────── How it works ─────────────

function HowItWorks() {
  const cols = [
    {
      icon: Radar, step: '01', title: 'Identify', tone: 'bg-primary-soft text-primary',
      body: 'Watchlists by keyword, category, HSN, state, ministry and value. New BidPlus bids are matched every 30 minutes.',
      points: ['Instant WhatsApp, email or in-app alerts', 'Daily digest for busy owners', 'Corrigendum tracking on bids you follow'],
    },
    {
      icon: ScanText, step: '02', title: 'Analyse', tone: 'bg-accent-soft text-accent',
      body: 'Bid PDFs, ATC and corrigenda are read for you. Every requirement is checked against your company profile.',
      points: ['Weighted Go / No-Go score with reasons', 'Turnover, experience, EMD, MSE, Startup, MII Class-I/II', 'Each clause linked to its page in the bid'],
    },
    {
      icon: FileCheck2, step: '03', title: 'Apply', tone: 'bg-success-soft text-success',
      body: 'Your document vault fills the checklist. Undertakings are generated. One merged PDF, in the order GeM wants.',
      points: ['Expired certificates flagged before they block you', 'Annexures: MII, EMD exemption, non-blacklisting', 'Chrome co-pilot pre-fills non-financial fields'],
    },
  ];
  return (
    <section id="how" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHead eyebrow="How it works" title="From a new bid on GeM to a ready packet — in one flow"
          body="TenderPilot does the reading, matching and paperwork. You make the decisions that matter." />
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {cols.map((c, i) => (
            <Reveal key={c.title} delay={i * 0.08}>
              <article className="h-full rounded-2xl border bg-card p-6 shadow-xs transition-shadow hover:shadow-md">
                <div className="flex items-center justify-between">
                  <span className={cn('flex size-11 items-center justify-center rounded-xl', c.tone)}><c.icon className="size-5" /></span>
                  <span className="font-mono text-xs text-muted-foreground">{c.step}</span>
                </div>
                <h3 className="mt-5 text-xl font-semibold tracking-tight">{c.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
                <ul className="mt-5 grid gap-2.5 text-sm">
                  {c.points.map((p) => <li key={p} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{p}</li>)}
                </ul>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───────────── Compliance ─────────────

function Control() {
  const humans = [
    { icon: IndianRupee, t: 'Price entry', b: 'Your financial bid is typed by you, on GeM. We never store or suggest a price field.' },
    { icon: KeyRound, t: 'OTP, Aadhaar, e-Sign & DSC', b: 'Legal authentication always happens in your hands, on your device.' },
    { icon: Fingerprint, t: 'CAPTCHA & final submit', b: 'No bots on your seller account. A named person clicks Final Submit.' },
  ];
  return (
    <section id="control" className="scroll-mt-20 bg-sidebar py-20 text-sidebar-foreground sm:py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <SectionHead center={false} eyebrow="You stay in control" title="A co-pilot that never takes the wheel"
            body={<span className="text-sidebar-foreground/70">Automated logins and bot submissions get GeM seller accounts suspended. TenderPilot prepares everything up to the last click — and stops there, by design.</span>} />
          <Reveal className="mt-8 flex flex-wrap gap-2">
            {['Reads public BidPlus data only', 'Your GeM password is never asked for', 'Rate-limited, polite ingestion'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs"><ShieldCheck className="size-3.5 text-success" />{t}</span>
            ))}
          </Reveal>
        </div>
        <div className="grid gap-4">
          {humans.map((h, i) => (
            <Reveal key={h.t} delay={i * 0.08}>
              <div className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10"><h.icon className="size-5" /></span>
                <div>
                  <p className="flex items-center gap-2 font-semibold">{h.t}<Badge size="sm" className="border-white/15 bg-white/10 text-sidebar-foreground"><Hand /> Always human</Badge></p>
                  <p className="mt-1 text-sm text-sidebar-foreground/70">{h.b}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───────────── Metrics ─────────────

function Metrics() {
  const m = [
    { v: '3 hrs → 10 min', l: 'to assemble a bid packet' },
    { v: '30 min', l: 'from GeM publish to your alert' },
    { v: '20+', l: 'eligibility clauses checked per bid' },
    { v: '0', l: 'bids submitted without a human' },
  ];
  return (
    <section aria-label="Results" className="border-b py-14">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 sm:px-6 lg:grid-cols-4">
        {m.map((x, i) => (
          <Reveal key={x.l} delay={i * 0.05} className="text-center">
            <p className="text-3xl font-semibold tracking-tight sm:text-4xl"><span className="text-gradient">{x.v}</span></p>
            <p className="mt-2 text-sm text-muted-foreground">{x.l}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ───────────── Personas ─────────────

export const PERSONAS = [
  {
    key: 'owner', label: 'Owner', icon: Smartphone, title: 'Know what’s worth bidding — from your phone',
    body: 'A morning dashboard with new matches, bids closing this week, EMD at stake and your win rate. WhatsApp nudges for anything urgent.',
    points: ['Win rate and pipeline value at a glance', 'Approve Go / No-Go in one tap', 'Expiring certificates before they cost you a bid'],
  },
  {
    key: 'bm', label: 'Bid Manager', icon: Briefcase, title: 'Run every bid like a well-oiled pipeline',
    body: 'Kanban from Identified to Won, owners and due dates, comments, and a hard stop before “Ready” if a mandatory document is missing or expired.',
    points: ['Drag-and-drop pipeline with readiness', 'Override with a reason — fully audited', 'Tune scoring weights to your strategy'],
  },
  {
    key: 'an', label: 'Analyst', icon: FileSearch, title: 'Stop reading 40-page bid PDFs line by line',
    body: 'Requirements are extracted with the page and quote they came from, so you verify in seconds instead of hunting through the ATC.',
    points: ['Turnover, experience, EMD, MII, OEM clauses', 'Rules-first, AI-assisted, always explainable', 'Required-documents checklist per bid'],
  },
  {
    key: 'co', label: 'Compliance', icon: BadgeCheck, title: 'Every certificate valid, every undertaking right',
    body: 'One vault for GST, PAN, Udyam, balance sheets, OEM authorisations and CRACs — with expiry tracking and generated annexures in your letterhead format.',
    points: ['30 / 7 / 1-day expiry reminders', 'Activity log of who did what, when', 'Role-based access for auditors (view-only)'],
  },
];

function Personas() {
  return (
    <section id="teams" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHead eyebrow="For the whole team" title="One workspace, the right view for every role" />
        <Reveal className="mt-10">
          <Tabs defaultValue="owner">
            <TabsList variant="pill" className="mx-auto flex w-full max-w-xl overflow-x-auto">
              {PERSONAS.map((p) => <TabsTrigger key={p.key} value={p.key} className="flex-1 gap-1.5"><p.icon className="size-4" />{p.label}</TabsTrigger>)}
            </TabsList>
            {PERSONAS.map((p) => (
              <TabsContent key={p.key} value={p.key} className="mt-8">
                <div className="grid items-center gap-8 rounded-3xl border bg-card p-6 shadow-sm sm:p-10 lg:grid-cols-2">
                  <div>
                    <h3 className="text-2xl font-semibold tracking-tight">{p.title}</h3>
                    <p className="mt-3 text-muted-foreground">{p.body}</p>
                    <ul className="mt-6 grid gap-3">
                      {p.points.map((x) => <li key={x} className="flex gap-2.5 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />{x}</li>)}
                    </ul>
                  </div>
                  <PersonaVisual k={p.key} />
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </Reveal>
      </div>
    </section>
  );
}

function PersonaVisual({ k }: { k: string }) {
  if (k === 'owner') {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[['New matches today', '12', Radar], ['Closing this week', '7', Clock], ['EMD at stake', '₹4.6 L', IndianRupee], ['Win rate', '67%', Gauge]].map(([l, v, I]) => {
          const Icon = I as typeof Radar;
          return (
            <div key={l as string} className="rounded-xl border bg-subtle/60 p-4">
              <div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">{l as string}</p><Icon className="size-4 text-primary" /></div>
              <p className="mt-2 text-2xl font-semibold tabular tracking-tight">{v as string}</p>
            </div>
          );
        })}
      </div>
    );
  }
  if (k === 'bm') {
    return (
      <div className="grid grid-cols-3 gap-2 text-xs">
        {[['Go', 2, 'bg-success'], ['Preparing', 2, 'bg-primary'], ['Ready', 1, 'bg-accent']].map(([s, n, c]) => (
          <div key={s as string} className="rounded-xl border bg-subtle/60 p-2">
            <p className="mb-2 flex items-center gap-1.5 font-semibold"><span className={cn('size-1.5 rounded-full', c as string)} />{s as string}</p>
            {Array.from({ length: n as number }, (_, i) => (
              <div key={i} className="mb-2 rounded-lg border bg-card p-2 shadow-xs">
                <div className="h-2 w-4/5 rounded bg-muted" /><div className="mt-1.5 h-2 w-1/2 rounded bg-muted" />
                <Progress value={[60, 85, 100][i % 3]} tone="auto" size="sm" className="mt-2" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (k === 'an') {
    return (
      <div className="rounded-xl border bg-subtle/60 p-4 text-sm">
        {[
          ['Minimum average turnover', '₹1.1 Cr', 'p. 1'],
          ['Years of past experience', '3 years', 'p. 1'],
          ['EMD amount', '₹35,800', 'p. 2'],
          ['MII purchase preference', 'Yes', 'p. 2'],
          ['OEM authorisation', 'Required', 'p. 1'],
        ].map(([l, v, p]) => (
          <div key={l} className="flex items-center justify-between gap-3 border-b py-2 last:border-0">
            <span className="text-muted-foreground">{l}</span>
            <span className="flex items-center gap-2 font-medium">{v}<Badge size="sm" tone="outline">{p}</Badge></span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {[['GST certificate', 'Valid', 'success'], ['ISO 9001:2015', '10 days left', 'warning'], ['OEM authorisation – Dell', 'Expired', 'danger'], ['Udyam (Micro)', 'Valid', 'success']].map(([t, s, tone]) => (
        <div key={t} className="flex items-center justify-between rounded-xl border bg-subtle/60 px-4 py-3 text-sm">
          <span className="flex items-center gap-2 font-medium"><FileCheck2 className="size-4 text-muted-foreground" />{t}</span>
          <Badge size="sm" tone={tone as 'success' | 'warning' | 'danger'}>{s}</Badge>
        </div>
      ))}
    </div>
  );
}

// ───────────── Pricing ─────────────

function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-20 border-t bg-subtle/50 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHead eyebrow="Pricing" title="Pays for itself with one extra win" body={PRICING_NOTE} />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {PLANS.map((p, i) => (
            <Reveal key={p.key} delay={i * 0.06}>
              <div className={cn('relative flex h-full flex-col rounded-2xl border bg-card p-6 shadow-xs sm:p-8', p.featured && 'border-primary shadow-lg ring-1 ring-primary/30')}>
                {p.featured && <Badge tone="solid" className="absolute -top-3 left-6"><Sparkles /> Most popular</Badge>}
                <h3 className="text-lg font-semibold">{p.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{p.blurb}</p>
                <p className="mt-6 flex items-baseline gap-1"><span className="text-4xl font-semibold tracking-tight tabular">{formatPlanPrice(p)}</span>{p.monthlyInr != null && <span className="text-sm text-muted-foreground">/month</span>}</p>
                <ul className="mt-6 grid flex-1 content-start gap-2.5 text-sm">
                  {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{f}</li>)}
                </ul>
                <Button className="mt-8" variant={p.featured ? 'primary' : 'secondary'} size="lg" asChild>
                  {p.key === 'enterprise' ? <a href={planCtaHref(p)}>{p.cta}</a> : <Link to={planCtaHref(p)}>{p.cta}</Link>}
                </Button>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───────────── FAQ ─────────────

export const FAQ = [
  ['Will TenderPilot submit bids on GeM for me?', 'No — and that’s deliberate. GeM requires a human to enter the price and authenticate with Aadhaar OTP, e-Sign or a DSC. Automated submissions put seller accounts at risk. TenderPilot prepares everything else and hands you a ready packet.'],
  ['Do you need my GeM login?', 'Never. We read publicly listed BidPlus bids and documents. Your GeM credentials stay with you.'],
  ['How accurate is the Go / No-Go score?', 'Every verdict comes from deterministic rules you can see — turnover, experience, EMD, MSE/Startup exemptions, MII class, OEM authorisation and documents — each linked to the clause and page it came from. AI helps read unusual clauses, but never decides silently. You can override any factor with a reason.'],
  ['Which documents can the vault hold?', 'GST, PAN, Udyam, DPIIT, incorporation, balance sheets, ITRs, CA turnover certificates, OEM authorisations, CRACs and work orders, ISO/BIS, MII certificates, bank details, power of attorney, catalogues and test reports — with expiry tracking.'],
  ['Is my data safe?', 'Each organization’s profile, documents, scores and packets are isolated and visible only to its members, with role-based access. Files are stored privately and served through short-lived links.'],
  ['Can my CA or consultant use it?', 'Yes. Invite them with the right role — Analyst to prepare, Viewer for read-only review. Consultants managing several sellers can switch between organizations.'],
];

function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <SectionHead eyebrow="FAQ" title="Questions sellers ask us" />
        <Accordion.Root type="single" collapsible className="mt-10 divide-y rounded-2xl border bg-card">
          {FAQ.map(([q, a], i) => (
            <Accordion.Item key={i} value={`q${i}`}>
              <Accordion.Header>
                <Accordion.Trigger className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-[15px] font-medium focus-ring rounded-2xl">
                  {q}
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="overflow-hidden px-5 pb-5 text-sm text-muted-foreground data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
                {a}
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-4 pb-20 sm:px-6">
      <Reveal className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border bg-primary px-6 py-14 text-center text-primary-foreground shadow-xl sm:px-12">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-20" aria-hidden />
        <h2 className="relative text-3xl font-semibold tracking-tight sm:text-4xl">Your next GeM win is already published.</h2>
        <p className="relative mx-auto mt-3 max-w-xl text-primary-foreground/80">Set up in five minutes, see your first matches today. Explore with demo data before live bids arrive.</p>
        <div className="relative mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button size="lg" variant="secondary" asChild><Link to="/signup">Start free trial <ArrowRight /></Link></Button>
          <Button size="lg" variant="ghost" className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground" asChild><Link to="/login">Sign in</Link></Button>
        </div>
      </Reveal>
    </section>
  );
}

/** WCAG 2.5.8: footer links are standalone targets, so they get a 24px-tall hit area. */
const FOOTER_LINK = 'inline-flex min-h-6 items-center rounded-sm hover:text-foreground focus-ring';

function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">The GeM tender co-pilot for Indian sellers. Identify, analyse and prepare — you submit.</p>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3.5" /> Not affiliated with GeM or the Government of India.</p>
        </div>
        {[
          ['Product', [['How it works', '#how'], ['Pricing', '#pricing'], ['Compliance', '#control'], ['FAQ', '#faq']]],
          ['Get started', [['Start free trial', '/signup'], ['Sign in', '/login']]],
          ['Contact', [['sales@tenderpilot.in', 'mailto:sales@tenderpilot.in'], ['support@tenderpilot.in', 'mailto:support@tenderpilot.in']]],
        ].map(([h, links]) => (
          <div key={h as string}>
            <p className="text-sm font-semibold">{h as string}</p>
            <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
              {(links as string[][]).map(([l, href]) => (
                <li key={l}>{href!.startsWith('/') ? <Link to={href!} className={FOOTER_LINK}>{l}</Link> : <a href={href} className={FOOTER_LINK}>{l}</a>}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted-foreground sm:px-6">© {new Date().getFullYear()} TenderPilot. Made in India for MSMEs. <BellRing className="ml-1 inline size-3" /></p>
      </div>
    </footer>
  );
}
