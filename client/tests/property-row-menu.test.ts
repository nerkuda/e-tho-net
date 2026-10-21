/**
 * Состав контекстного меню строки свойства (0.14.1, задача 92172035,
 * требование 53701739). Матрица по состоянию строки:
 *
 *  - системные («Родители»/«Потомки») — меню нет;
 *  - типовая — «Изменить», «Очистить», «Исключить» (без хвоста-подписи);
 *  - внетиповая — «Изменить», «Очистить», «Перенести» (у мысли с типом),
 *    «Удалить»;
 *  - легаси-ребро без реестрового свойства — «Очистить», «Удалить».
 *
 * Модуль чистый, поэтому матрица проверяется без DOM; действия — заглушки,
 * проверяется только их привязка к пунктам.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROPERTY_ROW_MENU_LABELS,
  propertyRowMenuItems,
  type PropertyRowMenuActions,
  type PropertyRowMenuState,
} from '../src/renderer/editor/property-row-menu.js';

function actions(log: string[] = []): PropertyRowMenuActions {
  return {
    edit: () => log.push('edit'),
    clear: () => log.push('clear'),
    promote: () => log.push('promote'),
    exclude: () => log.push('exclude'),
    remove: () => log.push('remove'),
  };
}

function state(overrides: Partial<PropertyRowMenuState> = {}): PropertyRowMenuState {
  return {
    structural: false,
    typed: false,
    hasType: true,
    hasRegistryProperty: true,
    ...overrides,
  };
}

describe('меню строки свойства: состав по состоянию (92172035)', () => {
  it('типовая скалярная строка: изменить, очистить, исключить (без хвоста)', () => {
    const items = propertyRowMenuItems(state({ typed: true }), actions());
    assert.deepEqual(
      items.map((item) => item.label),
      [
        PROPERTY_ROW_MENU_LABELS.edit,
        PROPERTY_ROW_MENU_LABELS.clear,
        PROPERTY_ROW_MENU_LABELS.exclude,
      ],
    );
    assert.ok(!items.some((item) => item.danger === true), 'у типовой нет удаления');
  });

  it('типовая связь: подпись исключения — без источников привязки', () => {
    const items = propertyRowMenuItems(state({ typed: true }), actions());
    assert.equal(items.at(-1)?.label, PROPERTY_ROW_MENU_LABELS.exclude);
  });

  it('внетиповая строка у мысли с типом: есть перенос и удаление', () => {
    const items = propertyRowMenuItems(state({ typed: false }), actions());
    assert.deepEqual(
      items.map((item) => item.label),
      [
        PROPERTY_ROW_MENU_LABELS.edit,
        PROPERTY_ROW_MENU_LABELS.clear,
        PROPERTY_ROW_MENU_LABELS.promote,
        PROPERTY_ROW_MENU_LABELS.remove,
      ],
    );
    assert.equal(items.at(-1)?.danger, true, 'удаление — опасный пункт');
    assert.ok(!items.some((item) => item.label.startsWith('Исключить')), 'исключения нет');
  });

  it('у мысли без типа «Перенести» скрыт', () => {
    const items = propertyRowMenuItems(state({ typed: false, hasType: false }), actions());
    assert.ok(!items.some((item) => item.label === PROPERTY_ROW_MENU_LABELS.promote));
    assert.ok(items.some((item) => item.label === PROPERTY_ROW_MENU_LABELS.remove));
  });

  it('системная строка: меню не строится', () => {
    assert.deepEqual(propertyRowMenuItems(state({ structural: true }), actions()), []);
  });

  it('легаси-ребро без реестрового свойства: только очистить и удалить', () => {
    const items = propertyRowMenuItems(
      state({ typed: false, hasRegistryProperty: false }),
      actions(),
    );
    assert.deepEqual(
      items.map((item) => item.label),
      [PROPERTY_ROW_MENU_LABELS.clear, PROPERTY_ROW_MENU_LABELS.remove],
    );
  });

  it('пункты вызывают переданные действия', () => {
    const log: string[] = [];
    for (const item of propertyRowMenuItems(state({ typed: false }), actions(log))) {
      item.onClick?.();
    }
    assert.deepEqual(log, ['edit', 'clear', 'promote', 'remove']);
  });

  it('внетиповая строка с порядком: «выше/ниже» после «Изменить»', () => {
    const log: string[] = [];
    const items = propertyRowMenuItems(state({ typed: false, reorder: { index: 1, count: 3 } }), {
      ...actions(),
      move: (from, to) => log.push(`${from}->${to}`),
    });
    assert.deepEqual(
      items.map((item) => item.label),
      [
        PROPERTY_ROW_MENU_LABELS.edit,
        'Переместить выше',
        'Переместить ниже',
        PROPERTY_ROW_MENU_LABELS.clear,
        PROPERTY_ROW_MENU_LABELS.promote,
        PROPERTY_ROW_MENU_LABELS.remove,
      ],
    );
    items[1]?.onClick?.();
    items[2]?.onClick?.();
    assert.deepEqual(log, ['1->0', '1->2'], 'оба пункта зовут единый onMove');
  });

  it('края порядка: «выше» недоступно на первой, «ниже» — на последней', () => {
    const first = propertyRowMenuItems(state({ typed: false, reorder: { index: 0, count: 2 } }), {
      ...actions(),
      move: () => undefined,
    });
    const last = propertyRowMenuItems(state({ typed: false, reorder: { index: 1, count: 2 } }), {
      ...actions(),
      move: () => undefined,
    });
    assert.equal(first[1]?.disabled, true, 'первая: выше disabled');
    assert.equal(first[2]?.disabled, false);
    assert.equal(last[1]?.disabled, false);
    assert.equal(last[2]?.disabled, true, 'последняя: ниже disabled');
  });

  it('типовая строка порядок не показывает (порядок задают привязки)', () => {
    const items = propertyRowMenuItems(state({ typed: true, reorder: { index: 0, count: 2 } }), {
      ...actions(),
      move: () => undefined,
    });
    assert.ok(!items.some((item) => item.label.startsWith('Переместить')), 'пунктов порядка нет');
  });
});
