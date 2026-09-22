/**
 * Audit-log admin route (task B14, 03-server-api.md §15).
 *
 *   GET /api/v1/admin/audit?actor=&network=&category=&from=&to=&limit=&offset=
 *
 * Admin-only. Returns the newest entries first with pagination metadata.
 *
 * Веха 8 (задача c9d5f21e): вход — единый контракт `RestAuditQuery`
 * из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type AuditCategory, type AuditQuery } from '@etn/shared';

import { sendList } from '../http/responses.js';
import { parseRest, RestAuditQuery } from '../contracts.js';

/** `/api/v1/admin/audit` route plugin (admin only). */
export const auditRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin } = app.accessControl;

  app.get(
    '/admin/audit',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const input = parseRest(RestAuditQuery, req);
      const q: AuditQuery = {
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        ...(input.network !== undefined ? { network: input.network } : {}),
        ...(input.category !== undefined ? { category: input.category as AuditCategory } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
      };
      const query = { ...q, limit: input.limit ?? 50, offset: input.offset ?? 0 };
      const total = app.systemDb.countAudit(query);
      const entries = app.systemDb.queryAudit(query);
      sendList(reply, entries, total, query.offset, query.limit);
    },
  );
};
