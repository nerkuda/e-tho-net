/**
 * Статистика мыслесети (задача c69b078d, версия 0.9.1; 03-server-api.md):
 *
 *   GET /networks/:networkId/statistics — сводка по всей сети (сумма по слоям).
 *
 * Права — обычные для участника сети (`requireNetworkMember`): любой участник
 * видит объём своей мыслесети, чужие сети закрыты. Только чтение: соединение
 * открывается в контексте основы, но доменный сервис читает физические
 * ветвимые таблицы и потому видит строки всех слоёв (см.
 * `domain/network-stats-service.ts`).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDbBase, type RouteDeps } from './helpers.js';
import { networkStatistics } from '../domain/network-stats-service.js';
import { NetworksStatistics, parseRest } from '../contracts.js';

/** `/api/v1/networks/:networkId/statistics` route plugin factory. */
export function createStatisticsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/statistics',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(NetworksStatistics, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        sendSuccess(reply, networkStatistics(ndb));
      },
    );
  };
}
