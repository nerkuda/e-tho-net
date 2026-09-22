/**
 * Trash routes (task S13, 03-server-api.md §14b).
 *
 *   GET  /networks/:networkId/trash        — marked-for-deletion thoughts/links
 *   POST /networks/:networkId/trash/purge  — delete unblocked marked rows
 *                                            (optional body `{ ids: [...] }` —
 *                                            targeted purge, ошибка 8b4b7a7e)
 *
 * The trash has no dedicated table: it is the set of rows with
 * `marked_for_deletion = 1` (02-data-model.md §3.1.2). Listing precomputes each
 * row's blocking check; purging physically deletes the unblocked ones and
 * silently skips the blocked ones.
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';
import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
import { listTrash, purgeTrash } from '../domain/trash-service.js';
import { parseRest, RestTrashList, RestTrashPurge } from '../contracts.js';

/** `/api/v1/networks*` trash routes plugin factory. */
export function createTrashRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/trash',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestTrashList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        sendSuccess(reply, listTrash(ndb));
      },
    );

    app.post(
      '/networks/:networkId/trash/purge',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestTrashPurge, req);
        // Optional targeted purge (ошибка 8b4b7a7e): `ids` narrows the sweep to
        // the listed rows — the per-item «Удалить совсем» of the link delete
        // dialog and the trash screen. Without the field the purge keeps its
        // original "every unblocked marked row" semantics.
        let ids: string[] | undefined;
        const rawIds = input.ids as string[] | undefined;
        if (rawIds !== undefined) {
          if (rawIds.length === 0) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'ids должен быть непустым массивом строк (или отсутствовать — очистка всей корзины).',
              { field: 'ids' },
              req.id,
            );
          }
          ids = [...new Set(rawIds)];
        }
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        // Весь проход очистки — одна обёрточная транзакция (требование
        // 3269a025): сбой посреди не оставляет частичного удаления. События
        // `*.deleted` и журнал — из результата очистки, после коммита.
        const outcome = runWrite(ndb, restWriteFx(deps, req, input.network_id), () =>
          purgeTrash(ndb, ids),
        );
        // Wire-ответ несёт только счётчики (03-server-api.md §14b) —
        // списки удалённых id остаются внутри исхода для событий/журнала.
        sendSuccess(reply, { purged: outcome.purged, skipped: outcome.skipped });
      },
    );
  };
}
