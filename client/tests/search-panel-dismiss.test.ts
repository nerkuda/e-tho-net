/**
 * Закрытие выпадающей панели строки поиска карты (ошибка 72a06e01).
 *
 * Контракт (элемент интерфейса «Строка поиска вида «Карта мыслей»»):
 * при изменении отбора он применяется к результатам, а панель скрывается
 * ТОЛЬКО по `Escape` или клику вне панели — клик по всплывающему слою,
 * открытому из панели (общая выпадашка подсказок в `document.body`, модальный
 * диалог), панель не закрывает. Иначе нажатие на строку подсказки прячет
 * панель, поле теряет фокус, список подсказок исчезает до `click` — выбранный
 * тип (фокус, тип связи) не доезжает до отбора.
 *
 * Политика закрытия — чистая функция `searchPanelClosesOnTap`
 * (`lib/pure.ts`), поэтому её таблица истинности проверяется напрямую;
 * подключение слоёв в обработчике панели — по якорям исходника (клиентские
 * тесты идут без jsdom, см. конвенцию в соседних тестах).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { searchPanelClosesOnTap } from '../src/renderer/lib/pure.js';

const SEARCH_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'search', 'search.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('политика закрытия панели поиска (ошибка 72a06e01)', () => {
  it('клик вне панели и вне всплывающих слоёв закрывает панель', () => {
    assert.equal(
      searchPanelClosesOnTap({ insidePanel: false, insideSuggest: false, insideDialog: false }),
      true,
    );
  });

  it('клик внутри панели, выпадашки подсказок или диалога панель не закрывает', () => {
    assert.equal(
      searchPanelClosesOnTap({ insidePanel: true, insideSuggest: false, insideDialog: false }),
      false,
      'сама панель (в т.ч. поле поиска и шестерёнка)',
    );
    assert.equal(
      searchPanelClosesOnTap({ insidePanel: false, insideSuggest: true, insideDialog: false }),
      false,
      'строка общей выпадашки подсказок — выбор типа/фокуса/связи',
    );
    assert.equal(
      searchPanelClosesOnTap({ insidePanel: false, insideSuggest: false, insideDialog: true }),
      false,
      'модальный диалог, открытый из панели',
    );
  });

  it('обработчик панели кормит политику всеми тремя слоями', () => {
    const src = readText(SEARCH_TS);
    assert.match(
      src,
      /searchPanelClosesOnTap\(\{[\s\S]*?insidePanel:[\s\S]*?insideSuggest: isInsideSuggestDropdown\(target\),[\s\S]*?insideDialog: isInsideDialog\(target\),/,
      'обработчик pointerdown обязан учитывать панель, выпадашку подсказок и диалог',
    );
    assert.match(
      src,
      /import \{ isInsideSuggestDropdown \} from '\.\.\/lib\/suggest-dropdown\.js';/,
      'слой выпадашки берётся у её общего модуля, а не распознаётся классом на месте',
    );
    assert.match(
      src,
      /import \{ isInsideDialog \} from '\.\.\/lib\/dialog\.js';/,
      'слой диалога берётся у общего модуля диалогов',
    );
  });

  it('Escape остаётся вторым путём закрытия (в поле и вне него)', () => {
    const src = readText(SEARCH_TS);
    // Esc в поле поиска.
    assert.match(
      src,
      /else if \(event\.key === 'Escape'\) \{[\s\S]*?hidePanel\(\);[\s\S]*?input\.blur\(\);/,
      'Esc в поле прячет панель и снимает фокус',
    );
    // Esc при видимой панели, даже если фокус ушёл.
    assert.match(
      src,
      /if \(event\.key === 'Escape' && !host\.classList\.contains\('hidden'\)\) \{[\s\S]*?hidePanel\(\);/,
      'Esc при видимой панели закрывает её независимо от фокуса',
    );
  });
});

describe('изменение отбора применяется к результатам (ошибка 72a06e01)', () => {
  it('типы мыслей и связей — чип-поля общего пикера, набор хранится массивом', () => {
    const src = readText(SEARCH_TS);
    assert.equal(
      (src.match(/buildEntityChipField\(\{/g) ?? []).length,
      3,
      'три поля собраны общим чип-полем: типы мыслей, типы связей и мысли-подкорни (задача a3247f84)',
    );
    assert.match(
      src,
      /onChange: \(values\) => \{\s*options\.typeIds = values;\s*persistState\(\);\s*refreshSearchIfVisible\(\);/,
      'выбор типов мыслей пишется в отбор массивом и сразу применяется',
    );
    assert.match(
      src,
      /onChange: \(values\) => \{\s*options\.linkTypeIds = values;\s*persistState\(\);\s*refreshSearchIfVisible\(\);/,
      'выбор типов связей пишется в отбор массивом и сразу применяется',
    );
  });

  it('остальные настройки применяются тем же путём (сохранение + перезапрос)', () => {
    const src = readText(SEARCH_TS);
    const applies = src.match(/persistState\(\);\s*refreshSearchIfVisible\(\);/g) ?? [];
    // Мысли-подкорни (поле и флажок), типы мыслей, типы связей, автор,
    // редактор и общий обработчик пяти флажков мест поиска (перекомпоновка
    // зоны настроек, задача a3247f84: прежде — свой обработчик на каждую
    // группу результатов).
    assert.ok(
      applies.length >= 7,
      `каждое изменение настройки обязано сохраняться и перезапрашивать результаты (найдено ${applies.length})`,
    );
  });
});
