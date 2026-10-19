/**
 * REST-паритет при включённом reader-пуле (задача 514dc30f, ошибка 49e05ea0).
 *
 * Маршруты `POST /thoughts/resolve`, `GET /thoughts/:id/neighbors`,
 * `GET /thoughts/duplicates` и `GET .../comments` теперь зовут фасад
 * `heavy-read.ts`. DoD: с процессным пулом и в синхронном фолбэке маршрут
 * отдаёт идентичный ответ (формы, порядок, `meta.total`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import { closeReaderPool, configureReaderPool } from '../src/db/reader-pool.js';
import { createComment } from '../src/domain/comment-service.js';

describe(
  'REST: тяжёлые чтения через reader-пул дают тот же ответ',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let ctx: RestTestContext;
    let ids: string[] = [];

    beforeEach(async () => {
      ctx = await buildRestContext();
      const ndb = ctx.ndb;
      const now = new Date().toISOString();
      const insertThought = ndb.prepare(
        `INSERT INTO thoughts
           (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
            version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
      );
      const insertSynonym = ndb.prepare(
        'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm, layer_id) VALUES (?, ?, ?, ?)',
      );
      const insertLink = ndb.prepare(
        `INSERT INTO links
           (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
            version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, ?, 1, 0, 1, ?, ?, ?, ?, 0, 0)`,
      );
      ids = Array.from({ length: 105 }, () => randomUUID());
      ndb.transaction(() => {
        for (const [i, id] of ids.entries()) {
          const title = `REST-мысль ${i}`;
          insertThought.run(id, BASE_LAYER_ID, title, title.toLowerCase(), now, ctx.adminId, now, ctx.adminId);
          insertSynonym.run(id, `rest-терм-${i}`, `rest-терм-${i}`, BASE_LAYER_ID);
        }
        let seq = 0;
        for (let i = 1; i < 20; i += 1) {
          insertLink.run(randomUUID(), BASE_LAYER_ID, ids[0]!, ids[i]!, seq++, now, now, ctx.adminId, ctx.adminId);
        }
      });
      createComment(
        ndb,
        'thought',
        ids[0]!,
        { kind: 'permanent', title: null, body_md: 'REST постоянный' },
        ctx.adminId,
      );
      configureReaderPool({ size: 2, taskTimeoutMs: 60_000 });
    });

    afterEach(async () => {
      await closeReaderPool();
      await closeRestContext(ctx);
    });

    /** Целевые маршруты одним пакетом. */
    async function runReads(): Promise<unknown[]> {
      const url = (suffix: string): string =>
        `/api/v1/networks/${ctx.networkId}${suffix}`;
      const request = async (
        method: 'GET' | 'POST',
        target: string,
        payload?: Record<string, unknown>,
      ) => {
        const res = await ctx.app.inject({
          method,
          url: url(target),
          headers: authHeaders(ctx),
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(res.statusCode, 200, `${method} ${target}: ${res.body}`);
        return res.json();
      };

      return [
        await request('POST', '/thoughts/resolve', { ids: ids.slice(0, 100) }),
        await request('GET', `/thoughts/${ids[0]}/neighbors?dir=children&limit=10&offset=0`),
        await request('GET', `/thoughts/duplicates?title=${encodeURIComponent('REST-мысль 7')}`),
        await request('GET', `/thoughts/${ids[0]}/comments`),
      ];
    }

    it('пул и синхронный фолбэк отдают идентичный JSON', async () => {
      const pooled = await runReads();
      await closeReaderPool();
      const sync = await runReads();

      for (const [index, viaPool] of pooled.entries()) {
        assert.deepEqual(
          viaPool,
          sync[index],
          `ответ маршрута №${index} разошёлся между пулом и синхронным путём`,
        );
      }
      // Паритет не пустоты: resolve вернул 100 ссылок, соседи/комментарии есть.
      const resolve = pooled[0] as { data: Array<unknown>; meta: { total: number } };
      assert.equal(resolve.data.length, 100);
      const neighbors = pooled[1] as { data: Array<{ id: string }>; meta: { total: number } };
      assert.ok(neighbors.meta.total > 0);
      assert.ok(neighbors.data.length > 0);
      const comments = pooled[3] as { data: Array<{ body_md: string }> };
      assert.equal(comments.data[0]?.body_md, 'REST постоянный');
    });

    it('resolve: 100 id — ок, 101 — VALIDATION_ERROR, пустой массив — ок', async () => {
      const post = (payloadIds: string[]) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/resolve`,
          headers: authHeaders(ctx),
          payload: { ids: payloadIds },
        });

      const ok100 = await post(ids.slice(0, 100));
      assert.equal(ok100.statusCode, 200, ok100.body);
      assert.equal((ok100.json().data as unknown[]).length, 100);

      // Паритет с MCP: `etn.thoughts.resolve` на 101 отвечает VALIDATION_ERROR.
      const bad101 = await post(ids.slice(0, 101));
      assert.equal(bad101.statusCode, 422, bad101.body);
      const error = bad101.json().error as { code: string; details?: { field?: string } };
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details?.field, 'ids');

      // Пустой массив по-прежнему допустим (ids может быть пустым).
      const empty = await post([]);
      assert.equal(empty.statusCode, 200, empty.body);
      assert.deepEqual(empty.json().data, []);
    });
  },
);
