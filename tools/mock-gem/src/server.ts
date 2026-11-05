/**
 * Mock GeM BidPlus server for local development and E2E.
 *   pnpm --filter @tp/mock-gem start        (PORT, default 4010)
 * Point the API at it with GEM_BASE_URL=http://localhost:4010.
 */
import { serve } from '@hono/node-server';
import { createMockGem } from './app';

const port = Number(process.env.PORT ?? 4010);
const { app, state } = createMockGem();

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => {
  console.log(`mock-gem listening on http://${info.address}:${info.port} (${state.docs.length} bids, ${state.pending.length} queued for /__admin/publish)`);
});
