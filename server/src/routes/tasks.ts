/**
 * Задачи (0.16.1, задача 632eca85; операции e6d65f51 / de4cee18).
 *
 *   GET   /networks/:networkId/tasks  — выборка задач из проекции
 *   PATCH /networks/:networkId/tasks  — правка строк (toggle/move/cancel,
 *                                       массовые cancel-all/move-all)
 *
 * GET читает ТОЛЬКО материализованную проекцию (парсинг при чтении не
 * выполняется, ADR d0c07f33) и идёт через фасад тяжёлых чтений (`listTasksAsync`
 * → reader-пул). PATCH меняет `body_md` источника через обёртку записи домена
 * (транзакция → журнал → события): таблицы проекции обновит хук записи
 * комментария, клиент получает новые ревизии для undo.
 *
 * Права — как у комментариев: членство в сети на чтение, захват владельца и
 * проверка ревизии — в доменной правке комментария.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { TaskMassAction, TaskOpResult, TaskPatchResult } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  resolveShowTrash,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import { listTasksAsync } from '../domain/heavy-read.js';
import { applyTaskMassCommand, applyTaskOps, type TaskOpInput } from '../domain/task-service.js';
import { parseRest, RestTaskList, RestTaskPatch } from '../contracts.js';

/** `/api/v1/networks/:networkId/tasks` route plugin factory. */
export function createTasksRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/tasks',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestTaskList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const page = await listTasksAsync(ndb, {
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.thought_id !== undefined ? { thoughtId: input.thought_id } : {}),
          ...(input.comment_id !== undefined ? { commentId: input.comment_id } : {}),
          ...(input.today !== undefined ? { today: input.today } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.count !== undefined ? { count: input.count } : {}),
          ...(input.include_nested !== undefined ? { includeNested: input.include_nested } : {}),
          // Содержимое корзины — per-user настройка (`show_trash`), явный
          // query-параметр имеет приоритет (пачка 11, задача 173e8368).
          showTrash: resolveShowTrash(app, req.auth!.user.id, input.network_id, input.show_trash),
        });
        sendSuccess(reply, page, { request_id: req.id });
      },
    );

    app.patch(
      '/networks/:networkId/tasks',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestTaskPatch, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const fx = restWriteFx(deps, req, input.network_id);

        const result: TaskPatchResult = runWrite(ndb, fx, () => {
          const applied =
            input.ops !== undefined
              ? applyTaskOps(ndb, input.ops as TaskOpInput[], fx.userId)
              : applyTaskMassCommand(
                  ndb,
                  {
                    action: input.action as TaskMassAction,
                    filter: input.filter ?? {},
                    ...(input.days !== undefined ? { days: input.days } : {}),
                    ...(input.months !== undefined ? { months: input.months } : {}),
                  },
                  fx.userId,
                );
          return {
            result: { results: applied.results as TaskOpResult[], revisions: applied.revisions },
            // Правка строки — правка её комментария-источника: подписчики
            // получают штатное `comment.updated` (новый `body_md` целиком,
            // чтобы клиент мог сравнить с открытой панелью и показать «Обновить»).
            events: applied.changed.map((comment) => ({
              type: 'comment.updated' as const,
              data: {
                id: comment.id,
                owner_id: comment.owner_id,
                owner_type: comment.owner_type,
                kind: comment.kind,
                changes: { body_md: comment.body_md },
                version: comment.version,
              },
            })),
            activity: applied.changed.map((comment) => ({
              kind: 'comment' as const,
              action: 'updated' as const,
              comment,
            })),
          };
        });
        sendSuccess(reply, result, { request_id: req.id });
      },
    );
  };
}
