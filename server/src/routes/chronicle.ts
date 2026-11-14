/**
 * Chronicle-view routes (L20, 03-server-api.md §20).
 *
 *   POST /networks/:networkId/chronicle/query — two-phase chronological-comment
 *     query (thoughts → their chronological comments + link comments).
 *   GET  /networks/:networkId/chronicle/day-links — «связи дня» диапазона
 *     календарных дней клиента (0.16.1, требование 1fb1047d): датовые факты
 *     мыслей + date-ссылки записей и постоянных комментариев (без задач).
 *
 * The query handler is read-only (no idempotency pre-handler); saved filters
 * of the chronicle view reuse the shared `/saved-filters` endpoints with
 * `view = 'chronicle'` (03-server-api.md §18).
 *
 * Веха 8 (задача c9d5f21e): валидация входа — доменный
 * `parseChronicleQueryBody`, тот же парсер, что у MCP `etn.chronicle.query`
 * (одна схема на операцию — в домене, оба фасада её вызывают).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendList, sendSuccess } from '../http/responses.js';
import { filterProfileHasTime, type DayLinksResult } from '@etn/shared';
import { openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import { parseRest, RestChronicleDayLinks } from '../contracts.js';
import { parseChronicleQueryBody, queryChronicle } from '../domain/chronicle-service.js';
import { listDayLinks } from '../domain/day-links-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** `/api/v1/networks*` chronicle routes plugin factory. */
export function createChronicleRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.post(
      '/networks/:networkId/chronicle/query',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        // Формат тела строки (0.15.1, ошибки 50a94510, 35e1319a): доменный
        // парсер принимает md|html|both, отсутствие — `html` (ровно прежний
        // состав ответа: клиент читает `body_html`); `md`/`both` — явными
        // значениями. Проекция выполняется в `queryChronicle` — общий путь с MCP.
        const query = parseChronicleQueryBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Контекст профиля хроники (требование 0095daad, ADR 0c02ab4f): первый
        // день недели сети для `$weekStart`/`$weekEnd` и `withTime` (хроника —
        // профиль со временем). Настроек сети у домена нет — берём здесь.
        const network = app.systemDb.getNetworkById(networkId);
        const result = queryChronicle(ndb, query, {
          userId: req.auth!.user.id,
          ...(network !== null && network.first_day_of_week !== undefined
            ? { firstDayOfWeek: network.first_day_of_week }
            : {}),
          withTime: filterProfileHasTime('chronicle'),
        });
        sendList(reply, result.rows, result.total, query.offset, query.limit, {
          // Диагностика ядра отбора (требование 44d61c8a): `warnings`
          // адресуют строку редактора — тот же конверт `meta`, что у
          // «Структур». Пусто — поле не добавляется.
          ...(result.warnings !== undefined && result.warnings.length > 0
            ? { warnings: result.warnings }
            : {}),
        });
      },
    );

    // «Связи дня» дня ленты «Дневника» (0.16.1, требование 1fb1047d): датовые
    // факты мыслей + date-ссылки из хроно-записей и постоянных комментариев,
    // кроме строк-задач. Данные — индексные чтения проекции (task_row_dates,
    // INDEX(date)) и справочника свойств; парсинг при чтении не выполняется.
    app.get(
      '/networks/:networkId/chronicle/day-links',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestChronicleDayLinks, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result: DayLinksResult = listDayLinks(ndb, {
          from: input.from,
          ...(input.to !== undefined ? { to: input.to } : {}),
        });
        sendSuccess(reply, result, { request_id: req.id });
      },
    );
  };
}
