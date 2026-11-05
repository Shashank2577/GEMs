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
});
