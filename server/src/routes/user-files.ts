/**
 * Фоновая картинка пользователя серверного уровня (0.16.1, задача 8e007e63;
 * операция API 31ef478a, сущность 62fd29b5, ADR a5888535).
 *
 *   GET    /api/v1/users/me/wallpaper      — метаданные картинки (404 — нет)
 *   GET    /api/v1/users/me/wallpaper/raw  — байты: ETag + nosniff (404 — нет)
 *   PUT    /api/v1/users/me/wallpaper      — загрузка/перезапись (201/200)
 *   DELETE /api/v1/users/me/wallpaper      — удаление (204 всегда, идемпотентно)
 *
 * Особенности контракта:
 *   * PUT принимает `multipart/form-data` (часть `file` + JSON-поле `meta`) либо
 *     JSON `{data_base64, meta}`; mime берётся из объявленного значения, а при
 *     его отсутствии — из магических байтов;
 *   * сервер НЕ обрабатывает изображения: только магические байты, белый список
 *     mime, лимит 5 МиБ и структура `meta` (никаких image-зависимостей);
 *   * перезапись удаляет прежний файл; DELETE идемпотентен и всегда 204;
 *   * real-time-событий нет: смена касается устройства пользователя, остальные
 *     устройства подтянут картинку при следующем старте.
 */

import multipartPlugin from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';

import { EtnError, USER_FILE_KIND, USER_FILE_MAX_BYTES } from '@etn/shared';

import { RestUserWallpaperUpload, parseRest } from '../contracts.js';
import { buildErrorBody, isPayloadTooLargeError, sendNormalisedError } from '../http/errors.js';
import { buildContentDisposition } from '../http/content-disposition.js';
import { sendSuccess } from '../http/responses.js';
import {
  deleteUserFile,
  detectImageMime,
  fileExtensionForMime,
  putUserFile,
  readUserFile,
  wallpaperInfo,
  type UserFileUpload,
} from '../domain/user-file-service.js';
import type { RouteDeps } from './helpers.js';

/**
 * Жёсткий потолок multipart-запроса (страховка памяти). Файл длиннее лимита
 * `USER_FILE_MAX_BYTES`, но короче потолка, отклоняется доменной проверкой с
 * 422 (как требует контракт операции); запрос сверх потолка режет сам
 * multipart-парсер, а скоуповый обработчик ошибок (`setErrorHandler` ниже)
 * переводит этот транспортный отказ в тот же 422 с `details.field =
 * file_size` — клиент не должен различать, где именно сработал предел.
 */
const MULTIPART_HARD_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Потолок JSON-тела PUT: 5 МиБ в base64 ≈ 6.7 МиБ; 8 МиБ — запас. Тело сверх
 * потолка режет Fastify, скоуповый обработчик ошибок переводит отказ в 422
 * (`file_size`), как и доменную проверку лимита.
 */
const JSON_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Текстовые части multipart-запроса (`file` — файловая часть). */
const MULTIPART_FIELDS = ['meta', 'mime_type'] as const;

/** Разбор JSON-поля `meta` (multipart присылает его строкой). */
function parseMetaField(raw: unknown, requestId?: string): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new EtnError(
      'VALIDATION_ERROR',
      'the "meta" field is not valid JSON.',
      { field: 'meta', reason: 'invalid_json' },
      requestId,
    );
  }
}

/**
 * Разобрать `multipart/form-data`: ровно одна файловая часть `file` и
 * необязательные текстовые поля {@link MULTIPART_FIELDS}. Неизвестное поле,
 * лишняя или отсутствующая файловая часть — `VALIDATION_ERROR` (неизвестный
 * вход не игнорируется молча). Части дочитываются до проверок: брошенный
 * посреди итерации `parts()` запрос оставил бы поток тела незавершённым.
 */
async function readMultipartUpload(req: FastifyRequest): Promise<UserFileUpload> {
  const fields: Record<string, string> = {};
  const files: { fieldname: string; buffer: Buffer; mimetype: string }[] = [];

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      files.push({
        fieldname: part.fieldname,
        buffer: await part.toBuffer(),
        mimetype: part.mimetype,
      });
      continue;
    }
    if (!(MULTIPART_FIELDS as readonly string[]).includes(part.fieldname)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `unknown multipart field "${part.fieldname}". Allowed: file, ${MULTIPART_FIELDS.join(', ')}.`,
        { field: part.fieldname, allowed: ['file', ...MULTIPART_FIELDS] },
        req.id,
      );
    }
    fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
  }

  const [file] = files;
  if (file === undefined || files.length !== 1 || file.fieldname !== 'file') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'a multipart wallpaper request takes exactly one file part named "file".',
      { field: 'file', allowed: ['file', ...MULTIPART_FIELDS] },
      req.id,
    );
  }
  if (fields['meta'] === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'the "meta" field is required (JSON with width/height/avg_luminance).',
      { field: 'meta' },
      req.id,
    );
  }
  const detected = detectImageMime(file.buffer);
  const declared = (fields['mime_type'] ?? '').trim() || file.mimetype.trim();
  return {
    mime_type: declared === '' ? (detected ?? '') : declared,
    buffer: file.buffer,
    meta: parseMetaField(fields['meta'], req.id),
  };
}

/**
 * JSON-ветка PUT: поля контракта {@link RestUserWallpaperUpload} → доменный вход
 * загрузки. Тело объявлено контрактом (стандарт 02c164ed), пустой/битый
 * `data_base64` отвергает домен (422: пустой файл / не картинка).
 */
function buildJsonUpload(input: {
  data_base64: string;
  meta: unknown;
  mime_type?: string;
}): UserFileUpload {
  const buffer = Buffer.from(input.data_base64, 'base64');
  const declared = (input.mime_type ?? '').trim();
  const detected = detectImageMime(buffer);
  return {
    mime_type: declared === '' ? (detected ?? '') : declared,
    buffer,
    meta: input.meta,
  };
}

/** `If-None-Match` совпал с ETag ресурса (в т. ч. `*`)? */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || part === etag || part === `W/${etag}`);
}

/** `/api/v1/users/me/wallpaper` routes plugin factory. */
export function createUserFilesRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    // Multipart подключён в контексте этого маршрута: прочие REST-роуты
    // продолжают принимать только JSON. Лимиты памяти — см.
    // MULTIPART_HARD_CAP_BYTES; бизнес-лимит 5 МиБ проверяет домен (422).
    await app.register(multipartPlugin, {
      limits: { fileSize: MULTIPART_HARD_CAP_BYTES, files: 1, fields: 2, parts: 4 },
    });

    // Транспортные потолки (8 МиБ) — страховка памяти, а не бизнес-правило:
    // контракт операции 31ef478a требует 422 на файл сверх 5 МиБ независимо от
    // того, где сработал предел (домен или парсер). Прочие ошибки — общий
    // конвейер сервера (та же форма ответа и логирование).
    app.setErrorHandler((err, req, reply) => {
      if (isPayloadTooLargeError(err)) {
        reply
          .code(422)
          .send(
            buildErrorBody(
              'VALIDATION_ERROR',
              `file is too large: the request exceeded the transport limit, server limit is ${USER_FILE_MAX_BYTES} bytes.`,
              { field: 'file_size', limit: USER_FILE_MAX_BYTES, reason: 'payload_too_large' },
              req.id,
            ),
          );
        return;
      }
      sendNormalisedError(err, req, reply, app.appLogger);
    });

    const kind = USER_FILE_KIND.MAP_WALLPAPER;

    app.get(
      '/users/me/wallpaper',
      { preHandler: [app.authPreHandler] },
      async (req: FastifyRequest, reply) => {
        const row = app.systemDb.getUserFile(req.auth!.user.id, kind);
        if (row === null) {
          throw new EtnError('NOT_FOUND', 'no wallpaper uploaded.', undefined, req.id);
        }
        sendSuccess(reply, wallpaperInfo(row), { request_id: req.id });
      },
    );

    app.get(
      '/users/me/wallpaper/raw',
      { preHandler: [app.authPreHandler] },
      async (req: FastifyRequest, reply) => {
        const file = readUserFile(app.systemDb, req.auth!.user.id, kind);
        if (file === null) {
          // «Строка есть, файла нет» — штатная деградация клиента (ADR a5888535).
          throw new EtnError('NOT_FOUND', 'no wallpaper file on this server.', undefined, req.id);
        }
        const etag = `"${file.row.content_hash}"`;
        if (matchesEtag(req.headers['if-none-match'], etag)) {
          return reply.code(304).header('etag', etag).send();
        }
        // Расширение по фактическому mime: клиент (и человек) видят, что это
        // за файл, даже если сохранит его из ответа (правки по вердикту).
        const extension = fileExtensionForMime(file.row.mime_type);
        const filename =
          extension === null ? `wallpaper.${kind}` : `wallpaper.${kind}.${extension}`;
        return reply
          .header('content-type', file.row.mime_type)
          .header('content-length', String(file.size))
          .header('etag', etag)
          .header('cache-control', 'private, max-age=0, must-revalidate')
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', buildContentDisposition('inline', filename))
          .send(createReadStream(file.filePath));
      },
    );

    app.put(
      '/users/me/wallpaper',
      {
        preHandler: [app.authPreHandler, app.idempotency.preHandler],
        bodyLimit: JSON_BODY_LIMIT_BYTES,
      },
      async (req: FastifyRequest, reply) => {
        const upload = req.isMultipart()
          ? await readMultipartUpload(req)
          : buildJsonUpload(parseRest(RestUserWallpaperUpload, req));
        const { info, created } = putUserFile(
          app.systemDb,
          deps.dataDir,
          req.auth!.user.id,
          kind,
          upload,
          req.id,
        );
        sendSuccess(reply, info, { request_id: req.id }, created ? 201 : 200);
      },
    );

    app.delete(
      '/users/me/wallpaper',
      { preHandler: [app.authPreHandler, app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        deleteUserFile(app.systemDb, req.auth!.user.id, kind);
        reply.code(204).send();
      },
    );
  };
}
