/** Resolve a readable label + in-app link for activity entries (shared by the dashboard and GET /activity). */
import { and, eq, inArray } from 'drizzle-orm';
import { bidWorkspaces, tenders, vaultDocuments, watchlists, type Db } from '@tp/db';
import type { ActivityItem } from '@tp/core/contracts/auth';

type ActivityTarget = NonNullable<ActivityItem['target']>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function enrichActivity<T extends Omit<ActivityItem, 'target'>>(db: Db, org: string, items: T[]): Promise<(T & { target: ActivityTarget | null })[]> {
  const ids = (type: string) => [...new Set(items.filter((i) => i.entityType === type && i.entityId).map((i) => i.entityId!))].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const wsIds = ids('workspace'), tIds = ids('tender'), vIds = ids('vault_document'), wlIds = ids('watchlist');
  const [wsRows, tRows, vRows, wlRows] = await Promise.all([
    wsIds.length ? db.select({ id: bidWorkspaces.id, title: tenders.title }).from(bidWorkspaces).innerJoin(tenders, eq(tenders.id, bidWorkspaces.tenderId))
      .where(and(eq(bidWorkspaces.orgId, org), inArray(bidWorkspaces.id, wsIds))) : [],
    tIds.length ? db.select({ id: tenders.id, title: tenders.title }).from(tenders).where(inArray(tenders.id, tIds)) : [],
    vIds.length ? db.select({ id: vaultDocuments.id, title: vaultDocuments.title }).from(vaultDocuments).where(and(eq(vaultDocuments.orgId, org), inArray(vaultDocuments.id, vIds))) : [],
    wlIds.length ? db.select({ id: watchlists.id, title: watchlists.name }).from(watchlists).where(and(eq(watchlists.orgId, org), inArray(watchlists.id, wlIds))) : [],
  ]);
  const ws = new Map(wsRows.map((r) => [r.id, r.title]));
  const ts = new Map(tRows.map((r) => [r.id, r.title]));
  const vs = new Map(vRows.map((r) => [r.id, r.title]));
  const wl = new Map(wlRows.map((r) => [r.id, r.title]));
  return items.map((i) => {
    const id = i.entityId ?? '';
    const metaTitle = typeof i.meta.title === 'string' ? i.meta.title : typeof i.meta.name === 'string' ? i.meta.name : null;
    let target: ActivityTarget | null = null;
    if (i.entityType === 'workspace' && ws.has(id)) target = { label: ws.get(id)!, href: `/workspaces/${id}` };
    else if (i.entityType === 'tender' && ts.has(id)) target = { label: ts.get(id)!, href: `/tenders/${id}` };
    else if (i.entityType === 'vault_document') target = { label: vs.get(id) ?? metaTitle ?? 'a document', href: '/vault' };
    else if (i.entityType === 'watchlist') target = { label: wl.get(id) ?? metaTitle ?? 'a watchlist', href: '/watchlists' };
    else if (i.entityType === 'company_profile' || i.action.startsWith('profile.')) target = { label: 'company profile', href: '/profile' };
    else if (i.action.startsWith('member.')) target = { label: str(i.meta.email) ?? str(i.meta.name) ?? 'a teammate', href: '/settings/team' };
    else if (metaTitle) target = { label: metaTitle, href: '/dashboard' };
    return { ...i, target };
  });
}

