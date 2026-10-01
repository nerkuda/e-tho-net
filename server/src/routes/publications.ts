/**
 * Publication & shelf routes (0.11.1, задача c59ce742; тех.проект c5261d02,
 * каталог «Публикации»).
 *
 *   POST   /networks/:networkId/publications                     — создание
 *   GET    /networks/:networkId/publications                     — список
 *   GET    /networks/:networkId/publications/:id                 — карточка
 *   PATCH  /networks/:networkId/publications/:id                 — правка настроек
 *   POST   /networks/:networkId/publications/:id/trash           — в корзину
 *   POST   /networks/:networkId/publications/:id/restore         — из корзины
 *   DELETE /networks/:networkId/publications/:id                 — purge (только основа)
 *   PUT    /networks/:networkId/publications/:id/order           — порядок узлов
 *   POST   /networks/:networkId/publications/:id/exclusions      — исключить мысль
 *   DELETE /networks/:networkId/publications/:id/exclusions      — вернуть мысль
 *   POST   /networks/:networkId/publications/:id/rebuild         — пересборка
 *   GET    /networks/:networkId/publications/:id/assembly        — сборка документа
 *   GET    /networks/:networkId/publications/:id/candidates      — новые кандидаты
 *   GET    /networks/:networkId/thoughts/:id/publications        — использование мысли
 *   POST   /networks/:networkId/shelves                          — создать полку
 *   GET    /networks/:networkId/shelves                          — список полок
 *   PATCH  /networks/:networkId/shelves/:id                      — переименовать/порядок
 *   DELETE /networks/:networkId/shelves/:id                      — удалить полку
 *   POST   /networks/:networkId/shelves/:id/items                — положить публикацию
 *   DELETE /networks/:networkId/shelves/:id/items                — убрать публикацию
 *
 * Карточки операций: CRUD 5af247e4, жизненный цикл 200b87be, сборка 19d80dd2,
 * порядок f6b242fe, исключения 109061e0, пересборка/кандидаты f9a20c3f,
 * использование f49c6420, полки c80951ea; события 67b8748e, журнал d4452908.
 *
 * Все мутации идут через `runWrite` (ADR 162d8e7a): после коммита обёртка
 * публикует события, пишет журнал и аудит. SQL в фасаде запрещён
 * (сторож guard-server-layers) — вся работа с БД в домене.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type Publication,
  type PublicationActiveFilter,
  type PublicationCreateInput,
  type PublicationOrderItem,
  type PublicationSort,
  type PublicationUpdateInput,
  type SavedFilterDefinition,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
import {
  addPublicationExclusion,
  addShelfItem,
  createPublication,
  createShelf,
  deleteShelf,
  getPublication,
  listPublications,
  listShelves,
  purgePublication,
  rebuildPublication,
  removePublicationExclusion,
  removeShelfItem,
  restorePublication,
  setPublicationOrder,
  trashPublication,
  updatePublication,
  updateShelf,
} from '../domain/publication-service.js';
import {
  assemblePublication,
  listPublicationCandidates,
  listPublicationUsage,
} from '../domain/publication-assembly-service.js';
import {
  parseRest,
  RestPublicationAssembly,
  RestPublicationById,
  RestPublicationCandidates,
  RestPublicationCreate,
  RestPublicationExclusionAdd,
  RestPublicationExclusionRemove,
  RestPublicationList,
  RestPublicationOrder,
  RestPublicationRebuild,
  RestPublicationUpdate,
  RestPublicationUsage,
  RestShelfCreate,
  RestShelfDelete,
  RestShelfItemAdd,
  RestShelfItemRemove,
  RestShelfList,
  RestShelfUpdate,
} from '../contracts.js';

/**
 * Снимок публикации для журнала ({ id, title }) с `NOT_FOUND`, если строки
 * уже нет. Читается доменным `getPublication` (SQL — только в домене).
 */
function publicationRef(ndb: ReturnType<typeof openRouteNetworkDb>, id: string): Pick<
  Publication,
  'id' | 'title'
> {
  const pub = getPublication(ndb, id);
  if (pub === null) {
    throw new EtnError('NOT_FOUND', `publication ${id} not found`, {
      entity: 'publication',
      id,
    });
  }
  return pub;
}

/** `/api/v1/networks*` publication & shelf routes plugin factory. */
export function createPublicationsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // -------------------------------------------------------------------------
    // Публикации: CRUD (карточка 5af247e4)
    // -------------------------------------------------------------------------
    app.get(
      '/networks/:networkId/publications',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = listPublications(ndb, {
          ...(input.q !== undefined ? { q: input.q } : {}),
          ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
          ...(input.active !== undefined
            ? { active: input.active as PublicationActiveFilter }
            : {}),
          ...(input.sort !== undefined ? { sort: input.sort as PublicationSort } : {}),
          ...(input.include_trashed !== undefined
            ? { include_trashed: input.include_trashed }
            : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
        });
        sendList(reply, result.items, result.total, input.offset ?? 0, input.limit ?? 50);
      },
    );

    app.post(
      '/networks/:networkId/publications',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationCreate, req);
        const create: PublicationCreateInput = {
          title: input.title,
          subtitle: input.subtitle ?? null,
          summary_md: input.summary_md ?? null,
          authorship: input.authorship ?? null,
          cover_attachment_id: input.cover_attachment_id ?? null,
          cover_url: input.cover_url ?? null,
          title_recipe: (input.title_recipe ?? null) as SavedFilterDefinition | null,
          ...(input.text_sources !== undefined ? { text_sources: input.text_sources } : {}),
          ...(input.extra_properties !== undefined
            ? { extra_properties: input.extra_properties }
            : {}),
          numbering_from: input.numbering_from ?? null,
          numbering_to: input.numbering_to ?? null,
        };
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const created = createPublication(ndb, create, req.auth!.user.id);
          return {
            result: created,
            // Отдельного `publication.created` каталог 67b8748e не объявляет:
            // создание узнаётся тем же `publication.updated`.
            events: [
              {
                type: 'publication.updated' as const,
                data: { id: created.id, changes: create, version: created.version },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'created' as const, publication: created },
            ],
          };
        });
        sendCreated(reply, publication, {
          version: publication.version,
          updated_at: publication.updated_at,
          request_id: req.id,
        });
      },
    );

    app.get(
      '/networks/:networkId/publications/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = getPublication(ndb, input.publication_id);
        if (publication === null) {
          throw new EtnError(
            'NOT_FOUND',
            `publication ${input.publication_id} not found`,
            { entity: 'publication', id: input.publication_id },
            req.id,
          );
        }
        sendSuccess(reply, publication);
      },
    );

    app.patch(
      '/networks/:networkId/publications/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationUpdate, req);
        const changes: PublicationUpdateInput = {};
        if (input.title !== undefined) changes.title = input.title;
        if (input.subtitle !== undefined) changes.subtitle = input.subtitle;
        if (input.summary_md !== undefined) changes.summary_md = input.summary_md;
        if (input.authorship !== undefined) changes.authorship = input.authorship;
        if (input.cover_attachment_id !== undefined)
          changes.cover_attachment_id = input.cover_attachment_id;
        if (input.cover_url !== undefined) changes.cover_url = input.cover_url;
        if (input.title_recipe !== undefined)
          changes.title_recipe = input.title_recipe as SavedFilterDefinition | null;
        if (input.text_sources !== undefined) changes.text_sources = input.text_sources;
        if (input.extra_properties !== undefined)
          changes.extra_properties = input.extra_properties;
        if (input.numbering_from !== undefined) changes.numbering_from = input.numbering_from;
        if (input.numbering_to !== undefined) changes.numbering_to = input.numbering_to;
        if (input.active !== undefined) changes.active = input.active;

        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = updatePublication(ndb, input.publication_id, changes, req.auth!.user.id);
          return {
            result: updated,
            events: [
              {
                type: 'publication.updated' as const,
                data: { id: updated.id, changes, version: updated.version },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: updated },
            ],
          };
        });
        sendSuccess(reply, publication, {
          version: publication.version,
          updated_at: publication.updated_at,
          request_id: req.id,
        });
      },
    );

    // -------------------------------------------------------------------------
    // Жизненный цикл (карточка 200b87be)
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/publications/:id/trash',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const trashed = trashPublication(ndb, input.publication_id, req.auth!.user.id);
          return {
            result: trashed,
            events: [
              { type: 'publication.trashed' as const, data: { id: trashed.id } },
            ],
            activity: [
              { kind: 'publication' as const, action: 'trashed' as const, publication: trashed },
            ],
          };
        });
        sendSuccess(reply, publication, {
          version: publication.version,
          updated_at: publication.updated_at,
          request_id: req.id,
        });
      },
    );

    app.post(
      '/networks/:networkId/publications/:id/restore',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const restored = restorePublication(ndb, input.publication_id, req.auth!.user.id);
          return {
            result: restored,
            events: [
              { type: 'publication.restored' as const, data: { id: restored.id } },
            ],
            activity: [
              { kind: 'publication' as const, action: 'restored' as const, publication: restored },
            ],
          };
        });
        sendSuccess(reply, publication, {
          version: publication.version,
          updated_at: publication.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/publications/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          // Снимок для журнала берём до физического удаления строки.
          const snapshot = publicationRef(ndb, input.publication_id);
          purgePublication(ndb, input.publication_id);
          return {
            result: undefined,
            events: [
              { type: 'publication.purged' as const, data: { id: input.publication_id } },
            ],
            activity: [
              { kind: 'publication' as const, action: 'deleted' as const, publication: snapshot },
            ],
          };
        });
        reply.code(204).send();
      },
    );

    // -------------------------------------------------------------------------
    // Локальный порядок и исключения (карточки f6b242fe, 109061e0)
    // -------------------------------------------------------------------------
    app.put(
      '/networks/:networkId/publications/:id/order',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationOrder, req);
        const items: PublicationOrderItem[] = input.items.map((item) => ({
          node_key: item.node_key,
          position: item.position,
        }));
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const ordered = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const order = setPublicationOrder(ndb, input.publication_id, items, req.auth!.user.id);
          const snapshot = publicationRef(ndb, input.publication_id);
          return {
            result: order,
            // Батч перестановок — ОДНО событие (каталог 67b8748e).
            events: [
              {
                type: 'publication.order.reordered' as const,
                data: { publication_id: input.publication_id, items: order },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
          };
        });
        sendSuccess(reply, { items: ordered }, { request_id: req.id });
      },
    );

    app.post(
      '/networks/:networkId/publications/:id/exclusions',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationExclusionAdd, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const exclusions = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const list = addPublicationExclusion(
            ndb,
            input.publication_id,
            input.thought_id,
            req.auth!.user.id,
          );
          const snapshot = publicationRef(ndb, input.publication_id);
          return {
            result: list,
            events: [
              {
                type: 'publication.exclusions.changed' as const,
                data: {
                  publication_id: input.publication_id,
                  thought_id: input.thought_id,
                  excluded: true,
                },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
          };
        });
        sendSuccess(reply, { exclusions }, { request_id: req.id });
      },
    );

    app.delete(
      '/networks/:networkId/publications/:id/exclusions',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationExclusionRemove, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const exclusions = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const list = removePublicationExclusion(ndb, input.publication_id, input.thought_id);
          const snapshot = publicationRef(ndb, input.publication_id);
          return {
            result: list,
            events: [
              {
                type: 'publication.exclusions.changed' as const,
                data: {
                  publication_id: input.publication_id,
                  thought_id: input.thought_id,
                  excluded: false,
                },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
          };
        });
        sendSuccess(reply, { exclusions }, { request_id: req.id });
      },
    );

    // -------------------------------------------------------------------------
    // Пересборка, сборка, кандидаты, использование (f9a20c3f, 19d80dd2, f49c6420)
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/publications/:id/rebuild',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationRebuild, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const publication = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const rebuilt = rebuildPublication(ndb, input.publication_id, req.auth!.user.id);
          return {
            result: rebuilt.publication,
            events: [
              {
                type: 'publication.rebuilt' as const,
                data: {
                  publication_id: rebuilt.publication.id,
                  assembly_date: rebuilt.publication.assembly_date ?? '',
                },
              },
            ],
            activity: [
              {
                kind: 'publication' as const,
                action: 'updated' as const,
                publication: rebuilt.publication,
              },
            ],
          };
        });
        sendSuccess(reply, publication, {
          version: publication.version,
          updated_at: publication.updated_at,
          request_id: req.id,
        });
      },
    );

    app.get(
      '/networks/:networkId/publications/:id/assembly',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationAssembly, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const assembly = assemblePublication(ndb, input.publication_id, req.auth!.user.id, {
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.include_excluded !== undefined
            ? { include_excluded: input.include_excluded }
            : {}),
        });
        sendSuccess(reply, assembly);
      },
    );

    app.get(
      '/networks/:networkId/publications/:id/candidates',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationCandidates, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const candidates = listPublicationCandidates(
          ndb,
          input.publication_id,
          req.auth!.user.id,
          {
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.offset !== undefined ? { offset: input.offset } : {}),
            ...(input.include_excluded !== undefined
              ? { include_excluded: input.include_excluded }
              : {}),
          },
        );
        sendSuccess(reply, candidates);
      },
    );

    app.get(
      '/networks/:networkId/thoughts/:id/publications',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPublicationUsage, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const usage = listPublicationUsage(ndb, input.thought_id, req.auth!.user.id, {
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.publication_limit !== undefined
            ? { publication_limit: input.publication_limit }
            : {}),
        });
        sendSuccess(reply, usage);
      },
    );

    // -------------------------------------------------------------------------
    // Полки библиотеки (карточка c80951ea)
    // -------------------------------------------------------------------------
    app.get(
      '/networks/:networkId/shelves',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const shelves = listShelves(ndb);
        sendList(reply, shelves, shelves.length, 0, shelves.length);
      },
    );

    app.post(
      '/networks/:networkId/shelves',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfCreate, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const shelf = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const created = createShelf(ndb, { title: input.title }, req.auth!.user.id);
          return {
            result: created,
            events: [{ type: 'shelf.updated' as const, data: { shelf: created } }],
            activity: [{ kind: 'shelf' as const, action: 'created' as const, shelf: created }],
          };
        });
        sendCreated(reply, shelf, {
          version: shelf.version,
          updated_at: shelf.updated_at,
          request_id: req.id,
        });
      },
    );

    app.patch(
      '/networks/:networkId/shelves/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfUpdate, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const shelf = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = updateShelf(
            ndb,
            input.shelf_id,
            {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.position !== undefined ? { position: input.position } : {}),
            },
            req.auth!.user.id,
          );
          return {
            result: updated,
            events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
            activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
          };
        });
        sendSuccess(reply, shelf, {
          version: shelf.version,
          updated_at: shelf.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/shelves/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfDelete, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const existing = listShelves(ndb).find((s) => s.id === input.shelf_id) ?? null;
          deleteShelf(ndb, input.shelf_id);
          return {
            result: undefined,
            events:
              existing === null
                ? []
                : [{ type: 'shelf.deleted' as const, data: { id: input.shelf_id } }],
            activity:
              existing === null
                ? []
                : [{ kind: 'shelf' as const, action: 'deleted' as const, shelf: existing }],
          };
        });
        reply.code(204).send();
      },
    );

    app.post(
      '/networks/:networkId/shelves/:id/items',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfItemAdd, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const shelf = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const current = listShelves(ndb).find((s) => s.id === input.shelf_id);
          // Без явной позиции публикация кладётся в конец состава.
          const position =
            input.position ??
            (current === undefined
              ? 1
              : current.items.reduce((max, item) => Math.max(max, item.position), 0) + 1);
          const updated = addShelfItem(
            ndb,
            input.shelf_id,
            input.publication_id,
            position,
            req.auth!.user.id,
          );
          return {
            result: updated,
            events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
            activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
          };
        });
        sendSuccess(reply, shelf, {
          version: shelf.version,
          updated_at: shelf.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/shelves/:id/items',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestShelfItemRemove, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const shelf = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = removeShelfItem(ndb, input.shelf_id, input.publication_id);
          return {
            result: updated,
            events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
            activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
          };
        });
        sendSuccess(reply, shelf, {
          version: shelf.version,
          updated_at: shelf.updated_at,
          request_id: req.id,
        });
      },
    );
  };
}
