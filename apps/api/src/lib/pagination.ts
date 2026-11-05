import type { Context } from 'hono';
import { paginationQuerySchema } from '@tp/core/contracts/common';
import { parseWith } from './validate';

/** Read `page`/`pageSize` from the query string → `{ page, pageSize, limit, offset }`. */
export function pageParams(c: Context) {
  const { page, pageSize } = parseWith(paginationQuerySchema, { page: c.req.query('page'), pageSize: c.req.query('pageSize') }, 'query');
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
