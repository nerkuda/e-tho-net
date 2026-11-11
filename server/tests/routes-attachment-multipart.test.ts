/**
 * Multipart-загрузка на маршруте создания вложения (ошибка 92446fbc, 0.15.4).
 *
 * Симптом до фикса: `POST …/thoughts/{id}/attachments` с `multipart/form-data`
 * (поле `file`) отвечал `500 INTERNAL`, хотя тот же маршрут с JSON-телом
 * создавал вложение и отдавал `201`. Корень — двойной: плагин
 * `@fastify/multipart` не был подключён к маршрутам вложений, а глобальный
 * обработчик ошибок превращал уже классифицированные Fastify-ошибки (415 на
 * неподдерживаемый `content-type`, 413 плагина) в общий 500.
 *
 * Покрытие DoD:
 *   * multipart-загрузка создаёт вложение: `201 { data: Attachment }`, файл
 *     лежит на сервере и читается через `GET /attachments/{id}/content`;
 *   * JSON-вариант создания не сломан;
 *   * ошибки валидации — 4xx (422/413/415), а не 500, и записи не остаётся;
 *   * multipart подключён только к семейству маршрутов вложений: на прочих
 *     REST-роутах `multipart/form-data` получает 415.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ATTACHMENT_FILE_MAX_BYTES } from '../src/domain/attachment-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Одна часть multipart-тела: файл (есть `filename`) или текстовое поле. */
interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

/** Собрать `multipart/form-data` тело и его `content-type` с границей. */
function multipartPayload(parts: readonly MultipartPart[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = '----etn-multipart-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const isFile = part.filename !== undefined;
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${
          isFile ? `; filename="${part.filename}"` : ''
        }\r\n`,
      ),
    );
    if (isFile) {
      chunks.push(
        Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n`),
      );
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(isFile ? (part.data ?? Buffer.alloc(0)) : Buffer.from(part.value ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** POST multipart-тела на маршрут создания вложения мысли. */
async function postMultipart(
  ctx: RestTestContext,
  thoughtId: string,
  parts: readonly MultipartPart[],
) {
  const { payload, contentType } = multipartPayload(parts);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
    headers: { ...authHeaders(ctx), 'content-type': contentType },
    payload,
  });
}

async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Вложения мысли (по владениям) — для проверки «записи не осталось». */
async function listAttachments(ctx: RestTestContext, thoughtId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data as { id: string; title: string | null }[];
}

/** Тело канонической ошибки REST (`{ error: { code, message, details } }`). */
function errorBody(res: { json: () => unknown }): {
  code: string;
  details?: Record<string, unknown>;
} {
  return (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
}

describe('REST: multipart-загрузка вложения (92446fbc)', { skip: !nativeAvailable() }, () => {
  it('multipart создаёт вложение: 201, серверная копия читается через /content', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Вложение multipart');
      const markdown = Buffer.from('# Заголовок\n\nТело вложения.\n', 'utf8');

      const res = await postMultipart(ctx, thoughtId, [
        { name: 'title', value: 'Отчёт' },
        { name: 'description', value: 'Описание из multipart' },
        {
          name: 'file',
          filename: 'report.md',
          contentType: 'text/markdown',
          data: markdown,
        },
      ]);

      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as {
        data: Record<string, unknown>;
        meta: Record<string, unknown>;
      };
      // Конверт ответа тот же, что у JSON-создания: `{ data: Attachment, meta }`.
      assert.equal(typeof body.meta['request_id'], 'string');
      const attachment = body.data;
      assert.equal(attachment['kind'], 'file');
      assert.equal(attachment['title'], 'Отчёт');
      assert.equal(attachment['description'], 'Описание из multipart');
      assert.equal(attachment['mime_type'], 'text/markdown');
      assert.equal(attachment['file_size'], markdown.length);
      const filePath = attachment['file_path'] as string;
      // Файл сохранён на сервере, а не остался путём клиента.
      assert.ok(
        filePath.startsWith(join(ctx.dataDir, 'networks', ctx.networkId, 'attachments')),
        `file_path должен указывать в каталог вложений сети: ${filePath}`,
      );

      // Сквозная проверка: вложение создано и его содержимое читается.
      const content = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/attachments/${String(attachment['id'])}/content`,
        headers: authHeaders(ctx),
      });
      assert.equal(content.statusCode, 200, content.body);
      assert.equal((content.json().data as { text: string }).text, markdown.toString('utf8'));

      const listed = await listAttachments(ctx, thoughtId);
      assert.equal(listed.length, 1);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('JSON-вариант создания вложения не сломан', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Вложение JSON');
      const filePath = join(ctx.dataDir, 'note.md');
      writeFileSync(filePath, '# note\n');

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
        headers: authHeaders(ctx),
        payload: { kind: 'file', file_path: filePath, mime_type: 'text/markdown', title: 'JSON' },
      });
      assert.equal(res.statusCode, 201, res.body);
      const attachment = res.json().data as Record<string, unknown>;
      assert.equal(attachment['kind'], 'file');
      assert.equal(attachment['file_path'], filePath);
      assert.equal(attachment['title'], 'JSON');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('multipart без файловой части — 422 и записи не остаётся', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Без файла');
      const res = await postMultipart(ctx, thoughtId, [
        { name: 'title', value: 'Только заголовок' },
      ]);
      assert.equal(res.statusCode, 422, res.body);
      const error = errorBody(res);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details?.['field'], 'file');
      assert.deepEqual(await listAttachments(ctx, thoughtId), []);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('неизвестное поле multipart — 422 с перечнем допустимых', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Лишнее поле');
      const res = await postMultipart(ctx, thoughtId, [
        { name: 'kind', value: 'file' },
        { name: 'file', filename: 'a.md', contentType: 'text/markdown', data: Buffer.from('x') },
        { name: 'file_path', value: 'C:\\tmp\\a.md' },
      ]);
      assert.equal(res.statusCode, 422, res.body);
      const error = errorBody(res);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details?.['field'], 'file_path');
      assert.ok(Array.isArray(error.details?.['allowed']));
      assert.deepEqual(await listAttachments(ctx, thoughtId), []);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('файл сверх лимита — 413, а не 500', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Слишком большой файл');
      const res = await postMultipart(ctx, thoughtId, [
        {
          name: 'file',
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          data: Buffer.alloc(ATTACHMENT_FILE_MAX_BYTES + 1, 0x61),
        },
      ]);
      assert.equal(res.statusCode, 413, res.body);
      assert.deepEqual(await listAttachments(ctx, thoughtId), []);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('неподдерживаемый content-type на маршруте создания — 415, а не 500', async () => {
    const ctx = await buildRestContext();
    try {
      const thoughtId = await createThought(ctx, 'Не тот тип тела');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
        headers: { ...authHeaders(ctx), 'content-type': 'application/xml' },
        payload: '<attachment/>',
      });
      assert.equal(res.statusCode, 415, res.body);
      assert.equal(errorBody(res).code, 'BAD_REQUEST');
      assert.deepEqual(await listAttachments(ctx, thoughtId), []);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('multipart подключён только к вложениям: на POST /thoughts — 415', async () => {
    const ctx = await buildRestContext();
    try {
      const { payload, contentType } = multipartPayload([{ name: 'title', value: 'Не тут' }]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts`,
        headers: { ...authHeaders(ctx), 'content-type': contentType },
        payload,
      });
      assert.equal(res.statusCode, 415, res.body);
    } finally {
      await closeRestContext(ctx);
    }
  });
});
