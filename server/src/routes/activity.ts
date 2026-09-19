/**
 * Activity-log REST route (задача f2eca5a4 «Журнал activity_log: запись,
 * миграция, REST /activity», операция 70dfe81d «/activity — лента, свёртка
 * и обрезка», docs/03-server-api.md §13d; задача 6bcccd2b «Свёртка и
 * обрезка журнала, авто-свёртка при слиянии слоёв»).
 *
 *   GET   /api/v1/networks/:nid/activity
 *         ?from_ms&to_ms&user_id&entity_type&entity_id&limit&offset
 *         → 200 { data: ActivityRow[], meta: { total, offset, limit } }
 *
 *   POST  /api/v1/networks/:nid/activity/rollup   { until_ms }
 *         → 200 { removed, kept }
 *
 *   POST  /api/v1/networks/:nid/activity/truncate { until_ms }
 *         → 200 { removed }
 *
 * Чтение (`GET`) доступно любому участнику сети. Запись идёт отдельной
 * транзакцией из мутирующих роутов (см. `domain/activity-service.ts`).
 * Обслуживание (`POST rollup`/`truncate`) тоже доступно любому участнику
 * сети: это публичные операции сети (требование 9ac48831 «равноправие»).
 *
 * Операции обслуживания необратимы; UI/клиент должен показывать
 * подтверждение, сервер сам по себе ничего не блокирует (требование 6bcccd2b).
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendList, sendSuccess } from '../http/responses.js';
import {
  ACTIVITY_LIMIT_MAX,
  listActivity,
  rollupActivity,
  truncateActivity,
} from '../domain/activity-service.js';
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
import { parseRest, RestActivityList, RestActivityRollup, RestActivityTruncate } from '../contracts.js';

/** `/api/v1/networks*` activity routes plugin factory. */
export function createActivityRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // -------------------------------------------------------------------------
    // GET /api/v1/networks/:nid/activity — list (filters + pagination)
    // -------------------------------------------------------------------------
    app.get(
      '/networks/:networkId/activity',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestActivityList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = listActivity(ndb, {
          networkId: input.network_id,
          from_ms: input.from_ms ?? 0,
          to_ms: input.to_ms ?? Number.MAX_SAFE_INTEGER,
          user_id: input.user_id,
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          limit: Math.min(ACTIVITY_LIMIT_MAX, input.limit ?? 50),
          offset: input.offset ?? 0,
        });
        sendList(reply, result.data, result.total, result.offset, result.limit);
      },
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/networks/:nid/activity/rollup — свёртка журнала до until_ms
    // (задача 6bcccd2b, требование 76443b7e «свёртка»).
    //
    // Тело: { until_ms: number } — все строки с `occurred_at_ms <= until_ms`
    // сворачиваются по семантике rollupActivity. Возвращает счётчики.
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/activity/rollup',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestActivityRollup, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = rollupActivity(ndb, input.network_id, input.until_ms);
        sendSuccess(reply, result);
      },
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/networks/:nid/activity/truncate — обрезка журнала до until_ms
    // (задача 6bcccd2b, требование 9921a32b «обрезка»).
    //
    // Тело: { until_ms: number } — все строки с `occurred_at_ms <= until_ms`
    // удаляются безусловно.
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/activity/truncate',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestActivityTruncate, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = truncateActivity(ndb, input.network_id, input.until_ms);
        sendSuccess(reply, result);
      },
    );
  };
}
