/**
 * Подсветка совпадений запроса в названиях результатов поиска (задача
 * a1766c7d, 0.8.2) — чистые хелперы `lib/pure.ts`.
 *
 * Контракт:
 *  - термы подсветки берутся из запроса по тому же правилу, что у серверного
 *    сниппета (`search-service.ts`): include-слова мини-синтаксиса, `*`
 *    разворачивается в разделитель, исключения `-слово` не подсвечиваются;
 *  - в названии подсвечиваются ВСЕ вхождения любого терма без учёта регистра;
 *  - совпадения в названии нет (хит нашёлся по тексту/синониму) — название
 *    остаётся без подсветки: отрезков-hit нет вовсе.
 *
 * Клиентские тесты идут без jsdom (конвенция соседних тестов): чистая логика
 * проверяется напрямую, отрисовка `<mark>` — по якорям в dom.ts (см.
 * search-results-zone.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchHighlightTerms, splitHighlightRuns } from '../src/renderer/lib/pure.js';

/** Текст без подсветки склеивается с подстветкой обратно в исходный. */
function reconstruct(text: string, terms: readonly string[]): string {
  return splitHighlightRuns(text, terms)
    .map((run) => run.text)
    .join('');
}

describe('термы подсветки по запросу строки поиска (задача a1766c7d)', () => {
  it('одно слово — один терм; регистр сохраняется как набран', () => {
    assert.deepEqual(searchHighlightTerms('Море'), ['Море']);
    assert.deepEqual(searchHighlightTerms('  море  '), ['море']);
  });

  it('несколько слов — несколько термов, повторы схлопываются без учёта регистра', () => {
    assert.deepEqual(searchHighlightTerms('красное   море'), ['красное', 'море']);
    assert.deepEqual(searchHighlightTerms('море Море МОРЕ'), ['море']);
  });

  it('исключения `-слово` не подсвечиваются', () => {
    assert.deepEqual(searchHighlightTerms('-вода море'), ['море']);
    assert.deepEqual(searchHighlightTerms('море -вода'), ['море']);
    assert.deepEqual(searchHighlightTerms('-только-исключение'), []);
  });

  it('`*` разворачивается в разделитель, кавычки снимаются', () => {
    assert.deepEqual(searchHighlightTerms('крас*море'), ['крас', 'море']);
    assert.deepEqual(searchHighlightTerms('"счёт"'), ['счёт']);
  });

  it('пустой запрос — пустой набор термов', () => {
    assert.deepEqual(searchHighlightTerms(''), []);
    assert.deepEqual(searchHighlightTerms('   '), []);
  });
});

describe('подсветка вхождений в название (задача a1766c7d)', () => {
  it('подсвечиваются все вхождения, регистр не важен', () => {
    const runs = splitHighlightRuns('Море и море', ['море']);
    assert.deepEqual(runs, [
      { text: 'Море', hit: true },
      { text: ' и ', hit: false },
      { text: 'море', hit: true },
    ]);
  });

  it('совпадения нет — название целиком без подсветки', () => {
    const runs = splitHighlightRuns('Совсем другое название', ['море']);
    assert.deepEqual(runs, [{ text: 'Совсем другое название', hit: false }]);
    assert.equal(runs.some((run) => run.hit), false);
  });

  it('хит нашёлся по тексту, а не по названию — в названии нет ни одного hit', () => {
    // Название без совпадения, сниппет (текст комментария) сервер подсветил
    // сам — заголовок облачка остаётся чистым.
    const runs = splitHighlightRuns('Мысль о погоде', ['шторм']);
    assert.deepEqual(runs, [{ text: 'Мысль о погоде', hit: false }]);
  });

  it('несколько термов подсвечиваются каждый по отдельности', () => {
    const runs = splitHighlightRuns('Красное море, красный закат', ['красн', 'море']);
    assert.deepEqual(runs, [
      { text: 'Красн', hit: true },
      { text: 'ое ', hit: false },
      { text: 'море', hit: true },
      { text: ', ', hit: false },
      { text: 'красн', hit: true },
      { text: 'ый закат', hit: false },
    ]);
  });

  it('пересекающиеся совпадения сливаются в один отрезок', () => {
    assert.deepEqual(splitHighlightRuns('абвгд', ['абв', 'вгд']), [
      { text: 'абвгд', hit: true },
    ]);
  });

  it('пустые термы и пустой текст безопасны', () => {
    assert.deepEqual(splitHighlightRuns('море', []), [{ text: 'море', hit: false }]);
    assert.deepEqual(splitHighlightRuns('море', ['']), [{ text: 'море', hit: false }]);
    assert.deepEqual(splitHighlightRuns('', ['море']), [{ text: '', hit: false }]);
  });

  it('отрезки склеиваются обратно в исходный текст', () => {
    for (const [text, terms] of [
      ['Море и море', ['море']],
      ['Счётчик счёта счётом', ['счёт']],
      ['Красное море', ['красн', 'море']],
      ['Ничего', ['море']],
      ['', ['море']],
    ] as Array<[string, string[]]>) {
      assert.equal(reconstruct(text, terms), text);
    }
  });
});
