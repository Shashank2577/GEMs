import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FilePlus2, Keyboard, LogOut, Moon, PlusCircle, Search, Sun, Monitor, UserPlus } from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Kbd } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { SETTINGS_ITEMS, settingsPaletteValue, visibleSettingsItems } from '@/features/settings/items';
import { NAV_MAIN, NAV_ORG } from './nav';
import { GOTO_KEYS, GOTO_WINDOW_MS, isHelpKey, isTypingTarget, openShortcuts } from './shortcuts';
import { ShortcutsDialog } from './ShortcutsDialog';

const isTyping = (e: KeyboardEvent) => isTypingTarget(e.target as HTMLElement | null);

/**
 * Global ⌘K palette + "G then X" navigation shortcuts + "?" shortcuts dialog.
 * Open programmatically with `window.dispatchEvent(new CustomEvent('tp:open-command'))`.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const { can, logout } = useAuth();
  const { setTheme } = useTheme();

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); return; }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' ) { e.preventDefault(); setOpen(true); return; }
      if (isHelpKey(e)) { e.preventDefault(); gAt = 0; openShortcuts(); return; }
      const k = e.key.toLowerCase();
      if (k === 'g') { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < GOTO_WINDOW_MS && GOTO_KEYS[k]) { e.preventDefault(); navigate(GOTO_KEYS[k].to); }
      gAt = 0;
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('tp:open-command', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('tp:open-command', onOpen); };
  }, [navigate]);

  useEffect(() => { if (!open) setQ(''); }, [open]);

  const run = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <>
    <ShortcutsDialog />
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages, actions, or tenders…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No matches. Press Enter to search tenders.</CommandEmpty>
        <CommandGroup heading="Go to">
          {[...NAV_MAIN, ...NAV_ORG].filter((n) => !n.min || can(n.min)).map((n) => {
            const key = Object.entries(GOTO_KEYS).find(([, v]) => v.to === n.to)?.[0];
            return (
              <CommandItem key={n.to} value={`${n.label} ${(n.keywords ?? []).join(' ')}`} onSelect={() => run(() => navigate(n.to))}>
                <n.icon />{n.label}
                {key && <span className="ml-auto flex gap-1"><Kbd>G</Kbd><Kbd>{key.toUpperCase()}</Kbd></span>}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          {visibleSettingsItems(can, SETTINGS_ITEMS).map((i) => (
            <CommandItem key={i.to} value={settingsPaletteValue(i)} keywords={i.keywords} onSelect={() => run(() => navigate(`/settings/${i.to}`))}>
              <i.icon />{i.label}
              <span className="ml-auto hidden truncate pl-3 text-xs text-muted-foreground sm:block">{i.description}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick actions">
          {can('analyst') && (
            <>
              <CommandItem value="new watchlist create alert" onSelect={() => run(() => navigate('/watchlists?new=1'))}><PlusCircle />Create a watchlist</CommandItem>
              <CommandItem value="upload document vault certificate" onSelect={() => run(() => navigate('/vault?upload=1'))}><FilePlus2 />Upload to document vault</CommandItem>
            </>
          )}
          {can('bid_manager') && (
            <CommandItem value="invite teammate member" onSelect={() => run(() => navigate('/settings/team'))}><UserPlus />Invite a teammate</CommandItem>
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Preferences">
          <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}><Sun />Light theme</CommandItem>
          <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}><Moon />Dark theme</CommandItem>
          <CommandItem value="theme system" onSelect={() => run(() => setTheme('system'))}><Monitor />System theme</CommandItem>
          <CommandItem value="keyboard shortcuts help hotkeys" onSelect={() => run(openShortcuts)}><Keyboard />Keyboard shortcuts<span className="ml-auto"><Kbd>?</Kbd></span></CommandItem>
          <CommandItem value="sign out logout" onSelect={() => run(async () => { await logout(); navigate('/login'); })}><LogOut />Sign out</CommandItem>
        </CommandGroup>
        {q.trim().length > 1 && (
          <CommandGroup heading="Search GeM tenders" forceMount>
            <CommandItem forceMount value={`__search ${q}`} onSelect={() => run(() => navigate(`/tenders?q=${encodeURIComponent(q.trim())}`))}>
              <Search />Search tenders for “<span className="truncate font-medium">{q.trim()}</span>”
              <ArrowRight className="ml-auto" />
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t bg-subtle px-4 py-2 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate <Kbd>↵</Kbd> open</span>
        <span className="flex items-center gap-1.5"><Kbd>esc</Kbd> close</span>
      </div>
    </CommandDialog>
    </>
  );
}
