import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PastContractDto, PastContractInput, ProfileInput, ProfileResponse } from '@tp/core/contracts/vault';
import { api, type Paged } from '@/lib/api';

export const profileKeys = { profile: ['profile'] as const, contracts: ['profile', 'past-contracts'] as const };

export function useProfile() {
  return useQuery({ queryKey: profileKeys.profile, queryFn: () => api.get<ProfileResponse>('/profile') });
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileInput) => api.put<ProfileResponse>('/profile', body),
    onSuccess: (data) => {
      qc.setQueryData(profileKeys.profile, data);
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['tenders'] });
    },
  });
}

export function usePastContracts() {
  return useQuery({ queryKey: profileKeys.contracts, queryFn: () => api.get<Paged<PastContractDto>>('/past-contracts') });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: profileKeys.profile });
}

export function useSavePastContract() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: PastContractInput & { id?: string }) =>
      id ? api.patch<PastContractDto>(`/past-contracts/${id}`, body) : api.post<PastContractDto>('/past-contracts', body),
    onSuccess: inv,
  });
}

export function useDeletePastContract() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete<{ ok: true }>(`/past-contracts/${id}`), onSuccess: inv });
}
