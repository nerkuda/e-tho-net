/**
 * File-journal management routes (task 1dd33e23 §4, 03-server-api.md §16).
 *
 *   GET    /api/v1/system/logging            — flag state + retention + file list
 *   PUT    /api/v1/system/logging            — toggle the in-memory logging flag
 *   GET    /api/v1/system/logs/:filename     — download one journal file (text/plain)
 *   DELETE /api/v1/system/logs/:filename     — remove one file (current day: truncate)
 *   DELETE /api/v1/system/logs               — remove every file (current day: truncate)
 *
 * All routes are admin-only (`requireAdmin` — system-level, no network scope).
 * The `:filename` parameter must match `^server-\d{4}-\d{2}-\d{2}\.log$`
 * strictly, which rules out path traversal by construction.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type SystemLoggingStatus } from '@etn/shared';

import { FileLog, RETENTION_DAYS } from '../log/file-log.js';
import { sendSuccess } from '../http/responses.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared file journal (created once per server process in `createServer`). */
    fileLog: FileLog;
  }
}

/** Full status payload for `GET`/`PUT /system/logging`. */
function statusPayload(fileLog: FileLog): SystemLoggingStatus {
  return {
    enabled: fileLog.enabled,
    logDir: fileLog.dir,
    retentionDays: RETENTION_DAYS,
    files: fileLog.listFiles(),
  };
}

/** `/api/v1/system/logging*` + `/api/v1/system/logs*` route plugin (admin only). */
export const systemLoggingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin } = app.accessControl;
  const fileLog = app.fileLog;

  app.get(
    '/system/logging',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (_req, reply) => {
      sendSuccess(reply, statusPayload(fileLog));
    },
  );

  app.put(
    '/system/logging',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const body = (req.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Поле enabled обязательно и должно быть boolean (true/false).',
          { field: 'enabled' },
          req.id,
        );
      }
      // The toggle itself is always journaled (with the acting admin) even
      // though WARN normally requires the flag — see FileLog.setEnabled.
      fileLog.setEnabled(body.enabled, req.auth?.user.username);
      sendSuccess(reply, statusPayload(fileLog));
    },
  );

  app.get(
    '/system/logs/:filename',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const { filename } = req.params as { filename: string };
      if (!FileLog.isValidLogFilename(filename)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Имя файла журнала должно иметь вид server-YYYY-MM-DD.log.',
          { field: 'filename' },
          req.id,
        );
      }
      const content = fileLog.readFile(filename);
      if (content === null) {
        throw new EtnError('NOT_FOUND', `Файл журнала ${filename} не найден.`, undefined, req.id);
      }
      reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(content);
    },
  );

  app.delete(
    '/system/logs/:filename',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const { filename } = req.params as { filename: string };
      if (!FileLog.isValidLogFilename(filename)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Имя файла журнала должно иметь вид server-YYYY-MM-DD.log.',
          { field: 'filename' },
          req.id,
        );
      }
      const result = fileLog.deleteFile(filename, req.auth?.user.username);
      if (result === null) {
        throw new EtnError('NOT_FOUND', `Файл журнала ${filename} не найден.`, undefined, req.id);
      }
      reply.code(204).send();
    },
  );

  app.delete(
    '/system/logs',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      fileLog.deleteAll(req.auth?.user.username);
      reply.code(204).send();
    },
  );
};
