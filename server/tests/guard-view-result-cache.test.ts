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

  it('write-пул инвалидирует кэш в главном потоке', () => {
    const source = readSource('domain/heavy-write.ts');
    assert.match(
      source,
      /bumpNetworkDataVersion\(/,
      'после ответа writer-воркера главный поток обязан отметить изменение сети',
    );
  });

  it('домен отборов читает и пишет кэш', () => {
    const source = readSource('domain/thought-type-views-service.ts');
    assert.match(source, /lookupViewResult\(/, 'домен обязан сначала смотреть в кэш');
    assert.match(source, /storeViewResult\(/, 'успешный результат обязан попадать в кэш');
  });
});
