import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { PlanLimitDialog } from '@/components/layout/PlanLimitDialog';
import { TooltipProvider } from '@/components/ui/menu';
import { Toaster } from '@/components/ui/toaster';
import { queryClient } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { router } from './router';

/**
 * AuthProvider uses react-router hooks only inside RequireAuth (rendered by routes),
 * so it can sit above RouterProvider.
 */
export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider delayDuration={250} skipDelayDuration={100}>
            <RouterProvider router={router} />
            <Toaster />
            {/* 008/FR-041b: opened by any 402 from the API (lib/api.ts). */}
            <PlanLimitDialog />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
