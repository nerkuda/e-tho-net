/**
 * Сторож кэша результатов отборов (задача 3f2b0958, стандарт f36a5207).
 *
 * Введённое правило: у результатов `views/run` ОДИН кэш (доменный
 * `view-result-cache`), и любая семантическая запись сети обязана его
 * инвалидировать. Правило без сторожа не считается введённым.
 *
 * Сторож краснеет, если:
 *   1. кэш/счётчик поколений используют в обход `domain/view-result-cache.ts` —
 *      второй кэш разошёлся бы с инвалидацией;
 *   2. обёртка записи (`runWriteCore`) перестала двигать счётчик сети;
 *   3. фасад write-пула перестал инвалидировать кэш в главном потоке (в
 *      воркере свой модульный счётчик, главный поток его не видит);
 *   4. домен отборов перестал читать/писать кэш.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файлы, которым разрешено знать про модуль кэша. */
const CACHE_USERS = new Set([
  'domain/view-result-cache.ts',
  'domain/thought-type-views-service.ts',
  'domain/write-wrapper.ts',
  'domain/heavy-write.ts',
]);

/**
 * Точки входа записи фасада `heavy-write.ts`, переведённые на writer-задачи.
 * Каждая обязана идти через единый helper инвалидации — иначе бамп на одном из
 * путей можно снять незаметно (замечание независимой проверки 3f2b0958).
 */
const WRITE_PATHS = [
  'runThoughtsWrite',
  'runThoughtCreate',
  'runThoughtsBatch',
  'runThoughtsCopy',
] as const;

/** Имя helper'а, в котором живёт единственный бамп поколения кэша. */
const INVALIDATION_HELPER = 'runWriteTaskWithInvalidation';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SERVER_SRC_ROOT, relativePath), 'utf8');
}

describe('guard: кэш результатов отборов — единая точка и обязательная инвалидация', () => {
  it('модуль кэша не импортируют в обход разрешённых точек', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'single-view-result-cache',
        description:
          'Кэш результатов отборов и его счётчик поколений живут только в ' +
          '`domain/view-result-cache.ts`; читать/писать их могут только домен ' +
          'отборов и центральные пути записи, иначе второй кэш разойдётся с ' +
          'инвалидацией (задача 3f2b0958).',
        pattern: /view-result-cache\.js/,
        include: (rel) => !CACHE_USERS.has(rel),
      },
    ]);
  });

  it('обёртка записи инвалидирует кэш после коммита, изменившего данные', () => {
    const source = readSource('domain/write-wrapper.ts');
    assert.match(
      source,
      /bumpNetworkDataVersion\(/,
      'runWriteCore обязан двигать поколение кэша после записи',
    );
    assert.match(
      source,
      /totalChanges\(\)/,
      'инвалидация обязана опираться на факт изменения данных, а не на вызов обёртки',
    );
    // Снимок «до» должен быть взят до транзакции, сравнение — после.
    const before = source.indexOf('const changesBefore');
    const transaction = source.indexOf('ndb.transaction(');
    const bump = source.indexOf('bumpNetworkDataVersion(');
    assert.ok(before !== -1 && transaction !== -1 && bump !== -1);
    assert.ok(before < transaction && transaction < bump, 'порядок: снимок → транзакция → инвалидация');
  });

  it('write-пул инвалидирует кэш в главном потоке через единый helper', () => {
    const source = readSource('domain/heavy-write.ts');

    // 1. Бамп поколения — ровно в одном месте — внутри helper'а.
    const bumps = [...source.matchAll(/bumpNetworkDataVersion\s*\(/g)];
    assert.equal(bumps.length, 1, 'инвалидация обязана жить в единственном месте');
    const helperStart = source.indexOf(`async function ${INVALIDATION_HELPER}(`);
    assert.ok(helperStart >= 0, `helper ${INVALIDATION_HELPER} обязан существовать`);
    assert.ok(
      (bumps[0]?.index ?? -1) > helperStart,
      'единственный бамп обязан находиться внутри helper\'а',
    );

    // 2. Прямой вызов runWriteTask допустим только внутри helper'а: все
    //    writer-задачи фасада идут через обёртку с инвалидацией.
    const directCalls = [...source.matchAll(/\brunWriteTask\s*\(/g)];
    assert.equal(directCalls.length, 1, 'все writer-задачи обязаны идти через helper');
    assert.ok(
      (directCalls[0]?.index ?? -1) > helperStart,
      'прямой runWriteTask вне helper\'а обошёл бы инвалидацию',
    );

    // 3. Каждый путь записи вызывает helper (мутация «обойти helper на одном
    //    пути» обязана краснить этот тест).
    for (const path of WRITE_PATHS) {
      const start = source.indexOf(`export async function ${path}(`);
      assert.ok(start >= 0, `путь записи ${path} не найден`);
      const next = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, next === -1 ? source.length : next);
      assert.match(
        body,
        new RegExp(`${INVALIDATION_HELPER}\\(`),
        `${path} обязан идти через ${INVALIDATION_HELPER}: иначе коммит воркера не инвалидирует кэш`,
      );
    }
  });

  it('домен отборов читает и пишет кэш', () => {
    const source = readSource('domain/thought-type-views-service.ts');
    assert.match(source, /lookupViewResult\(/, 'домен обязан сначала смотреть в кэш');
    assert.match(source, /storeViewResult\(/, 'успешный результат обязан попадать в кэш');
  });
});
