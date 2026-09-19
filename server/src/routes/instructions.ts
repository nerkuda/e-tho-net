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
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDbBase, queryInt, type RouteDeps } from './helpers.js';
import { getNetworkInstructions } from '../domain/instructions-service.js';

/** Route params for a network id. */
interface NetworkIdParams {
  networkId: string;
}

/** `/api/v1/networks*` instructions route plugin factory. */
export function createInstructionsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/instructions',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = req.query as Record<string, unknown>;

        const rawInstructionId = query['instruction_id'];
        const instructionId =
          typeof rawInstructionId === 'string' && rawInstructionId !== ''
            ? rawInstructionId
            : undefined;
        const rawKeywords = query['keywords'];
        const keywords = typeof rawKeywords === 'string' && rawKeywords !== '' ? rawKeywords : undefined;

        // Взаимоисключение режимов — как в схеме MCP-инструмента.
        if (instructionId !== undefined && keywords !== undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'instruction_id и keywords взаимоисключимы.',
            { fields: ['instruction_id', 'keywords'] },
            req.id,
          );
        }
        const limit = queryInt(query['limit'], undefined, { field: 'limit', min: 1, requestId: req.id });
        const offset = queryInt(query['offset'], undefined, { field: 'offset', min: 0, requestId: req.id });
        if (limit !== undefined && limit > 200) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'limit не может превышать 200.',
            { field: 'limit', max: 200 },
            req.id,
          );
        }
        if (instructionId !== undefined && (limit !== undefined || offset !== undefined)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'limit/offset применимы только к режиму перечня, не к instruction_id.',
            { fields: ['limit', 'offset'] },
            req.id,
          );
        }

        const network = app.systemDb.getNetworkById(networkId);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        const result = getNetworkInstructions(
          ndb,
          network.type_roles.instructions ?? null,
          networkId,
          {
            ...(instructionId !== undefined ? { instructionId } : {}),
            ...(keywords !== undefined ? { keywords } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
          },
        );
        sendSuccess(reply, { network_id: networkId, ...result });
      },
    );
  };
}
