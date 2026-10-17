/**
 * Регрессионные тесты чекпойнта WAL (ошибка dac92886 «WAL-файл сети не
 * чекпойнтится и растёт», боевой сервер: 119 МБ и растёт).
 *
 * Проверяется наблюдаемое поведение, а не внутренности: размер файла `-wal` до
 * и после чекпойнта, реакция на удерживаемый снапшот читателя (`busy`), сводка
 * прохода по открытым сетям, шаг остановки сервера и фоновый таймер. Тесты
 * работают на настоящих файловых БД во временном каталоге — в памяти WAL нет.
 * Полностью пропускаются, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import type { Logger } from '../src/logger.js';
import {
  closeAll,
  createInMemoryNetworkDb,
  getOpenNetworkDb,
  openNetworkDb,
} from '../src/db/network-db.js';
import {
  checkpointAndCloseAllNetworkDbs,
  checkpointOpenNetworkDbs,
  startWalCheckpointScheduler,
  walCheckpoint,
} from '../src/db/wal-checkpoint.js';

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

/** Размер файла в байтах (0 — файла нет). */
function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Запись лога, перехваченная {@link capturingLogger}. */
interface LogRecord {
  level: 'debug' | 'info' | 'warn';
  msg: string;
  fields: Record<string, unknown>;
}

/** Логгер, складывающий вызовы в массив (уровни wal-checkpoint: info/debug/warn). */
function capturingLogger(records: LogRecord[]): Logger {
  const push =
    (level: LogRecord['level']) =>
    (fields: unknown, msg?: string): void => {
      records.push({
        level,
        msg: msg ?? '',
        fields: (typeof fields === 'object' && fields !== null ? fields : {}) as Record<
          string,
          unknown
        >,
      });
    };
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
  } as unknown as Logger;
}

/** Заполнить тестовую таблицу строками по `payloadBytes` байт (WAL растёт). */
function writeRows(ndb: ReturnType<typeof openNetworkDb>, rows: number, payloadBytes: number): void {
  const payload = 'x'.repeat(payloadBytes);
  ndb.exec('CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY, payload TEXT)');
  const insert = ndb.prepare('INSERT INTO wal_probe (payload) VALUES (?)');
  ndb.exec('BEGIN');
  try {
    for (let i = 0; i < rows; i += 1) insert.run(`${i}:${payload}`);
    ndb.exec('COMMIT');
  } catch (err) {
    ndb.exec('ROLLBACK');
    throw err;
  }
}

/** Дождаться условия (`waitFor` без опоры на кадры, см. грабли 03e33360). */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe(
  'WAL checkpoint',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    // Каждый тест — свой каталог и пустой реестр: сводки прохода считают
    // ВСЕ открытые сети, поэтому изоляция обязательна.
    let tmpDataDir: string;

    beforeEach(() => {
      closeAll();
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-wal-'));
    });

    afterEach(() => {
      closeAll();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    it('TRUNCATE срезает выросший журнал, а PASSIVE оставляет «высокую воду»', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      const wal = `${ndb.dbPath}-wal`;

      writeRows(ndb, 4_000, 1_024);
      const grown = fileSize(wal);
      // Автоматический PASSIVE-чекпойнт переносит кадры, но НЕ усекает файл:
      // журнал остаётся на диске («высокая вода», замер в dac92886).
      assert.ok(grown > 0, `журнал непустой после записи (${grown} Б)`);

      const stats = walCheckpoint(ndb, 'TRUNCATE');
      assert.equal(stats.skipped, false, 'WAL-база не пропускается');
      assert.equal(stats.busy, false, 'читателей нет — чекпойнт свободен');
      assert.ok(stats.checkpointed >= 0, `перенос кадров: ${stats.checkpointed}`);
      assert.equal(fileSize(wal), 0, 'TRUNCATE усекает журнал до нуля');

      // После усечения запись снова наполняет журнал — файл не «залочен».
      writeRows(ndb, 10, 1_024);
      assert.ok(fileSize(wal) > 0, 'журнал снова наполняется после усечения');
    });

    it('удерживаемый снапшот читателя блокирует чекпойнт и растит журнал', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      const wal = `${ndb.dbPath}-wal`;
      writeRows(ndb, 100, 1_024);
      const baseline = fileSize(wal);

      // Читатель держит снапшот: открытая читательская транзакция на ОТДЕЛЬНОМ
      // соединении того же файла (так ведёт себя читающий запрос в пуле).
      const reader = new DatabaseConstructor(ndb.dbPath, { readonly: true });
      try {
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) AS n FROM wal_probe').get();

        writeRows(ndb, 2_000, 1_024);
        const grown = fileSize(wal);
        assert.ok(
          grown > baseline,
          `журнал вырос под удерживаемым снапшотом: ${baseline} → ${grown} Б`,
        );

        // Снапшот читателя не даёт перенести кадры: чекпойнт отвечает busy и
        // файл не усекается — именно этот механизм давал 119 МБ на проде.
        const blocked = walCheckpoint(ndb, 'TRUNCATE');
        assert.equal(blocked.busy, true, 'чекпойнт не проходит при удерживаемом снапшоте');
        assert.equal(fileSize(wal), grown, 'занятый чекпойнт файл не усекает');

        reader.exec('COMMIT');
      } finally {
        reader.close();
      }

      // Снапшот снят — тот же вызов усекает журнал.
      const released = walCheckpoint(ndb, 'TRUNCATE');
      assert.equal(released.busy, false, 'после снятия снапшота чекпойнт проходит');
      assert.equal(fileSize(wal), 0, 'журнал усечён после снятия снапшота');
    });

    it('checkpointOpenNetworkDbs схлопывает соединения по файлу и логирует проход', () => {
      const first = randomUUID();
      const second = randomUUID();
      const a = openNetworkDb(tmpDataDir, first);
      const b = openNetworkDb(tmpDataDir, second);
      writeRows(a, 200, 1_024);
      writeRows(b, 200, 1_024);

      const records: LogRecord[] = [];
      const run = checkpointOpenNetworkDbs({ logger: capturingLogger(records) });
      assert.equal(run.files, 2, 'две сети — два файла');
      assert.equal(run.checkpointed, 2, 'обе сети чекпойнтнуты');
      assert.equal(run.busy, 0);
      assert.equal(run.skipped, 0);
      assert.equal(fileSize(`${a.dbPath}-wal`), 0);
      assert.equal(fileSize(`${b.dbPath}-wal`), 0);
      const info = records.find((r) => r.level === 'info');
      assert.ok(info, 'проход, перенёсший кадры, пишется уровнем info');
      assert.equal(info?.msg, 'WAL checkpoint of network databases');
      assert.equal(info?.fields['files'], 2);
    });

    it('checkpointAndCloseAllNetworkDbs закрывает реестр и оставляет пустой журнал', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      writeRows(ndb, 300, 1_024);
      assert.ok(fileSize(`${ndb.dbPath}-wal`) > 0);

      const records: LogRecord[] = [];
      const run = checkpointAndCloseAllNetworkDbs({ logger: capturingLogger(records) });
      assert.equal(run.files, 1);
      assert.equal(fileSize(`${ndb.dbPath}-wal`), 0, 'журнал пуст после остановки сервера');
      assert.equal(getOpenNetworkDb(networkId), undefined, 'реестр соединений пуст');
      // Повторный шаг остановки идемпотентен (нет открытых сетей).
      const again = checkpointAndCloseAllNetworkDbs();
      assert.equal(again.files, 0);
    });

    it('фоновый таймер чекпойнтит сам и останавливается по stop()', async () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      const wal = `${ndb.dbPath}-wal`;
      const records: LogRecord[] = [];
      const scheduler = startWalCheckpointScheduler({
        intervalMs: 25,
        logger: capturingLogger(records),
      });
      try {
        writeRows(ndb, 50, 1_024);
        assert.ok(fileSize(wal) > 0, 'журнал наполнен сразу после записи');
        const truncated = await waitFor(() => fileSize(wal) === 0);
        assert.ok(truncated, 'фоновый таймер усекает журнал');

        const immediate = scheduler.runNow();
        assert.equal(immediate.files, 1, 'runNow идёт тем же путём, что и таймер');
      } finally {
        scheduler.stop();
      }

      writeRows(ndb, 50, 1_024);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok(fileSize(wal) > 0, 'после stop() таймер больше не усекает журнал');
    });

    it('пропускает не-WAL базу и закрытое соединение, не бросая', () => {
      const memory = createInMemoryNetworkDb();
      try {
        assert.equal(walCheckpoint(memory).skipped, true, 'в памяти WAL нет — пропуск');
      } finally {
        memory.close();
      }
      // Закрытое соединение: ошибка прагмы проглатывается, наружу — пропуск.
      const stats = walCheckpoint(memory);
      assert.equal(stats.skipped, true, 'закрытое соединение не бросает наружу');
      assert.equal(stats.busy, false);
    });
  },
);
