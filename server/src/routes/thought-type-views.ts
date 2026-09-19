/**
 * Routes for the thought-type-view resource (задача 65de7eaa, операции
 * b90bb6e6 «CRUD отборов типа» и 95273103 «POST /thoughts/{id}/views/{view}/run»;
 * контракт c643fd7b «События thought-type-view.*»).
 *
 *   GET    /api/v1/networks/{nid}/thought-types/{id}/views
 *   POST   /api/v1/networks/{nid}/thought-types/{id}/views
 *   GET    /api/v1/networks/{nid}/thought-types/{id}/views/{viewId}
 *   PATCH  /api/v1/networks/{nid}/thought-types/{id}/views/{viewId}
 *   DELETE /api/v1/networks/{nid}/thought-types/{id}/views/{viewId}
 *   POST   /api/v1/networks/{nid}/thoughts/{thoughtId}/views/{view}/run
 *
 * Стиль — Fastify + декораторы из shared, валидация тела — на доменном сервисе
 * (задачи 17eb741e и 20b2fca0). Слой читается/пишется через `openRouteNetworkDb`
 * — вся ветвимость уже учтена в `thought_type_views_v` и `materializeShadow`.
 *
 * События `thought-type-view.{created,updated,deleted,run}` публикуются
 * обёрткой записи домена `runWrite` (ADR 162d8e7a). Уважение слою
 * обеспечивает `layer-visibility.ts`: подписчик в основе не получает правок,
 * сделанных в слое версии, потому что
 * `thought-type-view.{created,updated,deleted}` привязаны к строке
 * `thought_type_views` (ветвимая таблица). Событие `run` — non-branchable,
 * доставляется всем подписчикам сети: оно описывает действие («отбор
 * исполнили»), а не правку строки.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type EffectiveThoughtTypeView,
  type StructureSort,
  type SortOrder,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  requestBody,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  parseBody,
  parseRest,
  RestIfMatch,
  RestViewCreateBody,
  RestViewRunBody,
  RestViewUpdateBody,
} from '../contracts.js';
import {
  createThoughtTypeView,
  deleteThoughtTypeView,
  getEffectiveViewsForThought,
  getThoughtTypeView,
  listThoughtTypeViewsByType,
  runViewForThought,
  updateThoughtTypeView,
} from '../domain/thought-type-views-service.js';
import { getThought } from '../domain/thought-service.js';

/** Route params для `:networkId` + `:id` (id типа мысли). */
interface TypeIdParams {
  networkId: string;
  id: string;
}

/** Route params для `:networkId` + `:id` + `:viewId`. */
interface ViewIdParams {
  networkId: string;
  id: string;
  viewId: string;
}

/** Route params для `:networkId` + `:thoughtId` + `:view`. */
interface RunViewParams {
  networkId: string;
  thoughtId: string;
  view: string;
}

/** Допустимые ключи тела `POST /thought-types/{id}/views`. */
function parseCreateBody(body: Record<string, unknown>, requestId: string): ThoughtTypeViewInput {
  const out = parseBody(RestViewCreateBody, body, requestId);
  return {
    name: out.name as string,
    description: (out.description ?? null) as string | null,
    definition: out.definition as string,
    ...(out.position !== undefined ? { position: out.position as number } : {}),
    ...(out.is_default !== undefined ? { is_default: out.is_default as boolean } : {}),
  } as unknown as ThoughtTypeViewInput;
}

function parseUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeViewUpdateInput {
  const out = parseBody(RestViewUpdateBody, body, requestId);
  const changes: ThoughtTypeViewUpdateInput = {};
  if (out.name !== undefined) changes.name = out.name as string;
  if (out.description !== undefined)
    changes.description = (out.description ?? null) as string | null;
  if (out.definition !== undefined) changes.definition = out.definition as string;
  if (out.position !== undefined) changes.position = out.position as number;
  if (out.is_default !== undefined) changes.is_default = out.is_default as boolean;
  return changes;
}

/**
 * Эффективный набор для типа мысли как «мысли» с `type_id`. Тип мысли — это
 * обычная мысль типа «определение типа», у неё может быть свой `type_id`
 * (потомок `определение типа`). На сервере нет операции «получить тип как
 * мысль», но нам хватает одного поля: `getEffectiveViewsForThought` принимает
 * узкое `ThoughtForEffectiveViews = { type_id: string | null }`.
 */
function effectiveViewsForType(
  ndb: import('../db/network-db.js').NetworkDb,
  thoughtTypeId: string,
): EffectiveThoughtTypeView[] {
  return getEffectiveViewsForThought(ndb, { type_id: thoughtTypeId });
}

/**
 * Найти отбор в эффективном наборе мысли по `name` (точное совпадение
 * регистронезависимо по `name_key`) или по `id`. Используется только
 * `run`-маршрутом; CRUD-маршруты адресуются по `:viewId` напрямую.
 */
function findViewInEffective(
  effective: EffectiveThoughtTypeView[],
  viewKey: string,
): EffectiveThoughtTypeView | null {
  const byId = effective.find((v) => v.id === viewKey);
  if (byId !== undefined) return byId;
  const wantedKey = viewKey.trim().toLowerCase();
  const byName = effective.find((v) => v.name_key === wantedKey);
  return byName ?? null;
}

/**
 * Фабрика плагина `/api/v1/networks*` маршрутов отборов типов мыслей.
 */
export function createThoughtTypeViewsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- GET /thought-types/{id}/views --------------------------------------

    app.get(
      '/networks/:networkId/thought-types/:id/views',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Контракт b90bb6e6: «GET отдаёт собственные отборы типа» —
        // только определения этого типа в текущем слое, без подъёма по
        // цепочке предков и без подтягивания базового слоя. Унаследованные
        // от предков показывает `meta.effective`, базовый слой в слое —
        // не виден до слияния (13-layers.md §3, §4.1).
        const views = listThoughtTypeViewsByType(ndb, id, { currentLayerOnly: true });
        // `?include_effective=true` отдаёт эффективный набор для типа (свой +
        // унаследованный от предков), см. контракт b90bb6e6 и требование
        // eaca1253. По умолчанию — `false`, чтобы не платить за обход цепочки
        // предков ради простого «свои отборы типа».
        const query = req.query as Record<string, unknown>;
        const includeEffectiveRaw = Array.isArray(query.include_effective)
          ? query.include_effective[0]
          : query.include_effective;
        const includeEffective = includeEffectiveRaw === 'true' || includeEffectiveRaw === true;
        const meta: Record<string, unknown> = {};
        if (includeEffective) {
          meta.effective = effectiveViewsForType(ndb, id);
        }
        sendList(reply, views, views.length, 0, views.length, meta);
      },
    );

    // --- POST /thought-types/{id}/views -------------------------------------

    app.post(
      '/networks/:networkId/thought-types/:id/views',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const input = parseCreateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const created = createThoughtTypeView(ndb, id, input, req.auth!.user.id, req.id);
          // Событие `created` отдаёт EffectiveThoughtTypeView — клиент не делает
          // лишний GET, чтобы узнать, свой отбор или унаследованный.
          const effective = effectiveViewsForType(ndb, id);
          const matched = effective.find((v) => v.id === created.id) ?? {
            ...created,
            defined_on: id,
            inherited: false,
          };
          return {
            result: created,
            events: [
              { type: 'thought-type-view.created', data: { thought_type_id: id, view: matched } },
            ],
          };
        });
        sendCreated(reply, view, {
          version: view.version,
          updated_at: view.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- GET /thought-types/{id}/views/{viewId} ----------------------------

    app.get(
      '/networks/:networkId/thought-types/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, viewId } = req.params as ViewIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = getThoughtTypeView(ndb, viewId);
        if (view === null) {
          throw new EtnError(
            'NOT_FOUND',
            `Отбор ${viewId} не найден.`,
            { entity: 'thought_type_view', id: viewId },
            req.id,
          );
        }
        sendSuccess(reply, view, {
          version: view.version,
          updated_at: view.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- PATCH /thought-types/{id}/views/{viewId} ---------------------------

    app.patch(
      '/networks/:networkId/thought-types/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const changes = parseUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateThoughtTypeView(
            ndb,
            viewId,
            changes,
            expectedVersion,
            req.auth!.user.id,
            req.id,
          );
          // Эффективный набор — после UPDATE, чтобы клиент видел новый `inherited`/
          // `defined_on` отбора (вдруг он переехал по `name_key` на одноимённый
          // отбор предка, или наоборот — был унаследованным, стал собственным).
          const effective = effectiveViewsForType(ndb, id);
          const matched = effective.find((v) => v.id === updated.id) ?? {
            ...updated,
            defined_on: id,
            inherited: false,
          };
          return {
            result: updated,
            events: [
              {
                type: 'thought-type-view.updated',
                data: {
                  thought_type_id: id,
                  view_id: viewId,
                  changes,
                  version: updated.version,
                  view: matched,
                },
              },
            ],
          };
        });
        sendSuccess(reply, view, {
          version: view.version,
          updated_at: view.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- DELETE /thought-types/{id}/views/{viewId} --------------------------

    app.delete(
      '/networks/:networkId/thought-types/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const before = getThoughtTypeView(ndb, viewId);
        if (before === null) {
          throw new EtnError(
            'NOT_FOUND',
            `Отбор ${viewId} не найден.`,
            { entity: 'thought_type_view', id: viewId },
            req.id,
          );
        }
        // Сравниваем версию здесь, а не в сервисе — `deleteThoughtTypeView`
        // оптимистическую блокировку не делает (только `update`/`create`),
        // см. thought-type-views-service.ts.
        if (expectedVersion !== undefined && before.version !== expectedVersion) {
          throw new EtnError(
            'VERSION_CONFLICT',
            'Версия отбора изменилась с момента чтения.',
            {
              entity: 'thought_type_view',
              id: viewId,
              expected: expectedVersion,
              current: before.version,
            },
            req.id,
          );
        }
        runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          deleteThoughtTypeView(ndb, viewId, req.id);
          return {
            result: undefined,
            events: [
              { type: 'thought-type-view.deleted', data: { thought_type_id: id, view_id: viewId } },
            ],
          };
        });
        reply.code(204).send();
      },
    );

    // --- POST /thoughts/{thoughtId}/views/{view}/run ------------------------

    app.post(
      '/networks/:networkId/thoughts/:thoughtId/views/:view/run',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, thoughtId, view } = req.params as RunViewParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);

        // 1. Мысль-контекст должна существовать и быть видимой в слое сессии.
        //    Без неё токены (`$thought.…`) не разрешатся; сервис всё равно
        //    бросит NOT_FOUND, но явная проверка здесь даёт более точный
        //    код 404 сразу, до резолвера.
        const thought = getThought(ndb, thoughtId);
        if (thought === null) {
          throw new EtnError(
            'NOT_FOUND',
            `Мысль ${thoughtId} не найдена.`,
            { entity: 'thought', id: thoughtId },
            req.id,
          );
        }

        // 2. Эффективный набор — относительно типа мысли (`thought.type_id`).
        //    Если у мысли тип снят — работают отборы корневого типа
        //    (требование 23e0f78e).
        const effective = getEffectiveViewsForThought(ndb, { type_id: thought.type_id });
        const matched = findViewInEffective(effective, view);
        if (matched === null) {
          throw new EtnError(
            'NOT_FOUND',
            `У мысли ${thoughtId} нет отбора «${view}».`,
            {
              entity: 'thought_type_view',
              thought_id: thoughtId,
              view,
            },
            req.id,
          );
        }

        // 3. Разобрать `sort`/`order`/`limit`/`offset` из тела —
        //    единым контрактом (веха 8).
        const runInput = parseRest(RestViewRunBody, req);
        const sort = runInput.sort as StructureSort | undefined;
        const order = runInput.order as SortOrder | undefined;
        const limit = runInput.limit as number | undefined;
        const offset = runInput.offset ?? 0;

        // 4. Сервис `runViewForThought` подставляет токены, исполняет запрос
        //    движком отбора мыслей и возвращает страницу. Сортировка и
        //    пагинация исполняются SQL-движком (`queryThoughts`) — ошибка
        //    4dd14aa3: прежде дефолт `alpha asc` зашивался в сервисе, а
        //    переопределение «исполнялось» JS-сортировкой страницы по полям,
        //    которых нет в ThoughtRef. Тело переопределяет значения,
        //    сохранённые в определении отбора (контракт 95273103).
        const result = runViewForThought(ndb, matched, thoughtId, req.auth!.user.id, req.id, {
          ...(sort !== undefined ? { sort } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });

        // 5. Если `unresolved` непустой — отдаём пустой результат с пояснением
        //    (требование b7fdab20). `sort`/`order`/`limit`/`offset` в этом
        //    случае игнорируются: фильтр в принципе не применился.
        if (result.unresolved.length > 0) {
          runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
            result: undefined,
            events: [
              {
                type: 'thought-type-view.run',
                data: {
                  thought_id: thoughtId,
                  view_id: matched.id,
                  view_name: matched.name,
                  result_count: 0,
                  unresolved: result.unresolved,
                },
              },
            ],
          }));
          reply.code(200).send({
            data: [],
            meta: {
              total: 0,
              limit: limit ?? result.items.length,
              offset,
              directions: {},
              view: { id: matched.id, name: matched.name, type_id: matched.defined_on },
              unresolved: result.unresolved,
            },
          });
          return;
        }

        // 6. Страница уже отсортирована и спагинирована SQL-движком;
        //    `meta.sort`/`meta.order` несут эффективные значения (тело или
        //    определение отбора) — ошибка 4dd14aa3.
        const total = result.total;
        runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: undefined,
          events: [
            {
              type: 'thought-type-view.run',
              data: {
                thought_id: thoughtId,
                view_id: matched.id,
                view_name: matched.name,
                result_count: total,
                unresolved: [],
              },
            },
          ],
        }));
        reply.code(200).send({
          data: result.items,
          meta: {
            total,
            limit: limit ?? result.items.length,
            offset,
            directions: result.directions,
            view: { id: matched.id, name: matched.name, type_id: matched.defined_on },
            sort: result.sort,
            order: result.order,
          },
        });
      },
    );
  };
}
