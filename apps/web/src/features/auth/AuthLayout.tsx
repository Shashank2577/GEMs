import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { BellRing, CheckCircle2, FileCheck2, Hand, Lock, ShieldCheck, AlertTriangle, Sparkles, IndianRupee } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { ScoreRing, VerdictBadge } from '@/components/ui/verdict';
import { Badge } from '@/components/ui/badge';
import { useDocumentTitle } from '@/lib/hooks';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

const TRUST = [
  { icon: Hand, title: 'Never auto-submits', body: 'You stay in control of price entry, OTP and DSC.' },
  { icon: Lock, title: 'Your data, your org', body: 'Documents are private to your team and served by short-lived links.' },
  { icon: ShieldCheck, title: 'Public data only', body: 'We read public BidPlus listings politely — your GeM login is never stored.' },
];

export function AuthLayout({ title, subtitle, children, footer, docTitle }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; docTitle: string }) {
  useDocumentTitle(docTitle);
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10 lg:px-14 xl:px-20">
        <div className="flex items-center justify-between">
          <Link to="/" className="rounded-md focus-ring" aria-label="TenderPilot home"><Logo /></Link>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center py-10">
          <div className="mx-auto w-full max-w-[400px] animate-slide-up">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-8 text-center text-sm text-muted-foreground">{footer}</div>}
          </div>
        </div>
        <ul className="mx-auto grid w-full max-w-[400px] gap-3 border-t pt-5 lg:hidden">
          {TRUST.slice(0, 2).map((t) => (
            <li key={t.title} className="flex items-start gap-3 text-xs text-muted-foreground">
              <t.icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span><span className="font-medium text-foreground">{t.title}.</span> {t.body}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-center text-2xs text-muted-foreground lg:text-left">© {new Date().getFullYear()} TenderPilot · Not affiliated with GeM or the Government of India.</p>
      </div>
      <Showcase />
    </div>
  );
}

function Showcase() {
  const reduce = useReducedMotion();
  const rise = (delay: number) => (reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] as const } });
  return (
    <aside className="dark relative hidden overflow-hidden bg-background text-foreground lg:flex lg:flex-col" aria-label="Product preview">
      {/* backdrop */}
      <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_80%_-10%,hsl(243_80%_45%/0.55),transparent_60%),radial-gradient(800px_500px_at_0%_110%,hsl(33_96%_50%/0.20),transparent_60%)]" aria-hidden />
      <div className="bg-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" aria-hidden />

      <div className="relative flex flex-1 flex-col justify-center px-12 py-14 xl:px-16">
        <motion.div {...rise(0)} className="max-w-lg">
          <Badge tone="accent" size="md" className="mb-4"><Sparkles /> GeM BidPlus co-pilot</Badge>
          <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-[34px]">
            Win more GeM bids, with a co-pilot that <span className="text-gradient">never takes the wheel.</span>
          </h2>
        </motion.div>

        <div className="relative mt-10 max-w-xl">
          {/* Score card */}
          <motion.div {...rise(0.12)} className="relative z-10 rounded-2xl border bg-card/90 p-5 shadow-xl backdrop-blur">
            <div className="flex items-start gap-4">
              <ScoreRing score={84} verdict="go" size={76} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <VerdictBadge verdict="go" size="sm" />
                  <span className="text-2xs font-medium text-muted-foreground">GEM/2026/B/5823412</span>
                </div>
                <p className="mt-1.5 truncate text-[15px] font-semibold">Supply of Desktop Computers (Q2)</p>
                <p className="truncate text-xs text-muted-foreground">Ministry of Defence · Pune, Maharashtra</p>
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1 font-medium"><IndianRupee className="size-3" />2.4 Cr est.</span>
                  <span className="text-danger">● Closes in 2d 4h</span>
                </div>
              </div>
            </div>
            <ul className="mt-4 grid gap-2 border-t pt-4 text-[13px]">
              {[
                { ok: 'yes', label: 'Avg. turnover ₹3.1 Cr ≥ required ₹1.5 Cr' },
                { ok: 'yes', label: '4 similar past orders (needs 3 years)' },
                { ok: 'yes', label: 'EMD exempt — MSE (Udyam verified)' },
                { ok: 'warn', label: 'OEM authorization expires in 12 days' },
              ].map((r) => (
                <li key={r.label} className="flex items-center gap-2.5">
                  {r.ok === 'yes' ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <AlertTriangle className="size-4 shrink-0 text-warning" />}
                  <span className="text-foreground/90">{r.label}</span>
                </li>
              ))}
            </ul>
          </motion.div>

          {/* Alert chip */}
          <motion.div {...rise(0.3)} className="absolute -right-4 -top-8 z-20 flex items-center gap-3 rounded-xl border bg-popover/95 px-3.5 py-2.5 shadow-lg backdrop-blur xl:-right-10">
            <span className="flex size-8 items-center justify-center rounded-lg bg-success-soft text-success"><BellRing className="size-4" /></span>
            <div>
              <p className="text-xs font-semibold">3 new matches</p>
              <p className="text-2xs text-muted-foreground">Sent to WhatsApp · 9:02 am</p>
            </div>
          </motion.div>

          {/* Packet chip */}
          <motion.div {...rise(0.42)} className="relative z-0 -mt-3 ml-8 mr-6 rounded-b-2xl border border-t-0 bg-card/60 px-5 pb-3 pt-6 backdrop-blur">
            <div className="flex items-center gap-3 text-xs">
              <FileCheck2 className="size-4 text-primary" />
              <span className="font-medium">Technical packet</span>
              <span className="text-muted-foreground">14 docs · 38 pages</span>
              <span className="ml-auto font-medium text-success">Ready 92%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full w-[92%] rounded-full bg-gradient-to-r from-primary to-success" /></div>
          </motion.div>
        </div>

        <motion.ul {...rise(0.55)} className="mt-12 grid max-w-xl gap-4 sm:grid-cols-3">
          {TRUST.map((t) => (
            <li key={t.title}>
              <t.icon className="size-5 text-accent" aria-hidden />
              <p className="mt-2 text-[13px] font-semibold">{t.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.body}</p>
            </li>
          ))}
        </motion.ul>
      </div>
    </aside>
  );
}
