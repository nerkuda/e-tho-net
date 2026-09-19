/**
 * REST-аналог витрины инструкций сети (ADR 8c93f03a, ADR 717f04df, спека
 * 14b0cc4f — веха 7 версии 0.8.2): паритет с `etn.instructions`.
 *
 *   GET /networks/:networkId/instructions
 *     ?instruction_id=<id>   — полный текст одной инструкции;
 *     ?keywords=<words>      — фильтр по title+synonyms мини-синтаксом;
 *     ?limit=&offset=        — пейджинг списка (только без instruction_id).
 *
 * Тонкий фасад над доменным {@link getNetworkInstructions}: разбирает вход,
 * зовёт домен, добавляет `network_id` в ответ. Читает базовый слой — тот же
 * контекст, что и MCP-инструмент (инструкции сети — канон из основы).
 *
 * Веха 8 (задача c9d5f21e): вход — единый контракт `RestInstructions` из
 * `contracts.ts`; сообщения ошибок — канонические, те же, что у MCP.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDbBase, type RouteDeps } from './helpers.js';
import { getNetworkInstructions } from '../domain/instructions-service.js';
import { parseRest, RestInstructions } from '../contracts.js';

/** `/api/v1/networks*` instructions route plugin factory. */
export function createInstructionsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/instructions',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestInstructions, req);

        const network = app.systemDb.getNetworkById(input.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const result = getNetworkInstructions(
          ndb,
          network.type_roles.instructions ?? null,
          input.network_id,
          {
            ...(input.instruction_id !== undefined ? { instructionId: input.instruction_id } : {}),
            ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.offset !== undefined ? { offset: input.offset } : {}),
          },
        );
        sendSuccess(reply, { network_id: input.network_id, ...result });
      },
    );
  };
}
