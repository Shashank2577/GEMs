import { Toaster as Sonner, toast as sonnerToast } from 'sonner';
import { useTheme } from '@/lib/theme';
import { useIsMobile } from '@/lib/hooks';

/** Below the sticky 56 px top bar, so a toast never hides the menu button, bell or avatar. */
const TOP_BELOW_HEADER = 'calc(64px + env(safe-area-inset-top, 0px))';

/** Mount once (done in app/App.tsx). Use `toast.success('Saved')`, `toast.error(msg)`, `toast.promise(p, {...})`. */
export function Toaster() {
  const { resolved } = useTheme();
  // Below md (768 px, where the shell shows the bottom tab bar) toasts go top-center: the bottom of a phone is taken by
  // the tab bar, the Profile "Unsaved changes" bar and form footers. Keyed on our md breakpoint, not sonner's own
  // 600 px one, so 600–767 px behaves like a phone too (002/US4 review follow-up).
  const phone = useIsMobile();
  return (
    <Sonner
      theme={resolved}
      position={phone ? 'top-center' : 'bottom-right'}
      closeButton
      richColors
      offset={phone ? { top: TOP_BELOW_HEADER } : 16}
      mobileOffset={{ top: TOP_BELOW_HEADER }}
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
