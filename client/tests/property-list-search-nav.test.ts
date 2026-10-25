/**
 * Клавиатурная навигация из поля поиска общего списка свойств (ошибка
 * 58981cf5, стандарт b6b2821d «Клавиатурная навигация списков — по умолчанию»).
 *
 * Симптом заказчика: в пикере свойств диалога «+ свойство» набрал запрос,
 * нажал ↓/Enter — ничего не происходит. Причина — поле поиска (первая строка
 * диалога-списка) забирало фокус, а навигация таблицы (ядро `nav-core` в
 * `lib/ui/table.ts`) срабатывала только на фокусе самой таблицы. Мост
 * `lib/ui/search-nav.ts` передаёт ↑/↓/Enter из поиска штатному обработчику
 * списка; здесь он проверяется на РЕАЛЬНОМ компоненте `buildPropertyList`
 * (пикер), а не на синтетической связке: удаление моста из компонента краснит
 * этот тест.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), конвенция
 * `selection-property-bulk-dialog.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import type { PropertyRegistryRow } from '../src/renderer/lib/property-list.js';

/** Устанавливает DOM-глобали до динамического импорта модулей под тестом. */
function installShim(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => {
      const element = new ShimElement(tag);
      if (tag === 'vaadin-grid') {
        const grid = element as unknown as Record<string, unknown>;
        grid['items'] = [];
        grid['columns'] = [];
        grid['clearCache'] = () => undefined;
        grid['generateCellPartNames'] = () => undefined;
        grid['scrollToIndex'] = () => undefined;
        grid['getEventContext'] = () => null;
      }
      return element;
    },
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => {
      const node = new ShimElement('#text') as any;
      node.textContent = text;
      return node;
    },
    body,
    documentElement: new ShimElement('html'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return body;
}

installShim();

const keymap = await import('../src/renderer/lib/keymap.js');
const { buildPropertyList, buildPropertyListRows } = await import(
  '../src/renderer/lib/property-list.js'
);

// Клавиатура идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

function registryRow(id: string, name: string): PropertyRegistryRow {
  return {
    id,
    name,
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
  };
}

const ROWS = buildPropertyListRows(
  [
    registryRow('p-priority', 'Приоритет'),
    registryRow('p-note', 'Заметка'),
    registryRow('p-term', 'Период'),
  ],
  [],
);

/** Поиск узла по классу в дереве шима. */
function findByClass(root: ShimElement, cls: string): ShimElement | null {
  if (root.classList.contains(cls)) return root;
  for (const child of root.children) {
    const found = findByClass(child, cls);
    if (found !== null) return found;
  }
  return null;
}

/** Поиск узла по тегу в дереве шима. */
function findTag(root: ShimElement, tag: string): ShimElement | null {
  if ((root.tagName ?? '').toLowerCase() === tag) return root;
  for (const child of root.children) {
    const found = findTag(child, tag);
    if (found !== null) return found;
  }
  return null;
}

/** Нажатие клавиши в поле поиска: событие уходит общеклиентскому диспетчеру. */
function pressInSearch(search: ShimElement, key: string): void {
  keymap.dispatchKeyEvent({
    key,
    target: search,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

/** Пикер со списком строк и записью активаций. */
function buildPicker(): {
  search: ShimElement;
  grid: Record<string, any>;
  activated: string[];
} {
  const activated: string[] = [];
  const list = buildPropertyList({
    mode: 'picker',
    callbacks: { onActivate: (row) => activated.push(row.id) },
  });
  list.setRows(ROWS);

  const root = list.root as unknown as ShimElement;
  const search = findByClass(root, 'property-list-search');
  assert.ok(search !== null, 'поле поиска — часть общего списка свойств');
  const grid = findTag(root, 'vaadin-grid') as unknown as Record<string, any>;
  assert.ok(grid !== null, 'таблица списка смонтирована');
  return { search: search!, grid, activated };
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('пикер свойств: ↑/↓/Enter из поля поиска', () => {
  it('↓ из поиска выделяет первую подходящую строку (без потери фокуса из поиска)', () => {
    const { search, grid } = buildPicker();
    search.value = 'Приоритет';
    search.emit('input');
    assert.equal(grid['items'].length, 1, 'фильтр оставил одну строку');

    search.emit('focusin');
    pressInSearch(search, 'ArrowDown');

    assert.equal(grid['activeItem']?.name, 'Приоритет', '↓ из поиска выделила строку списка');
  });

  it('Enter из поиска выбирает выделенное свойство (активация списка)', () => {
    const { search, grid, activated } = buildPicker();
    search.value = 'Приоритет';
    search.emit('input');
    search.emit('focusin');

    pressInSearch(search, 'ArrowDown');
    pressInSearch(search, 'Enter');

    assert.deepEqual(activated, ['p-priority'], 'Enter из поиска выбрал свойство пикера');
    assert.equal(grid['activeItem']?.name, 'Приоритет', 'Enter не сбросил выделение');
  });

  it('↑/↓ ходят по списку, не теряя фокус поиска (запрос можно продолжать набирать)', () => {
    const { search, grid } = buildPicker();
    search.emit('focusin');

    pressInSearch(search, 'ArrowDown');
    assert.equal(grid['activeItem']?.name, 'Заметка', 'первое ↓ — первая строка списка');
    pressInSearch(search, 'ArrowDown');
    assert.equal(grid['activeItem']?.name, 'Период', 'второе ↓ — следующая строка');
    pressInSearch(search, 'ArrowUp');
    assert.equal(grid['activeItem']?.name, 'Заметка', '↑ возвращает на строку выше');
  });

  it('Enter без выделения строку не выбирает (семантика стандарта: активируется выделенное)', () => {
    const { search, activated } = buildPicker();
    search.emit('focusin');

    pressInSearch(search, 'Enter');
    assert.deepEqual(activated, [], 'без текущей строки Enter ничего не активирует');
  });

  it('мост снят — ↑ из поиска список не двигает (контроль обратной стороны)', () => {
    const { search, grid } = buildPicker();
    // Диспетчер без контекста поиска: событие не адресовано списку.
    keymap.keymapInternals.reset();
    pressInSearch(search, 'ArrowDown');
    assert.equal(grid['activeItem'] ?? null, null, 'без моста навигация не срабатывает');
  });
});
