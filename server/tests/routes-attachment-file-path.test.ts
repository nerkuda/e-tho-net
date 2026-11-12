/**
 * Проверка читаемости `file_path` при REST-создании вложения (ошибка 93925275,
 * 0.15.4).
 *
 * Симптом до фикса: `POST …/thoughts/{id}/attachments` с JSON
 * `{ kind: "file", file_path: "C:\\…" }` отвечал `201`, даже когда файла на
 * машине сервера нет; ошибка вскрывалась позже — `GET …/attachments/{id}/content`
 * → 422 «the attachment file is not readable», а в сети оставалось висячее
 * вложение (в отличие от MCP-канала, где такой путь — `VALIDATION_ERROR`).
 *
 * Покрытие DoD:
 *   * существующий читаемый файл — 201, содержимое читается через `/content`;
 *   * несуществующий путь / каталог — 422 сразу, записи не остаётся;
 *   * ошибка указывает поле `file_path` и подсказывает, как передать файл.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

async function api(
  ctx: RestTestContext,
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${path}`,
    headers: authHeaders(ctx),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await api(ctx, 'POST', '/thoughts', { title });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Число живых строк вложений в сети (доказательство «записи не осталось»). */
function attachmentCount(ctx: RestTestContext): number {
  return ctx.ndb.prepare('SELECT COUNT(*) FROM attachments_v').pluck().get() as number;
}

function errorBody(res: { json: () => unknown }): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return (
    res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
  ).error;
}

describe(
  'REST: file_path вложения проверяется при создании (93925275)',
  { skip: !nativeAvailable() },
  () => {
    it('существующий читаемый файл — 201, содержимое доступно через /content', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'С файлом');
        const filePath = join(ctx.dataDir, 'readable.md');
        writeFileSync(filePath, '# Разбор\n\nТекст файла.\n');

        const res = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          kind: 'file',
          file_path: filePath,
          mime_type: 'text/markdown',
          title: 'Разбор',
        });
        assert.equal(res.statusCode, 201, res.body);
        const attachment = res.json().data as { id: string; file_path: string };
        assert.equal(attachment.file_path, filePath);

        const content = await api(ctx, 'GET', `/attachments/${attachment.id}/content`);
        assert.equal(content.statusCode, 200, content.body);
        assert.match((content.json().data as { text: string }).text, /Текст файла/);
        assert.equal(attachmentCount(ctx), 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('несуществующий путь — 422 сразу, висячего вложения не остаётся', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Битый путь');
        const res = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          kind: 'file',
          file_path: join(ctx.dataDir, 'no-such-file.md'),
          mime_type: 'text/markdown',
        });
        assert.equal(res.statusCode, 422, res.body);
        const error = errorBody(res);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.details?.['field'], 'file_path');
        assert.match(error.message, /does not point to a file on the server/);
        assert.equal(attachmentCount(ctx), 0);

        const list = await api(ctx, 'GET', `/thoughts/${thoughtId}/attachments`);
        assert.deepEqual(list.json().data, []);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('каталог вместо файла — 422 (путь обязан указывать на обычный файл)', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Каталог');
        const dirPath = join(ctx.dataDir, 'some-dir');
        mkdirSync(dirPath, { recursive: true });

        const res = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          kind: 'file',
          file_path: dirPath,
          mime_type: 'application/octet-stream',
        });
        assert.equal(res.statusCode, 422, res.body);
        assert.equal(errorBody(res).details?.['field'], 'file_path');
        assert.equal(attachmentCount(ctx), 0);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
