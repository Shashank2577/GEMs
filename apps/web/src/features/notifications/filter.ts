/** Unread filter is on for `?unread=1` (spec) or the legacy `?tab=unread`. */
export function isUnreadFilter(params: URLSearchParams): boolean {
  return params.get('unread') === '1' || params.get('tab') === 'unread';
}
