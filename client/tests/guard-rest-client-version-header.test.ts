/**
 * Сторож: заголовки версии клиента уходят во ВСЕХ запросах `RestClient`
 * (задача c3f33e6a, требование 339b507f, ADR 6ded6a87).
 *
 * Правило. Пара `Client-Id`/`Client-Version` строится только в
 * `RestClient.clientHeaders()` и подмешивается спредом в каждый объект
 * заголовков; собственный fetch каждого пути (общий движок, вложение,
 * скачивание джобы, файл журнала, печать публикации, публичные `/health`,
 * `/version`) обязан её получить. Пропуск в одном месте не виден юнит-тестам
 * других путей и проявляется в бою как `426 CLIENT_VERSION_UNSUPPORTED` на
 * изменяющем запросе — именно это и случилось при аудите задачи.
 *
 * Инвариант проверки — равенство «число вызовов fetch == число спредов
 * clientHeaders()»: один запрос — одна сборка заголовков. Мутации, которые
 * краснят сторож: убрать `...this.clientHeaders()` из любого места сборки
 * заголовков; вернуть литерал `'Client-Id'`/`'Client-Version'` мимо
 * `clientHeaders()`; добавить fetch без заголовков версии.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REST_CLIENT = path.join(CLIENT_ROOT, 'src', 'main', 'net', 'rest-client.ts');

/** Число вхождений подстроки в текст (без регулярок — литералы с кавычками). */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe('guard: Client-Id/Client-Version во всех запросах rest-client', () => {
  const source = fs.readFileSync(REST_CLIENT, 'utf8');

  it("литералы заголовков объявлены только в clientHeaders()", () => {
    assert.equal(
      occurrences(source, "'Client-Id'"),
      1,
      "литерал 'Client-Id' должен встречаться только в RestClient.clientHeaders()",
    );
    assert.equal(
      occurrences(source, "'Client-Version'"),
      1,
      "литерал 'Client-Version' должен встречаться только в RestClient.clientHeaders()",
    );
  });

  it('каждый fetch собирает заголовки через clientHeaders()', () => {
    const fetchCalls = occurrences(source, 'this.fetchImpl(');
    const headerSpreads = occurrences(source, '...this.clientHeaders()');
    assert.ok(fetchCalls > 0, 'в rest-client.ts должен быть хотя бы один запрос');
    assert.equal(
      headerSpreads,
      fetchCalls,
      `запросов ${fetchCalls}, а спредов clientHeaders() ${headerSpreads}: каждый fetch обязан нести Client-Id/Client-Version`,
    );
  });
});
