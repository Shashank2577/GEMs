import { useNavigate } from 'react-router-dom';
import { Building2, Keyboard, LogOut, Moon, Settings, Sun, Monitor, UserRound } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useTheme, type ThemePref } from '@/lib/theme';
import { ROLE_LABEL } from '@/lib/types';
import { Avatar } from '@/components/ui/misc';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/menu';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';

export function UserMenu({ compact, className }: { compact?: boolean; className?: string }) {
  const { me, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn('flex items-center gap-2 rounded-full focus-ring', !compact && 'rounded-lg p-1 pr-2 hover:bg-muted', className)}
        aria-label="Account menu"
      >
        <Avatar name={me.user.name} size="sm" />
        {!compact && <span className="hidden max-w-[8rem] truncate text-sm font-medium lg:block">{me.user.name.split(' ')[0]}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={me.user.name} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me.user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
          </div>
        </div>
        <div className="mx-2 mb-1 flex items-center justify-between rounded-md bg-muted px-2 py-1.5 text-xs">
          <span className="truncate text-muted-foreground">{me.org.name}</span>
          <span className="font-medium">{ROLE_LABEL[me.role]}</span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings/account')}><UserRound />Your profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/profile')}><Building2 />Company profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings')}><Settings />Settings<DropdownMenuShortcut>G S</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('tp:open-command'))}><Keyboard />Command palette<DropdownMenuShortcut>⌘K</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="sr-only">Session</DropdownMenuLabel>
        <DropdownMenuItem
          destructive
          onSelect={async () => {
            await logout();
            toast.success('Signed out');
            navigate('/login', { replace: true });
          }}
        >
          <LogOut />Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
