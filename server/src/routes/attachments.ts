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

import multipartPlugin from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';

import {
  EtnError,
  type AttachmentFileInput,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerType,
  type AttachmentUpdateInput,
} from '@etn/shared';

import { buildContentDisposition } from '../http/content-disposition.js';
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
  ATTACHMENT_FILE_MAX_BYTES,
  copyAttachment,
  createAttachmentFileResult,
  createAttachmentFromInputResult,
  enrichUrlAttachment,
  getAttachment,
  getAttachmentContent,
  getAttachmentRawByPath,
  listAttachments,
  listAttachmentUsage,
  parseAttachmentSearchQuery,
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

/**
 * Текстовые части multipart-запроса создания вложения (ошибка 92446fbc,
 * 0.15.4). Файловая часть — ровно одна, с именем `file`; `kind` принимается
 * только со значением `file` (multipart умеет лишь загрузку содержимого).
 */
const MULTIPART_ATTACHMENT_FIELDS = ['kind', 'title', 'description', 'mime_type'] as const;

/** Разобранный multipart-запрос создания вложения. */
interface MultipartAttachmentInput {
  title: string | null;
  description: string | null;
  mime_type: string;
  data_base64: string;
}

/**
 * Разобрать `multipart/form-data` запрос создания вложения: одна файловая часть
 * `file` (лимит размера — `ATTACHMENT_FILE_MAX_BYTES`, его держит busboy) плюс
 * необязательные поля {@link MULTIPART_ATTACHMENT_FIELDS}.
 *
 * Неизвестное поле, лишняя файловая часть и отсутствие `file` —
 * `VALIDATION_ERROR` с перечнем допустимых полей (неизвестный вход не
 * игнорируется молча). Части дочитываются ДО проверок: брошенный посреди
 * итерации `parts()` запрос оставил бы поток тела незавершённым.
 */
async function readMultipartAttachment(req: FastifyRequest): Promise<MultipartAttachmentInput> {
  const allowedFields: string[] = ['file', ...MULTIPART_ATTACHMENT_FIELDS];
  const fields: Record<string, string> = {};
  const files: { fieldname: string; buffer: Buffer; mimetype: string; filename: string }[] = [];

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      files.push({
        fieldname: part.fieldname,
        buffer: await part.toBuffer(),
        mimetype: part.mimetype,
        filename: part.filename,
      });
      continue;
    }
    if (!(MULTIPART_ATTACHMENT_FIELDS as readonly string[]).includes(part.fieldname)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `unknown multipart field "${part.fieldname}". Allowed: ${allowedFields.join(', ')}.`,
        { field: part.fieldname, allowed: allowedFields },
        req.id,
      );
    }
    fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
  }

  const [file] = files;
  if (file === undefined || files.length !== 1 || file.fieldname !== 'file') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'a multipart attachment request takes exactly one file part named "file".',
      { field: 'file', allowed: allowedFields },
      req.id,
    );
  }
  if (file.buffer.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'the "file" part is empty.', { field: 'file' }, req.id);
  }
  const kind = fields['kind']?.trim() ?? '';
  if (kind !== '' && kind !== 'file') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'multipart upload supports kind="file" only.',
      { field: 'kind', allowed: ['file'] },
      req.id,
    );
  }
  const mimeType = (fields['mime_type'] ?? '').trim() || file.mimetype;
  // Имя загруженного файла — дефолт заголовка (как у `POST …/attachments/file`
  // без `title`); пустое значение любого текстового поля — отсутствие значения.
  const titleRaw = fields['title'] ?? file.filename;
  const descriptionRaw = fields['description'] ?? '';
  return {
    title: titleRaw.trim() === '' ? null : titleRaw,
    description: descriptionRaw.trim() === '' ? null : descriptionRaw,
    mime_type: mimeType,
    data_base64: file.buffer.toString('base64'),
  };
}

/** `/api/v1/networks*` attachment routes plugin factory. */
export function createAttachmentsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // Multipart-загрузка на маршруте создания вложения (ошибка 92446fbc,
    // 0.15.4). Плагин подключён В КОНТЕКСТЕ этого семейства маршрутов: прочие
    // REST-роуты продолжают принимать только JSON, а `multipart/form-data` там
    // получает честный 415. Лимиты — те же, что у JSON-загрузки
    // (`POST …/attachments/file`): один файл не больше `ATTACHMENT_FILE_MAX_BYTES`.
    await app.register(multipartPlugin, {
      limits: { fileSize: ATTACHMENT_FILE_MAX_BYTES, files: 2, fields: 8, parts: 12 },
    });

    /**
     * События добавления владений (0.12.1, задача f77382ba, сущность 109be255):
     * на каждое новое владение — один `attachment.owner.added` с парой
     * (вложение, объект). Подписчики перечитывают список/счётчики владельца.
     */
    const ownerAddedEvents = (
      attachmentId: string,
      refs: readonly { owner_type: AttachmentOwnerType; owner_id: string }[],
    ): AnyWriteEvent[] =>
      refs.map((ref) => ({
        type: 'attachment.owner.added' as const,
        data: {
          attachment_id: attachmentId,
          owner_type: ref.owner_type,
          owner_id: ref.owner_id,
        },
      }));

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
          if (req.isMultipart()) {
            // Multipart-загрузка (ошибка 92446fbc, 0.15.4): тот же результат,
            // что у JSON-создания, — `201 { data: Attachment }`; содержимое
            // файла сохраняет домен (`createAttachmentFileResult`), отдельного
            // хранилища у этого маршрута нет (ADR 8c93f03a).
            const { network_id, owner_id } = parseRest(RestAttachmentListOwner, req);
            const upload = await readMultipartAttachment(req);
            const ndb = openRouteNetworkDb(deps, req, network_id, app.appLogger);
            const created = runWrite(ndb, restWriteFx(deps, req, network_id), () => {
              const stored = createAttachmentFileResult(
                ndb,
                ownerType,
                owner_id,
                {
                  title: upload.title,
                  mime_type: upload.mime_type,
                  data_base64: upload.data_base64,
                },
                req.auth!.user.id,
              );
              // `description` домен файловой загрузки не принимает — тот же
              // приём, что у PATCH: правка метаданных в этой же транзакции.
              const attachment =
                upload.description === null
                  ? stored.attachment
                  : updateAttachment(
                      ndb,
                      stored.attachment.id,
                      { description: upload.description },
                      req.auth!.user.id,
                    );
              return {
                result: attachment,
                // Дедуп по хэшу (ADR e3a35864): новой строки нет — эмитим
                // владение, а не `attachment.created` (как в JSON-загрузке).
                events: stored.reused
                  ? stored.ownership_added
                    ? ownerAddedEvents(attachment.id, [{ owner_type: ownerType, owner_id }])
                    : []
                  : [{ type: 'attachment.created', data: { attachment } }],
                activity: [{ kind: 'attachment', action: 'created', attachment }],
              };
            });
            sendCreated(reply, created, { request_id: req.id });
            return;
          }
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
          // Общий доменный диспетчер (не `createAttachmentResult` напрямую):
          // он проверяет, что `file_path` действительно читается сервером
          // (ошибка 93925275, 0.15.4 — иначе создавалось висячее вложение), и
          // отдаёт дедуп-переиспользование по хэшу (замечание f77382ba).
          const created = runWrite(ndb, fx, () => ({
            result: createAttachmentFromInputResult(
              ndb,
              ownerType,
              input.owner_id,
              parsed,
              req.auth!.user.id,
            ),
          }));
          let attachment = created.attachment;
          // URL attachments are enriched (page title + favicon) before the
          // response/event so clients render a filled row at once (L1).
          // Обогащение — сетевой вызов, поэтому вне транзакции.
          if (attachment.kind === 'url') {
            attachment = await enrichUrlAttachment(ndb, attachment);
          }
          // Событие и журнал — из итогового снимка, после коммита.
          runWrite(ndb, fx, () => ({
            result: undefined,
            events: created.reused
              ? created.ownership_added
                ? ownerAddedEvents(attachment.id, [
                    { owner_type: ownerType, owner_id: input.owner_id },
                  ])
                : []
              : [{ type: 'attachment.created', data: { attachment } }],
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
            const {
              attachment: created,
              reused,
              ownership_added,
            } = createAttachmentFileResult(
              ndb,
              ownerType,
              input.owner_id,
              parsed,
              req.auth!.user.id,
            );
            return {
              result: { created, reused },
              // Дедуп-переиспользование (ADR e3a35864): новой строки нет, к
              // существующему вложению добавлен владелец — эмитим владение, не
              // `attachment.created` (задача f77382ba, сущность 109be255).
              // Повторная загрузка тому же владельцу нового владения не даёт —
              // событий нет (запись не изменилась).
              events: reused
                ? ownership_added
                  ? ownerAddedEvents(created.id, [
                      { owner_type: ownerType, owner_id: input.owner_id },
                    ])
                  : []
                : [{ type: 'attachment.created', data: { attachment: created } }],
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
        // `ast` XOR плоские фильтры разбирает домен (задача 5a007bed); профиль
        // «вложения» времени не несёт (withTime=false) — контексту нужен лишь
        // пользователь для под-выборки мыслей-владельцев.
        const query = parseAttachmentSearchQuery({ ...input }, req.id);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const { items, total, warnings } = searchAttachments(ndb, query, {
          userId: req.auth!.user.id,
          requestId: req.id,
        });
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        sendList(
          reply,
          items,
          total,
          offset,
          limit,
          // Ошибка b23a7104: жёлтая диагностика ядра отбора в конверте —
          // семантика «пусто — поля нет», как у хроники и `etn.views.run`.
          warnings !== undefined && warnings.length > 0 ? { warnings } : undefined,
        );
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
        // Потоковая отдача: файл не читается целиком в память (ошибка
        // 24d75c96, тот же класс, что 99c16033 для `jobs/:id/download`);
        // `content-length` — из `stat`, размер известен заранее.
        return reply
          .header('content-type', file.mime_type)
          .header('content-length', String(file.size))
          .header('content-disposition', buildContentDisposition('inline', file.filename))
          .send(createReadStream(file.filePath));
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
          // строке; на каждое новое владение — `attachment.owner.added`
          // (задача f77382ba, операция 45903e1d).
          return { result: copied, events: ownerAddedEvents(input.attachment_id, copied.added) };
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
    // События владений (`attachment.owner.added`/`removed`) — задача f77382ba,
    // сущность 109be255, операции 6ba247cc/4924d61e.
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
          // На каждое новое владение — `attachment.owner.added` (операция 6ba247cc).
          return { result: added, events: ownerAddedEvents(input.attachment_id, added.added) };
        });
        sendSuccess(reply, result);
      },
    );

    app.delete(
      '/networks/:networkId/attachments/:id/owners',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestAttachmentOwnerRemove, req);
        const ownerType = input.owner_type as AttachmentOwnerType;
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const removed = removeOwner(
            ndb,
            input.attachment_id,
            ownerType,
            input.owner_id as string,
            input.confirm === true,
          );
          // Снятие владения — `attachment.owner.removed` (операция 4924d61e);
          // уход последнего владельца дополнительно удаляет вложение —
          // `attachment.deleted`, чтобы подписчики сбросили запись из кэша.
          const events: AnyWriteEvent[] = [
            {
              type: 'attachment.owner.removed',
              data: {
                attachment_id: input.attachment_id,
                owner_type: ownerType,
                owner_id: input.owner_id as string,
              },
            },
            ...(removed.attachment_deleted
              ? ([{ type: 'attachment.deleted', data: { id: input.attachment_id } }] as const)
              : []),
          ];
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
