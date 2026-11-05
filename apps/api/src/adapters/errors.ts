/** Error reporter adapters (008/FR-046). Sentry lands with US6; until then (and whenever SENTRY_DSN is unset) a no-op. */
import type { ErrorReporter } from '../deps';

export const noopErrorReporter: ErrorReporter = { capture() { /* Workers Logs / console remain the source of truth */ } };
