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
} from '../src/renderer/screens/publications/library-nav.js';
import { ShimElement } from './dom-shim.js';

/** Вызов клавиши на корне библиотеки. */
function press(root: ShimElement, key: string, target?: ShimElement): void {
  root.emit('keydown', {
    key,
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
}

function mount(sections: ShimElement[]): { root: ShimElement; nav: ReturnType<typeof attachLibraryNav>; spy: NavSpy } {
  const root = new ShimElement('div', 'publications');
  for (const section of sections) root.append(section);
  const spy: NavSpy = { toggled: [], edited: [], opened: [] };
  const nav = attachLibraryNav(root as unknown as HTMLElement, {
    onToggleShelf: (shelfId, collapsed) => spy.toggled.push({ shelfId, collapsed }),
    onEditShelf: (shelfId) => spy.edited.push(shelfId),
    onOpenPublication: (id) => spy.opened.push(id),
  });
  return { root, nav, spy };
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
