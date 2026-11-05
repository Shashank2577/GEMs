import type { ApiTokenScope } from '@tp/core/contracts/auth';

/** Token scope choices for the create dialog (006/FR-074). */
export const TOKEN_SCOPE_OPTIONS: { value: ApiTokenScope; label: string; hint: string }[] = [
  { value: 'full', label: 'Full access', hint: 'Acts as you for everything your role allows (read and write).' },
  { value: 'read', label: 'Extension (read-only)', hint: 'Can only read. The browser extension needs nothing more, and a leaked token cannot change or delete anything.' },
];

export const tokenScopeLabel = (scope: ApiTokenScope | undefined) => (scope === 'read' ? 'Read-only' : 'Full access');

/** `?scope=read` (the Submit step link) opens the create dialog with the read-only scope preselected. */
export function initialTokenScope(search: string): ApiTokenScope | null {
  const v = new URLSearchParams(search).get('scope');
  return v === 'read' || v === 'full' ? v : null;
}
