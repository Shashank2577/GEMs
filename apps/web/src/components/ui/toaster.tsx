import { Toaster as Sonner, toast as sonnerToast } from 'sonner';
import { useTheme } from '@/lib/theme';

/** Mount once (done in app/App.tsx). Use `toast.success('Saved')`, `toast.error(msg)`, `toast.promise(p, {...})`. */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      closeButton
      richColors
      offset={16}
      // Phones (≤600px in sonner): sit above the fixed mobile tab bar (h-14 + safe area) instead of covering it.
      mobileOffset={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
      toastOptions={{
        classNames: {
          toast: 'group !rounded-xl !border !border-border !shadow-lg !font-sans',
          title: '!text-sm !font-semibold',
          description: '!text-[13px] !text-muted-foreground',
        },
      }}
    />
  );
}

/**
 * Error toasts with the same text share one toast (keyed by the message), so a global handler and a call site
 * reporting the same API error (e.g. 403 `forbidden`, 002/FR-029) show it once. Pass an explicit `id` to opt out.
 */
export const errorToastId = (message: unknown) => (typeof message === 'string' ? `error:${message}` : undefined);
const error: typeof sonnerToast.error = (message, data) => sonnerToast.error(message, { id: errorToastId(message), ...data });
export const toast: typeof sonnerToast = Object.assign((...args: Parameters<typeof sonnerToast>) => sonnerToast(...args), sonnerToast, { error });
