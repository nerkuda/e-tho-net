/**
 * Сторож write-пула (задача 57068081, ADR ca3a9218, требование 661cd818).
 *
 * Запрет, который можно нарушить кодом, действует только вместе со сторожем
 * (AGENTS.md §2 п.5). В этой паре файлов легко «сломать» три инварианта:
 *
 *   1. **Воркер не мигрирует и не открывает БД сам через `openNetworkDb`** —
 *      спека требует контекста задачи и только его (требование cfba5ddf):
 *      `openNetworkDb` применяет миграции и чистит `object_locks` — это зона
 *      главного потока.
 *   2. **Воркер записи — не читатель и не мигрирующий владелец схемы**:
 *      соединение обязано быть ПИШУЩИМ (не `readonly`) и получать единый
 *      профиль прагм с общим набором SQL-функций (признак того, что соединение
 *      открыто «как в главном потоке»).
 *   3. **Пул не публикует события и не пишет журнал/аудит** — это половина
 *      WriteFx главного потока (ADR 162d8e7a, требование ba987ab2): пул —
 *      транспорт «задача → воркер → ответ» и не знает домена.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WORKER_FILE = 'db/write-worker.ts';
const POOL_FILE = 'db/write-pool.ts';

/** Файл — один из файлов write-пула. */
const inWritePool = (rel: string): boolean => rel === WORKER_FILE || rel === POOL_FILE;

/** Прочитать файл исходников как текст. */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(SERVER_SRC_ROOT, rel), 'utf8');
}

describe('guard: write-пул — контекст задачи, writer-соединение, никакой FX', () => {
  it('воркер не применяет миграции и не открывает сеть через openNetworkDb', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'write-worker-does-not-open-network-db',
        description:
          'Воркер открывает своё соединение сам; `openNetworkDb` применяет миграции ' +
          'и чистит object_locks — это зона главного потока (требование cfba5ddf).',
        pattern: /openNetworkDb\(/,
        include: (rel) => rel === WORKER_FILE,
      },
      {
        name: 'write-worker-does-not-run-migrations',
        description: 'Миграции схемы исполняет только главный поток (ADR ca3a9218).',
        pattern: /runMigrations|applyMigrations|registerMigrationHelpers/,
        include: (rel) => rel === WORKER_FILE,
      },
      {
        name: 'write-worker-is-not-readonly',
        description:
          'Соединение воркера записи — ПИШУЩЕЕ: `readonly: true` превратил бы ' +
          'write-пул во второго читателя.',
        pattern: /readonly\s*:\s*true/,
        include: (rel) => rel === WORKER_FILE,
      },
    ]);
  });

  it('пул и воркер не публикуют события и не пишут журнал/аудит', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'no-realtime-emit-in-write-pool',
        description:
          'Публикация real-time событий и аудит — половина WriteFx главного потока ' +
          '(ADR 162d8e7a, требование ba987ab2); пул — только транспорт.',
        pattern: /emitDomainEvent|\.emit\(|recordActivity|recordAuditLog|applyActivityEntry/,
        include: inWritePool,
      },
      {
        name: 'no-run-write-in-write-pool',
        description:
          'Обёртку записи `runWrite` исполняет главный поток: на границе потока нет ' +
          'замыкания `fn`, а пул диспетчеризует плоские op (ADR ca3a9218).',
        pattern: /runWrite\(/,
        include: inWritePool,
      },
    ]);
  });

  it('пул не тянет домен записи и не ходит в SQL сам', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'write-pool-imports-no-domain-services',
        description:
          'Пул диспетчеризует плоские задачи и не знает домена: доменные вызовы ' +
          'исполняет воркер по имени op (исключение — проверка типа контекста).',
        filePattern: /from\s+'\.\.\/domain\//,
        include: (rel) => rel === POOL_FILE,
      },
      {
        name: 'write-pool-has-no-sql',
        description: 'Пул не работает с SQL — соединение открывает воркер.',
        pattern: /\.(?:prepare|exec)\(/,
        include: (rel) => rel === POOL_FILE,
      },
    ]);
  });

  it('воркер переиспользует точку соединения: прагмы и SQL-функции на месте', () => {
    const source = readSource(WORKER_FILE);
    for (const needle of [
      'applyConnectionPragmas',
      'registerQueryFunctions',
      'new NetworkDb(',
      'foreign_keys = ON',
      'useLayer(context.layerId)',
    ]) {
      assert.ok(
        source.includes(needle),
        `воркер обязан переиспользовать «${needle}»: иначе соединение воркера ` +
          'разойдётся с главным (профиль прагм, SQL-функции, контекст слоя).',
      );
    }
  });
});
