import { forwardRef, useId, cloneElement, isValidElement, type ComponentPropsWithoutRef, type ElementRef, type ReactElement, type ReactNode } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Label = forwardRef<ElementRef<typeof LabelPrimitive.Root>, ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <LabelPrimitive.Root ref={ref} className={cn('text-[13px] font-medium leading-none text-foreground peer-disabled:opacity-60', className)} {...props} />
  ),
);
Label.displayName = 'Label';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Optional right-aligned element on the label row (e.g. "Forgot password?") */
  labelAside?: ReactNode;
  className?: string;
  id?: string;
  /** A single form control; it receives id, aria-invalid and aria-describedby. */
  children: ReactElement;
}

/** Label + control + hint/error with correct a11y wiring. */
export function Field({ label, hint, error, required, labelAside, className, id, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? (children.props as { id?: string }).id ?? auto;
  const hintId = `${controlId}-hint`;
  const errId = `${controlId}-err`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid min-w-0 grid-cols-1 gap-1.5', className)}>
      {(label || labelAside) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <Label htmlFor={controlId}>
              {label}
              {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
            </Label>
          )}
          {labelAside}
        </div>
      )}
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id: controlId,
            'aria-invalid': error ? true : undefined,
            'aria-describedby': describedBy,
            'aria-required': required || undefined,
          })
        : children}
      {error ? (
        <p id={errId} role="alert" className="flex items-center gap-1.5 text-xs font-medium text-danger animate-fade-in">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
