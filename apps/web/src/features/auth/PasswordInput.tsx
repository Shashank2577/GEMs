import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, type InputProps } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>((props, ref) => {
  const [show, setShow] = useState(false);
  return (
    <Input
      ref={ref}
      type={show ? 'text' : 'password'}
      {...props}
      trailing={
        <button type="button" onClick={() => setShow((s) => !s)} className="rounded p-1 hover:text-foreground focus-ring" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          {show ? <EyeOff /> : <Eye />}
        </button>
      }
    />
  );
});
PasswordInput.displayName = 'PasswordInput';

/** 0–4 score with label; simple, dependency-free heuristic. */
export function passwordStrength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  else if (/\d|[^A-Za-z0-9]/.test(pw) && pw.length >= 10) s += 0.5;
  if (pw.length < 8) s = Math.min(s, 1);
  const score = Math.min(4, Math.floor(s));
  return { score, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = passwordStrength(password);
  const color = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'][score];
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <div className="grid flex-1 grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn('h-1 rounded-full transition-colors duration-300', password && score >= i ? color : 'bg-muted')} />
        ))}
      </div>
      <span className="w-16 text-right text-2xs font-medium text-muted-foreground">{password ? label : 'Min 8 chars'}</span>
    </div>
  );
}
