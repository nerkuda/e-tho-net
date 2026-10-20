/**
 * Состав контекстного меню строки свойства (0.14.1, задача 92172035,
 * требование 53701739). Матрица по состоянию строки:
 *
 *  - системные («Родители»/«Потомки») — меню нет;
 *  - типовая — «Изменить», «Очистить», «Исключить» с источниками привязки;
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
  excludeRowLabel,
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
    sources: [],
    ...overrides,
  };
}

describe('меню строки свойства: состав по состоянию (92172035)', () => {
  it('типовая скалярная строка: изменить, очистить, исключить с источником', () => {
    const items = propertyRowMenuItems(
      state({ typed: true, sources: ['квартира'] }),
      actions(),
    );
    assert.deepEqual(
      items.map((item) => item.label),
      [
        PROPERTY_ROW_MENU_LABELS.edit,
        PROPERTY_ROW_MENU_LABELS.clear,
        'Исключить из типовых свойств — привязано в „квартира“',
      ],
    );
    assert.ok(!items.some((item) => item.danger === true), 'у типовой нет удаления');
  });

  it('типовая связь: подпись исключения перечисляет все привязки цепочки', () => {
    const items = propertyRowMenuItems(
      state({ typed: true, sources: ['недвижимость', 'квартира'] }),
      actions(),
    );
    assert.equal(
      items.at(-1)?.label,
      'Исключить из типовых свойств — привязано в „недвижимость“, „квартира“',
    );
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

  it('подпись исключения без источников — базовая', () => {
    assert.equal(excludeRowLabel([]), PROPERTY_ROW_MENU_LABELS.exclude);
  });
});
