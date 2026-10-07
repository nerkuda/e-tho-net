/**
 * Юнит-тесты семантики клика, позиционирования и копирования единого дерева
 * `lib/ui/tree.ts` (требование 11ddd910 «Единые правила диалогов-списков»,
 * правила 5–7; задача 1362e632, партия 1).
 *
 * Проверяется на DOM-шиме (`./dom-shim.js`, jsdom в проекте нет):
 *  - список (не выбор): клик — только текущая строка, двойной клик — редактор,
 *    Enter — активация;
 *  - одиночный выбор (пикер): клик только делает строку текущей, двойной клик
 *    и Enter подтверждают выбор (правило 6, ошибка d1a009fa);
 *  - выбор нескольких: клик переключает флажок, двойной клик — редактор;
 *  - revealRow раскрывает предков и делает строку текущей (правило 7);
 *  - copyCurrent пишет текст текущей строки (правило 2).
 * Согласованность структуры диалогов проверяет сторож `guard-list-dialogs`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура дерева идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Минимальный DOM-шим для конструкторов дерева. */
function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

type TreeModule = typeof import('../src/renderer/lib/ui/tree.js');

async function treeModule(): Promise<TreeModule> {
  shimDom();
  return import('../src/renderer/lib/ui/tree.js');
}

interface Item {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
  filterText?: string;
}

const ITEMS: Item[] = [
  { id: 'root', parentId: null, hasChildren: true, filterText: 'Основной' },
  { id: 'a', parentId: 'root', hasChildren: true, filterText: 'Архив' },
  { id: 'b', parentId: 'a', hasChildren: false, filterText: 'Задача' },
  { id: 'c', parentId: 'root', hasChildren: false, filterText: 'Проект' },
];

function textNode(text: string): Node {
  return new ShimElement('#text', undefined, text) as unknown as Node;
}

function rowById(root: ShimElement, id: string): ShimElement {
  const row = root.findAll(
    (el) => el.classList.contains('ui-tree-row') && el.dataset['treeId'] === id,
  )[0];
  assert.ok(row !== undefined, `строка ${id} есть`);
  return row!;
}

function key(keyName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: keyName, preventDefault: (): void => undefined, ...extra };
}

/** Нажатие клавиши на корне дерева: фокус кладёт контекст, событие — диспетчеру. */
function press(root: ShimElement, event: Record<string, unknown>): void {
  root.focus();
  keymap.dispatchKeyEvent(event as unknown as KeyboardEvent);
}

describe('lib/ui/tree: семантика клика (правило 6, требование 11ddd910)', () => {
  it('список (не выбор): клик ставит текущую строку, двойной клик открывает редактор', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const events = { activated: [] as string[], edited: [] as string[], current: [] as string[] };
    const tree = T.createTree<Item>({
      items: ITEMS,
      expandAll: true,
      onActivate: (item) => events.activated.push(item.id),
      onDblActivate: (item) => events.edited.push(item.id),
      onCurrentChange: (id) => events.current.push(id ?? 'null'),
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);

    rowById(host, 'b').click();
    assert.equal(tree.getCurrentId(), 'b', 'клик делает строку текущей');
    assert.ok(
      rowById(host, 'b').classList.contains('ui-tree-row--current'),
      'текущая строка подсвечена',
    );
    assert.deepEqual(events.activated, [], 'одиночный клик НЕ активирует (не открывает редактор)');
    assert.deepEqual(events.current, ['b'], 'смена текущей строки уведомляет владельца');

    rowById(host, 'b').emit('dblclick');
    assert.deepEqual(events.edited, ['b'], 'двойной клик открывает редактор');
    assert.deepEqual(events.activated, [], 'двойной клик не дублирует активацию');

    press(tree.root as unknown as ShimElement, key('Enter'));
    assert.deepEqual(events.activated, ['b'], 'Enter активирует строку');
  });

  it('одиночный выбор (пикер): клик ставит текущую, двойной клик и Enter подтверждают', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const activated: string[] = [];
    const tree = T.createTree<Item>({
      items: ITEMS,
      expandAll: true,
      onActivate: (item) => activated.push(item.id),
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);
    rowById(host, 'b').click();
    assert.equal(tree.getCurrentId(), 'b', 'клик делает строку текущей');
    assert.deepEqual(activated, [], 'одиночный клик НЕ подтверждает выбор (правило 6)');

    // Двойной клик в пикере (без onDblActivate) — подтверждение выбора.
    rowById(host, 'c').emit('dblclick');
    assert.deepEqual(activated, ['c'], 'двойной клик подтверждает выбор');

    // Enter — то же подтверждение текущей строки.
    press(tree.root as unknown as ShimElement, key('Enter'));
    assert.deepEqual(activated, ['c', 'c'], 'Enter подтверждает выбор текущей строки');
  });

  it('выбор нескольких: клик переключает флажок и ставит текущую строку, двойной клик — редактор', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const events = { checked: [] as string[], edited: [] as string[] };
    const tree = T.createTree<Item>({
      items: ITEMS,
      expandAll: true,
      checkbox: true,
      isChecked: (item) => events.checked.includes(item.id),
      onCheck: (item, on) => {
        events.checked = on
          ? [...events.checked, item.id]
          : events.checked.filter((id) => id !== item.id);
      },
      onDblActivate: (item) => events.edited.push(item.id),
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);

    rowById(host, 'b').click();
    assert.deepEqual(events.checked, ['b'], 'клик переключил флажок строки');
    assert.equal(tree.getCurrentId(), 'b', 'клик сделал строку текущей');

    rowById(host, 'b').emit('dblclick');
    assert.deepEqual(events.edited, ['b'], 'двойной клик открыл редактор');
    assert.deepEqual(
      events.checked,
      ['b'],
      'двойной клик сам флажок не переключает (его дают обычные клики)',
    );
  });
});

describe('lib/ui/tree: позиционирование и копирование (правила 7 и 2)', () => {
  it('revealRow раскрывает цепочку предков и делает строку текущей', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const notified: string[] = [];
    const tree = T.createTree<Item>({
      items: ITEMS,
      // Всё свёрнуто: виден только корень.
      expandedIds: [],
      onCurrentChange: (id) => notified.push(id ?? 'null'),
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);
    assert.deepEqual(tree.getVisibleIds(), ['root'], 'старт — свёрнутое дерево');

    tree.revealRow('b');
    assert.ok(tree.getVisibleIds().includes('b'), 'строка раскрыта предками и видна');
    assert.equal(tree.getCurrentId(), 'b', 'строка стала текущей');
    assert.deepEqual(notified, ['b'], 'revealRow уведомляет о текущей строке');
    assert.equal(tree.isExpanded('a'), true, 'предок строки раскрыт');
    assert.equal(tree.isExpanded('root'), true, 'корень ветви раскрыт');
  });

  it('copyCurrent пишет текст текущей строки; без строки или copyText — false', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const copied: string[] = [];
    const tree = T.createTree<Item>({
      items: ITEMS,
      expandAll: true,
      copyText: (item) => item.filterText ?? item.id,
      onCopy: (text) => copied.push(text),
      clipboard: () => undefined,
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);

    tree.setCurrentId('c');
    assert.equal(tree.copyCurrent(), true, 'копирование текущей строки выполняется');
    assert.deepEqual(copied, ['Проект'], 'в буфер уходит текст copyText текущей строки');

    const bare = T.createTree<Item>({ items: ITEMS, renderContent: () => textNode('x') });
    assert.equal(bare.copyCurrent(), false, 'без copyText копирования нет');
  });

  it('treeAncestorIds: цепочка предков от родителя к корню, циклы обрываются', async () => {
    const T = await treeModule();
    assert.deepEqual(T.treeAncestorIds(ITEMS, 'b'), ['a', 'root']);
    assert.deepEqual(T.treeAncestorIds(ITEMS, 'root'), []);
    assert.deepEqual(T.treeAncestorIds(ITEMS, 'нет-такого'), []);
    const cyclic: Item[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    assert.ok(T.treeAncestorIds(cyclic, 'x').length <= 2, 'цикл не зацикливает обход');
  });
});
