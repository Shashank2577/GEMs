/**
 * Provider send errors classified for retry (FR-047).
 *  - transient: network failure, timeout, HTTP 408 / 429 / 5xx (and provider-specific throttling codes) → retry later;
 *  - permanent: any other 4xx (bad request, auth, invalid recipient …) → do not retry.
 */
export class ProviderError extends Error {
  constructor(message: string, readonly transient: boolean, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** HTTP statuses worth retrying. */
export const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** Upper bound for one provider request; a hung connection becomes a transient `TimeoutError` (FR-047). */
export const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Whether a send error should be retried. Adapters throw `ProviderError` (network failures are wrapped by
 * `providerFetch`); otherwise only an abort / timeout is transient. Anything else — including a bare `TypeError`, which
 * is usually a programming error — is permanent, so it is not retried.
 */
export function isTransientSendError(e: unknown): boolean {
  if (e instanceof ProviderError) return e.transient;
  if (e instanceof Error) return e.name === 'AbortError' || e.name === 'TimeoutError';
  return false;
}

/**
 * Runs the provider request with a 30 s timeout (unless the caller passed its own signal); a thrown fetch (DNS, reset,
 * timeout) becomes a transient ProviderError.
 */
export async function providerFetch(provider: string, f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, { ...init, signal: init.signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(`${provider} network error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600), true);
  }
}
