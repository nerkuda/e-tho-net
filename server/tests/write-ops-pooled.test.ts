/**
 * Перенос путей записи сети в write-пул (задача c8920d04, ADR ca3a9218,
 * тех.проект 0df7ccd6). Проверяется НАБЛЮДАЕМОЕ поведение фасада
 * (`domain/heavy-write.ts`) на настоящих worker_threads и файловых БД:
 *
 *   * событие публикуется ПОСЛЕ коммита — в момент фан-аута запись уже видна
 *     соединению главного потока;
 *   * порядок событий НА СЕТЬ сохранён — батчи одной сети фан-аутят в порядке
 *     коммитов (sticky-очередь пула держит FIFO);
 *   * журнал активности (`activity_log`) пишет ВОРКЕР: строки на месте после
 *     ответа, с актором и слоем фасада;
 *   * несколько сетей пишутся параллельно, результат совпадает с синхронным;
 *   * graceful shutdown (drain + close) не теряет незакрытые батчи;
 *   * батч с кросс-сетевым адресом значения свойства не уходит в воркер
 *     (`poolable` по форме адреса).
 *
 * Пул создаётся процессный (`configureWritePool`) — как в живом сервере:
 * фасад ходит только через него.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';

import DatabaseConstructor from 'better-sqlite3';

import type { McpThoughtWriteParams, RealtimeEventMap, RealtimeEventType } from '@etn/shared';
import { MCP_MAX_THOUGHTS_PER_WRITE } from '@etn/shared';

import {
  closeAll,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import {
  closeWritePool,
  configureWritePool,
  drainWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import { runThoughtsWrite, type ThoughtsWriteOptions } from '../src/domain/heavy-write.js';
import { writeThoughts } from '../src/domain/thought-write-service.js';
import {
  thoughtsBatchNeedsMainThread,
} from '../src/domain/write-ops.js';
import type { WriteEmit, WriteFx } from '../src/domain/write-wrapper.js';

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

const ACTOR = 'pooled-write-user';
/** Лимит батча из контракта: массовый сценарий идёт полными батчами. */
const BATCH = MCP_MAX_THOUGHTS_PER_WRITE;

/** Одно перехваченное событие фасада: пара (тип, данные) без транспорта. */
interface CapturedEvent {
  type: RealtimeEventType;
  data: unknown;
}

/**
 * Фасад записи для теста: события копятся в списке, `onEmit` даёт проверку
 * МОМЕНТА публикации (что запись уже видна главному соединению).
 */
function captureFx(
  networkId: string,
  layerId: string | null,
  sink: CapturedEvent[],
  onEmit?: (event: CapturedEvent) => void,
): WriteFx {
  const emit: WriteEmit = (type, data) => {
    const event: CapturedEvent = { type, data: data as RealtimeEventMap[RealtimeEventType] };
    sink.push(event);
    onEmit?.(event);
  };
  return { networkId, userId: ACTOR, layerId, emit };
}

/** Батч из `n` мыслей сети с общим префиксом заголовков. */
function batch(networkId: string, prefix: string, n: number): McpThoughtWriteParams {
  return {
    network_id: networkId,
    thoughts: Array.from({ length: n }, (_, i) => ({ ref: `r${i}`, thought: { title: `${prefix}-${i}` } })),
  };
}

/** Заголовки батча — в порядке элементов. */
function batchTitles(input: McpThoughtWriteParams): string[] {
  return input.thoughts.map((t) => t.thought!.title);
}

/** Заголовки мыслей сети в порядке появления (rowid). */
function titlesInOrder(ndb: NetworkDb): string[] {
  const rows = ndb.prepare('SELECT title FROM thoughts ORDER BY rowid').all() as Array<{
    title: string;
  }>;
  return rows.map((r) => r.title);
}

/** Строки журнала активности сети: актор + слой + заголовок сущности. */
function activityRows(ndb: NetworkDb): Array<{ user_id: string; layer_id: string | null; entity_title: string }> {
  return ndb
    .prepare('SELECT user_id, layer_id, entity_title FROM activity_log ORDER BY occurred_at_ms, id')
    .all() as Array<{ user_id: string; layer_id: string | null; entity_title: string }>;
}

/** Заголовок, попавший в событие (для `thought.created`). */
function eventTitle(event: CapturedEvent): string | null {
  const data = event.data as { thought?: { title?: string } };
  return data.thought?.title ?? null;
}

describe(
  'фасад write-пула: батч-запись мыслей (c8920d04)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;
    let ndb: NetworkDb;

    beforeEach(() => {
      closeAll();
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-writeops-'));
      ndb = openNetworkDb(tmpDataDir, randomUUID());
    });

    afterEach(async () => {
      await closeWritePool();
      closeAll();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    /** Вторая сеть в том же каталоге данных. */
    function secondNetwork(): NetworkDb {
      return openNetworkDb(tmpDataDir, randomUUID());
    }

    it('событие уходит после коммита: в момент фан-аута запись уже видна', async () => {
      configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      const netId = ndb.networkId;
      const events: CapturedEvent[] = [];
      const invisible: string[] = [];
      const fx = captureFx(netId, ndb.layerId, events, (event) => {
        // Проверка «не раньше коммита»: читаем ТЕМ ЖЕ соединением главного
        // потока, которое писало бы без пула. Если бы событие публиковалось до
        // коммита (или транзакцию держал главный поток), строки бы не было.
        const title = eventTitle(event);
        if (title === null) return;
        const row = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE title = ?').get(title) as {
          c: number;
        };
        if (row.c === 0) invisible.push(title);
      });

      const result = await runThoughtsWrite(ndb, fx, batch(ndb.networkId, 'после-коммита', 3));
      assert.equal(result.items.length, 3);
      assert.deepEqual(invisible, [], 'все события опубликованы по уже закоммиченным строкам');
      assert.equal(events.filter((e) => e.type === 'thought.created').length, 3);
      assert.deepEqual(
        events.filter((e) => e.type === 'thought.created').map(eventTitle),
        ['после-коммита-0', 'после-коммита-1', 'после-коммита-2'],
        'порядок событий — порядок записи',
      );
      // Журнал писался воркером: строки на месте, актор и слой — из фасада.
      const rows = activityRows(ndb);
      assert.equal(rows.length, 3, 'журнал активности заполнен');
      assert.ok(rows.every((r) => r.user_id === ACTOR), 'актор журнала — актор записи');
      assert.ok(rows.every((r) => r.layer_id === ndb.layerId), 'слой журнала — слой сессии');
      assert.ok(getWritePool()!.stats().completed >= 1, 'задача исполнена пулом');
    });

    it('порядок событий одной сети сохранён на нескольких батчах', async () => {
      configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      const events: CapturedEvent[] = [];
      const fx = captureFx(ndb.networkId, ndb.layerId, events);

      // Батчи одной сети запускаются ПАРАЛЛЕЛЬНО: sticky-очередь обязана
      // сохранить порядок коммитов (в порядке вызова), а значит и фан-аута.
      const runs = [1, 2, 3, 4].map((n) =>
        runThoughtsWrite(ndb, fx, {
          network_id: ndb.networkId,
          thoughts: [{ ref: 'r', thought: { title: `очередь-${n}` } }],
        }),
      );
      await Promise.all(runs);

      assert.deepEqual(
        events.filter((e) => e.type === 'thought.created').map(eventTitle),
        ['очередь-1', 'очередь-2', 'очередь-3', 'очередь-4'],
        'события сети идут в порядке коммитов',
      );
      assert.deepEqual(titlesInOrder(ndb), ['очередь-1', 'очередь-2', 'очередь-3', 'очередь-4']);
    });

    it('нагрузка: массовые батчи на трёх сетях параллельно, события не перемешиваются', async () => {
      const pool = configureWritePool({ size: 3, taskTimeoutMs: 120_000 });
      assert.ok(pool !== null);
      const nets = [ndb, secondNetwork(), secondNetwork()];
      const sinks: CapturedEvent[][] = nets.map(() => []);
      const fxs = nets.map((n, i) => captureFx(n.networkId, n.layerId, sinks[i]!));

      // Полные батчи (лимит контракта) в два круга на каждую сеть, все девять
      // задач запускаются сразу: пул должен развести их по сетям и сохранить
      // порядок внутри сети.
      const runs: Array<Promise<unknown>> = [];
      for (let round = 1; round <= 2; round += 1) {
        nets.forEach((n, i) => {
          runs.push(
            runThoughtsWrite(n, fxs[i]!, batch(n.networkId, `нагрузка-${i}-${round}`, BATCH)),
          );
        });
      }
      await Promise.all(runs);

      nets.forEach((n, i) => {
        const expected = [
          ...batchTitles(batch(n.networkId, `нагрузка-${i}-1`, BATCH)),
          ...batchTitles(batch(n.networkId, `нагрузка-${i}-2`, BATCH)),
        ];
        assert.equal(titlesInOrder(n).length, 2 * BATCH, `сеть ${i}: все мысли записаны`);
        assert.equal(activityRows(n).length, 2 * BATCH, `сеть ${i}: журнал заполнен воркером`);
        assert.deepEqual(
          sinks[i]!.filter((e) => e.type === 'thought.created').map(eventTitle),
          expected,
          `сеть ${i}: события идут в порядке коммитов`,
        );
      });
      assert.ok(pool.stats().spawns >= 3, 'каждая сеть получила воркер');
      assert.equal(pool.stats().completed, 2 * nets.length, 'все задачи исполнены пулом');
    });

    it('graceful shutdown не теряет незакрытые батчи', async () => {
      configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      const fx = captureFx(ndb.networkId, ndb.layerId, []);
      const runs = [1, 2, 3, 4].map((n) =>
        runThoughtsWrite(ndb, fx, batch(ndb.networkId, `shutdown-${n}`, 4)),
      );

      // Мягкая остановка: очередь обязана слиться, ни один батч не потерян.
      const drained = await drainWritePool(30_000);
      assert.equal(drained.drained, true, 'очереди слились');
      const settled = await Promise.allSettled(runs);
      assert.deepEqual(
        settled.map((s) => s.status),
        ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
        'ни одна подтверждённая задача не потеряна остановкой',
      );
      for (const s of settled) {
        if (s.status === 'fulfilled') assert.equal(s.value.items.length, 4, 'батч применён целиком');
      }
      assert.equal(titlesInOrder(ndb).length, 16, 'все мысли на месте');

      await closeWritePool();
      assert.equal(getWritePool(), null, 'пул закрыт');
    });

    it('батч с кросс-сетевым адресом значения свойства не уходит в воркер', async () => {
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      assert.ok(pool !== null);
      const address = `n:${randomUUID()}#${randomUUID()}`;
      const input: McpThoughtWriteParams = {
        network_id: ndb.networkId,
        thoughts: [
          { ref: 'r', thought: { title: 'с-адресом' }, properties: { другое: address } },
        ],
      };
      assert.equal(thoughtsBatchNeedsMainThread(input), true, 'адрес распознан по форме');

      const plain = batch(ndb.networkId, 'без-адреса', 1);
      assert.equal(thoughtsBatchNeedsMainThread(plain), false);

      // Без кросс-сетевого контекста живой резолв адреса невозможен — запись
      // обязана отвергнуться ДО похода в пул, а воркер не должен подниматься.
      const fx = captureFx(ndb.networkId, ndb.layerId, []);
      await assert.rejects(runThoughtsWrite(ndb, fx, input, { poolable: false }));
      assert.equal(pool.stats().spawns, 0, 'воркер под эту задачу не поднимался');

      // Тот же путь синхронно работает: результат не зависит от места исполнения.
      const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-writeops-sync-'));
      try {
        const syncNet = openNetworkDb(syncDir, randomUUID());
        const inline = batch(ndb.networkId, 'синхронно', 2);
        const viaSync = writeThoughts(syncNet, inline, ACTOR);
        const syncFx = captureFx(ndb.networkId, ndb.layerId, []);
        const viaPool = await runThoughtsWrite(ndb, syncFx, inline);
        assert.equal(viaPool.items.length, viaSync.items.length);
        assert.deepEqual(
          titlesInOrder(ndb),
          titlesInOrder(syncNet),
          'состав мыслей совпадает с синхронным путём',
        );
      } finally {
        closeAll();
        fs.rmSync(syncDir, { recursive: true, force: true });
      }
    });
  },
);

/** Тип опций фасада — чтобы тест ловил изменение контракта (не только рантайм). */
export type { ThoughtsWriteOptions };
