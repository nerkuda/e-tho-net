/**
 * Тесты write-пула (задача 57068081, ADR ca3a9218, тех.проект 0df7ccd6).
 *
 * Проверяется НАБЛЮДАЕМОЕ поведение пула на настоящих файловых БД и настоящих
 * `worker_threads` (в памяти второе соединение невозможно, а WAL — тем более):
 *
 *   * порядок внутри сети (sticky: все задачи сети исполняет один воркер,
 *     очередь FIFO) и параллельность разных сетей;
 *   * вытеснение простаивающей привязки по LRU и ожидание допуска при
 *     исчерпании пула;
 *   * тайм-аут зависшей задачи, замена воркера и консистентность БД;
 *   * слив очередей при остановке и «батч целиком или никак» при жёстком
 *     закрытии;
 *   * деградация: без пула и на `:memory:` запись исполняется синхронно с ТЕМ ЖЕ
 *     результатом;
 *   * главный поток свободен: пока батч идёт в воркере, таймеры главного потока
 *     тикают — это и есть цель тех.проекта.
 *
 * Пул создаётся локально (`new WritePool`); процессный пул трогают только те
 * тесты, которые зовут `runWriteTask` (она работает с процессным пулом).
 * Полностью пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { MCP_MAX_THOUGHTS_PER_WRITE, type McpThoughtWriteParams } from '@etn/shared';
import { EtnError } from '@etn/shared';

import type { WriteTask, WriteTaskContext } from '../src/contracts.js';
import {
  closeAll,
  createInMemoryNetworkDb,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import {
  WritePool,
  closeWritePool,
  configureWritePool,
  getWritePool,
  runWriteTask,
  writeContextFor,
} from '../src/db/write-pool.js';
import { writeThoughts, type ThoughtWriteResult } from '../src/domain/thought-write-service.js';

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

const ACTOR = 'write-pool-user';
/** Лимит батча из контракта: пул тестируем настоящими батчами, не больше лимита. */
const BATCH = MCP_MAX_THOUGHTS_PER_WRITE;

/** Задача батч-записи мыслей: `titles` становятся мыслями батча. */
function batchTask(context: WriteTaskContext, titles: string[]): WriteTask {
  const input: McpThoughtWriteParams = {
    network_id: context.networkId,
    thoughts: titles.map((title, index) => ({ ref: `t${index}`, thought: { title } })),
  };
  return { context, op: 'write.thoughts', payload: { input, actorUserId: ACTOR } };
}

/** `count` заголовков с префиксом — полезная нагрузка батча. */
function titles(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

/** Заголовки мыслей сети в порядке появления (rowid) — порядок записи. */
function titlesInOrder(ndb: NetworkDb): string[] {
  const rows = ndb
    .prepare('SELECT title FROM thoughts ORDER BY rowid')
    .all() as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

/** Сколько мыслей с таким префиксом заголовка уже в БД. */
function countByPrefix(ndb: NetworkDb, prefix: string): number {
  const row = ndb
    .prepare('SELECT COUNT(*) AS n FROM thoughts WHERE title LIKE ?')
    .get(`${prefix}%`) as { n: number };
  return row.n;
}

/**
 * Настоящий `setTimeout`, снятый до подмены mock-таймерами (тест «поздний
 * коммит» держит таймеры ПУЛА под управлением теста). Ожидание реального
 * состояния обязано идти по реальным часам и не зависеть от тиков мока.
 */
const realSetTimeout = setTimeout;

/** Дождаться условия (ожидание по состоянию, не по кадрам; таймер всегда настоящий). */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  return predicate();
}

/** Результат записи из исхода батч-задачи: воркер отдаёт `{ result, events }`. */
function resultOf(outcome: unknown): ThoughtWriteResult {
  return (outcome as { result: ThoughtWriteResult }).result;
}

/** Результат записи в сопоставимом виде: id и версии новые у каждой сети. */
function normalize(result: ThoughtWriteResult): unknown {
  return {
    thought_count: result.thought_count,
    link_count: result.link_count,
    warnings: result.warnings.length,
    items: result.items.map((item) => ({
      ref: item.ref,
      thought_id: item.thought_id,
      thought_action: item.thought_action,
      matched_on: item.matched_on,
      comment: item.comment?.action ?? null,
      chronicle: item.chronicle?.length ?? 0,
    })),
  };
}

describe(
  'write pool',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;
    let ndb: NetworkDb;
    let networkId: string;
    let context: WriteTaskContext;

    beforeEach(() => {
      closeAll();
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-writepool-'));
      networkId = randomUUID();
      ndb = openNetworkDb(tmpDataDir, networkId);
      const built = writeContextFor(ndb);
      assert.ok(built !== null, 'контекст файловой сети строится');
      context = built;
    });

    afterEach(async () => {
      await closeWritePool();
      closeAll();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    /** Открыть вторую сеть в том же каталоге данных и вернуть её контекст. */
    function secondNetwork(): { ndb: NetworkDb; context: WriteTaskContext } {
      const id = randomUUID();
      const other = openNetworkDb(tmpDataDir, id);
      const otherContext = writeContextFor(other);
      assert.ok(otherContext !== null);
      return { ndb: other, context: otherContext };
    }

    it('исполняет батч в воркере: мысли записаны, главный поток свободен', async () => {
      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        // Тик главного потока: уйди запись в главный поток — тики встанут.
        let ticks = 0;
        const ticker = setInterval(() => {
          ticks += 1;
        }, 5);
        const runs = [1, 2, 3].map((n) => pool.run(batchTask(context, titles(`batch-${n}`, BATCH))));
        const results = (await Promise.all(runs)).map(resultOf);
        clearInterval(ticker);

        assert.equal(results.length, 3);
        assert.equal(countByPrefix(ndb, 'batch-'), 3 * BATCH, 'все мысли батчей видны главному потоку');
        assert.ok(ticks >= 2, `цикл событий главного потока жил во время батчей (тиков: ${ticks})`);
        assert.equal(pool.stats().completed, 3);
      } finally {
        await pool.close();
      }
    });

    it('sticky: задачи одной сети идут через ОДИН воркер и в порядке поступления', async () => {
      const pool = new WritePool({ size: 2, taskTimeoutMs: 30_000 });
      try {
        const runs: Array<Promise<unknown>> = [];
        for (let i = 1; i <= 5; i += 1) runs.push(pool.run(batchTask(context, [`order-${i}`])));
        await Promise.all(runs);

        assert.equal(pool.stats().spawns, 1, 'поднят один воркер на сеть');
        assert.deepEqual(pool.stats().pinnedNetworks, [networkId]);
        assert.deepEqual(titlesInOrder(ndb), ['order-1', 'order-2', 'order-3', 'order-4', 'order-5']);
      } finally {
        await pool.close();
      }
    });

    it('сети пишутся параллельно: у каждой свой воркер', async () => {
      const other = secondNetwork();
      const pool = new WritePool({ size: 2, taskTimeoutMs: 30_000 });
      try {
        const runs = [
          pool.run(batchTask(context, titles('par-a-1', BATCH))),
          pool.run(batchTask(other.context, titles('par-b-1', BATCH))),
          pool.run(batchTask(context, titles('par-a-2', BATCH))),
          pool.run(batchTask(other.context, titles('par-b-2', BATCH))),
        ];
        // Обе сети заняли воркер одновременно — значит исполняются параллельно.
        const concurrent = await waitFor(() => pool.stats().busyWorkers === 2);
        assert.ok(concurrent, 'две сети исполняются одновременно');
        await Promise.all(runs);

        assert.equal(pool.stats().spawns, 2, 'по воркеру на сеть');
        assert.equal(countByPrefix(ndb, 'par-a-'), 2 * BATCH);
        assert.equal(countByPrefix(other.ndb, 'par-b-'), 2 * BATCH);
      } finally {
        await pool.close();
      }
    });

    it('исчерпание пула: запись новой сети ждёт допуска', async () => {
      const other = secondNetwork();
      // Небольшой порог простоя: вторая сеть дождётся вытеснения простаивающей
      // привязки сразу после того, как первая сеть опустеет.
      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000, idleEvictionMs: 50 });
      try {
        const runs = [
          pool.run(batchTask(context, titles('hold-1', BATCH))),
          pool.run(batchTask(context, titles('hold-2', BATCH))),
        ];
        const waiting = pool.run(batchTask(other.context, ['waiting']));
        await waitFor(() => pool.stats().waitingAdmission === 1);
        assert.equal(pool.stats().busyWorkers, 1, 'единственный воркер занят первой сетью');

        await Promise.all([...runs, waiting]);
        assert.equal(countByPrefix(other.ndb, 'waiting'), 1, 'задача дождалась воркера');
      } finally {
        await pool.close();
      }
    });

    it('простаивающая привязка не блокирует допуск: очередь допуска будится таймером', async () => {
      // Регресс ошибки 79c64f3f. Задача новой сети встаёт в очередь допуска,
      // когда все воркеры закреплены, а привязка-владелец УЖЕ простаивает (её
      // последнее событие — прошлая задача). Будить допуск нечем: простаивающая
      // привязка событий не даёт, а `taskTimeoutMs` взводится только при передаче
      // задачи воркеру (`dispatchPin`). Пока `route` не звал `admit`, таймер
      // допуска не взводился вовсе — задача висела вечно. Пороги конфигурируемы:
      // реальные 30 с `idleEvictionMs` ждать нельзя.
      const other = secondNetwork();
      const warns: Array<{ msg: string; fields: Record<string, unknown> }> = [];
      const logger = {
        debug: (): void => {},
        info: (): void => {},
        warn: (fields: unknown, msg?: string): void => {
          warns.push({ msg: msg ?? '', fields: (fields ?? {}) as Record<string, unknown> });
        },
      } as unknown as NonNullable<
        NonNullable<ConstructorParameters<typeof WritePool>[0]>['logger']
      >;

      const pool = new WritePool({
        size: 1,
        taskTimeoutMs: 30_000,
        idleEvictionMs: 300,
        queueWaitWarnMs: 40,
        logger,
      });
      try {
        // Сеть A занимает единственный воркер и отпускает его, задача исполнена.
        await pool.run(batchTask(context, ['idle-holder']));
        assert.equal(pool.stats().busyWorkers, 0, 'воркер сети A освободился');
        assert.deepEqual(pool.stats().pinnedNetworks, [networkId], 'воркер закреплён за A');

        // Сеть B: воркера нет, а привязка A ещё не простояла порог вытеснения —
        // задача обязана исполниться по таймеру допуска, а не висеть вечно.
        const outcome = await Promise.race([
          pool.run(batchTask(other.context, ['idle-second'])).then(
            () => 'executed' as const,
            () => 'failed' as const,
          ),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
        ]);
        assert.equal(
          outcome,
          'executed',
          'задача новой сети обязана дождаться вытеснения простаивающей привязки',
        );
        assert.equal(countByPrefix(other.ndb, 'idle-second'), 1, 'новая сеть записана');
        assert.equal(pool.stats().evicted, 1, 'простаивающая привязка вытеснена по простою');
        // Аномально долгое ожидание допуска обязано быть видно в логах (WARN),
        // а не только в статистике: иначе зависание в допуске остаётся немым.
        const admissionWarn = warns.find(
          (w) => w.msg === 'write pool: задача долго ждёт допуска',
        );
        assert.ok(
          admissionWarn !== undefined,
          `ожидание допуска обязано логироваться WARN; получено: ${warns.map((w) => w.msg).join(' | ')}`,
        );
        assert.equal(admissionWarn!.fields.waitingAdmission, 1, 'WARN видит задачу в допуске');
      } finally {
        await pool.close();
      }
    });

    it('WARN допуска не вылетает ниже порога: таймер предупреждения следует за головой очереди', async () => {
      // Регресс ошибки c7a4d040. Таймер предупреждения взводился от ТЕКУЩЕЙ головы
      // очереди допуска, но не сбрасывался, когда голова уходила (или очередь
      // опустела): устаревший таймер выдавал WARN уже для НОВОЙ, свежей задачи, с
      // `waitMs` ниже `queueWaitWarnMs`. Сценарий: B ждёт допуска и даёт законный
      // WARN; затем вытесняет простаивающую A и уходит в исполнение; следом в допуск
      // встаёт свежая C — и устаревший таймер B срабатывает на ней. Пороги
      // конфигурируемы: реальные 30 с не ждём.
      const other = secondNetwork();
      const third = secondNetwork();
      const warns: Array<{ msg: string; fields: Record<string, unknown> }> = [];
      const logger = {
        debug: (): void => {},
        info: (): void => {},
        warn: (fields: unknown, msg?: string): void => {
          warns.push({ msg: msg ?? '', fields: (fields ?? {}) as Record<string, unknown> });
        },
      } as unknown as NonNullable<
        NonNullable<ConstructorParameters<typeof WritePool>[0]>['logger']
      >;

      const waitWarnMs = 150;
      // Порог вытеснения чуть больше порога WARN: B успевает дать ЗАКОННЫЙ WARN,
      // затем вытесняет A — устаревший таймер остаётся висеть до ~2·waitWarnMs.
      const pool = new WritePool({
        size: 1,
        taskTimeoutMs: 30_000,
        idleEvictionMs: 180,
        queueWaitWarnMs: waitWarnMs,
        logger,
      });
      const admissionWaits = (): number[] =>
        warns
          .filter((w) => w.msg === 'write pool: задача долго ждёт допуска')
          .map((w) => Number(w.fields.waitMs));

      try {
        await pool.run(batchTask(context, ['warn-holder'])); // A закреплена и простаивает

        const bRun = pool.run(batchTask(other.context, ['warn-b'])); // B ждёт допуска
        // Отказ фоновой задачи при закрытии пула не должен маскировать ассерт.
        void bRun.catch(() => {});
        const dispatched = await waitFor(
          () =>
            pool.stats().busyWorkers === 1 &&
            pool.stats().pinnedNetworks.includes(other.context.networkId),
          waitWarnMs * 6,
        );
        assert.ok(dispatched, 'B обязана получить воркер по таймеру допуска');
        assert.ok(admissionWaits().length >= 1, 'законный WARN о долгом ожидании B обязан быть');

        // Свежая C встаёт в допуск на короткое время — под устаревший таймер B.
        const cRun = pool.run(batchTask(third.context, ['warn-c']));
        void cRun.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, waitWarnMs * 2));

        // Допускаем ~10 мс джиттера таймера, но НЕ разницу в десятки мс: устаревший
        // таймер даёт waitMs порядка idleEvictionMs−waitWarnMs, то есть ниже порога.
        const tolerance = 10;
        const waits = admissionWaits();
        assert.ok(
          waits.every((w) => w >= waitWarnMs - tolerance),
          `WARN допуска обязан нести waitMs ≥ ${waitWarnMs}; получено: ${waits.join(', ')}`,
        );

        await Promise.all([bRun, cRun]);
        assert.equal(countByPrefix(other.ndb, 'warn-b'), 1, 'сеть B записана');
        assert.equal(countByPrefix(third.ndb, 'warn-c'), 1, 'сеть C записана');
      } finally {
        await pool.close();
      }
    });

    it('WARN допуска не вылетает ниже порога при возврате задач в голову очереди (closePin)', async () => {
      // Регресс ошибки c7a4d040, ВТОРОЙ путь: `closePin` возвращает невыполненные
      // задачи сети В НАЧАЛО очереди допуска (`admission.unshift`) — голова меняется
      // МИМО `admit` (тот зовётся лишь по завершении выхода воркера). Таймер
      // предупреждения, взведённый от ПРЕЖНЕЙ головы X, срабатывал на СВЕЖЕЙ p2 —
      // WARN с `waitMs` ниже порога. Пороги конфигурируемы: реальные 120 с и 30 с
      // вытеснения не ждём; пул из одного воркера.
      const p = secondNetwork();
      const x = secondNetwork();
      const warns: Array<{ atMs: number; waitMs: number }> = [];
      const logger = {
        debug: (): void => {},
        info: (): void => {},
        warn: (fields: unknown, msg?: string): void => {
          if (msg === 'write pool: задача долго ждёт допуска') {
            warns.push({ atMs: Date.now(), waitMs: Number((fields as { waitMs?: number }).waitMs) });
          }
        },
      } as unknown as NonNullable<
        NonNullable<ConstructorParameters<typeof WritePool>[0]>['logger']
      >;

      const waitWarnMs = 1100;
      // Тайм-аут заметно больше подъёма воркера (в норме ~0.4 с, под нагрузкой
      // машины — всплески), чтобы застрять в COMMIT воркер успел, и НЕ кратен
      // порогу WARN: голова p2 возвращается в допуск между периодическими
      // предупреждениями, поэтому устаревший таймер срабатывает вскорости после
      // возврата (waitMs ≈ 800), а взведённый от новой головы — через полный порог.
      const taskTimeoutMs = 2500;
      const pool = new WritePool({
        size: 1,
        taskTimeoutMs,
        idleEvictionMs: 1_000_000, // вытеснения по простою нет: X ждёт только закрытия P
        queueWaitWarnMs: waitWarnMs,
        logger,
      });
      let readTxn = false;
      try {
        // Откатный журнал ДО подъёма воркера: в WAL коммит под чужой блокировкой не
        // «зависает» (воркер получил бы SQLITE_BUSY), и окна `closing` не было бы.
        p.ndb.exec('PRAGMA journal_mode = DELETE');
        // Соединение главного потока держит разделяемую блокировку: COMMIT воркера
        // ждёт её в busy-обработчике, а `terminate()` нативный вызов не прерывает —
        // окно `closing` живёт, пока блокировка держится (тут — до конца теста).
        p.ndb.exec('BEGIN');
        readTxn = true;
        p.ndb.prepare('SELECT COUNT(*) AS n FROM thoughts').get();

        const p1 = pool.run(batchTask(p.context, ['head-p1'])); // застревает в COMMIT
        void p1.catch(() => {}); // отказ по тайм-ауту не должен маскировать ассерт
        const xRun = pool.run(batchTask(x.context, ['head-x'])); // ждёт допуска
        void xRun.catch(() => {});

        // Свежая задача сети P встаёт в очередь ЗАНЯТОГО воркера до тайм-аута...
        await new Promise((resolve) => setTimeout(resolve, taskTimeoutMs - 40));
        const p2At = Date.now();
        const p2 = pool.run(batchTask(p.context, ['head-p2']));
        void p2.catch(() => {});

        // ...и по тайм-ауту `closePin` прыгает в ГОЛОВУ очереди допуска. Наблюдаем
        // окно `closing` за предупреждением, взведённым уже от новой головы.
        await new Promise((resolve) => setTimeout(resolve, waitWarnMs + 150));

        assert.equal(pool.stats().timedOut, 1, 'воркер P снят по тайм-ауту (сценарий держится)');
        assert.equal(
          pool.stats().waitingAdmission,
          2,
          'в допуске обе задачи: вернувшаяся p2 (голова) и ждущая X',
        );
        assert.ok(
          warns.length >= 2,
          `предупреждения обязаны были быть; получено: ${JSON.stringify(warns)}`,
        );
        // ~5 мс на джиттер таймера, но не сотни: устаревший таймер даёт waitMs
        // порядка времени жизни головы p2 (тут ≈ 800 при пороге 1100).
        const tolerance = 5;
        assert.ok(
          warns.every((w) => w.waitMs >= waitWarnMs - tolerance),
          `WARN допуска обязан нести waitMs ≥ ${waitWarnMs}; получено: ${warns
            .map((w) => w.waitMs)
            .join(', ')}`,
        );
        // И наблюдаемость в окне `closing` НЕ глушится: последнее предупреждение
        // пришло через полный порог после постановки новой головы. Сброс без
        // перевзвода дал бы лишь предупреждения прежней головы и провалил условие.
        const last = warns[warns.length - 1];
        assert.ok(
          last !== undefined && last.atMs - p2At >= waitWarnMs - tolerance,
          `предупреждение о возвращённой голове обязано прийти через полный порог ` +
            `(${waitWarnMs} мс) после её постановки; получено: ${JSON.stringify(warns)}, p2At=${p2At}`,
        );
      } finally {
        if (readTxn) {
          try {
            p.ndb.exec('ROLLBACK');
          } catch {
            /* транзакции уже нет */
          }
        }
        await pool.close();
      }
    });

    it('вытесняет простаивающую привязку по LRU, чтобы новая сеть получила воркер', async () => {
      const other = secondNetwork();
      const third = secondNetwork();
      const pool = new WritePool({ size: 2, taskTimeoutMs: 30_000, idleEvictionMs: 30 });
      try {
        await pool.run(batchTask(context, ['first-net']));
        await pool.run(batchTask(other.context, ['second-net']));
        assert.equal(pool.stats().workers, 2, 'оба воркера закреплены');

        // Привязки простаивают дольше порога — третья сеть вытеснит старшую.
        await new Promise((resolve) => setTimeout(resolve, 60));
        await pool.run(batchTask(third.context, ['third-net']));

        assert.equal(pool.stats().evicted, 1, 'вытеснена одна привязка по простою');
        assert.ok(pool.stats().pinnedNetworks.includes(third.context.networkId), 'новая сеть с воркером');
        assert.equal(countByPrefix(third.ndb, 'third-net'), 1);
      } finally {
        await pool.close();
      }
    });

    it('тайм-аут задачи: слот заменяется, БД остаётся консистентной', async () => {
      // 1 мс — заведомо меньше любой реальной задачи (даже подъёма воркера):
      // так проверяется сам путь тайм-аута без поддельных операций.
      const impatient = new WritePool({ size: 1, taskTimeoutMs: 1 });
      try {
        await assert.rejects(
          impatient.run(batchTask(context, titles('stuck', BATCH))),
          (err: unknown) => err instanceof EtnError && /timed out/.test(err.message),
        );
        assert.equal(impatient.stats().timedOut, 1);
        assert.equal(countByPrefix(ndb, 'stuck'), 0, 'частичной записи от снятой задачи нет');

        // Мёртвый слот не переиспользуется: следующая задача поднимает новый воркер.
        await assert.rejects(
          impatient.run(batchTask(context, titles('stuck-2', BATCH))),
          /timed out/,
        );
        assert.ok(impatient.stats().spawns >= 2, 'слот заменён новым воркером');
        assert.equal(impatient.pending, 0, 'очередь не залипла на мёртвом слоте');
        assert.equal(countByPrefix(ndb, 'stuck-'), 0, 'частичных записей нет');
      } finally {
        await impatient.close();
      }

      // Сеть остаётся рабочей: обычный пул доводит запись до конца.
      const patient = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        const healed = resultOf(await patient.run(batchTask(context, ['after-timeout'])));
        assert.equal(healed.thought_count, 1);
        assert.equal(countByPrefix(ndb, 'after-timeout'), 1, 'сеть пишется после снятия слота');
      } finally {
        await patient.close();
      }
    });

    it('сеть под чужой блокировкой записи: доменная ошибка, воркер остаётся жив', async () => {
      // Соседний писатель держит блокировку (главное соединение): транзакция
      // воркера получает SQLITE_BUSY. Это доменная ошибка задачи, а не падение
      // воркера — слот обязан выжить и исполнить следующую задачу.
      ndb.exec('BEGIN IMMEDIATE');
      const pool = new WritePool({ size: 1, taskTimeoutMs: 5_000 });
      try {
        await assert.rejects(
          pool.run(batchTask(context, titles('locked', BATCH))),
          (err: unknown) => err instanceof EtnError && /locked/i.test(err.message),
        );
        assert.equal(countByPrefix(ndb, 'locked'), 0, 'под блокировкой ничего не записано');
        assert.equal(pool.stats().timedOut, 0, 'это не тайм-аут');
        assert.equal(pool.stats().spawns, 1, 'воркер не перезапускался');

        ndb.exec('ROLLBACK');
        const after = resultOf(await pool.run(batchTask(context, ['after-lock'])));
        assert.equal(after.thought_count, 1);
        assert.equal(countByPrefix(ndb, 'after-lock'), 1, 'тот же воркер дописал после снятия блокировки');
      } finally {
        await pool.close();
      }
    });

    it('смена схемы между задачами: следующая задача идёт по новому schemaVersion', async () => {
      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        await pool.run(batchTask(context, ['before-schema']));

        // Главный поток меняет схему (как миграция) — маркер инвалидации сменился.
        ndb.exec('CREATE TABLE IF NOT EXISTS schema_probe (n INTEGER)');
        const bumped = writeContextFor(ndb);
        assert.ok(bumped !== null);
        assert.notEqual(bumped.schemaVersion, context.schemaVersion, 'schema_version вырос');

        const after = resultOf(await pool.run(batchTask(bumped, ['after-schema'])));
        assert.equal(after.thought_count, 1);
        assert.equal(countByPrefix(ndb, 'after-schema'), 1);
        assert.equal(pool.stats().spawns, 1, 'воркер тот же — соединение переоткрыто внутри');
      } finally {
        await pool.close();
      }
    });

    it('контекст слоя применяется на каждой задаче', async () => {
      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        await pool.run(batchTask(context, ['layer-base-1']));

        // Несуществующий слой: контекст задачи реально применяется — задача падает,
        // а БД остаётся чистой.
        const bad: WriteTaskContext = { ...context, layerId: randomUUID() };
        await assert.rejects(pool.run(batchTask(bad, ['layer-bad'])));
        assert.equal(countByPrefix(ndb, 'layer-bad'), 0, 'в чужой слой ничего не записалось');

        // Тот же воркер снова пишет в базовый слой — контекст переустановлен.
        await pool.run(batchTask(context, ['layer-base-2']));
        assert.equal(pool.stats().spawns, 1, 'привязка переиспользована');
        assert.deepEqual(titlesInOrder(ndb), ['layer-base-1', 'layer-base-2']);
      } finally {
        await pool.close();
      }
    });

    it('поздний коммит после тайм-аута: результат помечается неизвестным', async (t) => {
      // Задача воркера ЗАСТРЕВАЕТ ПОСРЕДИ ТРАНЗАКЦИИ: соединение главного потока
      // держит разделяемую блокировку чтения, а `COMMIT` воркера не может взять
      // исключительную и ждёт в busy-обработчике. `terminate()` не прерывает
      // нативный вызов better-sqlite3, поэтому воркер, снятый по тайм-ауту,
      // доводит батч до конца, как только блокировка снимается, — уже после
      // ответа клиенту. Путь обязан назвать это `resultUnknown`, а не молчать.
      //
      // Почему откатный журнал, а не WAL: в WAL попытка записи под чужой
      // блокировкой отдаёт `SQLITE_BUSY` сразу (busy-обработчик на переход
      // «чтение → запись» не вызывается), и «зависнуть в транзакции» там нельзя —
      // а именно этот случай и надо воспроизвести. В откатном журнале `COMMIT`
      // ждёт освобождения разделяемой блокировки, что и даёт зависание.
      //
      // Синхронизация — по состоянию, не по таймингам (ошибка cc0f69f4). Раньше
      // тест рассчитывал, что за 1.5 с тайм-аута воркер успеет подняться и войти
      // в `COMMIT`. Под нагрузкой подъём воркера (tsx-загрузчик, открытие
      // соединения) и сама запись занимают больше: тайм-аут срабатывал ДО
      // `COMMIT`, воркер снимался до коммита, позднего коммита не было — тест
      // падал не по делу. Здесь тайм-аут пула взводится вручную ровно тогда,
      // когда проба увидела `COMMIT` в полёте.
      ndb.exec('PRAGMA journal_mode = DELETE');
      let readTxn = false;
      ndb.exec('BEGIN');
      readTxn = true;
      ndb.prepare('SELECT COUNT(*) AS n FROM thoughts').get(); // взять разделяемую блокировку

      // Пробное соединение — детектор состояния «воркер в COMMIT». Чтение через
      // него получает `SQLITE_BUSY` ровно тогда, когда воркер взял PENDING/
      // EXCLUSIVE (идёт коммит), а на фазе записи RESERVED чтению не мешает.
      const probe = new DatabaseConstructor(ndb.dbPath);
      probe.pragma('busy_timeout = 0');
      const commitInFlight = (): boolean => {
        try {
          probe.exec('BEGIN');
          probe.prepare('SELECT COUNT(*) AS n FROM thoughts').get();
          probe.exec('ROLLBACK');
          return false;
        } catch (err) {
          try {
            probe.exec('ROLLBACK');
          } catch {
            /* транзакции уже нет */
          }
          if ((err as { code?: string }).code !== 'SQLITE_BUSY') throw err;
          return true;
        }
      };

      // Таймер задачи — под управлением теста: `setTimeout` подменён mock-
      // таймерами node:test, поэтому тайм-аут пула срабатывает ровно в точке
      // «COMMIT в полёте», а не по настенным часам. `waitFor` ждёт состояние по
      // реальному времени (см. `realSetTimeout`), тики мока его не двигают.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const titles0 = titles('late', BATCH);
      const pool = new WritePool({ size: 1, taskTimeoutMs: 1_500 });
      try {
        let rejected: EtnError | null = null;
        const run = pool.run(batchTask(context, titles0)).then(
          () => {
            throw new Error('задача обязана быть снята по тайм-ауту');
          },
          (err: unknown) => {
            assert.ok(err instanceof EtnError, 'ошибка домена');
            rejected = err;
          },
        );
        assert.ok(
          await waitFor(commitInFlight),
          'воркер дошёл до COMMIT: поздний коммит в полёте (иначе тайм-аут снял бы его раньше)',
        );
        // Тайм-аут пула — точно в состоянии «COMMIT ждёт нашу блокировку».
        t.mock.timers.tick(pool.taskTimeoutMs);
        // Потолок ожидания `exit` в `terminate()` (TERMINATE_AWAIT_MS, 2 с):
        // нативный вызов не прерывается, ответ клиенту уходит до позднего коммита.
        t.mock.timers.tick(2_000);
        await run;
        assert.match(rejected!.message, /timed out/);
        assert.equal(
          (rejected!.details as { resultUnknown?: boolean }).resultUnknown,
          true,
          'результат помечен неизвестным: коммит мог состояться',
        );
        assert.equal(pool.stats().timedOut, 1);
        assert.equal(
          countByPrefix(ndb, 'late-'),
          0,
          'на момент ответа записи ещё нет: коммит воркера ждёт блокировку',
        );

        // Блокировка снята — снятый воркер доводит транзакцию до конца.
        ndb.exec('ROLLBACK');
        readTxn = false;
        const landed = await waitFor(() => countByPrefix(ndb, 'late-') === BATCH);
        assert.ok(landed, 'поздний коммит состоялся: запись есть, хотя клиент получил ошибку');
      } finally {
        if (readTxn) {
          try {
            ndb.exec('ROLLBACK');
          } catch {
            /* транзакции уже нет */
          }
        }
        // Сначала вернуть настоящие таймеры: `close()` ждёт `exit` воркера с
        // реальным потолком, а не мок-таймером, который никто не тикает.
        t.mock.timers.reset();
        await pool.close();
        probe.close();
      }

      // Повтор того же батча дублей не создаёт: гейт дубликатов отвергает его
      // (у батча `on_duplicate` по умолчанию `fail`) — запись уже на месте, и
      // клиент видит это явной ошибкой DUPLICATE, а не тихим дублем.
      const retryPool = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        await assert.rejects(
          retryPool.run(batchTask(context, titles0)),
          (err: unknown) => err instanceof EtnError && err.code === 'DUPLICATE',
        );
        assert.equal(countByPrefix(ndb, 'late-'), BATCH, 'повтор не создал дублей');
      } finally {
        await retryPool.close();
      }
    });

    it('замена слота не открывает второе соединение к той же базе', async () => {
      const other = secondNetwork();
      const records: Array<{ msg: string; networkId: string }> = [];
      const logger = {
        debug: (fields: unknown, msg?: string): void => {
          records.push({
            msg: msg ?? '',
            networkId: String((fields as { networkId?: string })?.networkId ?? ''),
          });
        },
        info: (): void => {},
        warn: (): void => {},
      } as unknown as NonNullable<NonNullable<ConstructorParameters<typeof WritePool>[0]>['logger']>;

      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000, idleEvictionMs: 0, logger });
      try {
        await pool.run(batchTask(context, ['slot-1']));
        // Вытеснение привязки сети A ради сети B: воркер A завершается.
        await pool.run(batchTask(other.context, ['slot-other']));
        // Задача обратно в сеть A: новый воркер не должен подняться, пока
        // прежний не отпустил базу.
        const back = resultOf(await pool.run(batchTask(context, ['slot-2'])));
        assert.equal(back.thought_count, 1);
        assert.equal(countByPrefix(ndb, 'slot-'), 2, 'обе записи сети A на месте');
        assert.ok(
          !pool.stats().closingNetworks.includes(networkId),
          'к моменту записи прежний воркер сети A уже отпустил базу',
        );
        assert.ok(
          await waitFor(() => pool.stats().closingNetworks.length === 0),
          'все заменённые воркеры завершились',
        );

        // Порядок событий воркера сети A: остановлен прежний → поднят новый.
        const aRecords = records
          .filter((r) => r.networkId === networkId)
          .map((r) => r.msg);
        const stopped = aRecords.indexOf('write pool: воркер сети остановлен, база освобождена');
        const spawnedAgain = aRecords.indexOf('write pool: воркер сети поднят', 1);
        assert.ok(stopped >= 0, 'завершение прежнего воркера зафиксировано');
        assert.ok(spawnedAgain >= 0, 'новый воркер сети A поднят');
        assert.ok(
          stopped < spawnedAgain,
          `новый воркер поднят только после завершения прежнего (${aRecords.join(' | ')})`,
        );
      } finally {
        await pool.close();
      }
    });

    it('drain дожидается слива очередей, close отклоняет невыполненное', async () => {
      const pool = new WritePool({ size: 1, taskTimeoutMs: 30_000 });
      try {
        const runs = [1, 2, 3].map((n) => pool.run(batchTask(context, titles(`drain-${n}`, BATCH))));
        const drained = await pool.drain();
        assert.equal(drained.drained, true, 'очереди слились');
        await Promise.all(runs);
        assert.equal(countByPrefix(ndb, 'drain-'), 3 * BATCH, 'подтверждённые задачи исполнены');

        // Жёсткое закрытие с задачами в полёте: каждый батч применяется ЦЕЛИКОМ
        // или не применяется вовсе — частичной записи не бывает (Сценарий S3).
        const inFlight = [1, 2, 3].map((n) => pool.run(batchTask(context, titles(`close-${n}`, BATCH))));
        const settled = await Promise.allSettled([pool.close(), ...inFlight]);
        assert.equal(settled[0]!.status, 'fulfilled');
        const written = countByPrefix(ndb, 'close-');
        assert.ok(
          written % BATCH === 0 && written <= 3 * BATCH,
          `записаны только целые батчи (записано: ${written} при батче ${BATCH})`,
        );
        assert.equal(pool.stats().workers, 0, 'воркеры остановлены');
        assert.equal(pool.isClosed, true);
        await assert.rejects(pool.run(batchTask(context, ['after-close'])), /closed/);
      } finally {
        await pool.close();
      }
    });

    it('деградация: без пула, на :memory: и с poolable:false запись идёт синхронно', async () => {
      const memory = createInMemoryNetworkDb();
      try {
        assert.equal(getWritePool(), null, 'процессный пул не настроен');
        assert.equal(writeContextFor(memory), null, ':memory: в пул не уходит');

        const inlineInput: McpThoughtWriteParams = {
          network_id: memory.networkId,
          thoughts: [{ ref: 'm', thought: { title: 'memory-inline' } }],
        };
        let syncCalls = 0;
        const sync = (): ThoughtWriteResult => {
          syncCalls += 1;
          return writeThoughts(memory, inlineInput, ACTOR);
        };

        // Нет пула — синхронный исполнитель.
        const withoutPool = (await runWriteTask(
          {
            context: { ...context, dbPath: ':memory:' },
            op: 'write.thoughts',
            payload: { input: inlineInput, actorUserId: ACTOR },
          },
          { sync },
        )) as ThoughtWriteResult;
        assert.equal(withoutPool.thought_count, 1);
        assert.equal(syncCalls, 1);

        // `poolable: false` — тоже синхронный путь (кросс-сетевой резолв и т.п.).
        // Исполнитель здесь подставной: проверяется выбор пути, а не запись.
        const notPoolable = (await runWriteTask(batchTask(context, ['not-poolable']), {
          poolable: false,
          sync: () => {
            syncCalls += 1;
            return 'synced';
          },
        })) as string;
        assert.equal(notPoolable, 'synced');
        assert.equal(syncCalls, 2, 'poolable:false не идёт в пул');
        assert.equal(countByPrefix(ndb, 'not-poolable'), 0, 'в пул задача не уходила');
      } finally {
        memory.close();
      }
    });

    it('через процессный пул: результат тот же, что при синхронной записи', async () => {
      const other = secondNetwork();
      const input: McpThoughtWriteParams = {
        network_id: other.context.networkId,
        thoughts: [
          { ref: 'a', thought: { title: 'идентичность-a' } },
          { ref: 'b', thought: { title: 'идентичность-b' }, comment: { body_md: 'текст' } },
        ],
      };
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 30_000 });
      assert.ok(pool !== null && getWritePool() !== null, 'процессный пул настроен');

      let syncCalls = 0;
      const viaPool = resultOf(
        await runWriteTask(
          { context: other.context, op: 'write.thoughts', payload: { input, actorUserId: ACTOR } },
          {
            sync: () => {
              syncCalls += 1;
              return writeThoughts(ndb, input, ACTOR);
            },
          },
        ),
      );
      assert.equal(syncCalls, 0, 'с настроенным пулом синхронный путь не зовётся');

      // Тот же батч синхронно в другой сети: результаты обязаны совпасть
      // (требование 3d9d017f — поведение не зависит от места исполнения).
      const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-writepool-sync-'));
      try {
        const syncNet = openNetworkDb(syncDir, randomUUID());
        const viaSync = writeThoughts(syncNet, input, ACTOR);
        assert.deepEqual(normalize(viaPool), normalize(viaSync), 'результаты обязаны совпадать');
        assert.deepEqual(
          titlesInOrder(other.ndb).sort(),
          titlesInOrder(syncNet).sort(),
          'и состав мыслей одинаков',
        );
      } finally {
        closeAll();
        fs.rmSync(syncDir, { recursive: true, force: true });
      }
    });

    it('кросс-сетевой контекст задачи не уходит в воркер (этап переноса)', async () => {
      const pool = configureWritePool({ size: 1, taskTimeoutMs: 5_000 });
      assert.ok(pool !== null);
      const task = batchTask(context, ['cross-net']);
      const withCross: WriteTask = {
        ...task,
        context: {
          ...context,
          crossNetworkAccess: {
            dataDir: tmpDataDir,
            userId: ACTOR,
            clientId: 'client',
            currentNetworkId: context.networkId,
            accessibleNetworkIds: [context.networkId],
          },
        },
      };
      let syncCalls = 0;
      const result = (await runWriteTask(withCross, {
        sync: () => {
          syncCalls += 1;
          // `WriteTask` — размеченное объединение по `op`: сужаем перед доступом к payload.
          if (withCross.op !== 'write.thoughts') throw new Error('expected write.thoughts task');
          return writeThoughts(ndb, withCross.payload.input, ACTOR);
        },
      })) as ThoughtWriteResult;
      assert.equal(syncCalls, 1, 'задача с кросс-сетевым контекстом исполнена синхронно');
      assert.equal(result.thought_count, 1);
      assert.equal(countByPrefix(ndb, 'cross-net'), 1);
      assert.equal(pool.stats().spawns, 0, 'воркер не поднимался');
    });
  },
);
