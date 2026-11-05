import { describe, expect, it } from 'vitest';
import { createJsonLogger, redact } from './logger';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const log = createJsonLogger({ level, write: (l) => lines.push(l), now: () => new Date('2026-01-02T03:04:05.000Z') });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('JSON-line logger (008/FR-045)', () => {
  it('emits one JSON object per line with ts, level, msg and meta', () => {
    const c = capture();
    c.log.info('request', { rid: 'r1', status: 200 });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).not.toContain('\n');
    expect(c.parsed()[0]).toEqual({ rid: 'r1', status: 200, ts: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'request' });
  });

  it('honours LOG_LEVEL ordering (default info hides debug)', () => {
    const d = capture();
    d.log.debug?.('d'); d.log.info('i'); d.log.warn('w'); d.log.error('e');
    expect(d.parsed().map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    const dbg = capture('debug');
    dbg.log.debug?.('d');
    expect(dbg.lines).toHaveLength(1);
    const err = capture('error');
    err.log.info('i'); err.log.warn('w'); err.log.error('e');
    expect(err.parsed().map((l) => l.level)).toEqual(['error']);
  });

  it('redacts password/token/secret/cookie/authorization keys at any depth, case-insensitively', () => {
    const c = capture();
    c.log.info('x', {
      password: 'hunter2', Authorization: 'Bearer abc', headers: { Cookie: 'tp_session=zzz', 'x-ok': 'fine' },
      list: [{ apiToken: 'tp_123' }], clientSecret: 's', resetToken: 't', keep: 'visible',
    });
    const out = c.lines[0]!;
    for (const s of ['hunter2', 'Bearer abc', 'tp_session=zzz', 'tp_123', '"s"', '"t"']) expect(out).not.toContain(s);
    const o = c.parsed()[0] as any;
    expect(o.password).toBe('[redacted]');
    expect(o.headers).toEqual({ Cookie: '[redacted]', 'x-ok': 'fine' });
    expect(o.keep).toBe('visible');
  });

  it('cannot be tricked into overwriting ts/level/msg, serialises Errors without stack, survives cycles', () => {
    const c = capture();
    const cyc: Record<string, unknown> = { a: 1 }; cyc.self = cyc;
    c.log.warn('real', { level: 'debug', msg: 'fake', ts: 'x', err: new Error('boom'), cyc });
    const o = c.parsed()[0] as any;
    expect(o).toMatchObject({ level: 'warn', msg: 'real', ts: '2026-01-02T03:04:05.000Z', err: { name: 'Error', message: 'boom' } });
    expect(o.cyc.self).toBe('[truncated]');
  });

  it('redact() leaves primitives alone', () => {
    expect(redact('token')).toBe('token');
    expect(redact(null)).toBeNull();
  });

  it('redacts api key / DSN / database URL keys and scrubs credential-shaped values', () => {
    const c = capture();
    c.log.error('connect failed postgres://tp:hunter2@db:5432/x', {
      RESEND_API_KEY: 're_1', sentryDsn: 'https://k@sentry', DATABASE_URL: 'postgres://a:b@h/d', databaseUrl: 'x',
      error: 'connect ECONNREFUSED postgres://tp:secretpw@db:5432/tp',
      header: 'Bearer abc.def', note: 'token tp_AbCdEfGhIjKlMnOpQrSt-_9 leaked', cookieName: 'tp_session', dedupeKey: 'digest:1',
    });
    const out = c.lines[0]!;
    for (const s of ['re_1', 'https://k@sentry', 'a:b@h', 'hunter2', 'secretpw', 'abc.def', 'tp_AbCd']) expect(out).not.toContain(s);
    const o = c.parsed()[0] as any;
    expect(o).toMatchObject({ RESEND_API_KEY: '[redacted]', sentryDsn: '[redacted]', DATABASE_URL: '[redacted]', databaseUrl: '[redacted]', dedupeKey: 'digest:1' });
    expect(o.msg).toBe('connect failed postgres://[redacted]@db:5432/x');
    expect(o.error).toBe('connect ECONNREFUSED postgres://[redacted]@db:5432/tp');
    expect(o.header).toBe('Bearer [redacted]');
    expect(o.note).toBe('token tp_[redacted] leaked');
  });

  it('copies an object shared by two fields instead of truncating it (only real cycles are cut)', () => {
    const shared = { id: 'x' };
    expect(redact({ a: shared, b: shared, list: [shared, shared] })).toEqual({ a: { id: 'x' }, b: { id: 'x' }, list: [{ id: 'x' }, { id: 'x' }] });
  });
});
