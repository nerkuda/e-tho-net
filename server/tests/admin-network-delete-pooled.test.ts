/**
 * DELETE /admin/networks/:id после записи через write-pool (ошибка abcd3f0b).
 *
 * Sticky-привязка воркера держала `data.db`, и `rmSync` падал с EBUSY: сеть
 * оставалась в реестре, а клиенты получали фантомный `network.deleted` ещё до
 * удаления. Проверяем: явное закрытие сети в пуле до удаления файлов, 204,
 * отсутствие фантомного события и освобождение воркера.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  closeWritePool,
  configureWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import { networkDir } from '../src/paths.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
} from './rest-helpers.js';

describe(
  'DELETE /admin/networks/:id после записи через write-pool (abcd3f0b)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    afterEach(async () => {
      await closeWritePool();
    });

    it('204: воркер отпущен до rmSync, событие — только после удаления', async () => {
      const ctx = await buildRestContext();
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });

        // Запись через REST создаёт sticky-привязку воркера к data.db сети.
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Через пул' },
        });
        assert.equal(created.statusCode, 201, created.body);
        const pool = getWritePool();
        assert.ok(pool !== null);
        assert.ok(
          pool.stats().pinnedNetworks.includes(ctx.networkId),
          'воркер сети должен быть закреплён до удаления',
        );

        const seen: Array<{ registryExists: boolean; dirExists: boolean; seq: number }> = [];
        const unsubscribe = ctx.app.pubsub.subscribe(ctx.networkId, (event) => {
          if (event.type !== 'network.deleted') return;
          seen.push({
            registryExists: ctx.sys.getNetworkById(ctx.networkId) !== null,
            dirExists: existsSync(networkDir(ctx.dataDir, ctx.networkId)),
            seq: event.seq,
          });
        });

        const deleted = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/networks/${ctx.networkId}`,
          headers: authHeaders(ctx),
        });
        unsubscribe();

        // Главное: удаление не падает EBUSY, хотя запись шла через пул.
        assert.equal(deleted.statusCode, 204, deleted.body);
        assert.equal(ctx.sys.getNetworkById(ctx.networkId), null, 'реестр очищен');
        assert.equal(
          existsSync(networkDir(ctx.dataDir, ctx.networkId)),
          false,
          'каталог сети удалён',
        );

        // Событие ровно одно и отправлено ПОСЛЕ фактического удаления.
        assert.equal(seen.length, 1, 'network.deleted отправлен один раз');
        assert.equal(seen[0]?.registryExists, false, 'в момент события сети уже нет в реестре');
        assert.equal(seen[0]?.dirExists, false, 'в момент события каталог уже удалён');
        assert.ok((seen[0]?.seq ?? 0) >= 1, 'seq терминального события назначен');

        // Событие сохранилось в event_log (сеть уже удалена — seq из журнала).
        const log = ctx.sys.readEventsAfter(ctx.networkId, 0, 10);
        assert.ok(
          log.some((e) => e.type === 'network.deleted'),
          'network.deleted записан в event_log',
        );

        // Воркер сети освобождён, сервер жив.
        assert.equal(
          getWritePool()?.stats().pinnedNetworks.includes(ctx.networkId),
          false,
          'привязка воркера снята',
        );
        const alive = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/networks',
          headers: authHeaders(ctx),
        });
        assert.equal(alive.statusCode, 200);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
