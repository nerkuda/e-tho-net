/**
 * Раскладка хита-мысли в выпадашке поиска (ошибки 265cdb5f, a42ea662).
 *
 * Контракт: строка-мысль несёт облачко в ширину ВСЕГО выпадающего списка —
 * название обрезается многоточием по ней, а не по холстовой фиксированной
 * `--cloud-width` (200px), — а snippet с подсветкой вхождений (`<mark>`)
 * уходит на следующую строку под облачко. Строки связи и хронологии
 * остаются однострочными (глиф + текст).
 *
 * Регрессия родилась из перевода списков на общую фабрику облачка (1b9dccc5):
 * фабричное `.cloud` — холстовое, фиксированной ширины. Ширину «по
 * контейнеру» теперь объявляет вызов фабрики (`width: 'container'`, класс
 * `cloud-width-container`) — контекстный обход `.search-hit… > .cloud`
 * закрыт. Клиентские тесты идут без jsdom (см. конвенцию в соседних тестах),
 * поэтому контракт раскладки проверяется по якорям исходника: опция ширины в
 * модуле поиска, модификатор строки и раскладка в стилях.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

const SEARCH_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'search', 'search.ts');
const STYLES_CSS = assembledStylesFile();

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('раскладка хита-мысли в выпадашке поиска (ошибка 265cdb5f)', () => {
  it('хит-мысль помечается модификатором строки', () => {
    const src = readText(SEARCH_TS);
    assert.match(
      src,
      /if \(hit\.isThought\) row\.classList\.add\('search-hit-cloud'\);/,
      'the thought hit row must be marked (cloud spans the list, snippet below)',
    );
    // Группы мыслей (имена/тексты) и секция «Мысль по ID» — все три места.
    assert.equal(
      (src.match(/isThought: true/g) ?? []).length,
      2,
      'both thought groups (names, texts) are marked as thought hits',
    );
    assert.equal(
      (src.match(/isThought: false/g) ?? []).length,
      2,
      'links and chronology rows are NOT thought hits (single-line glyph rows)',
    );
    assert.match(
      src,
      /const row = div\('search-hit search-hit-cloud'\);/,
      'the «Мысль по ID» row carries the same modifier',
    );
  });

  it('все три облачка хита-мысли берут ширину по контейнеру (библиотечная опция)', () => {
    const src = readText(SEARCH_TS);
    assert.equal(
      (src.match(/createThoughtCloud\(/g) ?? []).length,
      3,
      'the search dropdown builds exactly three clouds (id row + two hit groups)',
    );
    assert.equal(
      (src.match(/width: 'container',/g) ?? []).length,
      3,
      'each search cloud declares the container width instead of a contextual CSS override',
    );
  });

  it('в контексте хита-мысли строка — колонка, snippet уходит под облачко', () => {
    const css = readText(STYLES_CSS);
    const block = /\.search-hit\.search-hit-cloud \{(?<body>[^}]*)\}/.exec(css);
    assert.ok(block?.groups?.['body'] !== undefined, 'the modifier rule must exist');
    const body = block.groups['body'] ?? '';
    assert.match(body, /flex-direction:\s*column;/, 'cloud above, snippet below');
    assert.match(body, /align-items:\s*stretch;/, 'the cloud must stretch to the list width');

    // Снятие холстовой ширины — только библиотечным классом, не селектором
    // этого контекста (контекстный обход закрыт сторожем guard-thought-cloud).
    assert.ok(
      !/\.search-hit\.search-hit-cloud\s*>\s*\.cloud\s*\{/.test(css),
      'no contextual width override for the cloud (use width: container)',
    );
    assert.match(css, /\.cloud-width-container\s*\{[^}]*width:\s*auto;/, 'library class rule');
  });
});
