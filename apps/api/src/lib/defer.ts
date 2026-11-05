/**
 * Run work after the response is sent (e.g. emails whose timing must not leak information).
 *
 * - Workers: registered with `executionCtx.waitUntil`, and `settleDeferred(deps)` is awaited before the
 *   per-request DB pool is closed (worker.ts).
 * - Node: fire-and-forget; rejections are caught and logged.
 * - Tests: `await settleDeferred(ctx.deps)` to make the background work deterministic.
 *
 * Never put secrets in `label` — it is logged on failure.
 */
import type { Context } from 'hono';
import type { AppDeps } from '../deps';
import type { AppEnv } from '../types';

const pending = new WeakMap<AppDeps, Set<Promise<void>>>();

export function defer(c: Context<AppEnv>, label: string, task: () => Promise<unknown>): void {
  const deps = c.var.deps;
  const p: Promise<void> = Promise.resolve()
    .then(task)
    .then(() => undefined, (e: unknown) => { deps.logger.warn(`${label} failed`, { error: e instanceof Error ? e.message : String(e) }); })
    .finally(() => { pending.get(deps)?.delete(p); });
  let set = pending.get(deps);
  if (!set) pending.set(deps, (set = new Set()));
  set.add(p);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // Node / app.request(): no ExecutionContext — the promise runs on its own.
  }
}

/** Wait for every deferred task started with these deps (including tasks they start). */
export async function settleDeferred(deps: AppDeps): Promise<void> {
  for (let set = pending.get(deps); set && set.size; set = pending.get(deps)) {
    await Promise.all([...set]);
  }
}
