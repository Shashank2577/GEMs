import type { ReactNode } from 'react';
import { Sparkles, type LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';

/** Placeholder used by feature stubs until the owning team ships the real page. */
export function StubPage({ title, description, icon = Sparkles, children }: { title: string; description?: string; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState icon={icon} title="Coming soon" body="This part of TenderPilot is being built. Check back shortly." />
      {children}
    </>
  );
}
