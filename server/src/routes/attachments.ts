/**
 * Attachment routes (task D5, 03-server-api.md §11).
 *
 *   GET/POST /networks/:networkId/thoughts/:id/attachments — list/create on a thought
 *   GET/POST /networks/:networkId/links/:id/attachments    — list/create on a link
 *   GET/POST /networks/:networkId/publications/:id/attachments — list/create on a publication
 *   GET      /networks/:networkId/attachments/raw?path=…    — raw bytes of a stored file
 *   GET      /networks/:networkId/attachments/:id/usage     — owners + usages of the attachment
 *   POST     /networks/:networkId/attachments/:id/owners    — add owner(s) to an attachment
 *   DELETE   /networks/:networkId/attachments/:id/owners    — remove one ownership
 *   PATCH    /networks/:networkId/attachments/:id          — update metadata (title/description/icon)
 *
 * Удаления вложения в публичном API НЕТ (0.12.1, задача 478f8c1f, операция
 * 28ecc295): полное удаление выполняет owner-cleanup, когда снят последний
 * живой владелец во всех слоях; снятие одного владения — DELETE /owners.
 *
 * Attachments are polymorphic (`owner_type` + `owner_id`); on MVP `kind=file`
 * stores only a client-side path (no upload). The table has no `version`
 * column, so PATCH has no `If-Match` guard (documented in the service).
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type AttachmentFileInput,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerType,
  type AttachmentSearchQuery,
  type AttachmentUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  restWriteFx,
  runWrite,
  type AnyWriteEvent,
  type RouteDeps,
} from './helpers.js';
import {
  addOwners,
  copyAttachment,
  createAttachment,
  createAttachmentFileResult,
  enrichUrlAttachment,
  getAttachment,
  getAttachmentContent,
  getAttachmentRawByPath,
  listAttachments,
  listAttachmentUsage,
  removeOwner,
  searchAttachments,
  updateAttachment,
  updateAttachmentContent,
} from '../domain/attachment-service.js';
import {
  parseRest,
  RestAttachmentById,
  RestAttachmentContentPut,
  RestAttachmentCopy,
  RestAttachmentCreate,
  RestAttachmentFileCreate,
  RestAttachmentListOwner,
  RestAttachmentOwnersAdd,
  RestAttachmentOwnerRemove,
  RestAttachmentRaw,
  RestAttachmentSearch,
  RestAttachmentUpdate,
  RestAttachmentUsage,
} from '../contracts.js';

/** `/api/v1/networks*` attachment routes plugin factory. */
export function createAttachmentsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    /** Register list/create for one owner kind. */
    const registerOwnerRoutes = (pathBase: string, ownerType: AttachmentOwnerType) => {
      app.get(
        `${pathBase}/attachments`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestAttachmentListOwner, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const attachments = listAttachments(ndb, ownerType, input.owner_id);
          sendList(reply, attachments, attachments.length, 0, attachments.length);
        },
      );

      app.post(
        `${pathBase}/attachments`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestAttachmentCreate, req);
          const parsed: AttachmentInput = {
            kind: input.kind as AttachmentKind,
            url: (input.url ?? null) as string | null,
            file_path: (input.file_path ?? null) as string | null,
            file_size: input.file_size as number | undefined,
            mime_type: (input.mime_type ?? null) as string | null,
            title: (input.title ?? null) as string | null,
            description: (input.description ?? null) as string | null,
            position: input.position as number | undefined,
          };
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const fx = restWriteFx(deps, req, input.network_id);
          // Создание — через обёртку (без событий: снимок ещё не окончательный).
          let attachment = runWrite(ndb, fx, () => ({
            result: createAttachment(ndb, ownerType, input.owner_id, parsed, req.auth!.user.id),
          }));
          // URL attachments are enriched (page title + favicon) before the
          // response/event so clients render a filled row at once (L1).
          // Обогащение — сетевой вызов, поэтому вне транзакции.
          if (attachment.kind === 'url') {
            attachment = await enrichUrlAttachment(ndb, attachment);
          }
          // Событие и журнал — из итогового снимка, после коммита.
          runWrite(ndb, fx, () => ({
            result: undefined,
            events: [{ type: 'attachment.created', data: { attachment } }],
            activity: [{ kind: 'attachment', action: 'created', attachment }],
          }));
          sendCreated(reply, attachment, { request_id: req.id });
        },
      );

      // File upload: the payload is stored under the network's attachments/
      // directory (next to data.db); the response carries the stored path.
      app.post(
        `${pathBase}/attachments/file`,
        {
          preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler],
          // 10 MiB decoded ≈ 13.4 MiB base64 — allow headroom over the default 1 MiB.
          bodyLimit: 16 * 1024 * 1024,
        },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestAttachmentFileCreate, req);
          const parsed: AttachmentFileInput = {
            title: (input.title ?? null) as string | null,
            mime_type: input.mime_type as string,
            data_base64: input.data_base64 as string,
          };
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const outcome = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
            const { attachment: created, reused } = createAttachmentFileResult(
              ndb,
              ownerType,
              input.owner_id,
              parsed,
              req.auth!.user.id,
            );
            return {
              result: { created, reused },
              events: [{ type: 'attachment.created', data: { attachment: created } }],
              activity: [{ kind: 'attachment', action: 'created', attachment: created }],
            };
          });
          sendCreated(reply, outcome.created, { request_id: req.id, reused: outcome.reused });
        },
      );
    };

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');
    // Публикации — третий вид владельца (0.11.1, задача 46cf4bcb; ADR 73cfcf64):
    // список/добавление/загрузка файла для публикации, паритет с мыслями.
    registerOwnerRoutes('/networks/:networkId/publications/:id', 'publication');

    // Network-wide attachment search (03-server-api.md §11, workplan L25).
    // Must be registered before the `:id` routes to keep the URL space clear;
    // Fastify resolves by exact match first, but the explicit ordering keeps
    // route tables readable.
    app.get(
      '/networks/:networkId/attachments',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentSearch, req);
        const query: AttachmentSearchQuery = {
          q: (input.q as string | undefined) ?? '',
          ...(input.exclude_owner_type !== undefined
            ? {
                exclude_owner_type:
                  input.exclude_owner_type as AttachmentSearchQuery['exclude_owner_type'],
              }
            : {}),
          ...(input.exclude_owner_id !== undefined
            ? { exclude_owner_id: input.exclude_owner_id as string }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind as AttachmentKind } : {}),
          ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
          ...(input.offset !== undefined ? { offset: input.offset as number } : {}),
        };
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const { items, total } = searchAttachments(ndb, query);
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        sendList(reply, items, total, offset, limit);
      },
    );

    // Raw bytes of a server-stored attachment file by absolute `file_path` —
    // what remote clients download when their local filesystem has no such
    // path (the `etnimg:` scheme falls back to this endpoint). Registered
    // next to the search route, before the `:id` routes: the static `raw`
    // segment wins over the `:id` parameter.
    app.get(
      '/networks/:networkId/attachments/raw',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentRaw, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const file = getAttachmentRawByPath(ndb, input.path as string);
        reply
          .header('content-type', file.mime_type)
          .header('content-disposition', `inline; filename="${encodeURIComponent(file.filename)}"`)
          .send(file.body);
      },
    );

    // Copy an attachment to one or more target owners (workplan L25; с
    // муль-владением 0.12.1 — добавление владельцев той же строке, без новых
    // строк). 422 on unknown targets or invalid body, 404 on the source.
    app.post(
      '/networks/:networkId/attachments/:id/copy',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentCopy, req);
        const parsed = {
          target_owner_type: input.target_owner_type as AttachmentOwnerType,
          target_owner_ids: input.target_owner_ids as string[],
        };
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const copied = copyAttachment(ndb, input.attachment_id, parsed, req.auth!.user.id);
          // С муль-владением (0.12.1) копия = добавление владельцев той же
          // строке; новых строк нет. Отдельные события владельцев —
          // `attachment.owner.added` (задача f77382ba). Пока эмитим одно
          // `attachment.updated`, чтобы подписчики перечитали вложение.
          const events: AnyWriteEvent[] =
            copied.added.length === 0
              ? []
              : [{ type: 'attachment.updated', data: { id: input.attachment_id, changes: {} } }];
          return { result: copied, events };
        });
        sendSuccess(reply, result);
      },
    );

    // `GET /attachments/:id` — fetch one attachment with its owner info.
    // Используется для разрешения событий активности (задача 59119797): клик
    // по строке `entity_type='attachment'` открывает владельца вложения.
    app.get(
      '/networks/:networkId/attachments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const attachment = getAttachment(ndb, input.attachment_id);
        if (attachment === null) {
          throw new EtnError(
            'NOT_FOUND',
            `attachment ${input.attachment_id} not found`,
            {
              entity: 'attachment',
              id: input.attachment_id,
            },
            req.id,
          );
        }
        sendSuccess(reply, attachment);
      },
    );

    // `GET /attachments/:id/usage` — использование вложения (0.11.1, задача
    // 46cf4bcb): владельцы (мысли, связи, публикации), которые держат тот же
    // физический носитель. Нужно «облачкам» в диалоге выбора обложки
    // публикации. Статический сегмент `usage` не конфликтует с `:id`.
    app.get(
      '/networks/:networkId/attachments/:id/usage',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentUsage, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        sendSuccess(reply, listAttachmentUsage(ndb, input.attachment_id));
      },
    );

    // Владельцы вложения (0.12.1, задачи 6ba247cc/4924d61e, ADR 9f90b010):
    // добавить одного/нескольких владельцев и снять ОДНО владение. Снятие
    // последнего живого владельца во всех слоях удаляет вложение (owner-cleanup).
    // События владельцев (`attachment.owner.added`/`removed`) ставит задача
    // f77382ba; здесь — одно `attachment.updated`, чтобы подписчики перечитали.
    app.post(
      '/networks/:networkId/attachments/:id/owners',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentOwnersAdd, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const added = addOwners(
            ndb,
            input.attachment_id,
            input.owner_type as AttachmentOwnerType,
            input.owner_ids as string[],
            req.auth!.user.id,
          );
          const events: AnyWriteEvent[] =
            added.added.length === 0
              ? []
              : [{ type: 'attachment.updated', data: { id: input.attachment_id, changes: {} } }];
          return { result: added, events };
        });
        sendSuccess(reply, result);
      },
    );

    app.delete(
      '/networks/:networkId/attachments/:id/owners',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentOwnerRemove, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const removed = removeOwner(
            ndb,
            input.attachment_id,
            input.owner_type as AttachmentOwnerType,
            input.owner_id as string,
            input.confirm === true,
          );
          const events: AnyWriteEvent[] = removed.attachment_deleted
            ? [{ type: 'attachment.deleted', data: { id: input.attachment_id } }]
            : [{ type: 'attachment.updated', data: { id: input.attachment_id, changes: {} } }];
          return { result: removed, events };
        });
        sendSuccess(reply, result);
      },
    );

    // PATCH — правка МЕТАДАННЫХ вложения (0.12.1, задача 478f8c1f): только
    // title/description/icon. Смены владельца здесь нет (владельцы — POST/DELETE
    // …/owners); местоположение (url/file_path) неизменяемо.
    app.patch(
      '/networks/:networkId/attachments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentUpdate, req);
        const changes: AttachmentUpdateInput = {};
        if (input.title !== undefined) changes.title = input.title as string | null;
        if (input.description !== undefined)
          changes.description = input.description as string | null;
        if (input.icon !== undefined) changes.icon = input.icon as string | null;
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const attachment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = updateAttachment(ndb, input.attachment_id, changes, req.auth!.user.id);
          return {
            result: updated,
            events: [{ type: 'attachment.updated', data: { id: input.attachment_id, changes } }],
            activity: [{ kind: 'attachment', action: 'updated', attachment: updated }],
          };
        });
        sendSuccess(reply, attachment);
      },
    );

    // `DELETE /attachments/{id}` убран из публичного API (0.12.1, задача
    // 478f8c1f, операция 28ecc295): полное удаление вложения выполняет
    // owner-cleanup, когда снят последний живой владелец; снятие ОДНОГО
    // владения — DELETE …/owners.

    // Text content of a file attachment for the built-in viewer/editor (L7,
    // 03-server-api.md §11). GET returns text (+ rendered html for markdown);
    // PUT overwrites the file.
    app.get(
      '/networks/:networkId/attachments/:id/content',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        sendSuccess(reply, getAttachmentContent(ndb, input.attachment_id));
      },
    );

    app.put(
      '/networks/:networkId/attachments/:id/content',
      {
        preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler],
        bodyLimit: 16 * 1024 * 1024,
      },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentContentPut, req);
        const parsed = {
          data_base64: input.data_base64 as string,
          mime_type: input.mime_type as string | undefined,
        };
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const written = updateAttachmentContent(ndb, input.attachment_id, parsed);
          const updated = getAttachment(ndb, input.attachment_id);
          return {
            result: written,
            events: [
              {
                type: 'attachment.updated',
                data: {
                  id: input.attachment_id,
                  changes: {
                    file_size: updated?.file_size ?? null,
                    mime_type: updated?.mime_type ?? null,
                  },
                },
              },
            ],
            ...(updated === null
              ? {}
              : {
                  activity: [
                    {
                      kind: 'attachment' as const,
                      action: 'updated' as const,
                      attachment: updated,
                    },
                  ],
                }),
          };
        });
        sendSuccess(reply, result, { request_id: req.id });
      },
    );
  };
}
