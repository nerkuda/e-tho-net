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
 *   POST   /api/v1/networks/{nid}/thoughts/{thoughtId}/views/run   (ad-hoc AST,
 *          задача 0e7e89f5 — паритет с MCP `etn.views.run { ast }`)
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
  type EffectiveThoughtView,
  type RunThoughtTypeViewMeta,
  type StructureSort,
  type SortOrder,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
  type TypeViewMoveToThoughtResult,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  requestBody,
  restTokenContext,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  parseBody,
  parseRest,
  RestIfMatch,
  RestViewCreateBody,
  RestViewMoveToThoughtBody,
  RestViewRunAstBody,
  RestViewRunBody,
  RestViewUpdateBody,
} from '../contracts.js';
import {
  createThoughtTypeView,
  deleteThoughtTypeView,
  executeViewDefinitionForThought,
  getEffectiveViewsForThought,
  getThoughtTypeView,
  listThoughtTypeViewsByType,
  runViewForThought,
  updateThoughtTypeView,
} from '../domain/thought-type-views-service.js';
import { getThought } from '../domain/thought-service.js';
import { toEffectiveCustomView } from '../domain/thought-custom-views-service.js';
import { moveThoughtTypeViewToThought } from '../domain/thought-view-transfer.js';
import { logFilterStats } from '../log/filter-stats.js';

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

/** Route params для `:networkId` + `:thoughtId` (ad-hoc `.../views/run`). */
interface ThoughtIdParams {
  networkId: string;
  thoughtId: string;
}

/** Допустимые ключи тела `POST /thought-types/{id}/views`. */
export function parseViewCreateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeViewInput {
  const out = parseBody(RestViewCreateBody, body, requestId);
  return {
    name: out.name as string,
    description: (out.description ?? null) as string | null,
    definition: out.definition as string,
    ...(out.position !== undefined ? { position: out.position as number } : {}),
    ...(out.is_default !== undefined ? { is_default: out.is_default as boolean } : {}),
  } as unknown as ThoughtTypeViewInput;
}

export function parseViewUpdateBody(
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
 * Отбор обязан принадлежать типу из пути (`:id`): чужой `:viewId` — 404, не
 * 403 (ошибка 1cd2b6db; образец — `requireOwnedView` внетиповых отборов).
 *
 * Для унаследованного отбора фактический владелец — `thought_type_id` строки
 * (он же `defined_on`); клиент передаёт в `:id` именно его, а не тип фокуса.
 * Поэтому сверка идёт с `:id`, а `details.defined_on` сообщает фактического
 * владельца при промахе.
 */
function requireOwnedView(
  ndb: import('../db/network-db.js').NetworkDb,
  thoughtTypeId: string,
  viewId: string,
  requestId: string,
): ThoughtTypeView {
  const view = getThoughtTypeView(ndb, viewId);
  if (view === null || view.thought_type_id !== thoughtTypeId) {
    throw new EtnError(
      'NOT_FOUND',
      `У типа мысли ${thoughtTypeId} нет отбора ${viewId}.`,
      {
        entity: 'thought_type_view',
        id: viewId,
        type_id: thoughtTypeId,
        defined_on: view?.thought_type_id ?? null,
      },
      requestId,
    );
  }
  return view;
}

/**
 * Найти отбор в эффективном наборе мысли по `name` (точное совпадение
 * регистронезависимо по `name_key`) или по `id`. Используется только
 * `run`-маршрутом; CRUD-маршруты адресуются по `:viewId` напрямую.
 */
function findViewInEffective(
  effective: EffectiveThoughtView[],
  viewKey: string,
): EffectiveThoughtView | null {
  const byId = effective.find((v) => v.id === viewKey);
  if (byId !== undefined) return byId;
  const wantedKey = viewKey.trim().toLowerCase();
  const byName = effective.find((v) => v.name_key === wantedKey);
  return byName ?? null;
}

/**
 * `meta.view` прогона: владелец отбора виден по `scope`/`defined_on`.
 * `type_id` заполняется ТОЛЬКО для типового отбора — у внетипового владелец
 * мысль, подменять её типом нельзя (операция 5e55b7bb).
 */
function runViewMeta(view: EffectiveThoughtView): RunThoughtTypeViewMeta['view'] {
  return {
    id: view.id,
    name: view.name,
    scope: view.scope,
    defined_on: view.defined_on,
    ...(view.scope === 'type' ? { type_id: view.defined_on } : {}),
  };
}

/**
 * Событие исполнения — по владельцу отбора (контракт 5d447380): типовой —
 * `thought-type-view.run`, внетиповой — `thought-custom-view.run`. Payload
 * одинаковый; клиент оба события игнорирует, MCP `etn.views.run` их не пишет.
 */
function runEventFor(
  view: EffectiveThoughtView,
  data: {
    thought_id: string;
    view_id: string;
    view_name: string;
    result_count: number;
    unresolved: Array<{ token: string; reason: string; message: string }>;
  },
): { type: 'thought-type-view.run' | 'thought-custom-view.run'; data: typeof data } {
  return view.scope === 'thought'
    ? { type: 'thought-custom-view.run', data }
    : { type: 'thought-type-view.run', data };
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
        const input = parseViewCreateBody(requestBody(req), req.id);
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
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Владелец сверяется с `:id` (ошибка 1cd2b6db): отбор чужого типа
        // не читается по прямому id.
        const view = requireOwnedView(ndb, id, viewId, req.id);
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
        const changes = parseViewUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Чужой `:viewId` — 404 до записи (ошибка 1cd2b6db).
        requireOwnedView(ndb, id, viewId, req.id);
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
          // Владелец для события и набора — фактический `thought_type_id`
          // строки, а не `:id` из пути (ошибка 1cd2b6db).
          const ownerTypeId = updated.thought_type_id;
          const effective = effectiveViewsForType(ndb, ownerTypeId);
          const matched = effective.find((v) => v.id === updated.id) ?? {
            ...updated,
            defined_on: ownerTypeId,
            inherited: false,
          };
          return {
            result: updated,
            events: [
              {
                type: 'thought-type-view.updated',
                data: {
                  thought_type_id: ownerTypeId,
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
        // Чужой `:viewId` — 404 (ошибка 1cd2b6db).
        const before = requireOwnedView(ndb, id, viewId, req.id);
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
              {
                type: 'thought-type-view.deleted',
                // Фактический владелец строки, не `:id` из пути (1cd2b6db).
                data: { thought_type_id: before.thought_type_id, view_id: viewId },
              },
            ],
          };
        });
        reply.code(204).send();
      },
    );

    // --- POST /thought-types/{id}/views/{viewId}/move-to-thought ------------
    //
    // Перенос владельца «тип → вне» (0.14.1, операция 85414fbd): отбор типа
    // становится внетиповым у указанной мысли и исчезает у всех прочих (для
    // унаследованного — у всех потомков предка-владельца). Одна транзакция:
    // upsert в `thought_custom_views` + надгробие/удаление источника. Ответ
    // 200 — внетиповая карточка (`scope:'thought'`, `defined_on`).
    //
    // `:id` для унаследованного отбора — `defined_on` (тип-владелец), не тип
    // фокуса; чужой `:viewId`/`:id` — 404 с `details.defined_on`.
    app.post(
      '/networks/:networkId/thought-types/:id/views/:viewId/move-to-thought',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const input = parseRest(RestViewMoveToThoughtBody, req);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const moved = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const result = moveThoughtTypeViewToThought(
            ndb,
            id,
            viewId,
            input.target_thought_id,
            req.id,
          );
          const card = toEffectiveCustomView(result.view);
          return {
            result: card,
            events: [
              {
                type: 'thought-type-view.deleted',
                data: {
                  // Фактический владелец строки (для унаследованного — тип, на
                  // котором отбор определён), не тип фокуса.
                  thought_type_id: result.source.thought_type_id,
                  view_id: viewId,
                  reason: 'moved',
                  moved_to: result.thought_id,
                },
              },
              {
                type: 'thought-custom-view.created',
                data: { thought_id: result.thought_id, view: card },
              },
            ],
          };
        });
        sendSuccess(reply, moved satisfies TypeViewMoveToThoughtResult, {
          version: moved.version,
          updated_at: moved.updated_at,
          request_id: req.id,
        });
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

        // 2. Смешанный эффективный набор — относительно мысли (id + type_id):
        //    именованный запуск разрешает и внетиповые отборы (0.14.1,
        //    операция 5e55b7bb). Если у мысли тип снят — работают отборы
        //    корневого типа (требование 23e0f78e).
        const effective = getEffectiveViewsForThought(ndb, {
          id: thought.id,
          type_id: thought.type_id,
        });
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
        const result = await runViewForThought(ndb, matched, thoughtId, req.auth!.user.id, req.id, {
          ...(sort !== undefined ? { sort } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          // Контекст разрешения токенов AST (обязательный пункт задачи c13762b1):
          // часы/пользователь/первый день недели сети/профиль времени.
          tokenContext: restTokenContext(app, req.auth!.user.id, networkId),
          // Статистика — только при включённом журналировании (0f34a5ff).
          collectStats: app.fileLog.enabled,
        });
        logFilterStats(app.fileLog, networkId, 'rest.view_run', result.stats);

        // 5. Если `unresolved` непустой — отдаём пустой результат с пояснением
        //    (требование b7fdab20). `sort`/`order`/`limit`/`offset` в этом
        //    случае игнорируются: фильтр в принципе не применился.
        if (result.unresolved.length > 0) {
          runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
            result: undefined,
            events: [
              runEventFor(matched, {
                thought_id: thoughtId,
                view_id: matched.id,
                view_name: matched.name,
                result_count: 0,
                unresolved: result.unresolved,
              }),
            ],
          }));
          reply.code(200).send({
            data: [],
            meta: {
              total: 0,
              limit: limit ?? result.items.length,
              offset,
              directions: {},
              view: runViewMeta(matched),
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
            runEventFor(matched, {
              thought_id: thoughtId,
              view_id: matched.id,
              view_name: matched.name,
              result_count: total,
              unresolved: [],
            }),
          ],
        }));
        reply.code(200).send({
          data: result.items,
          meta: {
            total,
            limit: limit ?? result.items.length,
            offset,
            directions: result.directions,
            view: runViewMeta(matched),
            sort: result.sort,
            order: result.order,
            // Жёлтая диагностика (требование 325efc13): свойство отвязано от
            // типа — отбор исполнен, предупреждение видно пользователю/агенту.
            ...(result.warnings !== undefined && result.warnings.length > 0
              ? { warnings: result.warnings }
              : {}),
          },
        });
      },
    );

    // --- POST /thoughts/{thoughtId}/views/run (ad-hoc AST) -------------------
    //
    // Паритет с MCP `etn.views.run { ast }` (задача 0e7e89f5): исполняет
    // произвольное AST-тело ОТНОСИТЕЛЬНО контекстной мысли через единую
    // доменную точку. Маршрут регистрируется отдельно от `:view/run`
    // (разное число сегментов) — старый контракт не меняется по форме.
    // Событие `thought-type-view.run` НЕ эмитится: сохранённого отбора
    // (view_id/view_name) у ad-hoc прогона нет, это операция чтения.
    app.post(
      '/networks/:networkId/thoughts/:thoughtId/views/run',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, thoughtId } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);

        // Мысль-контекст обязательна: без неё токены `$thought*` не разрешатся,
        // а `thought.type_id` — якорь жёлтой диагностики.
        const thought = getThought(ndb, thoughtId);
        if (thought === null) {
          throw new EtnError(
            'NOT_FOUND',
            `Мысль ${thoughtId} не найдена.`,
            { entity: 'thought', id: thoughtId },
            req.id,
          );
        }

        // Разбор тела единым контрактом (строгая схема): `ast` + корпусные
        // `sort`/`order`/`limit`/`offset`. Конфликт `ast.sort` ↔ `sort`/`order`
        // проверяет домен (`exclusiveSort`).
        const runInput = parseRest(RestViewRunAstBody, req);
        const bodySort = runInput.sort as StructureSort | undefined;
        const bodyOrder = runInput.order as SortOrder | undefined;
        const limit = runInput.limit as number | undefined;
        const offset = runInput.offset ?? 0;

        const result = await executeViewDefinitionForThought(ndb, {
          definition: runInput.ast as Record<string, unknown>,
          thoughtTypeId: thought.type_id,
          thoughtId,
          userId: req.auth!.user.id,
          ...(req.id !== undefined ? { requestId: req.id } : {}),
          options: {
            ...(bodySort !== undefined ? { sort: bodySort } : {}),
            ...(bodyOrder !== undefined ? { order: bodyOrder } : {}),
            ...(limit !== undefined ? { limit } : {}),
            offset,
            // Контекст разрешения токенов AST (как у `:view/run`).
            tokenContext: restTokenContext(app, req.auth!.user.id, networkId),
            // Статистика — только при включённом журналировании (0f34a5ff);
            // строка источника — своя (`rest.view_run_ast`).
            collectStats: app.fileLog.enabled,
            // Потолок страницы — общий с MCP-ветками `etn.views.run` (200).
            maxLimit: 200,
            // Ad-hoc: `ast.sort` XOR `sort`/`order` (конвенция cb78315b).
            exclusiveSort: true,
          },
        });
        logFilterStats(app.fileLog, networkId, 'rest.view_run_ast', result.stats);

        // Неразрешимые токены (требование b7fdab20) — пустая страница с
        // пояснением. Конверт несёт те же поля страницы, что и успешный ответ
        // (спека c989a4e2 перечисляет их безусловно; паритет с MCP-веткой
        // `etn.views.run`, которая отдаёт их и при `unresolved`).
        if (result.unresolved.length > 0) {
          reply.code(200).send({
            data: [],
            meta: {
              total: 0,
              limit: limit ?? 0,
              offset,
              directions: {},
              sort: result.sort,
              order: result.order,
              ast: true,
              has_more: result.has_more,
              next_cursor: result.next_cursor,
              unresolved: result.unresolved,
            },
          });
          return;
        }

        reply.code(200).send({
          data: result.items,
          meta: {
            total: result.total,
            limit: limit ?? result.items.length,
            offset,
            directions: result.directions,
            sort: result.sort,
            order: result.order,
            // Клиенту видно, что исполнен ad-hoc отбор, а не сохранённый.
            ast: true,
            has_more: result.has_more,
            next_cursor: result.next_cursor,
            ...(result.warnings !== undefined && result.warnings.length > 0
              ? { warnings: result.warnings }
              : {}),
          },
        });
      },
    );
  };
}
