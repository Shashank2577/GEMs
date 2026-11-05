import type { Logger } from '../deps';

const fmt = (meta?: Record<string, unknown>) => (meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '');

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[tp] ${m}${fmt(meta)}`),
  warn: (m, meta) => console.warn(`[tp] ${m}${fmt(meta)}`),
  error: (m, meta) => console.error(`[tp] ${m}${fmt(meta)}`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
