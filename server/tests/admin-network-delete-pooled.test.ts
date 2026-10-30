/**
 * DELETE /admin/networks/:id после записи через write-pool и чтения через
 * reader-pool (ошибка abcd3f0b).
 *
 * Sticky-привязка write-воркера и кэшированное read-only соединение
 * reader-воркера держали `data.db`, и `rmSync` падал с EBUSY: сеть оставалась в
 * реестре, а клиенты получали фантомный `network.deleted` ещё до удаления.
 * Проверяем: явное закрытие сети в обоих пулах до удаления файлов, 204,
 * отсутствие фантомного события и освобождение воркеров.
 *
 * Второй сценарий — регресс задачи 0178253c: `db.ping` (проверка БД в
 * `GET /api/v1/health`, установщик опрашивает её каждые 2 с) — задача БЕЗ сети.
 * Пул обязан сохранить привязку слота к сети, к чьему `data.db` воркер держит
 * соединение, иначе удаление сети снова падает EBUSY.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { FILTER_AST_VERSION } from '@etn/shared';

import {
  closeWritePool,
  configureWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import {
  closeReaderPool,
  configureReaderPool,
  getReaderPool,
} from '../src/db/reader-pool.js';
import { probeDbThroughReaderPool } from '../src/db/db-health.js';
import { networkDir, systemDbPath } from '../src/paths.js';
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
      await closeReaderPool();
      await closeWritePool();
    });

    it('204: воркеры отпущены до rmSync, событие — только после удаления', async () => {
      const ctx = await buildRestContext();
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        configureReaderPool({ size: 1, taskTimeoutMs: 60_000 });

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

        // Тяжёлое чтение уходит в reader-pool и кэширует там read-only
        // соединение с тем же data.db — второй держатель файла (блокер
        // верификатора: закрытия только write-пула недостаточно).
        const queried = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
          headers: authHeaders(ctx),
          payload: {
            ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } },
          },
        });
        assert.equal(queried.statusCode, 200, queried.body);
        const readerPool = getReaderPool();
        assert.ok(readerPool !== null);
        assert.ok(
          readerPool.stats().networks.includes(ctx.networkId),
          'reader-воркер должен держать соединение сети до удаления',
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

        // Воркеры обоих пулов освобождены, сервер жив.
        assert.equal(
          getWritePool()?.stats().pinnedNetworks.includes(ctx.networkId),
          false,
          'привязка write-воркера снята',
        );
        assert.equal(
          getReaderPool()?.stats().networks.includes(ctx.networkId),
          false,
          'reader-воркер сети терминирован',
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

    it('db.ping (/health) не сбрасывает привязку reader-слота: DELETE 204 (0178253c)', async () => {
      // Проверку БД для /health ведём реальным `db.ping` через процессный
      // reader-пул — так же, как обработчик `/health`. Путь файла известен
      // только после создания контекста, поэтому проба читает переменную в
      // момент вызова.
      let pingDbPath = '';
      const ctx = await buildRestContext({
        // Обёртка как в `createDbHealthCheck`: успешное чтение → `ok`, отказ →
        // `error` (сам `probeDbThroughReaderPool` — проба без статуса).
        dbHealth: () =>
          probeDbThroughReaderPool(pingDbPath).then(
            () => 'ok' as const,
            () => 'error' as const,
          ),
      });
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        // Размер 1: ping обязан попасть на ТОТ ЖЕ слот, что держит соединение
        // сети, — только тогда дефект воспроизводится.
        configureReaderPool({ size: 1, taskTimeoutMs: 60_000 });
        // Проверяемый файл БД: `db.ping` читает `PRAGMA schema_version` на
        // read-only соединении, поэтому достаточно пустой SQLite-базы.
        pingDbPath = systemDbPath(ctx.dataDir);
        const pingFile = new DatabaseConstructor(pingDbPath);
        pingFile.close();

        const queried = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
          headers: authHeaders(ctx),
          payload: {
            ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } },
          },
        });
        assert.equal(queried.statusCode, 200, queried.body);
        const pool = getReaderPool();
        assert.ok(pool !== null);
        assert.ok(
          pool.stats().networks.includes(ctx.networkId),
          'reader-воркер держит соединение сети до ping',
        );

        // Публичный триггер: установщик опрашивает /health каждые 2 с.
        const health = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(health.statusCode, 200, health.body);
        assert.equal(
          (health.json() as { db?: string }).db,
          'ok',
          'db.ping по-прежнему работает после правки',
        );

        // Главное: задача без сети не стирает привязку слота — иначе воркер с
        // открытым `data.db` невидим для `closeNetwork` и `rmSync` даёт EBUSY.
        assert.ok(
          pool.stats().networks.includes(ctx.networkId),
          'db.ping не сбрасывает привязку reader-слота к сети',
        );

        const deleted = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/networks/${ctx.networkId}`,
          headers: authHeaders(ctx),
        });

        assert.equal(deleted.statusCode, 204, deleted.body);
        assert.equal(ctx.sys.getNetworkById(ctx.networkId), null, 'реестр очищен');
        assert.equal(
          existsSync(networkDir(ctx.dataDir, ctx.networkId)),
          false,
          'каталог сети удалён',
        );
        assert.deepEqual(pool.stats().networks, [], 'привязки к сети не осталось');
        assert.equal(pool.stats().workers, 0, 'reader-воркер терминирован');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
