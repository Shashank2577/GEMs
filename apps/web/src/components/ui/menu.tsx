import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── DropdownMenu ───
export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;
export const DropdownMenuSub = DM.Sub;
export const DropdownMenuRadioGroup = DM.RadioGroup;

const menuPanel = 'z-50 min-w-[12rem] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1';
const menuItem = 'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

export const DropdownMenuContent = forwardRef<ElementRef<typeof DM.Content>, ComponentPropsWithoutRef<typeof DM.Content>>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <DM.Portal><DM.Content ref={ref} sideOffset={sideOffset} className={cn(menuPanel, className)} {...props} /></DM.Portal>
  ),
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<ElementRef<typeof DM.Item>, ComponentPropsWithoutRef<typeof DM.Item> & { destructive?: boolean }>(
  ({ className, destructive, ...props }, ref) => (
    <DM.Item ref={ref} className={cn(menuItem, destructive && 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger', className)} {...props} />
  ),
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuCheckboxItem = forwardRef<ElementRef<typeof DM.CheckboxItem>, ComponentPropsWithoutRef<typeof DM.CheckboxItem>>(
  ({ className, children, ...props }, ref) => (
    <DM.CheckboxItem ref={ref} className={cn(menuItem, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center"><DM.ItemIndicator><Check className="!text-primary" /></DM.ItemIndicator></span>
      {children}
    </DM.CheckboxItem>
  ),
);
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

export const DropdownMenuRadioItem = forwardRef<ElementRef<typeof DM.RadioItem>, ComponentPropsWithoutRef<typeof DM.RadioItem>>(
  ({ className, children, ...props }, ref) => (
    <DM.RadioItem ref={ref} className={cn(menuItem, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center"><DM.ItemIndicator><Check className="!text-primary" /></DM.ItemIndicator></span>
      {children}
    </DM.RadioItem>
  ),
);
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

export const DropdownMenuSubTrigger = forwardRef<ElementRef<typeof DM.SubTrigger>, ComponentPropsWithoutRef<typeof DM.SubTrigger>>(
  ({ className, children, ...props }, ref) => (
    <DM.SubTrigger ref={ref} className={cn(menuItem, 'data-[state=open]:bg-muted', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </DM.SubTrigger>
  ),
);
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

export const DropdownMenuSubContent = forwardRef<ElementRef<typeof DM.SubContent>, ComponentPropsWithoutRef<typeof DM.SubContent>>(
  ({ className, ...props }, ref) => (
    <DM.Portal><DM.SubContent ref={ref} className={cn(menuPanel, className)} {...props} /></DM.Portal>
  ),
);
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

export const DropdownMenuLabel = forwardRef<ElementRef<typeof DM.Label>, ComponentPropsWithoutRef<typeof DM.Label>>(
  ({ className, ...props }, ref) => <DM.Label ref={ref} className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />,
);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export const DropdownMenuSeparator = forwardRef<ElementRef<typeof DM.Separator>, ComponentPropsWithoutRef<typeof DM.Separator>>(
  ({ className, ...props }, ref) => <DM.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />,
);
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuShortcut = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...p} />
);

// ─── Popover ───
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;
export const PopoverContent = forwardRef<ElementRef<typeof PopoverPrimitive.Content>, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  ({ className, align = 'center', sideOffset = 6, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn(menuPanel, 'w-72 p-4', className)} {...props} />
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = 'PopoverContent';

// ─── Tooltip ───
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipContent = forwardRef<ElementRef<typeof TooltipPrimitive.Content>, ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn('z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = 'TooltipContent';

/** `<Tooltip content="Explain EMD">…</Tooltip>` */
export function Tooltip({ content, children, side, delay = 250 }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }) {
  if (!content) return <>{children}</>;
  return (
    <TooltipRoot delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  );
}
