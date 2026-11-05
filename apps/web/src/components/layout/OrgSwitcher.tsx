import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ROLE_LABEL } from '@/lib/types';
import { cn, initials } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { toast } from '@/components/ui/toaster';
import { errorMessage } from '@/lib/api';

function OrgChip({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[hsl(20_90%_52%)] text-[11px] font-bold text-white shadow-sm', className)}>
      {initials(name, true)}
    </span>
  );
}

export function OrgSwitcher({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  const { me, switchOrg } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    // Non-modal: a modal menu aria-hides the whole shell while its links stay focusable (axe aria-hidden-focus).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn('group flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-muted focus-ring', collapsed && 'justify-center', className)}
      >
        {/* Name comes from the visible text (WCAG 2.5.3 label-in-name); the chip's initials are decorative. */}
        <OrgChip name={me.org.name} />
        {collapsed && <span className="sr-only">{me.org.name}</span>}
        <span className="sr-only">Switch organization</span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-tight">{me.org.name}</span>
              {' '}
              <span className="block truncate text-2xs capitalize text-muted-foreground">{me.org.plan} plan · {ROLE_LABEL[me.role]}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {me.orgs.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={async () => {
              if (o.id === me.org.id) return;
              try {
                await switchOrg(o.id);
                toast.success(`Switched to ${o.name}`);
                navigate('/dashboard');
              } catch (e) { toast.error(errorMessage(e)); }
            }}
          >
            <OrgChip name={o.name} className="size-6 text-[10px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.name}</span>
              <span className="block text-2xs text-muted-foreground">{ROLE_LABEL[o.role]}</span>
            </span>
            {o.id === me.org.id && <Check className="!text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings/team')}><Plus />Invite teammates</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
