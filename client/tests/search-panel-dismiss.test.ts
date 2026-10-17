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
import { isInsideMenu } from '../src/renderer/lib/menu.js';

const SEARCH_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'search', 'search.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('слой меню для панели поиска (задача 4b1cc3d4)', () => {
  it('isInsideMenu: строка меню и подменю — внутри слоя, посторонний узел — нет', () => {
    // Цель события — DOM-узел с `closest`; в тестах без jsdom подменяем его
    // минимальной заглушкой (та же конвенция, что у соседних проверок слоёв).
    const withClosest = (match: boolean): EventTarget =>
      ({ closest: (sel: string): object | null => (match && sel === '.menu' ? {} : null) }) as unknown as EventTarget;
    assert.equal(isInsideMenu(withClosest(true)), true, 'строка меню — внутри слоя');
    assert.equal(isInsideMenu(withClosest(true)), true, 'строка подменю — внутри слоя');
    assert.equal(isInsideMenu(withClosest(false)), false, 'посторонний узел — вне слоя');
    assert.equal(isInsideMenu(null), false, 'нет цели — вне слоя');
  });
});

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
    assert.equal(
      searchPanelClosesOnTap({
        insidePanel: false,
        insideSuggest: false,
        insideDialog: false,
        insideFloating: true,
      }),
      false,
      'всплывающая панель lib/ui — список выбора редактора отбора (ошибка 50d9bf4e п. B1)',
    );
    assert.equal(
      searchPanelClosesOnTap({
        insidePanel: false,
        insideSuggest: false,
        insideDialog: false,
        insideMenu: true,
      }),
      false,
      'строка МЕНЮ, открытого из панели (подменю «Добавить отбор…», задача 4b1cc3d4)',
    );
  });

  it('обработчик панели кормит политику всеми пятью слоями', () => {
    const src = readText(SEARCH_TS);
    assert.match(
      src,
      /searchPanelClosesOnTap\(\{[\s\S]*?insidePanel:[\s\S]*?insideSuggest: isInsideSuggestDropdown\(target\),[\s\S]*?insideDialog: isInsideDialog\(target\),[\s\S]*?insideFloating: isInsidePopover\(target\),[\s\S]*?insideMenu: isInsideMenu\(target\),/,
      'обработчик pointerdown обязан учитывать панель, выпадашку подсказок, диалог, всплывающие панели и меню',
    );
    assert.match(
      src,
      /import \{ isInsidePopover \} from '\.\.\/lib\/ui\/popover\.js';/,
      'слой всплывающих панелей берётся у их общего модуля, а не распознаётся классом на месте',
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
    // Слой меню — у общего модуля меню (не распознаётся классом на месте):
    // самовольная проверка `.menu` в вызывающем коде разошлась бы с разметкой
    // меню (задача 4b1cc3d4).
    assert.match(
      src,
      /import \{ menuAction, isInsideMenu, showMenuAt \} from '\.\.\/lib\/menu\.js';/,
      'слой меню берётся у общего модуля меню',
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
  it('корпусные поля зоны сняты, мыслевые — строки единого редактора', () => {
    const src = readText(SEARCH_TS);
    // Решение заказчика (2026-10-15, задача 4b1cc3d4): поля «Ограничения»
    // (тип связи), «Автор» и «Редактор» убраны с панели СОВСЕМ — их фильтрация
    // хитов объявлена осознанной потерей; чип-полей и селектов пользователей в
    // зоне больше нет.
    assert.equal(
      (src.match(/buildEntityChipField\(\{/g) ?? []).length,
      0,
      'чип-полей ограничений в зоне нет',
    );
    assert.ok(!src.includes('buildUserSelectWidget'), 'селектов «Автор»/«Редактор» нет');
    assert.ok(!src.includes("span('Ограничения:'"), 'строки «Ограничения» нет');
    assert.match(src, /buildFilterEditor\(\{/, 'мыслевые настройки монтирует единый редактор');
    // Места поиска (области FTS) — единственная плоская строка зоны; она
    // сохраняется и сразу применяется.
    assert.match(
      src,
      /onChange: \(checked\) => \{\s*options = \{ \.\.\.options, \[key\]: checked \};\s*persistState\(\);\s*refreshSearchIfVisible\(\);/,
      'флажки мест поиска пишутся в отбор и сразу применяются',
    );
  });

  it('остальные настройки применяются тем же путём (сохранение + перезапрос)', () => {
    const src = readText(SEARCH_TS);
    const applies = src.match(/persistState\(\);\s*refreshSearchIfVisible\(\);/g) ?? [];
    // Флажки мест поиска, правка мыслевых условий в редакторе (структурная и
    // значения) и быстрые команды «Добавить отбор…» (задача 4b1cc3d4) — все
    // сохраняются и перезапрашивают результаты.
    assert.ok(
      applies.length >= 4,
      `каждое изменение настройки обязано сохраняться и перезапрашивать результаты (найдено ${applies.length})`,
    );
  });
});
