/**
 * Поведение общего ядра клавиатурной навигации и компонента списка `lib/ui`
 * (ADR «Списки и таблицы: два компонента над общим ядром навигации» fadf99e0,
 * требование 93115633, задача 7893e429).
 *
 * Проверяем то, за что отвечает ядро и что раньше дублировалось по модулям:
 *   • чистая математика навигации — стрелки, границы, Home/End, PgUp/PgDn,
 *     поведение без текущей строки;
 *   • компонент списка на подставном адаптере — ход по видимой
 *     последовательности (группа → её элементы), Home/End, ←/→
 *     сворачивание/разворачивание группы, Enter-активация, отсечка полей
 *     ввода, сохранение выделения по ключу после перерисовки.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `publications-library-nav.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import {
  isEditingTarget,
  listTargetIndex,
  nextNavIndex,
  resolveNavAction,
} from '../src/renderer/lib/ui/nav-core.js';
import { createListNav, type ListNavAdapter, type ListNavHandle } from '../src/renderer/lib/ui/list.js';

// ---------------------------------------------------------------------------
// Чистое ядро
// ---------------------------------------------------------------------------

describe('nav-core: чистая математика навигации', () => {
  it('resolveNavAction: карта клавиш едина для таблиц и списков', () => {
    assert.equal(resolveNavAction('ArrowUp'), 'up');
    assert.equal(resolveNavAction('ArrowDown'), 'down');
    assert.equal(resolveNavAction('Home'), 'home');
    assert.equal(resolveNavAction('End'), 'end');
    assert.equal(resolveNavAction('ArrowLeft'), 'collapse');
    assert.equal(resolveNavAction('ArrowRight'), 'expand');
    assert.equal(resolveNavAction('Enter'), 'activate');
    assert.equal(resolveNavAction('Tab'), null, 'Tab ядром не перехватывается (режим полей)');
    assert.equal(resolveNavAction('Escape'), null);
  });

  it('nextNavIndex: стрелки, границы, Home/End, PgUp/PgDn, без текущей строки', () => {
    assert.equal(nextNavIndex('down', 1, 5), 2);
    assert.equal(nextNavIndex('up', 1, 5), 0);
    assert.equal(nextNavIndex('down', 4, 5), 4, 'не выходим за конец');
    assert.equal(nextNavIndex('up', 0, 5), 0, 'не выходим за начало');
    assert.equal(nextNavIndex('home', 3, 5), 0);
    assert.equal(nextNavIndex('end', 0, 5), 4);
    assert.equal(nextNavIndex('pageDown', 0, 100, { pageStep: 10 }), 10);
    assert.equal(nextNavIndex('pageUp', 15, 100, { pageStep: 10 }), 5);
    assert.equal(nextNavIndex('down', -1, 5), 0, 'без выделения — первая');
    assert.equal(nextNavIndex('end', -1, 5), 4, 'без выделения End — последняя');
    assert.equal(
      nextNavIndex('pageDown', -1, 100, { pageStep: 10 }),
      9,
      'без выделения PgDn — первая страница',
    );

    // Правило списков: без выделения up встаёт на последнюю.
    assert.equal(
      nextNavIndex('up', -1, 5, { emptyTarget: 'direction' }),
      4,
      'список: ↑ без выделения — последняя',
    );
    assert.equal(nextNavIndex('down', -1, 5, { emptyTarget: 'direction' }), 0);

    assert.equal(nextNavIndex('down', 0, 0), -1, 'пусто — цели нет');
  });

  it('listTargetIndex: границы списка — без заворота', () => {
    assert.equal(listTargetIndex(-1, 3, 1), 0, 'вниз без выделения — первая');
    assert.equal(listTargetIndex(-1, 3, -1), 2, 'вверх без выделения — последняя');
    assert.equal(listTargetIndex(0, 3, -1), -1, 'у верха дальше вверх — нет движения');
    assert.equal(listTargetIndex(2, 3, 1), -1, 'у низа дальше вниз — нет движения');
    assert.equal(listTargetIndex(1, 3, 1), 2);
    assert.equal(listTargetIndex(0, 0, 1), -1);
  });

  it('isEditingTarget: поля ввода отсекаются от навигации', () => {
    assert.equal(isEditingTarget(new ShimElement('input')), true);
    assert.equal(isEditingTarget(new ShimElement('textarea')), true);
    assert.equal(isEditingTarget(new ShimElement('div')), false);
    assert.equal(isEditingTarget(null), false);
    const editable = new ShimElement('div');
    editable.setAttribute('contenteditable', 'true');
    assert.equal(isEditingTarget(editable), true);
  });
});

// ---------------------------------------------------------------------------
// Компонент списка на подставном адаптере
// ---------------------------------------------------------------------------

interface GroupedEntry {
  kind: 'group' | 'item';
  key: string;
}

/** Список из групп с элементами: DOM-контракт `.grp[data-group]` + `.it[data-item]`. */
function buildList(spec: Array<{ group: string; items: string[]; collapsed?: boolean }>): ShimElement {
  const root = new ShimElement('div', 'list-root');
  for (const group of spec) {
    const section = new ShimElement('div', 'grp');
    section.setAttribute('data-group', group.group);
    if (group.collapsed === true) section.classList.add('is-collapsed');
    section.append(new ShimElement('button', 'grp-head'));
    for (const item of group.items) {
      const node = new ShimElement('div', 'it');
      node.setAttribute('data-item', item);
      section.append(node);
    }
    root.append(section);
  }
  return root;
}

interface NavSpy {
  collapses: Array<{ key: string; collapsed: boolean }>;
  activations: string[];
}

function mount(root: ShimElement): { nav: ListNavHandle<GroupedEntry>; spy: NavSpy } {
  const spy: NavSpy = { collapses: [], activations: [] };
  const sections = (): ShimElement[] => root.querySelectorAll('.grp');
  const groupKey = (section: ShimElement): string => section.getAttribute('data-group') ?? '';
  const entries = (): GroupedEntry[] => {
    const out: GroupedEntry[] = [];
    for (const section of sections()) {
      out.push({ kind: 'group', key: groupKey(section) });
      if (section.classList.contains('is-collapsed')) continue;
      for (const node of section.querySelectorAll('.it')) {
        out.push({ kind: 'item', key: node.getAttribute('data-item') ?? '' });
      }
    }
    return out;
  };
  const elementOf = (entry: GroupedEntry): HTMLElement | null => {
    if (entry.kind === 'group') {
      const section = sections().find((s) => groupKey(s) === entry.key);
      return (section?.querySelector('.grp-head') as unknown as HTMLElement) ?? null;
    }
    for (const section of sections()) {
      const found = section.querySelectorAll('.it').find((n) => n.getAttribute('data-item') === entry.key);
      if (found !== undefined) return found as unknown as HTMLElement;
    }
    return null;
  };
  const adapter: ListNavAdapter<GroupedEntry> = {
    entries,
    tokenOf: (entry) => `${entry.kind}\u0000${entry.key}`,
    elementOf,
    applyHighlight: (entry) => {
      for (const el of root.querySelectorAll('.current')) el.classList.remove('current');
      if (entry !== null) elementOf(entry)?.classList.add('current');
    },
    onCollapse: (entry, collapsed) => {
      if (entry.kind === 'group') spy.collapses.push({ key: entry.key, collapsed });
    },
    onActivate: (entry) => spy.activations.push(`${entry.kind}:${entry.key}`),
  };
  const nav = createListNav<GroupedEntry>(root as unknown as HTMLElement, adapter);
  return { nav, spy };
}

function press(root: ShimElement, key: string, target?: ShimElement): void {
  root.emit('keydown', { key, target: target ?? root, preventDefault: (): void => undefined });
}

function currentKey(root: ShimElement): string | null {
  const el = root.querySelectorAll('.current')[0];
  return el === undefined ? null : (el.getAttribute('data-item') ?? el.parent?.getAttribute('data-group') ?? null);
}

describe('lib/ui/list: навигация компонента списка', () => {
  it('↓ идёт группа → её элементы → следующая группа; границы не заворачивают', () => {
    const root = buildList([{ group: 'g1', items: ['a', 'b'] }, { group: 'g2', items: ['c'] }]);
    const { nav } = mount(root);
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g1' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a' });
    press(root, 'ArrowDown');
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g2' });
    press(root, 'ArrowUp');
    assert.deepEqual(nav.current(), { kind: 'item', key: 'b' });
    // Граница: дальше вверх от первой сущности ничего не меняется.
    press(root, 'Home');
    press(root, 'ArrowUp');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g1' });
    nav.destroy();
  });

  it('элементы свёрнутой группы пропускаются', () => {
    const root = buildList([
      { group: 'g1', items: ['a', 'b'], collapsed: true },
      { group: 'g2', items: ['c'] },
    ]);
    const { nav } = mount(root);
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g1' });
    press(root, 'ArrowDown');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g2' }, 'элементы свёрнутой группы пропущены');
    nav.destroy();
  });

  it('Home/End — к границам видимого списка', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }, { group: 'g2', items: ['b'] }]);
    const { nav } = mount(root);
    press(root, 'End');
    assert.deepEqual(nav.current(), { kind: 'item', key: 'b' });
    press(root, 'Home');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g1' });
    nav.destroy();
  });

  it('←/→ сообщают о сворачивании/разворачивании текущей группы', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav, spy } = mount(root);
    press(root, 'ArrowDown');
    press(root, 'ArrowLeft');
    press(root, 'ArrowRight');
    assert.deepEqual(spy.collapses, [
      { key: 'g1', collapsed: true },
      { key: 'g1', collapsed: false },
    ]);
    nav.destroy();
  });

  it('Enter активирует текущую сущность; без выделения — ничего', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav, spy } = mount(root);
    press(root, 'Enter');
    assert.deepEqual(spy.activations, [], 'без выделения активации нет');
    press(root, 'ArrowDown');
    press(root, 'Enter');
    press(root, 'ArrowDown');
    press(root, 'Enter');
    assert.deepEqual(spy.activations, ['group:g1', 'item:a']);
    nav.destroy();
  });

  it('в поле ввода стрелки навигацию не двигают', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav } = mount(root);
    press(root, 'ArrowDown', new ShimElement('input', 'rename'));
    assert.equal(nav.current(), null);
    nav.destroy();
  });

  it('выделение переживает перерисовку; пропавшая сущность снимается', () => {
    const root = buildList([{ group: 'g1', items: ['a', 'b'] }]);
    const { nav } = mount(root);
    press(root, 'ArrowDown');
    press(root, 'ArrowDown'); // item a
    assert.equal(currentKey(root), 'a');

    // Полная перерисовка: узлы заменены новыми, выделения на них нет.
    root.replaceChildren(buildList([{ group: 'g1', items: ['a', 'b'] }]).children[0] as ShimElement);
    assert.equal(currentKey(root), null);
    nav.refresh();
    assert.equal(currentKey(root), 'a', 'выделение переприменено по ключу');

    // Сущность исчезла — выделение снимается.
    root.replaceChildren(buildList([{ group: 'g1', items: ['b'] }]).children[0] as ShimElement);
    nav.refresh();
    assert.equal(nav.current(), null);
    nav.destroy();
  });
});
