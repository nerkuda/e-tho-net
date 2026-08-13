/**
 * Success-response helpers wrapping the canonical `{ data, meta }` envelope
 * (03-server-api.md §2). Kept separate from {@link errors.ts} so handlers read
 * symmetrically: `sendSuccess(...)` / `sendEtnError(...)`.
 */

import type { FastifyReply } from 'fastify';

import type { ApiList, ApiSuccess, SuccessMeta } from '@etn/shared';

/**
 * Send a single-item success response `{ data }` (optional `meta`).
 *
 * @param status - HTTP status (default 200).
 */
export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  meta?: SuccessMeta,
  status: number = 200,
): void {
  const body: ApiSuccess<T> = { data };
  if (meta !== undefined) {
    body.meta = meta;
  }
  reply.code(status).send(body);
}

/**
 * Send a list response `{ data: [...], meta: { total, offset, limit } }`.
 */
export function sendList<T>(
  reply: FastifyReply,
  data: T[],
  total: number,
  offset: number,
  limit: number,
): void {
  const body: ApiList<T> = { data, meta: { total, offset, limit } };
  reply.code(200).send(body);
}

/** Send a 201 with a Location-style body. Convenience over {@link sendSuccess}. */
export function sendCreated<T>(reply: FastifyReply, data: T, meta?: SuccessMeta): void {
  sendSuccess(reply, data, meta, 201);
}
