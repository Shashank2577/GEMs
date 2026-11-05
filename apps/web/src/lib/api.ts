import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Error envelope from the API: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isConflict() { return this.status === 409; }
}

export const API_BASE = '/api';

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

export function toQueryString(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  query?: Query;
  body?: unknown;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || 'Request failed';
  let details: unknown;
  try {
    const data = await res.json();
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      details = data.error.details;
    }
  } catch { /* non-JSON body */ }
  if (res.status >= 500 && message === res.statusText) message = 'Something went wrong on our side. Please try again.';
  return new ApiError(res.status, code, message, details);
}

/** Typed fetch wrapper. JSON in/out, cookies included, ApiError on non-2xx. */
export async function apiFetch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { query, body, headers, ...rest } = opts;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const init: RequestInit = {
    credentials: 'include',
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${toQueryString(query)}`, init);
  } catch {
    throw new ApiError(0, 'network_error', 'Can’t reach TenderPilot. Check your connection and try again.');
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, init?: RequestOptions) => apiFetch<T>(path, { ...init, method: 'GET', query }),
  post: <T>(path: string, body?: unknown, init?: RequestOptions) => apiFetch<T>(path, { ...init, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, init?: RequestOptions) => apiFetch<T>(path, { ...init, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, init?: RequestOptions) => apiFetch<T>(path, { ...init, method: 'PATCH', body }),
  delete: <T>(path: string, init?: RequestOptions) => apiFetch<T>(path, { ...init, method: 'DELETE' }),
  /** Multipart upload. `fields` values that are objects are JSON-encoded. */
  upload: <T>(path: string, file: File | Blob, fields: Record<string, unknown> = {}, fileField = 'file') => {
    const fd = new FormData();
    fd.append(fileField, file);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return apiFetch<T>(path, { method: 'POST', body: fd });
  },
};

/** Build an absolute URL for a download link (`<a href>`), e.g. `/vault/:id/download`. */
export const apiUrl = (path: string, query?: Query) => `${API_BASE}${path}${toQueryString(query)}`;

export interface Paged<T> { items: T[]; total: number }

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Query key of `GET /auth/me` (re-exported by `lib/auth`). `null` data = signed out. */
export const ME_KEY = ['auth', 'me'] as const;

export const SESSION_ENDED_MESSAGE = 'Your session ended. Please sign in again.';

let sessionEndPending = false;

/**
 * 002/FR-013: a 401 from any query or mutation while signed in means the session expired or was revoked.
 * Clear every cached query, mark the user signed out (RequireAuth then redirects to `/login?next=<current>`)
 * and show one toast. Auth forms opt out with `meta: { authFlow: true }`; the `/auth/me` probe never throws 401.
 */
export function handleSessionEnd(err: unknown, meta?: Record<string, unknown>): boolean {
  if (!(err instanceof ApiError) || err.status !== 401 || meta?.authFlow) return false;
  if (sessionEndPending || !queryClient.getQueryData(ME_KEY)) return false;
  sessionEndPending = true;
  // Defer so the cache is not cleared while it is notifying about this very error.
  setTimeout(() => {
    queryClient.clear();
    queryClient.setQueryData(ME_KEY, null);
    toast.error(SESSION_ENDED_MESSAGE, { id: 'session-ended' });
    sessionEndPending = false;
  }, 0);
  return true;
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => { handleSessionEnd(err, query.meta); } }),
  mutationCache: new MutationCache({ onError: (err, _vars, _ctx, mutation) => { handleSessionEnd(err, mutation.meta); } }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status > 0 && err.status < 500) return false;
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});
