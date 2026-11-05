/// <reference types="chrome" />
/** Settings (chrome.storage.local) and API calls for the popup. Uses a personal API token (Bearer tp_…). */
import type { AssistPayload } from '@tp/core/assist/allowlist';

export interface Settings { apiBase: string; token: string; workspaceId: string | null }

export const DEFAULT_SETTINGS: Settings = { apiBase: 'http://localhost:8787', token: '', workspaceId: null };

export async function loadSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['apiBase', 'token', 'workspaceId']);
  return { ...DEFAULT_SETTINGS, ...(s as Partial<Settings>) };
}

export async function saveSettings(s: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(s);
}

export const normalizeBase = (u: string) => u.trim().replace(/\/+$/, '').replace(/\/api$/, '');

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function call<T>(s: Settings, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(s.apiBase)}/api${path}`, { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'Cannot reach TenderPilot. Check the URL and that the extension may access it.');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json())?.error?.message ?? msg; } catch { /* ignore */ }
    throw new ApiError(res.status, res.status === 401 ? 'The API token is invalid or was revoked. Create a new one in TenderPilot → Settings → API tokens.' : msg);
  }
  return res.json() as Promise<T>;
}

export interface WorkspaceCardLite {
  id: string; stage: string;
  tender: { bidNumber: string; title: string; endAt: string | null };
  readiness: { percent: number; blockers: number };
}

export const api = {
  me: (s: Settings) => call<{ user: { name: string }; org: { name: string } }>(s, '/auth/me'),
  workspaces: (s: Settings) => call<{ items: WorkspaceCardLite[] }>(s, '/workspaces?stage=go,preparing,ready,submitted'),
  assist: (s: Settings, id: string) => call<AssistPayload & { stage: string; workspaceUrl: string; readiness: { percent: number; blockers: number; analysed: boolean } }>(s, `/assist/${id}`),
};

/** Ask Chrome for access to the API origin (optional host permission). */
export async function ensureHostPermission(apiBase: string): Promise<boolean> {
  try {
    const origin = `${new URL(normalizeBase(apiBase)).origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
