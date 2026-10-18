/**
 * Тесты кэша результата исполнения отбора (задача 3f2b0958, ошибка 49e05ea0).
 *
 * Покрывают DoD:
 *   * попадание: повторный запуск того же отбора не исполняет SQL — возвращается
 *     тот же объект результата, `misses` не растёт, `hits` растёт;
 *   * инвалидация: любая семантическая запись в сеть (в том числе через
 *     обёртку `runWrite`) двигает поколение; событие-only запись
 *     `thought-type-view.run` кэш НЕ инвалидирует;
 *   * изоляция контекстов: сеть, слой, пользователь, фокусная мысль и
 *     параметры запуска дают разные ключи;
 *   * ошибки не кэшируются;
 *   * LRU-вытеснение и ограничение памяти.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как у остальных
 * unit-тестов серверного домена.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, type EtnError } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { closeAll, createInMemoryNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { closeWritePool, configureWritePool } from '../src/db/write-pool.js';
import { createLayer } from '../src/domain/layer-service.js';
import { createThought, updateThought } from '../src/domain/thought-service.js';
import {
  executeViewDefinitionForThought,
  type RunViewQueryOptions,
  type RunViewResult,
} from '../src/domain/thought-type-views-service.js';
import { runThoughtCreate } from '../src/domain/heavy-write.js';
import {
  getViewResultCacheStats,
  resetViewResultCache,
  setViewResultCacheLimits,
} from '../src/domain/view-result-cache.js';
import type { WriteFx } from '../src/domain/write-wrapper.js';
import { runWrite } from '../src/domain/write-wrapper.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'user-1';
const OTHER_USER = 'user-2';
/** Фиксированные часы — ключ кэша не зависит от момента прогона. */
const TOKEN_CONTEXT = {
  nowMs: Date.UTC(2026, 0, 15, 12, 0, 0),
  firstDayOfWeek: 1,
  withTime: false,
} as const;

interface Fixture {
  ndb: NetworkDb;
  focusId: string;
  alphaId: string;
  betaId: string;
}

function makeFixture(networkId = 'net-1'): Fixture {
  const ndb = createInMemoryNetworkDb(BASE_LAYER_ID, networkId);
  const focus = createThought(ndb, { title: 'item-focus' }, USER);
  const alpha = createThought(ndb, { title: 'item-alpha' }, USER);
  const beta = createThought(ndb, { title: 'item-beta' }, USER);
  return { ndb, focusId: focus.id, alphaId: alpha.id, betaId: beta.id };
}

/** Исполнить отбор так, как это делают REST/MCP-фасады (общий потолок 200). */
async function runView(
  ndb: NetworkDb,
  thoughtId: string,
  definition: Record<string, unknown>,
  options: RunViewQueryOptions = {},
): Promise<RunViewResult> {
  return executeViewDefinitionForThought(ndb, {
    definition,
    thoughtId,
    userId: USER,
    options: {
      maxLimit: 200,
      tokenContext: TOKEN_CONTEXT,
      ...options,
    },
  });
}

/** Транспорт обёртки записи для теста: события не публикуются. */
function writeFx(ndb: NetworkDb): WriteFx {
  return {
    networkId: ndb.networkId,
    userId: USER,
    layerId: ndb.layerId,
    emit: () => undefined,
  };
}

describe(
  'view-result-cache (задача 3f2b0958)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    beforeEach(() => {
      resetViewResultCache();
    });

    it('повторный запуск — попадание: тот же объект, SQL повторно не исполняется', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        const first = await runView(ndb, focusId, definition);
        assert.deepEqual(
          first.items.map((i) => i.title).sort(),
          ['item-alpha', 'item-beta'],
          'первый прогон исполняет отбор',
        );

        const second = await runView(ndb, focusId, definition);
        // Тот же объект — промах всегда собирает новый. Это и есть
        // доказательство, что тяжёлый путь (reader-пул + COUNT) не исполнялся.
        assert.equal(second, first);
        assert.deepEqual(second, first);

        const stats = getViewResultCacheStats();
        assert.equal(stats.misses, 1);
        assert.equal(stats.hits, 1);
        assert.equal(stats.stores, 1);
      } finally {
        ndb.close();
      }
    });

    it('REST- и MCP-формы входа с одинаковым нормализованным ключом делят запись', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        // REST ad-hoc: maxLimit 200, profile по умолчанию.
        const rest = await runView(ndb, focusId, { keywords: 'item' });
        // MCP ad-hoc: profile задан явно, maxLimit тот же.
        const mcp = await runView(ndb, focusId, { keywords: 'item' }, {
          profile: 'thoughts',
        });
        assert.equal(mcp, rest, 'нормализованный ключ обязан совпасть');
        assert.equal(getViewResultCacheStats().hits, 1);
      } finally {
        ndb.close();
      }
    });

    it('любая семантическая запись через runWrite инвалидирует результат', async () => {
      const { ndb, focusId, betaId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        const before = await runView(ndb, focusId, definition);
        assert.equal(before.items.length, 2);

        // Обёртка записи — единственный путь мутации домена. Переименование
        // выводит item-beta из выборки.
        runWrite(ndb, writeFx(ndb), () => {
          const updated = updateThought(ndb, betaId, { title: 'other-beta' }, undefined, USER);
          return { result: updated, events: [] };
        });

        const after = await runView(ndb, focusId, definition);
        assert.notEqual(after, before, 'после записи обязан быть промах');
        assert.deepEqual(
          after.items.map((i) => i.title),
          ['item-alpha'],
          'результат отражает запись',
        );
        const stats = getViewResultCacheStats();
        assert.equal(stats.stores, 2);
        assert.equal(stats.stale, 1, 'старая запись отброшена по поколению');
      } finally {
        ndb.close();
      }
    });

    it('событие thought-type-view.run (запись без изменения данных) не инвалидирует', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        const first = await runView(ndb, focusId, definition);
        // Как в маршруте сохранённого отбора: runWrite только ради события.
        runWrite(ndb, writeFx(ndb), () => ({
          result: undefined,
          events: [
            {
              type: 'thought-type-view.run',
              data: {
                thought_id: focusId,
                view_id: 'view-1',
                view_name: 'Все',
                result_count: first.total,
                unresolved: [],
              },
            },
          ],
        }));
        const second = await runView(ndb, focusId, definition);
        assert.equal(second, first, 'run-событие не меняет данные — попадание');
        assert.equal(getViewResultCacheStats().hits, 1);
      } finally {
        ndb.close();
      }
    });

    it('ошибки валидации и NOT_FOUND не кэшируются', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        // Неизвестный токен — VALIDATION_ERROR до обращения к кэшу.
        for (let i = 0; i < 2; i += 1) {
          await assert.rejects(
            runView(ndb, focusId, { keywords: '$bogus' }),
            (err: EtnError) => err.code === 'VALIDATION_ERROR',
          );
        }
        // Несуществующая фокусная мысль — NOT_FOUND до обращения к кэшу.
        for (let i = 0; i < 2; i += 1) {
          await assert.rejects(
            runView(ndb, '00000000-0000-4000-8000-000000000000', { keywords: 'item' }),
            (err: EtnError) => err.code === 'NOT_FOUND',
          );
        }
        const stats = getViewResultCacheStats();
        assert.equal(stats.stores, 0, 'ошибки не попадают в кэш');
        assert.equal(stats.hits, 0);
      } finally {
        ndb.close();
      }
    });

    it('изоляция пользователя, фокуса и параметров запуска', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        // Второй фокус создаём ДО первого запуска: прямой доменный вызов в
        // тесте обходит обёртку записи (в проде запись идёт только через неё).
        const secondFocus = createThought(ndb, { title: 'item-second-focus' }, USER);

        await runView(ndb, focusId, definition);
        // Другой пользователь.
        await executeViewDefinitionForThought(ndb, {
          definition,
          thoughtId: focusId,
          userId: OTHER_USER,
          options: { maxLimit: 200, tokenContext: TOKEN_CONTEXT },
        });
        // Другая фокусная мысль.
        await runView(ndb, secondFocus.id, definition);
        // Другие параметры запуска.
        await runView(ndb, focusId, definition, { limit: 1 });
        await runView(ndb, focusId, definition, { offset: 1 });
        await runView(ndb, focusId, definition, { order: 'desc' });

        const stats = getViewResultCacheStats();
        assert.equal(stats.hits, 0, 'ни один контекст не должен делить запись');
        assert.equal(stats.misses, 6);
        assert.equal(stats.stores, 6);
      } finally {
        ndb.close();
      }
    });

    it('изоляция слоя', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        const base = await runView(ndb, focusId, definition);

        const layer = createLayer(ndb, {
          title: 'layer-1',
          parentId: BASE_LAYER_ID,
          createdBy: USER,
        });
        ndb.useLayer(layer.id);
        const inLayer = await runView(ndb, focusId, definition);
        assert.notEqual(inLayer, base, 'результат слоя не должен браться из основы');

        // Возврат в основу — запись основы всё ещё валидна.
        ndb.useLayer(BASE_LAYER_ID);
        const baseAgain = await runView(ndb, focusId, definition);
        assert.equal(baseAgain, base, 'ключ основы не тронут чтением слоя');

        const stats = getViewResultCacheStats();
        assert.equal(stats.hits, 1);
        assert.equal(stats.misses, 2);
      } finally {
        ndb.close();
      }
    });

    it('изоляция сетей', async () => {
      const first = makeFixture('net-1');
      const second = makeFixture('net-2');
      try {
        const definition = { keywords: 'item' };
        const a = await runView(first.ndb, first.focusId, definition);
        const b = await runView(second.ndb, second.focusId, definition);
        assert.notEqual(a, b, 'ключ обязан различать сети');
        const stats = getViewResultCacheStats();
        assert.equal(stats.hits, 0);
        assert.equal(stats.misses, 2);
      } finally {
        first.ndb.close();
        second.ndb.close();
      }
    });

    it('отбор со временем не кэшируется', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const timeOptions = {
          maxLimit: 200,
          tokenContext: { ...TOKEN_CONTEXT, withTime: true },
        };
        await executeViewDefinitionForThought(ndb, {
          definition: { keywords: 'item' },
          thoughtId: focusId,
          userId: USER,
          options: timeOptions,
        });
        await executeViewDefinitionForThought(ndb, {
          definition: { keywords: 'item' },
          thoughtId: focusId,
          userId: USER,
          options: timeOptions,
        });
        const stats = getViewResultCacheStats();
        assert.equal(stats.stores, 0, 'время нельзя замораживать в кэше');
        assert.equal(stats.size, 0);
      } finally {
        ndb.close();
      }
    });

    it('LRU-вытеснение по числу записей', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        setViewResultCacheLimits({ maxEntries: 2, maxBytes: Number.MAX_SAFE_INTEGER });
        const keys = ['aaa-target', 'bbb-target', 'ccc-target'];
        for (const keyword of keys) {
          await runView(ndb, focusId, { keywords: keyword });
        }
        let stats = getViewResultCacheStats();
        assert.equal(stats.size, 2, 'в кэше ровно две записи');
        assert.equal(stats.evictions, 1, 'самая старая вытеснена');

        // Первый ключ вытеснен — повторный запуск обязан быть промахом.
        await runView(ndb, focusId, { keywords: keys[0] });
        stats = getViewResultCacheStats();
        assert.equal(stats.misses, 4);
        assert.equal(stats.hits, 0);
      } finally {
        ndb.close();
      }
    });

    it('LRU-вытеснение по оценке памяти', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        setViewResultCacheLimits({ maxEntries: 100, maxBytes: 1 });
        await runView(ndb, focusId, { keywords: 'item' });
        const stats = getViewResultCacheStats();
        // Запись больше лимита — сразу вытеснена, кэш пуст.
        assert.equal(stats.size, 0);
        assert.equal(stats.evictions, 1);
      } finally {
        ndb.close();
      }
    });

    it('расхождение input.userId и tokenContext.userId — fail-closed (кэш не используется)', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        // `$user` движка резолвится из tokenContext.userId, а ключ иначе брал бы
        // input.userId. Транспорты держат их равными, но инварианта нет:
        // расхождение обязано отключать кэш, а не смешивать контексты.
        const options: RunViewQueryOptions = {
          tokenContext: { ...TOKEN_CONTEXT, userId: OTHER_USER },
        };
        await runView(ndb, focusId, definition, options);
        await runView(ndb, focusId, definition, options);

        const stats = getViewResultCacheStats();
        assert.equal(stats.stores, 0, 'при расхождении результата в кэш не кладём');
        assert.equal(stats.hits, 0, 'и не читаем из кэша');
        assert.equal(stats.size, 0);
      } finally {
        ndb.close();
      }
    });

    it('совпадение input.userId и tokenContext.userId — кэш работает', async () => {
      const { ndb, focusId } = makeFixture();
      try {
        const definition = { keywords: 'item' };
        // Пользователь передан так же, как транспорты: оба источника равны.
        const options: RunViewQueryOptions = {
          tokenContext: { ...TOKEN_CONTEXT, userId: USER },
        };
        const first = await runView(ndb, focusId, definition, options);
        const second = await runView(ndb, focusId, definition, options);

        assert.equal(second, first, 'равные контексты обязаны делить запись');
        const stats = getViewResultCacheStats();
        assert.equal(stats.hits, 1);
        assert.equal(stats.stores, 1);
      } finally {
        ndb.close();
      }
    });

    it('запись через writer-воркер инвалидирует кэш главного потока', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-view-cache-'));
      const networkId = 'net-worker';
      let ndb: NetworkDb | null = null;
      try {
        ndb = openNetworkDb(dataDir, networkId);
        const focus = createThought(ndb, { title: 'item-focus' }, USER);
        createThought(ndb, { title: 'item-alpha' }, USER);

        const definition = { keywords: 'item' };
        const before = await runView(ndb, focus.id, definition);
        assert.equal(before.items.length, 1);

        // Процессный write-пул: запись уходит в writer-воркер (настоящий файл,
        // второй connection). Главный поток обязан увидеть изменение.
        assert.ok(configureWritePool({ size: 1, taskTimeoutMs: 30_000 }) !== null);
        await runThoughtCreate(
          ndb,
          writeFx(ndb),
          { title: 'item-beta' },
          { poolable: true },
        );

        const after = await runView(ndb, focus.id, definition);
        assert.notEqual(after, before, 'запись воркера обязана инвалидировать кэш');
        assert.deepEqual(
          after.items.map((i) => i.title).sort(),
          ['item-alpha', 'item-beta'],
        );
        assert.equal(getViewResultCacheStats().stale, 1);
      } finally {
        await closeWritePool();
        closeAll();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  },
);
