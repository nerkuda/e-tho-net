/**
 * Юнит-тесты единого дерева списков `lib/ui/tree.ts` (задача d1c15a2d,
 * требование 0086037c «Единое дерево списков lib/ui», компонент 24a05c95).
 *
 * Проверяется: чистые помощники над плоским списком узлов (глубина, счётчики
 * детей, фильтр с цепочкой предков, видимые строки), и поведение компонента —
 * рендер строк с кареткой и отступом, раскрытие/сворачивание, фильтр с
 * автораскрытием родителей, флажок и клик по строке, клавиатура (стрелки,
 * Enter, Space), ARIA-дерево и колонки. Согласованные размеры строки —
 * статическая проверка `guard-ui-tree.test.ts`.
 *
 * jsdom в проекте нет — используется общий DOM-шим (`./dom-shim.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

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

/** Текстовый узел содержимого строки (шим вместо настоящего `Node`). */
function textNode(text: string): Node {
  return new ShimElement('#text', undefined, text) as unknown as Node;
}

/** Все строки дерева в порядке DOM. */
function rows(root: ShimElement): ShimElement[] {
  return root.findAll((el) => el.classList.contains('ui-tree-row'));
}

/** Строка по id узла. */
function rowById(root: ShimElement, id: string): ShimElement {
  const row = root.findAll((el) => el.classList.contains('ui-tree-row') && el.dataset['treeId'] === id)[0];
  assert.ok(row !== undefined, `строка ${id} есть`);
  return row!;
}

/** Узлы, у которых есть класс. */
function byClass(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((el) => el.classList.contains(cls));
}

/** Событие клавиатуры для шима. */
function key(key: string): { key: string; preventDefault: () => void } {
  return { key, preventDefault: () => undefined };
}

describe('lib/ui/tree: чистые помощники дерева', () => {
  it('глубина узла (верхний = 1), неизвестный/цикл не вешают', async () => {
    const { treeDepthOf } = await treeModule();
    assert.equal(treeDepthOf(ITEMS, 'root'), 1);
    assert.equal(treeDepthOf(ITEMS, 'a'), 2);
    assert.equal(treeDepthOf(ITEMS, 'b'), 3);
    assert.equal(treeDepthOf(ITEMS, 'нет'), 1);
    const cyclic: Item[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    assert.equal(treeDepthOf(cyclic, 'x'), 2, 'цикл обрывается, не зависает');
  });

  it('счётчик прямых детей', async () => {
    const { treeChildCounts } = await treeModule();
    const counts = treeChildCounts(ITEMS);
    assert.equal(counts.get('root'), 2);
    assert.equal(counts.get('a'), 1);
    assert.equal(counts.get('b'), undefined);
  });

  it('фильтр: совпадения и цепочка предков; пустой запрос — «фильтра нет»', async () => {
    const { treeFilterKeepIds } = await treeModule();
    assert.equal(treeFilterKeepIds(ITEMS, ''), null);
    assert.deepEqual(
      [...treeFilterKeepIds(ITEMS, 'задач')!].sort(),
      ['a', 'b', 'root'],
      'совпадение b тянет предков a и root',
    );
  });

  it('видимые строки: свёрнутая ветвь скрывает потомков, фильтр раскрывает предков', async () => {
    const { treeVisibleIds } = await treeModule();
    const collapsed = new Set<string>(['root']);
    assert.deepEqual(treeVisibleIds(ITEMS, collapsed, ''), ['root', 'a', 'c']);
    const expanded = new Set<string>(['root', 'a']);
    assert.deepEqual(treeVisibleIds(ITEMS, expanded, ''), ['root', 'a', 'b', 'c']);
    // Фильтр «задач» оставляет b и его предков, даже если ветвь свёрнута.
    assert.deepEqual(treeVisibleIds(ITEMS, new Set(), 'задач'), ['root', 'a', 'b']);
  });
});

describe('lib/ui/tree: рендер строк и раскрытие', () => {
  it('строка: каретка, отступ по уровню, содержимое, счётчик детей', async () => {
    const { createTree } = await treeModule();
    const host = new ShimElement('div');
    const tree = createTree<Item>({
      items: ITEMS,
      expandAll: true,
      showChildCount: true,
      ariaLabel: 'Дерево',
      renderContent: (item) => textNode(item.filterText ?? item.id),
    });
    host.append(tree.root as unknown as ShimElement);

    assert.equal(tree.root.getAttribute('role'), 'tree');
    assert.equal(tree.root.getAttribute('aria-label'), 'Дерево');
    assert.equal(rows(host).length, 4, 'все строки видны при expandAll');

    const rootRow = rowById(host, 'root');
    assert.equal(rootRow.getAttribute('role'), 'treeitem');
    assert.equal(rootRow.getAttribute('aria-level'), '1');
    assert.equal(rootRow.getAttribute('aria-expanded'), 'true');
    assert.equal(rootRow.style.getPropertyValue('--tree-level'), '0', 'верхний уровень без отступа');

    const bRow = rowById(host, 'b');
    assert.equal(bRow.getAttribute('aria-level'), '3');
    assert.equal(bRow.style.getPropertyValue('--tree-level'), '2');

    // Каретка — первая колонка строки; у листа невидимая распорка с тем же классом.
    assert.ok(rootRow.children[0]!.classList.contains('ui-tree-caret'), 'у ветви каретка');
    assert.ok(
      !rootRow.children[0]!.classList.contains('ui-tree-caret--leaf'),
      'у ветви каретка активна',
    );
    assert.ok(bRow.children[0]!.classList.contains('ui-tree-caret--leaf'), 'у листа распорка');
    // Счётчик детей — бейдж.
    assert.equal(byClass(rootRow, 'ui-tree-count').length, 1, 'у root счётчик детей');
  });

  it('каретка сворачивает ветвь; лист-распорка раскрытия не даёт', async () => {
    const { createTree } = await treeModule();
    const host = new ShimElement('div');
    const tree = createTree<Item>({
      items: ITEMS,
      expandedIds: ['root', 'a'],
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);
    assert.deepEqual(tree.getVisibleIds(), ['root', 'a', 'b', 'c']);

    const caret = rowById(host, 'root').children[0]!;
    caret.click();
    assert.deepEqual(tree.getVisibleIds(), ['root'], 'каретка свернула ветвь root (скрылись a и c)');
  });

  it('пустое состояние — текст из опции', async () => {
    const { createTree } = await treeModule();
    const tree = createTree<Item>({
      items: [],
      emptyText: 'Пусто',
      emptyHint: 'Добавьте узел',
      renderContent: () => textNode('x'),
    });
    const empty = byClass(tree.root as unknown as ShimElement, 'ui-tree-empty');
    assert.equal(empty.length, 1, 'пустое состояние — с хуком ui-tree-empty');
    // Текст — заголовок и подсказка общего компонента `lib/ui/empty-state.ts`.
    assert.ok(empty[0]!.flatText().includes('Пусто'), 'виден заголовок из опции');
    assert.ok(empty[0]!.flatText().includes('Добавьте узел'), 'видна подсказка из опции');
  });
});

describe('lib/ui/tree: фильтр и колонки', () => {
  it('фильтр скрывает несоответствующие с автораскрытием родителей', async () => {
    const { createTree } = await treeModule();
    const host = new ShimElement('div');
    const tree = createTree<Item>({
      items: ITEMS,
      expandedIds: [],
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);
    assert.deepEqual(tree.getVisibleIds(), ['root'], 'при пустом раскрытии виден только корень');

    tree.setFilter('задач');
    assert.deepEqual(tree.getVisibleIds(), ['root', 'a', 'b'], 'фильтр раскрыл цепочку предков');

    tree.setFilter('');
    assert.deepEqual(tree.getVisibleIds(), ['root'], 'снятие фильтра возвращает ручное раскрытие');
  });

  it('колонки и строка заголовков', async () => {
    const { createTree } = await treeModule();
    const tree = createTree<Item>({
      items: ITEMS,
      expandAll: true,
      treeColumnHeader: 'Тип',
      renderContent: () => textNode('x'),
      columns: [
        { key: 'count', header: 'Количество', align: 'end', render: (item) => item.id },
      ],
    });
    const root = tree.root as unknown as ShimElement;
    const head = byClass(root, 'ui-tree-head');
    assert.equal(head.length, 1, 'есть строка заголовков');
    assert.deepEqual(
      head[0]!.children.map((c) => c.textContent),
      ['Тип', 'Количество'],
    );
    const cell = byClass(rowById(root, 'root'), 'ui-tree-cell--count')[0]!;
    assert.equal(cell.textContent, 'root');
    assert.equal(cell.title, 'root', 'строка-значение колонки несёт полный текст в title');
    assert.ok(cell.classList.contains('ui-tree-cell--end'), 'колонка выровнена по концу');
  });
});

describe('lib/ui/tree: флажок, клик, клавиатура', () => {
  function buildTree(
    Tree: TreeModule,
    events: { checked: string[]; activated: string[] },
    host: ShimElement,
  ): import('../src/renderer/lib/ui/tree.js').TreeHandle<Item> {
    const tree = Tree.createTree<Item>({
      items: ITEMS,
      expandAll: true,
      checkbox: true,
      isChecked: (item) => events.checked.includes(item.id),
      onCheck: (item, on) => {
        events.checked = on
          ? [...events.checked, item.id]
          : events.checked.filter((id) => id !== item.id);
      },
      onActivate: (item) => events.activated.push(item.id),
      renderContent: () => textNode('x'),
    });
    host.append(tree.root as unknown as ShimElement);
    return tree;
  }

  it('флажок отражает состояние, клик по строке переключает его', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const events = { checked: ['a'], activated: [] as string[] };
    buildTree(T, events, host);

    const aRow = rowById(host, 'a');
    const input = byClass(aRow, 'ui-tree-check')[0]!;
    assert.equal(input.checked, true, 'флажок отражает isChecked');
    assert.equal(aRow.getAttribute('aria-checked'), 'true');

    rowById(host, 'b').click();
    assert.deepEqual(events.checked, ['a', 'b'], 'клик по строке отметил флажок');
    assert.ok(
      rowById(host, 'b').classList.contains('ui-tree-row--current'),
      'клик делает строку текущей',
    );
    assert.ok(events.activated.length === 0, 'в режиме флажка клик не «активирует» строку');
  });

  it('клавиатура: стрелки двигают текущую строку, Space — флажок, Enter — активация', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const events = { checked: [] as string[], activated: [] as string[] };
    const tree = buildTree(T, events, host);
    const root = tree.root as unknown as ShimElement;
    assert.equal(tree.getCurrentId(), 'root', 'текущая строка — первая видимая');

    root.emit('keydown', key('ArrowDown'));
    assert.equal(tree.getCurrentId(), 'a', 'вниз — к следующей строке');
    root.emit('keydown', key(' '));
    assert.deepEqual(events.checked, ['a'], 'Space переключил флажок');
    root.emit('keydown', key('Enter'));
    assert.deepEqual(events.activated, ['a'], 'Enter активировал строку');
  });

  it('клавиатура: ← сворачивает/уходит к родителю, → раскрывает/идёт к потомку', async () => {
    const T = await treeModule();
    const host = new ShimElement('div');
    const events = { checked: [] as string[], activated: [] as string[] };
    const tree = buildTree(T, events, host);
    const root = tree.root as unknown as ShimElement;
    root.emit('keydown', key('ArrowDown')); // a
    root.emit('keydown', key('ArrowDown')); // b
    root.emit('keydown', key('ArrowLeft')); // b — лист → к родителю a
    assert.equal(tree.getCurrentId(), 'a');
    root.emit('keydown', key('ArrowLeft')); // a раскрыт → свернуть
    assert.equal(tree.isExpanded('a'), false, '← свернул раскрытую ветвь');
    root.emit('keydown', key('ArrowRight')); // → раскрыть
    assert.equal(tree.isExpanded('a'), true, '→ раскрыл ветвь');
    root.emit('keydown', key('ArrowRight')); // → к первому потомку
    assert.equal(tree.getCurrentId(), 'b', '→ у раскрытой ветви идёт к потомку');
  });

  it('без флажка клик по строке активирует (одиночный выбор)', async () => {
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
    assert.deepEqual(activated, ['b']);
  });
});
