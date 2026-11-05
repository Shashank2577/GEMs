import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        primary: 'border-primary/20 bg-primary-soft text-primary-ink',
        accent: 'border-accent/25 bg-accent-soft text-[hsl(26_90%_32%)] dark:text-accent',
        success: 'border-success/20 bg-success-soft text-success',
        warning: 'border-warning/25 bg-warning-soft text-[hsl(32_90%_32%)] dark:text-warning',
        danger: 'border-danger/20 bg-danger-soft text-danger',
        info: 'border-info/20 bg-info-soft text-info',
        outline: 'border-border bg-transparent text-foreground',
        solid: 'border-transparent bg-foreground text-background',
      },
      size: { sm: 'h-5 px-1.5 text-2xs', md: 'h-6 px-2 text-xs', lg: 'h-7 px-2.5 text-[13px]' },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, tone, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;
