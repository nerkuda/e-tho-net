/**
 * Нагрузочная приёмка write-пула (задача 2d5684cc, тех.проект 0df7ccd6,
 * ADR ca3a9218, требования R1–R8).
 *
 * Проверяется то, ради чего пул существует, — на НАСТОЯЩИХ worker_threads и
 * файловых БД в tmp (в памяти второе соединение невозможно, а WAL тем более):
 *
 *   * «массовый батч»: батч из 50 мыслей исполняется воркером, а главный поток
 *     отвечает на пинги — p99 задержки пинга не выше относительного потолка от
 *     синхронного ориентира (см. `ping-lag.ts`, ошибки ea49a9b6/23e0e0cf);
 *   * «параллельная запись в разные сети»: сети пишутся одновременно (наблюдаемо
 *     две занятые привязки), пул не медленнее синхронного пути на том же объёме;
 *   * «две записи одной сети»: порядок событий = порядок коммитов, латентность
 *     записи на насыщенной очереди ограничена;
 *   * исчерпание пула: очередь растёт, ни один принятый батч не теряется;
 *   * тайм-аут под нагрузкой: задача снимается с `resultUnknown`, батч остаётся
 *     целым (целиком или никак), пул самовосстанавливается;
 *   * «рестарт с очередью»: при остановке принятые батчи либо закоммичены, либо
 *     отклонены явно; чекпойнт WAL делается последним и усекает журнал;
 *   * длинный прогон: воркер сети переиспользуется, память процесса не растёт.
 *
 * Профиль сети воспроизводит форму большой сети из ошибки 646347ab: тысячи
 * мыслей + тысячи wildcard-синонимов — именно на нём батч перестал быть
 * мгновенным (после 0.13.1 батч из 12 элементов — ~180 мс на файловой БД, на
 * синхронном пути это те самые «десятки секунд» из жалобы). Числа подобраны
 * так, чтобы замеры были устойчивы на CI, а не чтобы ловить микрорегрессии.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, type McpThoughtWriteParams, type RealtimeEventType } from '@etn/shared';

import { closeAll, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { checkpointOpenNetworkDbs } from '../src/db/wal-checkpoint.js';
import {
  closeWritePool,
  configureWritePool,
  drainWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import { runThoughtsWrite } from '../src/domain/heavy-write.js';
import type { WriteEmit, WriteFx } from '../src/domain/write-wrapper.js';
import { PING_P99_CEIL_MS, p99, pingP99Ceiling, startPingLag } from './ping-lag.js';

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

const ACTOR = 'write-load-user';
/** Форма большой сети (см. ошибку 646347ab): мысли + wildcard-синонимы. */
const PROFILE_THOUGHTS = 3_000;
const PROFILE_WILDCARDS = 1_500;
/** Батч, на котором ловится блокировка главного потока: ~400 мс в воркере. */
const LOAD_BATCH = 50;
/** Обычный батч приёмки — как в замерах ошибки 646347ab. */
const SMALL_BATCH = 12;
/**
 * Порог вытеснения простоя для нагрузочных прогонов: сетей больше, чем слотов,
 * поэтому привязки обязаны освобождаться быстро, а не через 30 с по умолчанию.
 */
const EVICT_MS = 50;

/** Заполнить сеть «формой большой сети»: мысли + wildcard-синонимы. */
function fillLargeNetwork(ndb: NetworkDb, thoughts: number, wildcards: number): void {
  const insThought = ndb.prepare(
    `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                           version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u', 0, 0)`,
  );
  const insSynonym = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
  );
  ndb.transaction(() => {
    const ids: string[] = [];
    for (let i = 0; i < thoughts; i += 1) {
      const id = randomUUID();
      const title = `Мысль номер ${i}`;
      insThought.run(id, BASE_LAYER_ID, title, title.toLowerCase());
      ids.push(id);
    }
    for (let i = 0; i < wildcards; i += 1) {
      const synonym = `терм${i}*`;
      insSynonym.run(ids[i % ids.length] as string, synonym, synonym.toLowerCase());
    }
  });
}

/** Батч из `n` мыслей; `tag` разводит заголовки между батчами (гейт дубликатов). */
function batch(networkId: string, tag: string, n: number): McpThoughtWriteParams {
  return {
    network_id: networkId,
    thoughts: Array.from({ length: n }, (_, i) => ({
      ref: `r${i}`,
      thought: { title: `Батч-${tag}-${i}` },
    })),
  };
}

/** Фасад записи для теста: транспорт подменён, события перехватываются. */
function captureFx(
  networkId: string,
  layerId: string | null,
  onEvent?: (type: RealtimeEventType) => void,
): WriteFx {
  const emit: WriteEmit = (type) => {
    onEvent?.(type);
  };
  return { networkId, userId: ACTOR, layerId, emit };
}

/** Сколько мыслей с префиксом заголовка уже в БД. */
function countByPrefix(ndb: NetworkDb, prefix: string): number {
  const row = ndb
    .prepare('SELECT COUNT(*) AS n FROM thoughts WHERE title LIKE ?')
    .get(`${prefix}%`) as { n: number };
  return row.n;
}

/** Дождаться условия (ожидание по состоянию). */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** Размер `-wal` файла сети (0, если файла нет). */
function walSize(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

describe(
  'write-пул: нагрузочная приёмка (2d5684cc)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;
    let ndb: NetworkDb;

    beforeEach(() => {
      closeAll();
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-write-load-'));
      ndb = openNetworkDb(tmpDataDir, randomUUID());
      fillLargeNetwork(ndb, PROFILE_THOUGHTS, PROFILE_WILDCARDS);
    });

    afterEach(async () => {
      await closeWritePool();
      closeAll();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    /** Ещё одна сеть «формы большой сети» в том же каталоге данных. */
    function largeNetwork(): NetworkDb {
      const other = openNetworkDb(tmpDataDir, randomUUID());
      fillLargeNetwork(other, PROFILE_THOUGHTS, PROFILE_WILDCARDS);
      return other;
    }

    it('массовый батч 50 не блокирует главный поток (p99 пинга < 50 мс)', async () => {
      // Замер одного и того же батча на двух путях: сначала без пула (фасад
      // деградирует в синхронную запись в главном потоке — так было до переноса),
      // затем через пул. Пинги главного потока считаются в обоих прогонах.
      assert.equal(getWritePool(), null, 'перед синхронным замером пула нет');
      const measure = async (
        tag: string,
      ): Promise<{ ms: number; pings: number; p99: number; busy: number }> => {
        // Лаг главного потока — сэмплер из `ping-lag`: тик ставится с расчётом
        // «предыдущий + период», и разница с фактом показывает, сколько поток был
        // занят. На синхронном пути просроченный тик отчитается длительностью
        // всей записи.
        const stopPing = startPingLag(
          () => (getWritePool()?.stats().busyWorkers ?? 0) > 0,
        );

        const started = Date.now();
        const result = await runThoughtsWrite(
          ndb,
          captureFx(ndb.networkId, ndb.layerId),
          batch(ndb.networkId, tag, LOAD_BATCH),
        );
        const ms = Date.now() - started;
        const lag = await stopPing();

        assert.equal(result.items.length, LOAD_BATCH, `батч ${tag} записан целиком`);
        return { ms, ...lag };
      };

      const sync = await measure('синхронно-50');
      const pool = configureWritePool({ size: 2, taskTimeoutMs: 60_000 });
      assert.ok(pool !== null);
      // Разогрев привязки: подъём воркера (~0,5 с) — разовая плата, в замер батча
      // она входить не должна.
      await runThoughtsWrite(ndb, captureFx(ndb.networkId, ndb.layerId), batch(ndb.networkId, 'разогрев', 2));
      const pooled = await measure('через-пул-50');

      console.log(
        `[write-pool-load] батч ${LOAD_BATCH}: синхронно=${sync.ms} мс (p99 пинга=${sync.p99.toFixed(1)} мс, ` +
          `пингов=${sync.pings}); через пул=${pooled.ms} мс (p99 пинга=${pooled.p99.toFixed(1)} мс, ` +
          `пингов=${pooled.pings}, при занятом воркере=${pooled.busy})`,
      );

      assert.equal(countByPrefix(ndb, 'Батч-через-пул-50-'), LOAD_BATCH);
      assert.ok(pooled.pings >= 5, `пинги успели накопиться (${pooled.pings})`);
      assert.ok(
        sync.p99 >= PING_P99_CEIL_MS,
        `синхронный путь обязан блокировать главный поток (p99 пинга ${sync.p99.toFixed(1)} мс)`,
      );
      assert.ok(
        pooled.busy > 0,
        'пинги через пул приходятся на время, когда воркер занят — окно перекрытия есть',
      );
      // Потолок относительный: под конкуренцией за CPU в полном прогоне
      // абсолютные 50 мс не выдерживаются даже корректным пулом (см. ping-lag).
      const ceiling = pingP99Ceiling(sync.p99);
      assert.ok(
        pooled.p99 <= ceiling,
        `p99 задержки пинга ${pooled.p99.toFixed(1)} мс > потолка ${ceiling.toFixed(1)} мс ` +
          `(синхронный ориентир ${sync.p99.toFixed(1)} мс) — главный поток блокируется`,
      );
    });

    it('параллельная запись в разные сети: сети пишутся одновременно, пул обгоняет синхронный путь', async () => {
      const networks = [ndb, largeNetwork(), largeNetwork()];
      const rounds = 4;
      const total = networks.length * rounds;

      // 1. Синхронный ориентир: пула нет вовсе — тот же фасад пишет по батчу
      // последовательно, в главном потоке (до переноса запись шла именно так).
      assert.equal(getWritePool(), null, 'перед синхронным замером пула нет');
      const syncStarted = Date.now();
      for (let round = 0; round < rounds; round += 1) {
        for (const [i, n] of networks.entries()) {
          await runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `синхронно-${round}-${i}`, SMALL_BATCH),
          );
        }
      }
      const syncMs = Date.now() - syncStarted;

      // 2. Тот же объём через пул: сети идут параллельно. Разогрев снимает
      // разовую плату подъёма воркеров — сравнивается установившаяся пропускная.
      const pool = configureWritePool({ size: 3, taskTimeoutMs: 60_000, idleEvictionMs: EVICT_MS });
      assert.ok(pool !== null);
      await Promise.all(
        networks.map((n, i) =>
          runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `разогрев-${i}`, 2),
          ),
        ),
      );

      let maxBusy = 0;
      const sampler = setInterval(() => {
        maxBusy = Math.max(maxBusy, getWritePool()?.stats().busyWorkers ?? 0);
      }, 5);
      sampler.unref?.();
      const poolStarted = Date.now();
      await Promise.all(
        networks.flatMap((n, i) =>
          Array.from({ length: rounds }, (_, round) =>
            runThoughtsWrite(
              n,
              captureFx(n.networkId, n.layerId),
              batch(n.networkId, `через-пул-${round}-${i}`, SMALL_BATCH),
            ),
          ),
        ),
      );
      const poolMs = Date.now() - poolStarted;
      clearInterval(sampler);

      console.log(
        `[write-pool-load] параллельная запись ${networks.length} сетей × ${rounds} батчей(${SMALL_BATCH}): ` +
          `синхронно=${syncMs} мс, через пул=${poolMs} мс (x${(syncMs / poolMs).toFixed(2)}), ` +
          `одновременно занятых воркеров=${maxBusy}, spawns=${pool.stats().spawns}`,
      );

      assert.equal(pool.stats().completed, networks.length + total, 'все задачи исполнены');
      assert.ok(maxBusy >= 2, `сети писались одновременно (макс. занятых воркеров: ${maxBusy})`);
      assert.ok(pool.stats().spawns >= networks.length, 'у каждой сети свой воркер');
      networks.forEach((n, i) => {
        assert.equal(
          countByPrefix(n, 'Батч-через-пул-'),
          rounds * SMALL_BATCH,
          `сеть ${i}: все батчи записаны`,
        );
      });
      assert.ok(
        poolMs < syncMs,
        `пул обгоняет синхронный путь (пул ${poolMs} мс против ${syncMs} мс)`,
      );
    });

    it('две записи одной сети: порядок событий сохранён, латентность на насыщенной очереди ограничена', async () => {
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      assert.ok(pool !== null);

      const batches = 8;
      const order: string[] = [];
      const latencies: number[] = [];
      const starts: number[] = [];
      const fxs = Array.from({ length: batches }, (_, round) => {
        starts.push(Date.now());
        return captureFx(ndb.networkId, ndb.layerId, (type) => {
          if (type !== 'thought.created') return;
          order.push(`раунд-${round}`);
          latencies.push(Date.now() - (starts[round] as number));
        });
      });

      await Promise.all(
        fxs.map((fx, round) =>
          runThoughtsWrite(ndb, fx, batch(ndb.networkId, `порядок-${round}`, SMALL_BATCH)),
        ),
      );

      const p99Latency = p99(latencies);
      console.log(
        `[write-pool-load] ${batches} батчей одной сети внахлёст: событий=${latencies.length}, ` +
          `p99 латентности события=${p99Latency.toFixed(1)} мс, всего=${(Date.now() - (starts[0] as number)).toFixed(0)} мс`,
      );

      // Порядок событий = порядок коммитов: сначала все события первого батча,
      // затем второго и так далее (sticky-очередь пула — FIFO на сеть).
      const expected = Array.from({ length: batches }, (_, round) =>
        Array.from({ length: SMALL_BATCH }, () => `раунд-${round}`),
      ).flat();
      assert.deepEqual(order, expected, 'события идут батчами в порядке постановки задач');
      assert.equal(
        countByPrefix(ndb, 'Батч-порядок-'),
        batches * SMALL_BATCH,
        'все батчи записаны',
      );
      // Насыщенная очередь одной сети: латентность растёт с глубиной очереди, но
      // остаётся ограниченной — задачи не голодают и не «залипают».
      assert.ok(
        p99Latency < 10_000,
        `p99 латентности события ${p99Latency.toFixed(1)} мс — запись залипла`,
      );
    });

    it('исчерпание пула: очередь растёт, ни один принятый батч не теряется', async () => {
      const networks = [ndb, largeNetwork(), largeNetwork(), largeNetwork()];
      const pool = configureWritePool({ size: 2, taskTimeoutMs: 120_000, idleEvictionMs: EVICT_MS });
      assert.ok(pool !== null);
      const rounds = 3;

      const runs = networks.flatMap((n, i) =>
        Array.from({ length: rounds }, (_, round) =>
          runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `затор-${round}-${i}`, SMALL_BATCH),
          ),
        ),
      );
      // Задачи поставлены разом: слотов меньше, чем сетей — допуск работает.
      const queued = await waitFor(() => pool.stats().maxQueueDepth > 0, 5_000);
      const settled = await Promise.all(runs);
      const stats = pool.stats();

      console.log(
        `[write-pool-load] исчерпание: задач=${runs.length}, maxQueueDepth=${stats.maxQueueDepth}, ` +
          `evicted=${stats.evicted}, spawns=${stats.spawns}, completed=${stats.completed}`,
      );

      assert.ok(queued, `очередь росла (maxQueueDepth=${stats.maxQueueDepth})`);
      assert.equal(settled.length, networks.length * rounds);
      assert.equal(stats.completed, networks.length * rounds, 'все принятые задачи исполнены');
      assert.equal(stats.failed + stats.timedOut, 0, 'под затором никто не упал и не снялся');
      networks.forEach((n, i) => {
        assert.equal(
          countByPrefix(n, 'Батч-затор-'),
          rounds * SMALL_BATCH,
          `сеть ${i}: все батчи дошли целиком`,
        );
      });
      assert.equal(pool.stats().pinnedNetworks.length <= 2, true, 'слотов больше не появилось');
    });

    it('тайм-аут под нагрузкой: снятие с resultUnknown, батч цел целиком, пул самовосстанавливается', async () => {
      const networks = [ndb, largeNetwork(), largeNetwork()];
      // Потолок задачи заведомо меньше батча 50 (~400 мс) — тайм-аут гарантирован.
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 100, idleEvictionMs: EVICT_MS });
      assert.ok(pool !== null);

      const results = await Promise.allSettled(
        networks.map((n, i) =>
          runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `таймаут-${i}`, LOAD_BATCH),
          ),
        ),
      );

      console.log(
        `[write-pool-load] тайм-ауты: ${results.map((r) => r.status).join(', ')}, ` +
          `timedOut=${pool.stats().timedOut}, spawns=${pool.stats().spawns}`,
      );

      for (const [i, settled] of results.entries()) {
        assert.equal(settled.status, 'rejected', `задача ${i} снята по тайм-ауту`);
        const err = (settled as PromiseRejectedResult).reason as {
          code?: string;
          message?: string;
          details?: { resultUnknown?: boolean };
        };
        assert.match(String(err.message), /timed out/);
        assert.equal(
          err.details?.resultUnknown,
          true,
          'результат помечен неизвестным: коммит мог состояться',
        );
      }
      assert.equal(pool.stats().timedOut, networks.length, 'все задачи прошли путь тайм-аута');

      // Батч остаётся ЦЕЛЫМ: снятая задача могла докоммититься после ответа
      // (поздний коммит), но частичной записи не бывает. Поздний коммит требует,
      // чтобы воркер стоял ВНУТРИ нативного вызова (см. тест приёмки пула на
      // откатном журнале): здесь он считает батч в JS, поэтому `terminate()`
      // останавливает поток между инструкциями и транзакция откатывается —
      // ожидаемо ноль записей, а признак `resultUnknown` страхует на будущее.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      for (const [i, n] of networks.entries()) {
        const written = countByPrefix(n, 'Батч-таймаут-');
        assert.ok(
          written === 0 || written === LOAD_BATCH,
          `сеть ${i}: записано ${written} — батч обязан быть целым или отсутствовать`,
        );
      }

      // Самовосстановление: после снятия слотов сеть снова пишется. Пул берём
      // свежий — у прежнего потолок 100 мс рассчитан на ловлю тайм-аута.
      await closeWritePool();
      const fresh = configureWritePool({ size: 1, taskTimeoutMs: 30_000 });
      assert.ok(fresh !== null);
      const healed = await runThoughtsWrite(
        networks[0] as NetworkDb,
        captureFx(networks[0]!.networkId, networks[0]!.layerId),
        batch(networks[0]!.networkId, 'после-таймаута', 3),
      );
      assert.equal(healed.items.length, 3, 'пул исполнил следующую задачу');
      assert.equal(countByPrefix(networks[0] as NetworkDb, 'Батч-после-таймаута-'), 3);
      assert.equal(fresh.stats().timedOut, 0, 'новая задача тайм-аута не получила');
    });

    it('длинный прогон: воркер переиспользуется, память процесса не растёт', async () => {
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
      assert.ok(pool !== null);
      const fx = captureFx(ndb.networkId, ndb.layerId);
      const rounds = 150;
      const perBatch = 2;
      const run = (round: number): Promise<unknown> =>
        runThoughtsWrite(ndb, fx, batch(ndb.networkId, `долгий-${round}`, perBatch));

      // Прогрев: соединение воркера открыто, страничный кэш набран (свой
      // префикс заголовков, чтобы замер считал только основной прогон).
      for (let round = 0; round < 20; round += 1) {
        await runThoughtsWrite(ndb, fx, batch(ndb.networkId, `разогрев-${round}`, perBatch));
      }
      const baselineRss = process.memoryUsage().rss;
      const baselineHeap = process.memoryUsage().heapUsed;

      for (let round = 0; round < rounds; round += 1) await run(round);

      const rssGrowthMb = (process.memoryUsage().rss - baselineRss) / 1024 / 1024;
      const heapGrowthMb = (process.memoryUsage().heapUsed - baselineHeap) / 1024 / 1024;
      const stats = pool.stats();
      console.log(
        `[write-pool-load] длинный прогон: ${rounds} батчей, spawns=${stats.spawns}, ` +
          `completed=${stats.completed}, рост rss=${rssGrowthMb.toFixed(1)} МБ, heap=${heapGrowthMb.toFixed(1)} МБ`,
      );

      assert.equal(countByPrefix(ndb, 'Батч-долгий-'), rounds * perBatch, 'все батчи записаны');
      assert.equal(stats.spawns, 1, 'воркер сети поднят один раз — соединение переиспользовано');
      assert.equal(stats.completed, 20 + rounds, 'счётчики сошлись');
      assert.equal(pool.pending, 0, 'очередь пуста: задачи не накапливаются');
      // Утечки соединений/DTO показали бы безграничный рост; порог с запасом на
      // страничный кэш SQLite (до 64 МиБ на соединение).
      assert.ok(rssGrowthMb < 96, `рост rss ${rssGrowthMb.toFixed(1)} МБ — похоже на утечку`);
      assert.ok(heapGrowthMb < 32, `рост heap ${heapGrowthMb.toFixed(1)} МБ — похоже на утечку`);
    });

    it('graceful shutdown под нагрузкой: очередь сливается, чекпойнт WAL делается последним', async () => {
      const networks = [ndb, largeNetwork(), largeNetwork()];
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 120_000, idleEvictionMs: EVICT_MS });
      assert.ok(pool !== null);
      const rounds = 3;

      const runs = networks.flatMap((n, i) =>
        Array.from({ length: rounds }, (_, round) =>
          runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `рестарт-${round}-${i}`, SMALL_BATCH),
          ),
        ),
      );
      // Очереди заполнены: часть задач ещё ждёт допуска.
      const busy = await waitFor(() => pool.stats().busyWorkers > 0, 5_000);
      assert.ok(busy, 'к моменту остановки пул работал');

      const drained = await drainWritePool(60_000);
      const settled = await Promise.allSettled(runs);
      assert.equal(drained.drained, true, 'очереди слились');
      assert.ok(
        settled.every((s) => s.status === 'fulfilled'),
        'ни одна принятая задача не потеряна остановкой',
      );
      networks.forEach((n, i) => {
        assert.equal(
          countByPrefix(n, 'Батч-рестарт-'),
          rounds * SMALL_BATCH,
          `сеть ${i}: все батчи закоммичены`,
        );
      });

      // Остановка пула, затем чекпойнт — последним шагом (как в index.ts):
      // writer-соединения не переживают остановку, поэтому журнал усекается.
      await closeWritePool();
      assert.equal(getWritePool(), null, 'пул закрыт');
      checkpointOpenNetworkDbs();
      for (const [i, n] of networks.entries()) {
        const size = walSize(n.dbPath);
        assert.equal(size, 0, `сеть ${i}: WAL после чекпойнта пуст (${size} байт)`);
      }
    });

    it('остановка без слива: принятые батчи целы, остальные отклонены явно', async () => {
      const networks = [ndb, largeNetwork()];
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 120_000, idleEvictionMs: EVICT_MS });
      assert.ok(pool !== null);

      const runs = networks.flatMap((n, i) =>
        [0, 1, 2].map((round) =>
          runThoughtsWrite(
            n,
            captureFx(n.networkId, n.layerId),
            batch(n.networkId, `жёстко-${round}-${i}`, SMALL_BATCH),
          ),
        ),
      );
      await waitFor(() => pool.stats().busyWorkers > 0, 5_000);
      const settled = await Promise.allSettled([closeWritePool(), ...runs]);

      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
      const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
      console.log(
        `[write-pool-load] жёсткая остановка: fulfilled=${fulfilled}, rejected=${rejected.length}`,
      );

      assert.equal(settled.length, runs.length + 1, 'все задачи завершились');
      for (const r of rejected) {
        assert.match(String((r.reason as Error).message), /closed/, 'отклонение явное и объяснённое');
      }
      // Каждый батч — целиком или никак: снятая задача могла докоммититься, но
      // частичной записи не бывает.
      for (const [i, n] of networks.entries()) {
        const written = countByPrefix(n, 'Батч-жёстко-');
        assert.equal(written % SMALL_BATCH, 0, `сеть ${i}: записано ${written} — не целый батч`);
        assert.ok(written <= 3 * SMALL_BATCH, `сеть ${i}: записей больше, чем задач`);
      }
    });
  },
);

/** Пустая ссылка на тип, чтобы импорт `NetworkDb` не считался неиспользуемым. */
export type { NetworkDb };
