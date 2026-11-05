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
