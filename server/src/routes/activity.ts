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
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendList, sendSuccess } from '../http/responses.js';
import {
  ACTIVITY_LIMIT_MAX,
  listActivity,
  rollupActivity,
  truncateActivity,
} from '../domain/activity-service.js';
import {
  bodyObject,
  fieldNullableInt,
  openRouteNetworkDb,
  queryInt,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

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
        const { networkId } = req.params as NetworkIdParams;
        const query = req.query as Record<string, unknown>;
        // `user_id`/`entity_type`/`entity_id` — одиночные строки, чтобы не
        // множить комбинации. Множественные значения отвергаются валидацией.
        const userIds = queryStrings(query['user_id']);
        const entityTypes = queryStrings(query['entity_type']);
        const entityIds = queryStrings(query['entity_id']);
        if (userIds.length > 1 || entityTypes.length > 1 || entityIds.length > 1) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'user_id, entity_type и entity_id принимают ровно одно значение.',
            { field: 'user_id|entity_type|entity_id' },
            req.id,
          );
        }
        const fromMs = queryInt(query['from_ms'], 0, {
          field: 'from_ms',
          min: 0,
          requestId: req.id,
        });
        const toMs = queryInt(query['to_ms'], Number.MAX_SAFE_INTEGER, {
          field: 'to_ms',
          min: 0,
          requestId: req.id,
        });
        const limit = queryInt(query['limit'], 50, {
          field: 'limit',
          min: 1,
          requestId: req.id,
        });
        const offset = queryInt(query['offset'], 0, {
          field: 'offset',
          min: 0,
          requestId: req.id,
        });

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = listActivity(ndb, {
          networkId,
          from_ms: fromMs,
          to_ms: toMs,
          user_id: userIds[0],
          entity_type: entityTypes[0],
          entity_id: entityIds[0],
          limit: Math.min(ACTIVITY_LIMIT_MAX, limit),
          offset,
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
        const { networkId } = req.params as NetworkIdParams;
        const body = bodyObject(requestBody(req), req.id);
        const untilMs = fieldNullableInt(body, 'until_ms', req.id);
        if (untilMs === undefined || untilMs === null) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'until_ms обязателен и должен быть неотрицательным целым.',
            { field: 'until_ms' },
            req.id,
          );
        }
        if (untilMs < 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'until_ms должен быть неотрицательным целым.',
            { field: 'until_ms' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = rollupActivity(ndb, networkId, untilMs);
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
        const { networkId } = req.params as NetworkIdParams;
        const body = bodyObject(requestBody(req), req.id);
        const untilMs = fieldNullableInt(body, 'until_ms', req.id);
        if (untilMs === undefined || untilMs === null) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'until_ms обязателен и должен быть неотрицательным целым.',
            { field: 'until_ms' },
            req.id,
          );
        }
        if (untilMs < 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'until_ms должен быть неотрицательным целым.',
            { field: 'until_ms' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = truncateActivity(ndb, networkId, untilMs);
        sendSuccess(reply, result);
      },
    );
  };
}
