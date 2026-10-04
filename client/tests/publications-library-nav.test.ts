/**
 * DOM-тесты единой клавиатурной навигации библиотеки публикаций (0.11.1,
 * задача 55ee3c85): ↑/↓ по видимой последовательности (полка/публикация),
 * Home/End, ←/→ сворачивание полки, Enter на полке — правка имени, Enter на
 * публикации — открытие в панели редактора, выделение переживает перерисовку.
 *
 * Проверяется ИНТЕРАКЦИОННО — на контроллере `library-nav.ts` через DOM-шим:
 * симуляция keydown, проверка выделения и колбэков. Контроллер вынесен из
 * экрана именно ради такой проверки (образец — `chronicle-acceptance-iter9`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachLibraryNav,
  LIB_GROUP_CLASS,
  LIB_GROUP_COLLAPSED_CLASS,
  LIB_HEAD_CLASS,
  LIB_NAV_CURRENT_CLASS,
  LIB_OPEN_CLASS,
  type LibraryNavOptions,
} from '../src/renderer/screens/publications/library-nav.js';
import { ShimElement } from './dom-shim.js';

/** Вызов клавиши на корне библиотеки. */
function press(root: ShimElement, key: string, target?: ShimElement, ctrlKey = false): void {
  root.emit('keydown', {
    key,
    ctrlKey,
    target: target ?? root,
    preventDefault: (): void => undefined,
  });
}

/** Секция-группа полки с заголовком и публикациями. */
function group(shelfId: string, pubIds: string[], collapsed = false): ShimElement {
  const section = new ShimElement('div', `${LIB_GROUP_CLASS} pub-shelf`);
  section.setAttribute('data-shelf-key', shelfId);
  if (collapsed) section.classList.add(LIB_GROUP_COLLAPSED_CLASS);
  const head = new ShimElement('button', LIB_HEAD_CLASS);
  const title = new ShimElement('span', 'pub-group-title');
  title.textContent = shelfId;
  head.append(title);
  section.append(head);
  for (const id of pubIds) {
    const card = new ShimElement('div', 'pub-card');
    card.setAttribute('data-pub-key', id);
    section.append(card);
  }
  return section;
}

interface NavSpy {
  toggled: Array<{ shelfId: string; collapsed: boolean }>;
  edited: string[];
  opened: string[];
  read: string[];
}

function mount(sections: ShimElement[]): { root: ShimElement; nav: ReturnType<typeof attachLibraryNav>; spy: NavSpy } {
  const root = new ShimElement('div', 'publications');
  for (const section of sections) root.append(section);
  return attach(root);
}

/** Подключить контроллер к готовому корню с дополнительными опциями. */
function attach(
  root: ShimElement,
  extra: Partial<LibraryNavOptions> = {},
): { root: ShimElement; nav: ReturnType<typeof attachLibraryNav>; spy: NavSpy } {
  const spy: NavSpy = { toggled: [], edited: [], opened: [], read: [] };
  const nav = attachLibraryNav(root as unknown as HTMLElement, {
    onToggleShelf: (shelfId, collapsed) => spy.toggled.push({ shelfId, collapsed }),
    onEditShelf: (shelfId) => spy.edited.push(shelfId),
    onOpenPublication: (id) => spy.opened.push(id),
    onReadPublication: (id) => spy.read.push(id),
    ...extra,
  });
  return { root, nav, spy };
}

/** Узел с классом внутри корня. */
function keysWithClass(root: ShimElement, cls: string): string[] {
  return root
    .querySelectorAll(`.${cls}`)
    .map(
      (node) =>
        node.dataset['shelfKey'] ??
        node.dataset['pubKey'] ??
        node.parent?.dataset['shelfKey'] ??
        '',
    );
}

/** Геометрическая полка: заголовок во всю ширину + карточки сеткой (rects для 2D). */
function geoGroup(shelfId: string, rows: string[][], top: number): { section: ShimElement; height: number } {
  const section = new ShimElement('div', `${LIB_GROUP_CLASS} pub-shelf`);
  section.setAttribute('data-shelf-key', shelfId);
  const head = new ShimElement('button', LIB_HEAD_CLASS);
  head.rect = { left: 0, top, right: 400, bottom: top + 20, width: 400, height: 20 };
  section.append(head);
  rows.forEach((row, rowIndex) => {
    row.forEach((id, colIndex) => {
      const card = new ShimElement('div', 'pub-card');
      card.setAttribute('data-pub-key', id);
      const x = 105 + colIndex * 200;
      const y = top + 30 + rowIndex * 70;
      card.rect = { left: x, top: y, right: x + 190, bottom: y + 60, width: 190, height: 60 };
      section.append(card);
    });
  });
  return { section, height: 40 + rows.length * 70 };
}

/** Корень вида «Полки» с заданными сетками карточек. */
function geoRoot(shelves: Array<{ id: string; rows: string[][] }>): ShimElement {
  const root = new ShimElement('div', 'publications');
  let top = 0;
  for (const shelf of shelves) {
    const { section, height } = geoGroup(shelf.id, shelf.rows, top);
    root.append(section);
    top += height;
  }
  return root;
}

/** Узел с классом выделения внутри корня. */
function currentKeys(root: ShimElement): string[] {
  return root
    .querySelectorAll(`.${LIB_NAV_CURRENT_CLASS}`)
    .map(
      (node) =>
        node.dataset['shelfKey'] ??
        node.dataset['pubKey'] ??
        node.parent?.dataset['shelfKey'] ??
        '',
    );
}

describe('навигация библиотеки: видимая последовательность (55ee3c85)', () => {
  it('↓ идёт полка → её публикации → следующая полка; ↑ — назад', () => {
    const { root, nav } = mount([group('s1', ['p1', 'p2']), group('s2', ['p3'])]);
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's1' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p1' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p2' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's2' });
    press(root, 'ArrowUp');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p2' });
    nav.destroy();
  });

  it('публикации свёрнутой полки пропускаются', () => {
    const { root, nav } = mount([group('s1', ['p1', 'p2'], true), group('s2', ['p3'])]);
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's1' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's2' });
    nav.destroy();
  });

  it('Home и End — к границам видимого списка', () => {
    const { root, nav } = mount([group('s1', ['p1', 'p2']), group('s2', ['p3'])]);
    press(root, 'End');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p3' });
    press(root, 'ArrowUp');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's2' });
    press(root, 'Home');
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's1' });
    nav.destroy();
  });

  it('выделение ставится классом на узел текущей сущности', () => {
    const { root, nav } = mount([group('s1', ['p1'])]);
    press(root, 'ArrowDown');
    press(root, 'ArrowDown');
    assert.deepEqual(currentKeys(root), ['p1']);
    nav.destroy();
  });
});

describe('навигация библиотеки: ←/→ и Enter (55ee3c85)', () => {
  it('←/→ сообщают о сворачивании/разворачивании текущей полки', () => {
    const { root, nav, spy } = mount([group('s1', ['p1'])]);
    press(root, 'ArrowDown');
    press(root, 'ArrowLeft');
    press(root, 'ArrowRight');
    assert.deepEqual(spy.toggled, [
      { shelfId: 's1', collapsed: true },
      { shelfId: 's1', collapsed: false },
    ]);
    nav.destroy();
  });

  it('Enter на полке — inline-правка имени, на публикации — открытие в панели редактора', () => {
    const { root, nav, spy } = mount([group('s1', ['p1'])]);
    press(root, 'Enter'); // без выделения — ничего
    assert.deepEqual(spy.edited, []);
    press(root, 'ArrowDown');
    press(root, 'Enter');
    assert.deepEqual(spy.edited, ['s1']);
    press(root, 'ArrowDown');
    press(root, 'Enter');
    assert.deepEqual(spy.opened, ['p1']);
    nav.destroy();
  });

  it('Ctrl+Enter на публикации — режим чтения (задача b51dbca4)', () => {
    const { root, nav, spy } = mount([group('s1', ['p1'])]);
    press(root, 'ArrowDown');
    press(root, 'ArrowDown');
    press(root, 'Enter', undefined, true);
    assert.deepEqual(spy.read, ['p1'], 'Ctrl+Enter открывает рабочую область чтения');
    assert.deepEqual(spy.opened, [], 'обычная карточка не открывается');
    nav.destroy();
  });

  it('в поле правки имени стрелки навигации не перехватываются', () => {
    const { root, nav } = mount([group('s1', ['p1'])]);
    const input = new ShimElement('input', 'pub-shelf-rename');
    press(root, 'ArrowDown', input);
    assert.equal(nav.current(), null);
    nav.destroy();
  });
});

describe('навигация библиотеки: устойчивость выделения (55ee3c85)', () => {
  it('refresh переприменяет выделение после перерисовки; пропавшая сущность — снимается', () => {
    const { root, nav } = mount([group('s1', ['p1', 'p2'])]);
    press(root, 'ArrowDown');
    press(root, 'ArrowDown'); // p1
    // Перерисовка: узлы заменены новыми, выделения на них нет.
    root.replaceChildren(group('s1', ['p1', 'p2']));
    assert.deepEqual(currentKeys(root), []);
    nav.refresh();
    assert.deepEqual(currentKeys(root), ['p1']);
    // Публикация исчезла (например, realtime) — выделение снимается.
    root.replaceChildren(group('s1', ['p2']));
    nav.refresh();
    assert.equal(nav.current(), null);
    nav.destroy();
  });
});

describe('навигация «Полок»: геометрия книжек (432ab7ba п.2)', () => {
  it('матрица переходов: ←/→ по ряду, ↑/↓ по столбцу, границы', () => {
    const root = geoRoot([{ id: 's1', rows: [['a1', 'a2'], ['b1', 'b2']] }, { id: 's2', rows: [['c1']] }]);
    const { nav } = attach(root, { isShelvesView: () => true });
    press(root, 'ArrowDown'); // без текущей — первый элемент (заголовок s1)
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's1' });
    press(root, 'ArrowDown'); // ↓ с заголовка — книга под ним (столбец 1)
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a1' });
    press(root, 'ArrowRight');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a2' }, '→ по ряду');
    press(root, 'ArrowLeft');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a1' }, '← по ряду');
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'b1' }, '↓ по столбцу');
    press(root, 'ArrowRight');
    press(root, 'ArrowDown'); // с b2 вниз — заголовок следующей полки (ближайший элемент)
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's2' });
    // Граница: из самого левого столбца ← цели нет — сущность не меняется.
    press(root, 'ArrowDown'); // c1
    press(root, 'ArrowLeft');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'c1' });
    nav.destroy();
  });

  it('Home/End — первая/последняя книжка ТЕКУЩЕЙ полки', () => {
    const root = geoRoot([{ id: 's1', rows: [['a1', 'a2'], ['b1', 'b2']] }, { id: 's2', rows: [['c1']] }]);
    const { nav } = attach(root, { isShelvesView: () => true });
    press(root, 'ArrowDown'); // заголовок s1
    press(root, 'Home');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a1' }, 'Home с заголовка — первая книжка');
    press(root, 'End');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'b2' }, 'End — последняя книжка полки s1');
    press(root, 'ArrowUp'); // с b2 вверх — книга верхнего ряда той же колонки
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a2' });
    press(root, 'ArrowUp'); // выше книг — заголовок полки
    assert.deepEqual(nav.current(), { kind: 'shelf', key: 's1' });
    press(root, 'End');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'b2' });
    nav.destroy();
  });

  it('Ctrl+Home/Ctrl+End — первая книжка первой полки / последняя книжка последней полки', () => {
    const root = geoRoot([{ id: 's1', rows: [['a1', 'a2'], ['b1', 'b2']] }, { id: 's2', rows: [['c1']] }]);
    const { nav } = attach(root, { isShelvesView: () => true });
    press(root, 'End', undefined, true);
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'c1' }, 'Ctrl+End — последняя полка');
    press(root, 'Home', undefined, true);
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a1' }, 'Ctrl+Home — первая полка');
    nav.destroy();
  });

  it('←/→ на ЗАГОЛОВКЕ сворачивают полку, на КНИЖКЕ — перемещают', () => {
    const root = geoRoot([{ id: 's1', rows: [['a1', 'a2']] }]);
    const { nav, spy } = attach(root, { isShelvesView: () => true });
    press(root, 'ArrowDown'); // заголовок s1
    press(root, 'ArrowLeft');
    press(root, 'ArrowRight');
    assert.deepEqual(spy.toggled, [
      { shelfId: 's1', collapsed: true },
      { shelfId: 's1', collapsed: false },
    ]);
    // На книжке ←/→ сворачивание НЕ переключают.
    press(root, 'ArrowDown'); // a1
    press(root, 'ArrowLeft');
    assert.deepEqual(spy.toggled.length, 2, 'книжка не сворачивает полку');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'a1' }, 'у границы ряда — без движения');
    nav.destroy();
  });

  it('в виде «Список» геометрия выключена — прежний последовательный ход', () => {
    const { root, nav } = mount([group('s1', ['p1', 'p2']), group('s2', ['p3'])]);
    press(root, 'ArrowDown');
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p1' });
    press(root, 'End'); // глобальный край списка (не «граница полки»)
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'p3' });
    nav.destroy();
  });
});

describe('навигация библиотеки: двухрамочность (ADR e6d48e09)', () => {
  it('выбор → одна сплошная рамка; стрелка → пунктир и сплошная', () => {
    let opened: string | null = null;
    const root = geoRoot([{ id: 's1', rows: [['a1', 'a2'], ['b1', 'b2']] }]);
    const { nav } = attach(root, { isShelvesView: () => true, openedKey: () => opened });
    press(root, 'ArrowDown'); // s1
    press(root, 'ArrowDown'); // a1
    // Выбор a1 (открыта в редакторе): пунктир не рисуется, только сплошная.
    opened = 'a1';
    nav.refresh();
    assert.deepEqual(keysWithClass(root, LIB_OPEN_CLASS), ['a1'], 'сплошная рамка на открытой');
    assert.deepEqual(keysWithClass(root, LIB_NAV_CURRENT_CLASS), [], 'пунктир скрыт при совпадении');
    // Стрелка уводит текущий на b1 — снова обе рамки.
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'publication', key: 'b1' });
    assert.deepEqual(keysWithClass(root, LIB_OPEN_CLASS), ['a1'], 'открытая по-прежнему под сплошной');
    assert.deepEqual(keysWithClass(root, LIB_NAV_CURRENT_CLASS), ['b1'], 'текущая — под пунктиром');
    // Выбор b1 — остаётся только сплошная.
    opened = 'b1';
    nav.refresh();
    assert.deepEqual(keysWithClass(root, LIB_OPEN_CLASS), ['b1']);
    assert.deepEqual(keysWithClass(root, LIB_NAV_CURRENT_CLASS), []);
    nav.destroy();
  });
});
