import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto, NotificationsResponse } from '@tp/core/contracts/identify';
import { api } from '@/lib/api';

export const notificationKeys = {
  all: ['notifications'] as const,
  bell: ['notifications', 'bell'] as const,
  list: (unread: boolean) => ['notifications', 'list', unread] as const,
};

/** Latest few for the bell; polls every minute so new matches show up without a reload. */
export function useBellNotifications() {
  return useQuery({
    queryKey: notificationKeys.bell,
    queryFn: () => api.get<NotificationsResponse>('/notifications', { pageSize: 8 }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

const PAGE = 25;
export function useNotificationList(unread: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(unread),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.get<NotificationsResponse>('/notifications', { unread: unread ? 1 : undefined, page: pageParam, pageSize: PAGE }),
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length + 1 : undefined),
  });
}

type Cache = NotificationsResponse;

/** Optimistically flip `read` in every cached notifications query. */
function patchCaches(qc: ReturnType<typeof useQueryClient>, fn: (n: NotificationDto) => NotificationDto) {
  qc.setQueriesData<Cache | { pages: Cache[]; pageParams: unknown[] }>({ queryKey: notificationKeys.all }, (old) => {
    if (!old) return old;
    const fix = (c: Cache): Cache => {
      const items = c.items.map(fn);
      const delta = c.items.filter((n, i) => !n.read && items[i].read).length;
      return { ...c, items, unreadCount: Math.max(0, c.unreadCount - delta) };
    };
    return 'pages' in old ? { ...old, pages: old.pages.map(fix) } : fix(old);
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onMutate: (id) => patchCaches(qc, (n) => (n.id === id ? { ...n, read: true } : n)),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true; updated: number }>('/notifications/read-all'),
    onMutate: () => patchCaches(qc, (n) => ({ ...n, read: true })),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
