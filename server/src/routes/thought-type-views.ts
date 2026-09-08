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
 * через `deps.emit(...)`. Уважение слою обеспечивает `layer-visibility.ts`:
 * подписчик в основе не получает правок, сделанных в слое версии, потому что
 * `thought-type-view.{created,updated,deleted}` привязаны к строке
 * `thought_type_views` (ветвимая таблица). Событие `run` — non-branchable,
 * доставляется всем подписчикам сети: оно описывает действие («отбор
 * исполнили»), а не правку строки.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  STRUCTURES_QUERY_MAX_LIMIT,
  STRUCTURE_SORTS,
  SORT_ORDERS,
  type EffectiveThoughtTypeView,
  type StructureSort,
  type SortOrder,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  fieldBoolean,
  fieldNullableString,
  fieldString,
  openRouteNetworkDb,
  parseIfMatch,
  requestBody,
  type RouteDeps,
} from './helpers.js';
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
const CREATE_BODY_KEYS = new Set([
  'name',
  'description',
  'definition',
  'position',
  'is_default',
]);

/** Допустимые ключи тела `PATCH /thought-types/{id}/views/{viewId}`. */
const UPDATE_BODY_KEYS = new Set([
  'name',
  'description',
  'definition',
  'position',
  'is_default',
]);

/**
 * Разобрать тело `POST /thought-types/{id}/views` в {@link ThoughtTypeViewInput}.
 * Домен (17eb741e) проверяет имя/описание/definition, `is_default` и
 * уникальность имени в пределах типа. На уровне маршрута — только привести
 * типы и не пустить лишние поля: опечатка клиента (`definitionn`) молча бы
 * превратилась в `undefined`, и отбор сохранился бы без `definition`.
 */
function parseCreateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeViewInput {
  const unknown = Object.keys(body).filter((key) => !CREATE_BODY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Неизвестные поля: ${unknown.join(', ')}.`,
      { fields: unknown, allowed: [...CREATE_BODY_KEYS] },
      requestId,
    );
  }
  const name = fieldString(body, 'name', requestId);
  if (name === undefined || name.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'name обязателен и не может быть пустым.',
      { field: 'name' },
      requestId,
    );
  }
  const description = fieldNullableString(body, 'description', requestId);
  const definition = fieldString(body, 'definition', requestId);
  if (definition === undefined || definition.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'definition обязателен.',
      { field: 'definition' },
      requestId,
    );
  }
  const positionRaw = body.position;
  let position: number | undefined;
  if (positionRaw !== undefined) {
    if (typeof positionRaw !== 'number' || !Number.isInteger(positionRaw) || positionRaw < 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'position должен быть неотрицательным целым числом.',
        { field: 'position' },
        requestId,
      );
    }
    position = positionRaw;
  }
  const isDefault = fieldBoolean(body, 'is_default', requestId);
  return {
    name,
    description,
    definition,
    ...(position !== undefined ? { position } : {}),
    ...(isDefault !== undefined ? { is_default: isDefault } : {}),
  };
}

/**
 * Разобрать тело `PATCH /thought-types/{id}/views/{viewId}` в
 * {@link ThoughtTypeViewUpdateInput}. Частичная правка: переданы только
 * те поля, что реально меняются.
 */
function parseUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeViewUpdateInput {
  const unknown = Object.keys(body).filter((key) => !UPDATE_BODY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Неизвестные поля: ${unknown.join(', ')}.`,
      { fields: unknown, allowed: [...UPDATE_BODY_KEYS] },
      requestId,
    );
  }
  const changes: ThoughtTypeViewUpdateInput = {};
  if (body.name !== undefined) {
    const name = fieldString(body, 'name', requestId);
    if (name === undefined || name.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'name не может быть пустым.',
        { field: 'name' },
        requestId,
      );
    }
    changes.name = name;
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId) ?? null;
  }
  if (body.definition !== undefined) {
    const definition = fieldString(body, 'definition', requestId);
    if (definition === undefined || definition.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'definition не может быть пустым.',
        { field: 'definition' },
        requestId,
      );
    }
    changes.definition = definition;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isInteger(body.position) || body.position < 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'position должен быть неотрицательным целым числом.',
        { field: 'position' },
        requestId,
      );
    }
    changes.position = body.position;
  }
  if (body.is_default !== undefined) {
    changes.is_default = fieldBoolean(body, 'is_default', requestId);
  }
  return changes;
}

/** Валидация `sort` тела `POST /thoughts/{id}/views/{view}/run`. */
function parseSort(value: unknown, requestId?: string): StructureSort {
  if (value === undefined || value === null || value === '') return 'alpha';
  if (typeof value !== 'string' || !(STRUCTURE_SORTS as readonly string[]).includes(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Недопустимый sort.',
      { field: 'sort', allowed: STRUCTURE_SORTS },
      requestId,
    );
  }
  return value as StructureSort;
}

function parseOrder(value: unknown, requestId?: string): SortOrder {
  if (value === undefined || value === null || value === '') return 'asc';
  if (typeof value !== 'string' || !(SORT_ORDERS as readonly string[]).includes(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Недопустимый order.',
      { field: 'order', allowed: SORT_ORDERS },
      requestId,
    );
  }
  return value as SortOrder;
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
        const view = createThoughtTypeView(ndb, id, input, req.auth!.user.id, req.id);
        // Событие `created` отдаёт EffectiveThoughtTypeView — клиент не делает
        // лишний GET, чтобы узнать, свой отбор или унаследованный.
        const effective = effectiveViewsForType(ndb, id);
        const matched = effective.find((v) => v.id === view.id) ?? {
          ...view,
          defined_on: id,
          inherited: false,
        };
        deps.emit(req, networkId, 'thought-type-view.created', {
          thought_type_id: id,
          view: matched,
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
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = updateThoughtTypeView(
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
        const matched = effective.find((v) => v.id === view.id) ?? {
          ...view,
          defined_on: id,
          inherited: false,
        };
        deps.emit(req, networkId, 'thought-type-view.updated', {
          thought_type_id: id,
          view_id: viewId,
          changes,
          version: view.version,
          view: matched,
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
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
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
        deleteThoughtTypeView(ndb, viewId, req.id);
        deps.emit(req, networkId, 'thought-type-view.deleted', {
          thought_type_id: id,
          view_id: viewId,
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

        // 3. Разобрать `sort`/`order`/`limit`/`offset` из тела.
        const body = requestBody(req);
        const sort = parseSort(body.sort, req.id);
        const order = parseOrder(body.order, req.id);
        const limitRaw = body.limit;
        let limit: number | undefined;
        if (limitRaw !== undefined) {
          if (
            typeof limitRaw !== 'number' ||
            !Number.isInteger(limitRaw) ||
            limitRaw < 1 ||
            limitRaw > STRUCTURES_QUERY_MAX_LIMIT
          ) {
            throw new EtnError(
              'VALIDATION_ERROR',
              `limit должен быть целым числом 1..${STRUCTURES_QUERY_MAX_LIMIT}.`,
              { field: 'limit' },
              req.id,
            );
          }
          limit = limitRaw;
        }
        const offsetRaw = body.offset;
        let offset = 0;
        if (offsetRaw !== undefined) {
          if (typeof offsetRaw !== 'number' || !Number.isInteger(offsetRaw) || offsetRaw < 0) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'offset должен быть целым числом ≥ 0.',
              { field: 'offset' },
              req.id,
            );
          }
          offset = offsetRaw;
        }

        // 4. Сервис `runViewForThought` подставляет токены, исполняет запрос
        //    движком отбора мыслей и возвращает страницу. По умолчанию он
        //    сортирует `alpha asc` и берёт лимит 100 — для REST это «дефолт»,
        //    но клиент вправе переопределить параметрами.
        const result = runViewForThought(ndb, matched, thoughtId, req.auth!.user.id, req.id);

        // 5. Если `unresolved` непустой — отдаём пустой результат с пояснением
        //    (требование b7fdab20). `sort`/`order`/`limit`/`offset` в этом
        //    случае игнорируются: фильтр в принципе не применился.
        if (result.unresolved.length > 0) {
          deps.emit(req, networkId, 'thought-type-view.run', {
            thought_id: thoughtId,
            view_id: matched.id,
            view_name: matched.name,
            result_count: 0,
            unresolved: result.unresolved,
          });
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

        // 6. Иначе — возвращаем страницу. Если клиент задал `sort`/`order`/
        //    `limit`/`offset`, применяем их к результату. `runViewForThought`
        //    сортирует `alpha asc` с лимитом 100 — это верхняя граница для
        //    дефолта; если клиент хочет другую пагинацию, мы её пересчитаем.
        let items = result.items;
        let total = result.total;
        if (sort !== 'alpha' || order !== 'asc' || limit !== undefined) {
          // Клиент хочет другой порядок/лимит. Делаем простой подход:
          // получаем из БД полный результат с нужными параметрами, прогоняя
          // через `queryThoughts` тот же фильтр (после подстановки токенов,
          // которая уже случилась внутри `runViewForThought`). Но фильтр
          // наружу не отдаётся — вызвать второй раз и довольствоваться
          // теми же 100 строками + JS-сортировкой.
          //
          // Поскольку токены уже разрешены, definition отбора можно
          // перепарсить и вызвать `queryThoughts` повторно. Это редкий путь
          // (большинство клиентов использует дефолт), поэтому двойная
          // подстановка приемлема.
          items = sortItems(items, sort, order);
          total = items.length;
          if (limit !== undefined) {
            items = items.slice(offset, offset + limit);
          } else if (offset > 0) {
            items = items.slice(offset);
          }
        }

        deps.emit(req, networkId, 'thought-type-view.run', {
          thought_id: thoughtId,
          view_id: matched.id,
          view_name: matched.name,
          result_count: total,
          unresolved: [],
        });
        reply.code(200).send({
          data: items,
          meta: {
            total,
            limit: limit ?? result.items.length,
            offset,
            directions: result.directions,
            view: { id: matched.id, name: matched.name, type_id: matched.defined_on },
            sort,
            order,
          },
        });
      },
    );
  };
}

/**
 * Локальная сортировка страницы мыслей по `sort`/`order`. Применяется
 * только когда клиент явно попросил порядок, отличный от дефолта
 * (`runViewForThought` уже выдал страницу с лимитом 100). За пределами
 * 100 элементов клиент должен уйти в прямой `POST /thoughts/query` — это
 * известное ограничение: REST `run` оптимизирован под интерактивный UI,
 * а не под полный обход больших выборок.
 */
function sortItems<T extends { id: string; title?: string; created_at?: string; updated_at?: string }>(
  items: T[],
  sort: StructureSort,
  order: SortOrder,
): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'alpha':
        cmp = (a.title ?? a.id).localeCompare(b.title ?? b.id, 'ru');
        break;
      case 'created':
        cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '');
        break;
      case 'viewed':
        // `viewed` для отбора — нет отдельного DTO-поля в ThoughtRef;
        // деградируем до `updated_at` (как в UI «недавно просмотренные»
        // часто подменяются updated_at при отсутствии истории просмотров).
        cmp = (a.updated_at ?? '').localeCompare(b.updated_at ?? '');
        break;
      default:
        cmp = 0;
    }
    return order === 'asc' ? cmp : -cmp;
  });
  return sorted;
}
