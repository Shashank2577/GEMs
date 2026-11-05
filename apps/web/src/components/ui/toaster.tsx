import { Toaster as Sonner, toast } from 'sonner';
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

export { toast };
