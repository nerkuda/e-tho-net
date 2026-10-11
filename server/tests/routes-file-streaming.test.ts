/**
 * Регрессия ошибки 24d75c96: файлы отдаются потоком, без чтения целиком
 * в память (тот же класс, что закрыт в 99c16033 для `jobs/:id/download`).
 *
 * Здесь — поведенческая часть (сквозные REST-проверки): байты, заголовки
 * `content-length`/`content-type`/`content-disposition` и прежние коды ошибок.
 * Отсутствие буферизации на уровне кода фиксируется отдельно:
 *   * сторож по исходникам `guard-file-streaming.test.ts`;
 *   * юнит-контракты сервисов (`attachment-service.test.ts` — `filePath`/`size`
 *     без `body`; `file-log.test.ts` — `fileStat` без чтения содержимого).
 *
 * Патч `node:fs` как способ поймать буферизацию не работает: именованные
 * ESM-импорты билтинов — снимки, подмена свойства модуля их не перехватывает
 * (проверено на Node 22).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { authHeaders, buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

describe(
  'потоковая выдача файлов (ошибка 24d75c96)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('GET /attachments/raw отдаёт байты файла с корректными заголовками', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Носитель' },
        });
        assert.equal(thought.statusCode, 201, thought.body);
        const thoughtId = (thought.json().data as { id: string }).id;

        const text = 'stream-me-'.repeat(5000); // ~50 КБ, больше одного чанка
        const bytes = Buffer.from(text);
        const upload = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments/file`,
          headers: authHeaders(ctx),
          payload: {
            title: 'big',
            mime_type: 'application/octet-stream',
            data_base64: bytes.toString('base64'),
          },
        });
        assert.equal(upload.statusCode, 201, upload.body);
        const filePath = (upload.json().data as { file_path: string }).file_path;

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/raw?path=${encodeURIComponent(filePath)}`,
          headers: authHeaders(ctx),
        });

        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.rawPayload.length, bytes.length, 'байты отданы целиком');
        assert.equal(res.rawPayload.toString(), text);
        assert.equal(res.headers['content-length'], String(bytes.length), 'content-length из stat');
        assert.equal(res.headers['content-type'], 'application/octet-stream');
        assert.ok(
          String(res.headers['content-disposition'] ?? '').startsWith('inline;'),
          'content-disposition сохранён (inline)',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('GET /attachments/raw: отсутствующий файл — прежний код VALIDATION_ERROR (422)', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Носитель' },
        });
        const thoughtId = (thought.json().data as { id: string }).id;
        const upload = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments/file`,
          headers: authHeaders(ctx),
          payload: {
            title: 'gone',
            mime_type: 'text/plain',
            data_base64: Buffer.from('bye').toString('base64'),
          },
        });
        const filePath = (upload.json().data as { file_path: string }).file_path;
        fs.rmSync(filePath);

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/raw?path=${encodeURIComponent(filePath)}`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 422, res.body);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('GET /system/logs/:filename отдаёт журнал с корректными заголовками', async () => {
      const ctx = await buildRestContext();
      try {
        const name = 'server-2026-01-02.log';
        const file = path.join(ctx.dataDir, 'logs', name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const text = '2026-01-02T00:00:00.000Z INFO [test] line\n'.repeat(2000);
        fs.writeFileSync(file, text);
        const bytes = Buffer.from(text);

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/system/logs/${name}`,
          headers: authHeaders(ctx),
        });

        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.rawPayload.toString(), text);
        assert.equal(res.headers['content-length'], String(bytes.length), 'content-length из stat');
        assert.ok(String(res.headers['content-type'] ?? '').includes('text/plain'));
        assert.ok(
          String(res.headers['content-disposition'] ?? '').includes(
            `attachment; filename="${name}"`,
          ),
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
