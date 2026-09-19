/**
 * Раскладка хита-мысли в выпадашке поиска (ошибка 265cdb5f).
 *
 * Контракт: строка-мысль несёт облачко в ширину ВСЕГО выпадающего списка —
 * название обрезается многоточием по ней, а не по холстовой фиксированной
 * `--cloud-width` (200px), — а snippet с подсветкой вхождений (`<mark>`)
 * уходит на следующую строку под облачко. Строки связи и хронологии
 * остаются однострочными (глиф + текст).
 *
 * Регрессия родилась из перевода списков на общую фабрику облачка (1b9dccc5):
 * фабричное `.cloud` — холстовое, фиксированной ширины. Клиентские тесты идут
 * без jsdom (см. конвенцию в соседних тестах), поэтому контракт раскладки
 * проверяется по якорям исходника: модификатор строки в модуле поиска и
 * снимающая фиксированную ширину группа правил в стилях.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SEARCH_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'search', 'search.ts');
const STYLES_CSS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles.css');

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

  it('в контексте хита-мысли облачко растягивается по списку, snippet уходит под него', () => {
    const css = readText(STYLES_CSS);
    const block = /\.search-hit\.search-hit-cloud \{(?<body>[^}]*)\}/.exec(css);
    assert.ok(block?.groups?.['body'] !== undefined, 'the modifier rule must exist');
    const body = block.groups['body'] ?? '';
    assert.match(body, /flex-direction:\s*column;/, 'cloud above, snippet below');
    assert.match(body, /align-items:\s*stretch;/, 'the cloud must stretch to the list width');

    const cloudOverride =
      /\.search-hit\.search-hit-cloud > \.cloud \{(?<body>[^}]*)\}/.exec(css);
    assert.ok(cloudOverride?.groups?.['body'] !== undefined, 'the cloud width override must exist');
    const cloudBody = cloudOverride.groups['body'] ?? '';
    assert.match(cloudBody, /width:\s*auto;/, 'the fixed --cloud-width must be released');
    assert.match(cloudBody, /max-width:\s*100%;/, 'the cloud must not overflow the list');
  });
});
