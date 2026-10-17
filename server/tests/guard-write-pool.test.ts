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

  it('переведённый op идёт в пул: главный поток не исполняет батч сам', () => {
    /** Строка — комментарий (упоминание вызова в пояснении не является вызовом). */
    const inComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'no-direct-write-thoughts-outside-pool',
        description:
          'Батч-запись мыслей (`etn.thoughts.write`) идёт через write-пул: доменная ' +
          'функция вызывается только из композиции op, а её исполняет воркер или ' +
          'синхронный путь фасада (задача c8920d04, ADR ca3a9218). Прямой вызов из ' +
          'фасада (MCP/REST) вернул бы запись в главный поток в обход пула.',
        pattern: /writeThoughts\(/,
        allow: (rel, line) =>
          inComment(line) ||
          rel === 'domain/thought-write-service.ts' ||
          rel === 'domain/write-ops.ts',
      },
      {
        name: 'no-direct-create-thought-outside-pool',
        description:
          'REST-создание мысли (`POST /thoughts`) исполняется в write-пуле через фасад ' +
          '`runThoughtCreate`: доменная функция `createThought` вызывается только из ' +
          'композиции op (`domain/write-ops.ts`) и из домена. Прямой вызов из роута вернул ' +
          'бы массовую запись GUI-клиента в главный поток в обход пула (задача c744e05c).',
        pattern: /createThought\(/,
        allow: (rel, line) =>
          inComment(line) || rel.startsWith('domain/'),
      },
      {
        name: 'no-direct-run-write-task-outside-facade',
        description:
          'Выбор «пул или главный поток» — единственная точка фасада ' +
          '(`domain/heavy-write.ts`): фасады транспортов не диспетчеризуют задачи сами.',
        pattern: /runWriteTask\(/,
        allow: (rel, line) =>
          inComment(line) || rel === 'db/write-pool.ts' || rel === 'domain/heavy-write.ts',
      },
      {
        name: 'no-direct-thoughts-batch-outside-pool',
        description:
          'Батчевая операция REST-пути `POST /thoughts/batch` идёт через write-пул ' +
          '(фасад `runThoughtsBatch`): композиция исхода — `domain/write-ops.ts` ' +
          '(`composeThoughtBatch`), доменные батч-функции вызываются только из неё. ' +
          'Прямой вызов из роута вернул бы массовую запись в главный поток в обход ' +
          'пула (задача b9c70dd8).',
        pattern: /applyBulkThoughtOp\(|composeThoughtBatch\(/,
        // Фасады транспортов: REST-роуты и MCP-инструменты обязаны звать
        // фасад `runThoughtsBatch`, а не композицию/домен напрямую (задача
        // dba7fabc перевела MCP `bulk_update` на пул).
        include: (rel) => rel.startsWith('routes/') || rel.startsWith('mcp/tools/'),
        allow: (rel, line) => inComment(line),
      },
      {
        name: 'no-direct-copy-batch-outside-pool',
        description:
          'Пакетное копирование REST-пути `POST /thoughts/copy-batch` идёт через ' +
          'write-пул (фасад `runThoughtsCopy`): `copyThoughtsBatch` и планировщик ' +
          'файлов вызываются только из `domain/write-ops.ts`. Прямой вызов из роута ' +
          'вернул бы пакетное создание в главный поток в обход пула (задача b9c70dd8).',
        pattern: /copyThoughtsBatch\(|makeCopyFileCopier\(|composeThoughtCopyOutcome\(/,
        // Фасады транспортов: домен (в т.ч. copy_subtree) и write-ops —
        // легальные места вызова.
        include: (rel) => rel.startsWith('routes/') || rel.startsWith('mcp/tools/'),
        allow: (rel, line) => inComment(line),
      },
    ]);
  });

  it('батч-пути роутов идут через фасады write-пула, а не напрямую', () => {
    // Маршруты батчей обязаны звать фасады `domain/heavy-write.ts`: только они
    // решают «пул или главный поток» (задача b9c70dd8).
    const routes = readSource('routes/thoughts.ts');
    for (const needle of ['runThoughtsBatch(', 'runThoughtsCopy(']) {
      assert.ok(
        routes.includes(needle),
        `роут обязан вызывать фасад «${needle}»: иначе батч исполняется в главном ` +
          'потоке в обход write-пула.',
      );
    }
  });

  it('MCP bulk_update идёт через фасад write-пула, а не напрямую', () => {
    // Обязательство-комплемент запрету выше: MCP-тул обязан звать
    // `runThoughtsBatch` — только фасад решает «пул или главный поток»
    // (задача dba7fabc, ADR ca3a9218).
    const tools = readSource('mcp/tools/thoughts-write.ts');
    assert.ok(
      tools.includes('runThoughtsBatch('),
      'MCP `etn.thoughts.bulk_update` обязан вызывать фасад «runThoughtsBatch(»: ' +
        'иначе батч исполняется в главном потоке в обход write-пула.',
    );
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
