/**
 * zod validation helpers. Failures become 400 `validation_error` with
 * `details: { fields: { "a.b": "message" }, issues: [...] }` so forms can map errors to inputs.
 *
 *   const body = await parseJson(c, signupInputSchema);
 *   const q = parseQuery(c, tenderQuerySchema);
 *   app.post('/x', vJson(schema), (c) => { const body = c.req.valid('json'); ... })
 */
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import type { ZodError, ZodSchema, ZodTypeAny, z } from 'zod';
import { badRequest, validationError } from './errors';

export function zodDetails(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join('.') || '_';
    if (!(k in fields)) fields[k] = i.message;
  }
  return { fields, issues: err.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) };
}

export function zodToHttpError(err: ZodError, where = 'request') {
  const d = zodDetails(err);
  const first = Object.entries(d.fields)[0];
  const msg = first ? (first[0] === '_' ? first[1] : `${first[0]}: ${first[1]}`) : `Invalid ${where}`;
  return validationError(msg, d);
}

/** Parse arbitrary data with a schema, throwing a 400 on failure. */
export function parseWith<S extends ZodTypeAny>(schema: S, data: unknown, where = 'request'): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw zodToHttpError(r.error, where);
  return r.data;
}

/** Parse and validate the JSON body. */
export async function parseJson<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.output<S>> {
  let data: unknown;
  try {
    const text = await c.req.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return parseWith(schema, data, 'body');
}

/** Parse and validate query parameters (single values; use `c.req.queries()` for repeated keys). */
export function parseQuery<S extends ZodTypeAny>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.query(), 'query');
}

/** Parse and validate route params. */
export function parseParams<S extends ZodTypeAny>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.param(), 'path');
}

const hook = (result: { success: boolean; error?: ZodError }) => {
  if (!result.success && result.error) throw zodToHttpError(result.error);
};

/** Hono validator middleware variants (typed `c.req.valid('json' | 'query' | 'param')`). */
export const vJson = <S extends ZodSchema>(schema: S) => zValidator('json', schema, hook);
export const vQuery = <S extends ZodSchema>(schema: S) => zValidator('query', schema, hook);
export const vParam = <S extends ZodSchema>(schema: S) => zValidator('param', schema, hook);
