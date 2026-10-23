/**
 * REST-маршруты внетиповых отборов мысли (0.14.1, задача a28d444b; операция
 * 5e55b7bb «CRUD /thoughts/{id}/views», контракт событий 5d447380).
 *
 *   GET    /api/v1/networks/{nid}/thoughts/{id}/views
 *   POST   /api/v1/networks/{nid}/thoughts/{id}/views
 *   GET    /api/v1/networks/{nid}/thoughts/{id}/views/{viewId}
 *   PATCH  /api/v1/networks/{nid}/thoughts/{id}/views/{viewId}
 *   DELETE /api/v1/networks/{nid}/thoughts/{id}/views/{viewId}
 *
 * GET без параметров отдаёт СОБСТВЕННЫЕ внетиповые отборы мысли в текущем
 * слое (контракт зеркален `GET /thought-types/{id}/views`). `?include_effective=true`
 * добавляет в `meta.effective` полный эффективный набор (типовые по цепочке +
 * внетиповые, со `scope`/`defined_on` и перекрытием) — единая точка полосы
 * отборов (требование 045f539a).
 *
 * Вложенные GET/PATCH/DELETE проверяют владельца: чужой `:viewId` (отбор другой
 * мысли) даёт 404. Права — `requireNetworkMember()`, как на правку мысли;
 * захват объекта (`edit.acquired`) правку отборов не блокирует (операция
 * 5e55b7bb).
 *
 * События `thought-custom-view.*` публикует обёртка записи `runWrite` (ADR
 * 162d8e7a); слой-видимость обеспечивает `layer-visibility.ts` по строке
 * `thought_custom_views` (ветвимая таблица). Payload — полная карточка отбора,
 * включая `definition` (контракт 5d447380).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type EffectiveThoughtCustomView,
  type ThoughtCustomView,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  requestBody,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  parseRest,
  RestIfMatch,
} from '../contracts.js';
import { getThought } from '../domain/thought-service.js';
import {
  createThoughtCustomView,
  deleteThoughtCustomView,
  getThoughtCustomView,
  listThoughtCustomViews,
  updateThoughtCustomView,
} from '../domain/thought-custom-views-service.js';
import { getEffectiveViewsForThought } from '../domain/thought-type-views-service.js';
import { parseViewCreateBody, parseViewUpdateBody } from './thought-type-views.js';

/** Route params для `:networkId` + `:id` (id мысли-владельца). */
interface ThoughtIdParams {
  networkId: string;
  id: string;
}

/** Route params для `:networkId` + `:id` + `:viewId`. */
interface ViewIdParams {
  networkId: string;
  id: string;
  viewId: string;
}

/**
 * Карточка внетипового отбора в форме события/эффективного набора: владелец —
 * мысль, `scope: 'thought'`, `defined_on` = id мысли, `inherited: false`,
 * `thought_type_id` отсутствует (не подменять владельца).
 */
function customViewCard(view: ThoughtCustomView): EffectiveThoughtCustomView {
  return {
    id: view.id,
    name: view.name,
    name_key: view.name_key,
    description: view.description,
    definition: view.definition,
    position: view.position,
    is_default: view.is_default,
    version: view.version,
    created_at: view.created_at,
    updated_at: view.updated_at,
    created_by: view.created_by,
    scope: 'thought',
    defined_on: view.thought_id,
    inherited: false,
  };
}

/** Мысль-владелец должна существовать и быть видимой в слое сессии (404). */
function requireThought(
  ndb: NetworkDb,
  thoughtId: string,
  requestId: string,
): { id: string; type_id: string | null } {
  const thought = getThought(ndb, thoughtId);
  if (thought === null) {
    throw new EtnError(
      'NOT_FOUND',
      `Мысль ${thoughtId} не найдена.`,
      { entity: 'thought', id: thoughtId },
      requestId,
    );
  }
  return { id: thought.id, type_id: thought.type_id };
}

/**
 * Отбор обязан принадлежать этой мысли: чужой `:viewId` — 404, не 403
 * (операция 5e55b7bb).
 */
function requireOwnedView(
  ndb: NetworkDb,
  thoughtId: string,
  viewId: string,
  requestId: string,
): ThoughtCustomView {
  const view = getThoughtCustomView(ndb, viewId);
  if (view === null || view.thought_id !== thoughtId) {
    throw new EtnError(
      'NOT_FOUND',
      `У мысли ${thoughtId} нет отбора ${viewId}.`,
      { entity: 'thought_custom_view', id: viewId, thought_id: thoughtId },
      requestId,
    );
  }
  return view;
}

/** `?include_effective=true` — как у отборов типа (b90bb6e6). */
function wantsEffective(query: Record<string, unknown>): boolean {
  const raw = Array.isArray(query.include_effective)
    ? query.include_effective[0]
    : query.include_effective;
  return raw === 'true' || raw === true;
}

/**
 * Фабрика плагина маршрутов внетиповых отборов мысли.
 */
export function createThoughtCustomViewsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- GET /thoughts/{id}/views ------------------------------------------

    app.get(
      '/networks/:networkId/thoughts/:id/views',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const thought = requireThought(ndb, id, req.id);
        // Собственные определения в текущем слое — без подтягивания базового
        // слоя до слияния (как `GET /thought-types/{id}/views`). Эффективный
        // набор (`meta.effective`) показывает и унаследованное, и базовое.
        const views = listThoughtCustomViews(ndb, thought.id, { currentLayerOnly: true });
        const meta: Record<string, unknown> = {};
        if (wantsEffective(req.query as Record<string, unknown>)) {
          meta.effective = getEffectiveViewsForThought(ndb, {
            id: thought.id,
            type_id: thought.type_id,
          });
        }
        sendList(reply, views, views.length, 0, views.length, meta);
      },
    );

    // --- POST /thoughts/{id}/views -----------------------------------------

    app.post(
      '/networks/:networkId/thoughts/:id/views',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const input = parseViewCreateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const created = createThoughtCustomView(ndb, id, input, req.auth!.user.id, req.id);
          return {
            result: created,
            events: [
              {
                type: 'thought-custom-view.created',
                data: { thought_id: created.thought_id, view: customViewCard(created) },
              },
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

    // --- GET /thoughts/{id}/views/{viewId} ---------------------------------

    app.get(
      '/networks/:networkId/thoughts/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const view = requireOwnedView(ndb, id, viewId, req.id);
        sendSuccess(reply, view, {
          version: view.version,
          updated_at: view.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- PATCH /thoughts/{id}/views/{viewId} -------------------------------

    app.patch(
      '/networks/:networkId/thoughts/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const changes = parseViewUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        requireOwnedView(ndb, id, viewId, req.id);
        const view = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateThoughtCustomView(
            ndb,
            viewId,
            changes,
            expectedVersion,
            req.id,
          );
          return {
            result: updated,
            events: [
              {
                type: 'thought-custom-view.updated',
                data: {
                  thought_id: updated.thought_id,
                  view_id: viewId,
                  changes,
                  version: updated.version,
                  view: customViewCard(updated),
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

    // --- DELETE /thoughts/{id}/views/{viewId} ------------------------------

    app.delete(
      '/networks/:networkId/thoughts/:id/views/:viewId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, viewId } = req.params as ViewIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const before = requireOwnedView(ndb, id, viewId, req.id);
        // Оптимистическая блокировка — на маршруте (сервис удаления её не
        // делает; паритет с отборами типа).
        if (expectedVersion !== undefined && before.version !== expectedVersion) {
          throw new EtnError(
            'VERSION_CONFLICT',
            'Версия отбора изменилась с момента чтения.',
            {
              entity: 'thought_custom_view',
              id: viewId,
              expected: expectedVersion,
              current: before.version,
            },
            req.id,
          );
        }
        runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          deleteThoughtCustomView(ndb, viewId, req.id);
          return {
            result: undefined,
            events: [
              {
                type: 'thought-custom-view.deleted',
                // Полная карточка — как у created/updated (контракт 5d447380):
                // карточка уже прочитана в `before`, лишнего GET не нужно.
                data: {
                  thought_id: before.thought_id,
                  view_id: viewId,
                  view: customViewCard(before),
                },
              },
            ],
          };
        });
        reply.code(204).send();
      },
    );
  };
}
