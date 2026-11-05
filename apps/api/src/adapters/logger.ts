/**
 * JSON-line logger (008/FR-045, NFR-008): one object per line — `ts`, `level`, `msg` plus meta. Keys that look like
 * credentials are replaced by "[redacted]" at any depth and credential-shaped strings (URL passwords, bearer and `tp_`
 * tokens) are scrubbed, so secrets and cookies can never reach Workers Logs.
 */
import type { LogLevel } from '../env';
import type { Logger } from '../deps';

export const REDACT_KEY = /password|token|secret|cookie|authorization|(?:api|access|private)_?key|dsn|database_?url/i;
/** Credential-shaped substrings scrubbed from string values: URL userinfo, bearer tokens, extension tokens (`tp_…`). */
const SCRUB_VALUE: [RegExp, string][] = [
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\btp_[A-Za-z0-9_-]{16,}/g, 'tp_[redacted]'],
];
export const scrubString = (s: string) => SCRUB_VALUE.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 6;

/**
 * Deep copy of `value` with credential-looking keys redacted and credential-shaped strings scrubbed; Errors become
 * `{name, message}` (no stack). `ancestors` holds only the current path, so a cycle is cut but an object shared by two
 * fields is copied twice.
 */
export function redact(value: unknown, depth = 0, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value == null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (depth >= MAX_DEPTH || ancestors.has(value)) return '[truncated]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v, depth + 1, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  /** Sink for one finished line (default console.log/warn/error by level). */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

const consoleWrite = (line: string, level: LogLevel) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createJsonLogger(opts: JsonLoggerOptions = {}): Logger {
  const min = RANK[opts.level ?? 'info'];
  const write = opts.write ?? consoleWrite;
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel) => (msg: string, meta?: Record<string, unknown>) => {
    if (RANK[level] < min) return;
    const safe = meta ? (redact(meta) as Record<string, unknown>) : {};
    // ts/level/msg are reserved: meta cannot overwrite them.
    write(JSON.stringify({ ...safe, ts: now().toISOString(), level, msg: scrubString(msg) }), level);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const consoleLogger: Logger = createJsonLogger();

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
