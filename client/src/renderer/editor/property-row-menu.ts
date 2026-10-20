/**
 * Состав контекстного меню имени строки свойства на вкладке «Свойства»
 * (0.14.1, задача 92172035, требование 53701739). Пункты собираются только
 * конструкторами общего словаря `lib/menu.ts` — самодельных `{ label }` здесь
 * нет (сторож `guard-canvas-menu-dictionary`).
 *
 * Состав зависит от состояния строки:
 *  - системная («Родители»/«Потомки») — меню нет;
 *  - типовая — «Изменить», «Очистить», «Исключить из типовых свойств»
 *    (подпись перечисляет источники привязки);
 *  - внетиповая — «Изменить», «Очистить», «Перенести в типовые свойства»
 *    (только у мысли с типом), «Удалить»;
 *  - легаси-ребро без реестрового свойства (property_id пуст) — «Изменить» и
 *    «Перенести» недоступны, остаются «Очистить» и «Удалить».
 *
 * Модуль чистый: действия приходят извне, поэтому матрицу состава проверяют
 * юнит-тесты без DOM.
 */

import { menuAction, type MenuItem } from '../lib/menu.js';
import { rowReorderMenuItems } from '../lib/row-reorder.js';

/** Состояние строки, от которого зависит состав меню. */
export interface PropertyRowMenuState {
  /** Системная строка «Родители»/«Потомки» — меню не строится. */
  structural: boolean;
  /** Строка группы «Свойства типа» (эффективное определение). */
  typed: boolean;
  /** У владельца есть тип (у мысли без типа «Перенести» скрыт). */
  hasType: boolean;
  /** У свойства есть реестровая запись (легаси-ребро — нет). */
  hasRegistryProperty: boolean;
  /** Источники привязки для подписи «Исключить» (имена типов). */
  sources: readonly string[];
  /**
   * Позиция строки среди переупорядочиваемых внетиповых строк (0.14.1,
   * задача 2e87285b). Задана только у строки, которую можно двигать;
   * пункты «Переместить выше/ниже» собирает `rowReorderMenuItems`.
   */
  reorder?: { index: number; count: number };
}

/** Действия меню. Вызывающие оборачивают async-операции сами. */
export interface PropertyRowMenuActions {
  edit: () => void;
  clear: () => void;
  promote: () => void;
  exclude: () => void;
  remove: () => void;
  /** Единый колбэк перестановки строки (тот же, что у `createRowReorder`). */
  move?: (from: number, to: number) => void;
}

/** Подписи пунктов — единый источник для меню и тестов. */
export const PROPERTY_ROW_MENU_LABELS = {
  edit: 'Изменить свойство',
  clear: 'Очистить',
  promote: 'Перенести в типовые свойства',
  exclude: 'Исключить из типовых свойств',
  remove: 'Удалить',
} as const;

/**
 * Подпись «Исключить…» с источниками привязки: «привязано в „недвижимости“»
 * или перечислением. Без источников — базовая подпись.
 */
export function excludeRowLabel(sources: readonly string[]): string {
  if (sources.length === 0) return PROPERTY_ROW_MENU_LABELS.exclude;
  const list = sources.map((source) => `„${source}“`).join(', ');
  return `${PROPERTY_ROW_MENU_LABELS.exclude} — привязано в ${list}`;
}

/** Собирает пункты меню строки свойства по её состоянию. */
export function propertyRowMenuItems(
  state: PropertyRowMenuState,
  actions: PropertyRowMenuActions,
): MenuItem[] {
  if (state.structural) return [];
  const items: MenuItem[] = [];
  if (state.hasRegistryProperty) {
    items.push(menuAction(PROPERTY_ROW_MENU_LABELS.edit, actions.edit));
  }
  // Порядок строки — та же операция, что DnD и Alt+↑/↓ (компонента
  // row-reorder): «выше/ниже» с `disabled` на краях.
  if (!state.typed && state.reorder !== undefined && actions.move !== undefined) {
    items.push(
      ...rowReorderMenuItems({
        index: state.reorder.index,
        count: state.reorder.count,
        onMove: actions.move,
      }),
    );
  }
  items.push(menuAction(PROPERTY_ROW_MENU_LABELS.clear, actions.clear));
  if (!state.typed && state.hasType && state.hasRegistryProperty) {
    items.push(menuAction(PROPERTY_ROW_MENU_LABELS.promote, actions.promote));
  }
  if (state.typed) {
    items.push(menuAction(excludeRowLabel(state.sources), actions.exclude));
  }
  if (!state.typed) {
    items.push(menuAction(PROPERTY_ROW_MENU_LABELS.remove, actions.remove, { danger: true }));
  }
  return items;
}
