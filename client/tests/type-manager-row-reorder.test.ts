/**
 * Таблица привязок редактора типа на row-reorder (0.14.1, задача 1425457f).
 *
 * Проверяется контракт потребителя общей компоненты:
 *  - кнопок порядка ▲/▼ в таблице привязок больше нет;
 *  - перестановка — `createRowReorder` (захват ВСЕЙ строки, без `captureOf`),
 *    навигация — `createListNav` поверх `nav-core`;
 *  - пункты «Переместить выше/ниже» — из общего словаря `rowReorderMenuItems`;
 *  - набор порядка — обе стороны привязки и скаляры (`canReorderBinding`);
 *  - порядок живёт в ЧЕРНОВИКЕ: DnD/Alt/меню не пишут на сервер, запись —
 *    на «Применить и закрыть» (проверяется `planPropertyDiff` в
 *    `type-property-draft.test.ts`).
 *
 * Клиентские тесты идут без jsdom, поэтому DOM-поведение (порядок тремя
 * способами, черновик, переоткрытие редактора) доказывается живым сценарием
 * стенда. Здесь — исходник и чистые хелперы.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { canReorderBinding, reorderDraftRows } from '../src/renderer/lib/type-property-draft.js';

const TYPE_MANAGER = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'type-manager.ts'),
  'utf8',
);

/** Строка таблицы привязок: id + сторона (все виды строк переставляются). */
function row(id: string, side: 'source' | 'target' | null): { id: string; side: 'source' | 'target' | null } {
  return { id, side };
}

describe('редактор типа на row-reorder — убрать ▲/▼ (1425457f)', () => {
  it('кнопок порядка ▲/▼ в таблице привязок нет', () => {
    assert.doesNotMatch(TYPE_MANAGER, /label:\s*'▲'/, 'кнопка «выше» удалена');
    assert.doesNotMatch(TYPE_MANAGER, /label:\s*'▼'/, 'кнопка «ниже» удалена');
  });

  it('перестановка — общая компонента row-reorder, захват не сужается', () => {
    assert.match(
      TYPE_MANAGER,
      /createRowReorder<DraftProperty>\s*\(\s*ownScroll/,
      'корень порядка — прокручиваемый контейнер таблицы привязок',
    );
    assert.match(TYPE_MANAGER, /onMove:\s*moveOwnRow/, 'все способы ведут в один колбэк');
    assert.doesNotMatch(
      TYPE_MANAGER,
      /captureOf\s*:/,
      'потребитель не сужает захват — перетаскивается вся строка',
    );
    assert.match(
      TYPE_MANAGER,
      /currentKey:\s*\(\)\s*=>\s*ownNav\?\.token\(\)/,
      'Alt+↑/↓ двигает текущую строку навигации',
    );
  });

  it('клавиатурная навигация — общий компонент списка (стандарт b6b2821d)', () => {
    assert.match(TYPE_MANAGER, /createListNav<DraftProperty>\s*\(\s*ownScroll/);
    assert.match(TYPE_MANAGER, /onActivate:\s*\(row\)\s*=>/, 'Enter активирует строку');
    assert.match(TYPE_MANAGER, /focusOwnDefault\(node\.defaultCell\)/, 'активация ведёт в редактор дефолта');
  });

  it('пункты «Переместить выше/ниже» — общий словарь порядка', () => {
    assert.match(TYPE_MANAGER, /rowReorderMenuItems\(\s*\{\s*index:\s*slot\.index/);
    assert.match(TYPE_MANAGER, /showMenuAt\(/, 'меню открывается общим словарём lib/menu');
    assert.match(TYPE_MANAGER, /reorderSlotOf\(rowId\)/, 'позиция вычисляется в момент открытия меню');
  });

  it('набор порядка — обе стороны привязки и скаляры (canReorderBinding)', () => {
    assert.match(
      TYPE_MANAGER,
      /ownDraft\.filter\(\(row\)\s*=>\s*canReorderBinding\(row\)\)/,
      'правило b044237d не сужено до стороны источника',
    );
    for (const side of ['source', 'target', null] as const) {
      assert.equal(canReorderBinding({ side }), true, `сторона ${String(side)} переставляется`);
    }
  });

  it('порядок — черновик: перестановка только меняет draft и перерисовывает', () => {
    const block = /function moveOwnRow\(from: number, to: number\): void \{([\s\S]*?)\n {2}\}/.exec(
      TYPE_MANAGER,
    );
    assert.ok(block !== null, 'moveOwnRow объявлен');
    const body = block[1] ?? '';
    assert.match(body, /reorderDraftRows\(ordered, from, to\)/, 'та же чистая перестановка');
    assert.match(body, /draftTouched = true/, 'правка помечает черновик грязным');
    assert.doesNotMatch(
      body,
      /etn\.types\.|fetch\(|properties\./,
      'на сервер во время перестановки ничего не пишется — запись на «Применить и закрыть»',
    );
  });

  it('rows не теряются и не дублируются при перестановке', () => {
    const rows = [row('s1', 'source'), row('t1', 'target'), row('n1', null)];
    const up = reorderDraftRows(rows, 1, 0);
    assert.deepEqual(up.map((r) => r.id), ['t1', 's1', 'n1']);
    const down = reorderDraftRows(rows, 2, 0);
    assert.deepEqual(down.map((r) => r.id), ['n1', 's1', 't1']);
    // Диапазон больше перестановки: каждая строка ровно один раз.
    for (const moved of [up, down]) {
      assert.deepEqual([...moved.map((r) => r.id)].sort(), ['n1', 's1', 't1']);
    }
  });
});
