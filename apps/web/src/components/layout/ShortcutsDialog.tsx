import { Fragment, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/misc';
import { isMac } from '@/lib/utils';
import { OPEN_SHORTCUTS_EVENT, shortcutGroups } from './shortcuts';

/** "Keyboard shortcuts" help (002/FR-046). Opened by "?" (see CommandPalette) or `openShortcuts()` from the user menu. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts work anywhere in the app except while you are typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          {shortcutGroups(isMac ? '⌘' : 'Ctrl').map((g) => (
            <section key={g.title} aria-labelledby={`kbd-${g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
              <h3 id={`kbd-${g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h3>
              <ul className="grid gap-1.5">
                {g.rows.map((r) => (
                  <li key={r.label} className="flex items-center justify-between gap-3 text-sm">
                    <span>{r.label}</span>
                    <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                      {r.keys.map((seq, i) => (
                        <Fragment key={seq.join('+')}>
                          {i > 0 && <span>or</span>}
                          {seq.map((k, j) => (
                            <Fragment key={k}>
                              {j > 0 && seq[0] === 'G' && <span>then</span>}
                              <Kbd>{k}</Kbd>
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
