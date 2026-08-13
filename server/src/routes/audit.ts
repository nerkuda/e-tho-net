/**
 * Audit-log admin route (task B14, 03-server-api.md §15).
 *
 *   GET /api/v1/admin/audit?actor=&network=&category=&from=&to=&limit=&offset=
 *
 * Admin-only. Returns the newest entries first with pagination metadata.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { AUDIT_CATEGORIES, type AuditCategory, type AuditQuery } from '@etn/shared';

import { EtnError } from '@etn/shared';

import { sendList } from '../http/responses.js';

/** Parsed + validated query for `GET /admin/audit`. */
function parseAuditQuery(raw: NodeJS.Dict<string>): AuditQuery & { limit: number; offset: number } {
  const q: AuditQuery = {};
  if (typeof raw.actor === 'string' && raw.actor.length > 0) {
    q.actor = raw.actor;
  }
  if (typeof raw.network === 'string' && raw.network.length > 0) {
    q.network = raw.network;
  }
  if (typeof raw.category === 'string' && raw.category.length > 0) {
    if (!(AUDIT_CATEGORIES as readonly string[]).includes(raw.category)) {
      throw new EtnError('VALIDATION_ERROR', `Недопустимая категория: ${raw.category}`, {
        field: 'category',
      });
    }
    q.category = raw.category as AuditCategory;
  }
  if (typeof raw.from === 'string' && raw.from.length > 0) {
    q.from = raw.from;
  }
  if (typeof raw.to === 'string' && raw.to.length > 0) {
    q.to = raw.to;
  }
  const limit = raw.limit !== undefined ? Number.parseInt(raw.limit, 10) : 50;
  const offset = raw.offset !== undefined ? Number.parseInt(raw.offset, 10) : 0;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new EtnError('VALIDATION_ERROR', 'limit должен быть положительным целым.', {
      field: 'limit',
    });
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new EtnError('VALIDATION_ERROR', 'offset должен быть неотрицательным целым.', {
      field: 'offset',
    });
  }
  return { ...q, limit, offset };
}

/** `/api/v1/admin/audit` route plugin (admin only). */
export const auditRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin } = app.accessControl;

  app.get(
    '/admin/audit',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const query = parseAuditQuery(req.query as NodeJS.Dict<string>);
      const total = app.systemDb.countAudit(query);
      const entries = app.systemDb.queryAudit(query);
      sendList(reply, entries, total, query.offset, query.limit);
    },
  );
};
