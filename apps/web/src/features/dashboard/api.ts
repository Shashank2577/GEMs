import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DashboardResponse, DemoSeedResponse } from '@tp/core/contracts/experience';
import { api } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';

export const dashboardKeys = { all: ['dashboard'] as const };

export function useDashboard() {
  return useQuery({
    queryKey: dashboardKeys.all,
    queryFn: () => api.get<DashboardResponse>('/dashboard'),
    refetchInterval: 120_000,
  });
}

/** POST /demo/seed — loads the sample company and refreshes everything that shows org data. */
export function useSeedDemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DemoSeedResponse>('/demo/seed'),
    onSuccess: () => {
      qc.invalidateQueries();
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}
