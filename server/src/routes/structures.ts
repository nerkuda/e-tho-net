/**
 * Structures-view routes (L15, 03-server-api.md §6.10, §6.11, §18).
 *
 *   POST   /networks/:networkId/thoughts/query        — filter thoughts (paged)
 *   GET    /networks/:networkId/thoughts/:id/hierarchy — one-level parents/children
 *   GET    /networks/:networkId/saved-filters          — list own saved filters
 *   POST   /networks/:networkId/saved-filters          — create (idempotent)
 *   PATCH  /networks/:networkId/saved-filters/:fid     — rename / redefine (idempotent)
 *   DELETE /networks/:networkId/saved-filters/:fid     — delete
 *
 * The query/hierarchy handlers are read-only (no idempotency pre-handler);
 * saved-filter mutations emit `saved-filter.*` events with audience=user so
 * the user's other clients refresh their lists.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  STRUCTURES_EDGES_MAX_IDS,
  STRUCTURES_PAGE_SIZE,
  STRUCTURES_QUERY_IDS_MAX_LIMIT,
  STRUCTURES_QUERY_MAX_LIMIT,
  type CrossNetworkStructureQueryResponse,
  type FilterAst,
  type FocusEdge,
  type SavedFilterView,
  type StructureIdsQueryResponse,
  type StructureQueryRequest,
  type StructureSort,
  type SortOrder,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  requestBody,
  resolveShowTrash,
  restTokenContext,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  csvToList,
  parseBody,
  parseRest,
  RestEdgesBody,
  RestHierarchyQuery,
  RestSavedFilterCreateBody,
  RestSavedFilterPatchBody,
  RestSavedFilterViewQuery,
  RestStructureQueryBody,
} from '../contracts.js';
import {
  createSavedFilter,
  deleteSavedFilter,
  getHierarchy,
  isFilterEmpty,
  listSavedFilters,
  parseSavedFilterDefinition,
  parseStructureFilter,
  updateSavedFilter,
} from '../domain/structure-service.js';
import { parseFilterAst } from '../domain/filter-ast.js';
import { assertPropertyConditionsResolvable, structureRequestToQuery } from '../domain/query-service.js';
import { queryThoughtIdsAsync, queryThoughtsAsync } from '../domain/heavy-read.js';
import { parseChronicleFilterDefinition } from '../domain/chronicle-service.js';
import { getEdgesAmong, toFocusEdge } from '../domain/link-service.js';
import {
  fanOutQuery,
  type CrossNetworkAccess,
} from '../domain/cross-network-search-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a network + saved-filter id. */
interface SavedFilterIdParams {
  networkId: string;
  fid: string;
}

/** Разобрать тело POST /thoughts/query: обёртку валидирует контракт,
 *  фильтр — shared-парсер parseStructureFilter (домен); лимиты — как раньше.
 *  `show_trash` — REST-only поле обёртки (ошибка 331ffb94): собирается в
 *  результат отдельно, чтобы `meta.directions` считались по той же видимости
 *  корзины, что и раскрытие дерева. */
function parseQueryBody(
  body: Record<string, unknown>,
  requestId: string,
): StructureQueryRequest & { show_trash?: boolean; ast?: FilterAst } {
  const out = parseBody(RestStructureQueryBody, body, requestId);
  const filter = parseStructureFilter(body, requestId);
  // Тело-отбор AST (требование 91983c20, тех.проект «Ядро AST и операторы»):
  // критерии отбора выражаются ЛИБО деревом AST, ЛИБО плоскими полями — не
  // оба сразу (неоднозначно, какой источник истины). ФАСАДНЫЕ пред-сужения
  // `parent_ids` и `link_filter` в этот конфликт НЕ входят: они применяются
  // ПОВЕРХ критериев AST (требование 3482a399 — корни входят; `link_filter`
  // вынесен из AST сущностью 489c394f), движок связку поддерживает. Форму
  // дерева валидирует доменный parseFilterAst; неизвестные корневые поля уже
  // отклонены контрактом.
  const astRaw = body['ast'];
  let ast: FilterAst | undefined;
  if (astRaw !== undefined) {
    ast = parseFilterAst(astRaw, requestId);
    // «Плоские критерии» без фасадных полей: если после их исключения критериев
    // не осталось — конфликта нет.
    if (!isFilterEmpty({ ...filter, parent_ids: undefined, link_filter: undefined })) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'Тело-AST (`ast`) и плоские критерии переданы одновременно — выберите один источник отбора (фасадные `parent_ids`/`link_filter` совместимы с `ast`).',
        { field: 'ast' },
        requestId,
      );
    }
  }
  const sort = (out.sort ?? 'created') as StructureSort;
  const order = (out.order ?? 'asc') as SortOrder;
  const idsOnly = out.ids_only === true;
  const limit = (out.limit as number | undefined) ?? STRUCTURES_PAGE_SIZE;
  const offset = (out.offset as number | undefined) ?? 0;
  const maxLimit = idsOnly ? STRUCTURES_QUERY_IDS_MAX_LIMIT : STRUCTURES_QUERY_MAX_LIMIT;
  if (limit < 1 || limit > maxLimit) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `limit должен быть целым числом 1..${maxLimit}.`,
      { field: 'limit' },
      requestId,
    );
  }
  if (offset < 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'offset должен быть целым числом ≥ 0.',
      { field: 'offset' },
      requestId,
    );
  }
  return {
    ...filter,
    sort,
    order,
    limit,
    offset,
    ...(idsOnly ? { ids_only: true } : {}),
    ...(out.count === true ? { count: true } : {}),
    ...(typeof out.cursor === 'string' && out.cursor !== '' ? { cursor: out.cursor } : {}),
    ...(typeof out.show_trash === 'boolean' ? { show_trash: out.show_trash } : {}),
    ...(ast !== undefined ? { ast } : {}),
  };
}

/** `/api/v1/networks*` structures routes plugin factory. */
export function createStructuresRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- Filter query (03-server-api.md §6.10) -------------------------------

    app.post(
      '/networks/:networkId/thoughts/query',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const query = parseQueryBody(body, req.id);
        // Задача eb1a3f43, требование c98d5d19: веерный режим. Несовместимо
        // с `ids_only` (тот используется для bulk-команд в одной сети).
        const networkIds = (body['network_ids'] as string[] | undefined);
        if (networkIds !== undefined) {
          const requested = (networkIds as string[]).includes(networkId)
            ? (networkIds as string[])
            : [networkId, ...(networkIds as string[])];
          const unique = [...new Set(requested)];
          const accessibleIds: string[] = [];
          for (const id of unique) {
            if (app.systemDb.getMemberRole(req.auth!.user.id, id) !== null) accessibleIds.push(id);
          }
          const networks = accessibleIds.map((id) => ({
            id,
            display_name: app.systemDb.getNetworkById(id)?.display_name ?? id,
          }));
          if (networks.length === 0) {
            sendSuccess(
              reply,
              {
                total: 0,
                items: [],
                directions: {},
                networks: [],
              } satisfies CrossNetworkStructureQueryResponse,
            );
            return;
          }
          const access: CrossNetworkAccess = {
            networks,
            accessibleIds,
            dataDir: deps.dataDir,
            userId: req.auth!.user.id,
            clientId:
              req.auth?.clientId ??
              (req.headers['x-etn-client-id'] as string | undefined) ??
              `rest:${req.auth!.user.id}`,
            logger: app.appLogger,
          };
          // Используем общий конвертер `structureRequestToQuery` —
          // те же правила резолва имён типов/свойств, что и в обычном пути.
          // `queryThoughts` принимает уже канонический `ThoughtQueryRequest`.
          const canon = structureRequestToQuery(query);
          const result = await fanOutQuery(access, {
            networkIds: accessibleIds,
            query: query.ast === undefined ? canon : { ...canon, ast: query.ast },
            limit: canon.limit ?? 50,
            offset: canon.offset ?? 0,
            // Токены AST в веерном режиме разрешаются по реестру КАЖДОЙ сети
            // (свой первый день недели) — фабрика берёт networkId.
            tokenContextFor: (nid) => restTokenContext(app, req.auth!.user.id, nid),
          });
          // Fan-out возвращает упрощённые хиты (id/title/type_id/active/depth).
          // Этого хватает для веерного режима — карточка читается через
          // `etn.thoughts.get` при необходимости. Для одиночной сети
          // `StructureQueryResponse.items` — полные `ThoughtRef`; в веерном
          // режиме добавляется `network_id` (нет в `ThoughtRef`).
          // `satisfies CrossNetworkStructureQueryResponse` опущен намеренно:
          // веерные элементы — не `ThoughtRef`, а расширение с `network_id`.
          sendSuccess(reply, {
            items: result.response.hits.map((h) => ({
              id: h.id,
              title: h.title,
              type_id: h.type_id,
              active: h.active,
              depth: h.depth,
              network_id: h.network_id,
            })),
            total: result.response.total,
            truncated: result.response.truncated,
            reason: result.response.reason,
            networks: result.networks,
            // Неразрешимые токены AST, агрегированные по сетям (требование
            // b7fdab20) — та же семантика, что у одиночной выборки; поле
            // формирует домен (`fanOutQuery`), здесь только проброс в JSON.
            ...(result.response.unresolved !== undefined && result.response.unresolved.length > 0
              ? { unresolved: result.response.unresolved }
              : {}),
          });
          return;
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Граница ввода (ошибки 090d0242/4f17cb73, 0.12.1): неразрешимая ссылка
        // на свойство в отборе — явная ошибка, а не молчаливое расширение
        // выборки. Движок на такую ссылку даёт «нет совпадений»; роут как
        // пользовательский вход отвергает её с указанием поля.
        assertPropertyConditionsResolvable(ndb, query.properties, req.id);
        // Контекст разрешения токенов AST (обязательный пункт задачи c13762b1):
        // `$today`/`$weekStart`/`$user` и профиль времени. Собирается в роуте —
        // движок ждёт `AstTokenContext` в опциях.
        const tokenContext = restTokenContext(app, req.auth!.user.id, networkId);
        // Канонический запрос: готовое AST-тело (если передано) или плоские
        // критерии (компилируются в AST внутри движка — единый вход).
        const canonical = (() => {
          const c = structureRequestToQuery(query);
          return query.ast === undefined ? c : { ...c, ast: query.ast };
        })();
        // ids_only (L22): bare ids for the bulk filter commands — the same
        // candidate set and ordering, a higher limit ceiling, no meta flags.
        if (query.ids_only === true) {
          const result = await queryThoughtIdsAsync(ndb, req.auth!.user.id, canonical, {
            maxLimit: STRUCTURES_QUERY_IDS_MAX_LIMIT,
            emptyFilterMode: 'home_orphans',
            tokenContext,
          });
          sendSuccess(reply, {
            ids: result.ids,
            total: result.total,
            has_more: result.has_more,
            next_cursor: result.next_cursor,
          } satisfies StructureIdsQueryResponse);
          return;
        }
        const result = await queryThoughtsAsync(
          ndb,
          req.auth!.user.id,
          canonical,
          {
            maxLimit: STRUCTURES_QUERY_MAX_LIMIT,
            emptyFilterMode: 'home_orphans',
            includeDirections: true,
            tokenContext,
            // Эллипс раскрываемости считает те же рёбра, что и раскрытие
            // (ошибка 331ffb94): directionsOf обязан смотреть на корзину тем
            // же флагом, что getHierarchy, иначе заполненный эллипс
            // разворачивается в пустую ветвь. Флаг резолвится как везде
            // (задача 77923b49): переопределение тела сильнее настройки сети.
            showTrash: resolveShowTrash(
              app,
              req.auth!.user.id,
              networkId,
              query.show_trash,
            ),
          },
        );
        sendList(reply, result.items, result.total, query.offset, query.limit, {
          directions: result.directions,
          has_more: result.has_more,
          next_cursor: result.next_cursor,
        });
      },
    );

    // --- One-level hierarchy expansion (03-server-api.md §6.11) --------------

    app.get(
      '/networks/:networkId/thoughts/:id/hierarchy',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestHierarchyQuery, req);
        const networkId = input.network_id as string;
        const dir = input.dir as 'parents' | 'children';
        const showInactive = (input.show_inactive as boolean | undefined) ?? false;
        // Показывать содержимое корзины (задача 77923b49): дерево «Структур»
        // прячет помеченных, когда настройка выключена (default — видны).
        const showTrash = resolveShowTrash(
          app,
          req.auth!.user.id,
          networkId,
          input.show_trash as boolean | undefined,
        );
        const offset = input.offset ?? 0;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const data = getHierarchy(ndb, input.thought_id, dir, {
          showInactive,
          showTrash,
          excludeIds: csvToList((req.query as Record<string, unknown>)['exclude_ids']),
          offset,
          // Фильтр обхода по связям (ошибка db504c1a): раскрытие ветви обязано
          // идти по тем же рёбрам, что и спуск отбора `parent_ids`.
          linkFilter: input.link_filter,
        });
        sendSuccess(reply, data);
      },
    );

    // --- Links among visible thoughts (03-server-api.md §6.12) ---------------

    app.post(
      '/networks/:networkId/thoughts/edges',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestEdgesBody, req);
        const networkId = input.network_id as string;
        const ids = (input.ids as string[]).slice(0, STRUCTURES_EDGES_MAX_IDS);
        const showInactive = input.show_inactive === true;
        const showTrash = resolveShowTrash(
          app,
          req.auth!.user.id,
          networkId,
          input.show_trash as boolean | undefined,
        );
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Same projection as the focus response (`toFocusEdge`) — including
        // the trash flag from 355319d4, so the tree lines mark trashed edges
        // exactly like the map does.
        // Фильтр типов связей (ошибка a617b4c6): снимок рёбер для догрузки
        // порций обязан уважать тот же `link_filter`, что и фокус/страницы
        // секторов, — иначе на холст возвращались рёбра отфильтрованных типов.
        const edges: FocusEdge[] = getEdgesAmong(
          ndb,
          ids,
          showInactive,
          input.link_filter,
          showTrash,
        ).map(toFocusEdge);
        sendSuccess(reply, { edges });
      },
    );

    // --- Saved filters (03-server-api.md §18) --------------------------------

    app.get(
      '/networks/:networkId/saved-filters',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const view = (parseRest(RestSavedFilterViewQuery, req).view ??
          'structures') as SavedFilterView;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listSavedFilters(ndb, req.auth!.user.id, view));
      },
    );

    app.post(
      '/networks/:networkId/saved-filters',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const input = parseRest(RestSavedFilterCreateBody, req);
        const view = (input.view ?? 'structures') as SavedFilterView;
        const name = input.name as string;
        const definitionRaw = input.definition;
        const definition =
          view === 'chronicle'
            ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
            : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const filter = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const created = createSavedFilter(ndb, req.auth!.user.id, view, name, definition);
          return {
            result: created,
            events: [
              {
                type: 'saved-filter.created',
                data: { filter: created },
                options: { audience: 'user' },
              },
            ],
          };
        });
        sendCreated(reply, filter, { request_id: req.id });
      },
    );

    app.patch(
      '/networks/:networkId/saved-filters/:fid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as SavedFilterIdParams;
        const input = parseRest(RestSavedFilterPatchBody, req);
        const view = (input.view ?? 'structures') as SavedFilterView;
        const name = input.name as string | undefined;
        let definition: Parameters<typeof updateSavedFilter>[3]['definition'];
        const definitionRaw = input.definition;
        if (definitionRaw !== undefined) {
          definition =
            view === 'chronicle'
              ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
              : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const filter = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateSavedFilter(ndb, req.auth!.user.id, fid, {
            ...(name !== undefined ? { name } : {}),
            ...(definition !== undefined ? { definition } : {}),
          });
          return {
            result: updated,
            events: [
              {
                type: 'saved-filter.updated',
                data: { filter: updated },
                options: { audience: 'user' },
              },
            ],
          };
        });
        sendSuccess(reply, filter, { request_id: req.id });
      },
    );

    app.delete(
      '/networks/:networkId/saved-filters/:fid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as SavedFilterIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: deleteSavedFilter(ndb, req.auth!.user.id, fid),
          events: [
            { type: 'saved-filter.deleted', data: { id: fid }, options: { audience: 'user' } },
          ],
        }));
        sendSuccess(reply, { id: fid });
      },
    );
  };
}
