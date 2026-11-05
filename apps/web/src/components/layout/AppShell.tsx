import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Eye, Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck } from 'lucide-react';
import { cn, isMac } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useLocalStorage } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/misc';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/menu';
import { SkeletonPage } from '@/components/ui/skeleton';
import NotificationsBell from '@/features/notifications/Bell';
import { Logo, LogoMark } from './Logo';
import { MOBILE_TABS, NAV_MAIN, NAV_ORG, type NavItem } from './nav';
import { OrgSwitcher } from './OrgSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import { CommandPalette } from './CommandPalette';
import { RouteErrorBoundary } from './RouteErrorBoundary';

/** Slot for the bell so feature code can render it elsewhere if needed. */
export function NotificationsBellSlot() {
  return <NotificationsBell />;
}

function openCommand() { window.dispatchEvent(new CustomEvent('tp:open-command')); }

function SideLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed?: boolean; onNavigate?: () => void }) {
  const link = (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) => cn(
        'group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors focus-ring',
        collapsed && 'justify-center px-0',
        isActive ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-sidebar-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-active" aria-hidden />}
          <item.icon className={cn('size-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} aria-hidden />
          {!collapsed && <span className="truncate">{item.label}</span>}
          {collapsed && <span className="sr-only">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
  return collapsed ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link;
}

function SidebarContent({ collapsed, onNavigate, onToggle }: { collapsed?: boolean; onNavigate?: () => void; onToggle?: () => void }) {
  const { can, role } = useAuth();
  const visible = (items: NavItem[]) => items.filter((i) => !i.min || can(i.min));
  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-14 items-center px-4', collapsed ? 'justify-center px-2' : 'justify-between')}>
        <NavLink to="/dashboard" onClick={onNavigate} className="rounded-md focus-ring" aria-label="TenderPilot home">
          {collapsed ? <LogoMark className="size-7" /> : <Logo />}
        </NavLink>
        {onToggle && !collapsed && (
          <Tooltip content="Collapse sidebar">
            <Button variant="ghost" size="icon-xs" onClick={onToggle} aria-label="Collapse sidebar" className="text-muted-foreground"><PanelLeftClose /></Button>
          </Tooltip>
        )}
      </div>
      <div className={cn('px-3 pb-2', collapsed && 'px-2')}><OrgSwitcher collapsed={collapsed} /></div>
      {!collapsed && (
        <div className="px-3 pb-3">
          <button
            onClick={() => { onNavigate?.(); openCommand(); }}
            className="flex h-8 w-full items-center gap-2 rounded-lg border bg-card px-2.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:border-foreground/15 hover:text-foreground focus-ring"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-left">Search…</span>
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd><Kbd>K</Kbd>
          </button>
        </div>
      )}
      <nav aria-label="Main" className={cn('scrollbar-thin flex-1 overflow-y-auto px-3', collapsed && 'px-2')}>
        <ul className="grid gap-0.5">
          {visible(NAV_MAIN).map((i) => <li key={i.to}><SideLink item={i} collapsed={collapsed} onNavigate={onNavigate} /></li>)}
        </ul>
        {!collapsed && <p className="mb-1.5 mt-6 px-2.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Organization</p>}
        {collapsed && <div className="mx-auto my-4 h-px w-6 bg-border" />}
        <ul className="grid gap-0.5">
          {visible(NAV_ORG).map((i) => <li key={i.to}><SideLink item={i} collapsed={collapsed} onNavigate={onNavigate} /></li>)}
        </ul>
      </nav>
      <div className={cn('p-3', collapsed && 'p-2')}>
        {collapsed ? (
          <div className="grid justify-center gap-1">
            {onToggle && (
              <Tooltip content="Expand sidebar" side="right">
                <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="Expand sidebar" className="text-muted-foreground"><PanelLeftOpen /></Button>
              </Tooltip>
            )}
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-3 shadow-xs">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold">
              <span className="flex size-6 items-center justify-center rounded-md bg-success-soft text-success"><ShieldCheck className="size-3.5" aria-hidden /></span>
              Co-pilot mode
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              We prepare everything. You enter the price and sign with OTP/DSC on GeM.
            </p>
            {role === 'viewer' && (
              <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground"><Eye className="size-3" /> View-only access</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MobileTabBar({ onMore }: { onMore: () => void }) {
  return (
    <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur-xl md:hidden">
      <ul className="grid grid-cols-5">
        {MOBILE_TABS.map((t) => (
          <li key={t.to}>
            <NavLink to={t.to} className={({ isActive }) => cn('flex h-14 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors focus-ring', isActive ? 'text-primary' : 'text-muted-foreground')}>
              {({ isActive }) => (
                <>
                  <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-primary-soft')}>
                    <t.icon className="size-[18px]" aria-hidden />
                  </span>
                  {t.short ?? t.label}
                </>
              )}
            </NavLink>
          </li>
        ))}
        <li>
          <button onClick={onMore} className="flex h-14 w-full flex-col items-center justify-center gap-1 text-[10.5px] font-medium text-muted-foreground focus-ring">
            <span className="flex h-7 w-12 items-center justify-center"><MoreHorizontal className="size-[18px]" aria-hidden /></span>
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

function PageTransition({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const reduce = useReducedMotion();
  const key = loc.pathname.split('/').slice(0, 2).join('/');
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useLocalStorage('tp-sidebar-collapsed', false);
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();

  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  // Focus <main> after each route change (002/US7 S7) — but not on first load, so the first Tab still lands on
  // "Skip to content".
  const lastPath = useRef(loc.pathname);
  useEffect(() => {
    if (lastPath.current === loc.pathname) return;
    lastPath.current = loc.pathname;
    document.getElementById('main')?.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }, [loc.pathname]);

  return (
    <div className="min-h-dvh bg-background">
      <a href="#main" className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus-ring">Skip to content</a>

      {/* Desktop sidebar */}
      <aside
        className={cn('fixed inset-y-0 left-0 z-30 hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out md:block', collapsed ? 'w-[64px]' : 'w-[248px]')}
        aria-label="Sidebar"
      >
        <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </aside>

      {/* Mobile drawer */}
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" className="w-[min(86%,300px)] bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation menu</SheetDescription>
          <SidebarContent onNavigate={() => setDrawer(false)} />
        </SheetContent>
      </Sheet>

      <div className={cn('flex min-h-dvh flex-col transition-[padding] duration-200 ease-out', collapsed ? 'md:pl-[64px]' : 'md:pl-[248px]')}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-xl sm:px-6">
          <Button variant="ghost" size="icon-sm" className="-ml-1.5 md:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <NavLink to="/dashboard" className="md:hidden" aria-label="TenderPilot home"><Logo /></NavLink>
          <button
            onClick={openCommand}
            className="ml-auto hidden h-8 w-full max-w-sm items-center gap-2 rounded-lg border bg-subtle px-3 text-[13px] text-muted-foreground transition-colors hover:border-foreground/15 hover:text-foreground focus-ring md:mr-auto md:ml-0 md:flex"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-left">Search tenders, pages, actions…</span>
            <Kbd>{isMac ? '⌘' : 'Ctrl'} K</Kbd>
          </button>
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={openCommand} aria-label="Search"><Search /></Button>
            <div className="hidden sm:block"><ThemeToggle /></div>
            <NotificationsBellSlot />
            <div className="ml-1"><UserMenu compact /></div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto w-full max-w-[1400px] px-4 pb-28 pt-6 sm:px-6 sm:pt-8 md:pb-12 lg:px-8">
            <RouteErrorBoundary resetKey={loc.pathname}>
              <Suspense fallback={<SkeletonPage />}>
                <PageTransition><Outlet /></PageTransition>
              </Suspense>
            </RouteErrorBoundary>
          </div>
        </main>
      </div>

      <MobileTabBar onMore={() => setDrawer(true)} />
      <CommandPalette />
    </div>
  );
}
