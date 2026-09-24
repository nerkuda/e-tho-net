/**
 * REST-аналог витрины инструкций сети (ADR 8c93f03a, ADR 717f04df, спека
 * 14b0cc4f — веха 7 версии 0.8.2): паритет с `etn.instructions`.
 *
 *   GET /networks/:networkId/instructions
 *     ?instruction_id=<id>   — полный текст одной инструкции;
 *     ?instruction_ids=<id>&instruction_ids=<id> — карточки перечня по списку
 *                            (в порядке запроса; ненайденные — в `missing`);
 *     ?keywords=<words>      — фильтр по title+synonyms мини-синтаксом;
 *     ?scope=roots|all       — только корневые (по умолчанию) или все активные;
 *     ?limit=&offset=        — пейджинг списка (только без instruction_id/
 *                              instruction_ids).
 *
 * Тонкий фасад над доменным {@link getNetworkInstructions}: разбирает вход,
 * зовёт домен, добавляет `network_id` в ответ. Читает **слой сессии** — тот же
 * контекст, что и остальные чтения сети (`openRouteNetworkDb`; ошибка
 * 3f535ae8: раньше здесь читалась основа в обход слоя).
 *
 * Веха 8 (задача c9d5f21e): вход — единый контракт `RestInstructions` из
 * `contracts.ts`; сообщения ошибок — канонические, те же, что у MCP.
 *
 * Нормы формы ответа общие с витриной `etn.instructions` (задача 65cf6074,
 * требование «Перечень etn.instructions отдаёт только корневые инструкции»):
 * режим без `keywords` возвращает только корневые инструкции, превью
 * постоянного комментария — до 300 символов; это дефолты доменного сервиса,
 * отдельно фасад их не передаёт.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
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
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        // REST-парсер repeatable-массива кладёт `[]` при отсутствии параметра —
        // пустой список считаем «не передан» (задача 649c55e2).
        const instructionIds =
          Array.isArray(input.instruction_ids) && input.instruction_ids.length > 0
            ? input.instruction_ids
            : undefined;
        const result = getNetworkInstructions(
          ndb,
          network.type_roles.instructions ?? null,
          input.network_id,
          {
            ...(input.instruction_id !== undefined ? { instructionId: input.instruction_id } : {}),
            ...(instructionIds !== undefined ? { instructionIds } : {}),
            ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.offset !== undefined ? { offset: input.offset } : {}),
          },
        );
        sendSuccess(reply, { network_id: input.network_id, ...result });
      },
    );
  };
}
