/**
 * Сторож reader-пула (задача d20edd33, этап 2 тех.проекта e29c0f00; ADR
 * bec191e6, требование 8e2fda79).
 *
 * Запрет, который можно нарушить кодом, действует только вместе со сторожем
 * (AGENTS.md §2 п.5): воркер пула — ЧИТАТЕЛЬ. Второй писатель запрещён, а
 * `openNetworkDb` при первом открытии применяет миграции и чистит
 * `object_locks` — то есть пишет. Поэтому сторож краснеет на:
 *
 *   1. записывающем SQL (INSERT/UPDATE/DELETE/DROP/ALTER) в файлах пула;
 *   2. вызове `openNetworkDb(` в воркере (своё соединение он открывает сам,
 *      `readonly: true`, с профилем прагм);
 *   3. оркестрации записи (`runWrite`/`emitDomainEvent`) в пуле и воркере.
 *
 * Дополнительно (позитивная проверка) тест требует, чтобы соединение воркера
 * открывалось `readonly: true` и получало единый профиль прагм — иначе
 * «читатель» однажды превратится в второго писателя тихо.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WORKER_FILE = 'db/reader-worker.ts';
const POOL_FILE = 'db/reader-pool.ts';

/** Файл — один из файлов reader-пула. */
const inReaderPool = (rel: string): boolean => rel === WORKER_FILE || rel === POOL_FILE;

describe('guard: reader-пул не пишет и не запускает миграции', () => {
  it('в файлах пула нет записывающего SQL', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'no-write-sql-in-reader-pool',
        description:
          'В `db/reader-worker.ts` и `db/reader-pool.ts` запрещён записывающий ' +
          'SQL: пул — читатель, второй писатель запрещён ADR bec191e6.',
        pattern: /['"`][^'"`]*(?:INSERT|UPDATE|DELETE|DROP|ALTER)[^'"`]*['"`]/i,
        filePattern: /['"`][^'"`]*(?:INSERT|UPDATE|DELETE|DROP|ALTER)[^'"`]*['"`]/i,
        include: inReaderPool,
      },
    ]);
  });

  it('воркер не открывает сеть через openNetworkDb и не пишет через обёртку', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'worker-does-not-open-network-db',
        description:
          'Воркер открывает своё READ-ONLY соединение сам; `openNetworkDb` ' +
          'применяет миграции и чистит object_locks — это запись.',
        pattern: /openNetworkDb\(/,
        include: (rel) => rel === WORKER_FILE,
      },
      {
        name: 'no-write-orchestration-in-reader-pool',
        description:
          'Пул и воркер не оркеструют запись: `runWrite`/`emitDomainEvent` ' +
          'живут только в домене записи, а не на пути чтения.',
        pattern: /(runWrite|emitDomainEvent)\(/,
        include: inReaderPool,
      },
    ]);
  });

  it('соединение воркера открывается read-only и с единым профилем прагм', () => {
    const source = fs.readFileSync(path.join(SERVER_SRC_ROOT, WORKER_FILE), 'utf8');
    assert.match(source, /readonly:\s*true/, 'воркер обязан открывать data.db read-only');
    assert.match(source, /applyConnectionPragmas\(/, 'воркер переиспользует единый профиль прагм');
    // Паритет SQL-функций с главным соединением (ошибка 883267ea): соединение
    // воркера обязано получать тот же набор функций, что и главный поток, —
    // иначе comment-scope keyword-поиск падает «no such function: unicode_lower».
    assert.match(
      source,
      /registerQueryFunctions\(/,
      'воркер регистрирует те же SQL-функции, что и главное соединение',
    );
  });
});
