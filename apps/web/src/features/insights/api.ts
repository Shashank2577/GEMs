/** Data hook for the competitor insights page (GET /insights/competitors, 003/FR-064). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CompetitorsResponse } from '@tp/core/contracts/identify';
import { api } from '@/lib/api';
import { toQuery, type CompetitorFilters } from './competitors';

export const insightKeys = { competitors: (f: CompetitorFilters) => ['insights', 'competitors', f] as const };

export function useCompetitors(f: CompetitorFilters) {
  return useQuery({
    queryKey: insightKeys.competitors(f),
    queryFn: () => api.get<CompetitorsResponse>('/insights/competitors', toQuery(f)),
    placeholderData: keepPreviousData,
  });
}
