/**
 * Сторож раскладки двухколоночных таблиц свойств (ошибка 2012f46b, версия 0.8.2).
 *
 * Правило: колонке значения таблицы свойств «имя → значение» задаёт ширину
 * сама таблица, а не её содержимое. Подпись чипа однострочная (`nowrap` +
 * `text-overflow: ellipsis`), поэтому её min-content равен полной ширине имени;
 * при `table-layout: auto` min-content содержимого побеждает ширину панели,
 * таблица раздувается и вместо обрезки имени появляется горизонтальная
 * прокрутка (`min-width: 0` этого не снимает — ошибка 10ad23d1).
 *
 * Что проверяется:
 * 1. Обе двухколоночные таблицы свойств редактора (`editor/properties.ts`)
 *    собираются с классом-модификатором `prop-grid` — литерал таблицы без
 *    модификатора запрещён. Многостолбцовые таблицы свойств типа и выбора
 *    мыслей живут в других файлах и намеренно остаются на auto-раскладке.
 * 2. `styles.css` держит приём: `table-layout: fixed` у `.prop-grid` (колонка
 *    значения получает остаток ширины панели), снятый пол 220px у
 *    `.link-value-wrap` внутри грида (в фиксированной раскладке он только
 *    выталкивает поле за колонку) и сжатие чип-редактора внетипового значения
 *    внутри flex-строки `.prop-outside-cell`.
 *
 * Сторож подключён зелёным — в том же изменении, которое устраняет ошибку
 * (мета-стандарт «Правило без теста-сторожа не считается введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);
const STYLES_CSS = path.join(RENDERER_ROOT, 'styles.css');
const PROPERTIES_TS = path.join(RENDERER_ROOT, 'editor', 'properties.ts');

/**
 * Тело CSS-правила по точному селектору: строка, начинающаяся селектором и
 * `{`, до закрывающей `}` на своём уровне. Комментарии над правилом не
 * задеваются — они не начинаются с селектора.
 */
function cssRuleBody(css: string, selector: string): string {
  const lines = css.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith(`${selector} {`));
  assert.notEqual(start, -1, `в styles.css нет правила «${selector}»`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '}') break;
    body.push(lines[i]!);
  }
  return body.join('\n');
}

describe('сторож раскладки таблиц свойств (prop-grid, ошибка 2012f46b)', () => {
  it('обе двухколоночные таблицы свойств объявляют prop-grid', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'property-table-without-grid',
        description:
          'двухколоночная таблица свойств без класса prop-grid: ' +
          'auto-раскладка раздувает таблицу nowrap-именем чипа (ошибка 2012f46b)',
        pattern: /'table-list prop-(?:table|outside-table)'/,
        include: (rel) => rel === 'editor/properties.ts',
      },
    ]);
    const source = fs.readFileSync(PROPERTIES_TS, 'utf8');
    // Обе таблицы — и основная, и «Свойства вне типа» — на фиксированной
    // раскладке; модификатор объявляется литералом класса рядом с таблицей.
    assert.equal(
      (source.match(/'table-list prop-(?:table|outside-table) prop-grid'/g) ?? []).length,
      2,
      'prop-grid объявлен у обеих таблиц свойств',
    );
  });

  it('styles.css задаёт колонке значения определённую ширину на уровне таблицы', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    assert.match(
      cssRuleBody(css, '.prop-grid'),
      /table-layout:\s*fixed/,
      'фиксированная раскладка колонок — иначе min-content чипа побеждает панель',
    );
    assert.match(
      cssRuleBody(css, '.prop-grid > tbody > tr > td:first-child'),
      /width:\s*\d+px/,
      'колонке имени задан предел — остаток ширины достаётся колонке значения',
    );
  });

  it('внутри грида снят пол поля значения, а чип внетипового значения сжимается', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    // Пол 220px — страховка auto-раскладки (ошибка 10ad23d1); в фиксированной
    // он выталкивает поле за колонку и возвращает прокрутку на узких панелях.
    assert.match(
      cssRuleBody(css, '.prop-grid .link-value-wrap'),
      /min-width:\s*0/,
      'в гриде пол 220px у .link-value-wrap не нужен',
    );
    const outside = cssRuleBody(css, '.prop-outside-cell > .link-value-editor');
    assert.match(outside, /flex:\s*1 1 auto/, 'чип-редактор обязан сжиматься по колонке');
    assert.match(outside, /min-width:\s*0/, 'без min-width:0 flex-строка не даст сжаться');
  });
});
