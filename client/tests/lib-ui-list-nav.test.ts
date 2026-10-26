/**
 * Поведение общего ядра клавиатурной навигации и компонента списка `lib/ui`
 * (ADR «Списки и таблицы: два компонента над общим ядром навигации» fadf99e0,
 * требование 93115633, задача 7893e429).
 *
 * Проверяем то, за что отвечает ядро и что раньше дублировалось по модулям:
 *   • чистая математика навигации — стрелки, границы, Home/End, PgUp/PgDn,
 *     поведение без текущей строки;
 *   • компонент списка на подставном адаптере — ход по видимой
 *     последовательности (группа → её элементы), Home/End, Ctrl+↑/↓
 *     сворачивание/разворачивание группы, ←/→ шаг по ряду в сеточном списке,
 *     Enter-активация, отсечка полей ввода, сохранение выделения по ключу
 *     после перерисовки.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `publications-library-nav.test.ts`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';
import {
  isEditingTarget,
  listTargetIndex,
  nextNavIndex,
  pickSpatialTarget,
  resolveNavAction,
  shouldDrawCurrentFrame,
} from '../src/renderer/lib/ui/nav-core.js';
import { createListNav, type ListNavAdapter, type ListNavHandle } from '../src/renderer/lib/ui/list.js';
import { bindSearchNav, SEARCH_NAV_KEYS } from '../src/renderer/lib/ui/search-nav.js';

// Клавиатура списка идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

// ---------------------------------------------------------------------------
// Чистое ядро
// ---------------------------------------------------------------------------

describe('nav-core: чистая математика навигации', () => {
  it('resolveNavAction: карта клавиш едина для таблиц и списков', () => {
    assert.equal(resolveNavAction('ArrowUp'), 'up');
    assert.equal(resolveNavAction('ArrowDown'), 'down');
    assert.equal(resolveNavAction('Home'), 'home');
    assert.equal(resolveNavAction('End'), 'end');
    assert.equal(resolveNavAction('ArrowLeft'), 'left', '← — шаг влево по ряду');
    assert.equal(resolveNavAction('ArrowRight'), 'right', '→ — шаг вправо по ряду');
    assert.equal(resolveNavAction('Enter'), 'activate');
    assert.equal(resolveNavAction('Tab'), null, 'Tab ядром не перехватывается (режим полей)');
    assert.equal(resolveNavAction('Escape'), null);
    // Свёрнутость узла — только Ctrl-сочетания (решение пользователя 2026-10-25):
    // прежняя роль ←/→ ушла к Ctrl+↑/↓, ←/→ свободны для хода по колонкам.
    assert.equal(resolveNavAction('ArrowUp', { ctrlKey: true }), 'collapse');
    assert.equal(resolveNavAction('ArrowDown', { ctrlKey: true }), 'expand');
    assert.equal(resolveNavAction('ArrowUp', { altKey: true }), 'moveUp', 'Alt-перенос не задет');
    assert.equal(resolveNavAction('ArrowDown', { altKey: true }), 'moveDown');
    assert.equal(resolveNavAction('ArrowLeft', { ctrlKey: true }), 'left', 'Ctrl не меняет ←');
    assert.equal(resolveNavAction('ArrowUp', { ctrlKey: true, shiftKey: true }), 'collapse');
    assert.equal(resolveNavAction('ArrowUp', { altKey: true, ctrlKey: true }), 'moveUp', 'Alt приоритетнее');
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
    // Последовательная навигация ←/→ индекса не двигает: колонки решает
    // геометрия в компоненте, ядро лишь распознаёт действие.
    assert.equal(nextNavIndex('left', 2, 5), 2);
    assert.equal(nextNavIndex('right', 2, 5), 2);
    assert.equal(nextNavIndex('collapse', 2, 5), 2);
    assert.equal(nextNavIndex('expand', 2, 5), 2);
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
// Пространственная (2D) навигация — общая для карты и сеточных списков
// (задача 432ab7ba п.2) и двухрамочная семантика (ADR e6d48e09)
// ---------------------------------------------------------------------------

describe('nav-core: пространственная навигация', () => {
  interface Box {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const box = (key: string, x: number, y: number, w = 100, h = 60): Box => ({ key, x, y, w, h });
  const pick = (items: Box[], cur: Box, dx: -1 | 0 | 1, dy: -1 | 0 | 1): Box | null =>
    pickSpatialTarget(items, cur, dx, dy, (item) => item.key, cur.key);

  it('матрица переходов «2 столбца × 2 строки»: ←/→ по строке, ↑/↓ по столбцу', () => {
    const a1 = box('a1', 105, 30);
    const a2 = box('a2', 305, 30);
    const b1 = box('b1', 105, 100);
    const b2 = box('b2', 305, 100);
    const items = [a1, a2, b1, b2];
    assert.equal(pick(items, a1, 1, 0)?.key, 'a2', '→ вправо по ряду');
    assert.equal(pick(items, a2, -1, 0)?.key, 'a1', '← влево по ряду');
    assert.equal(pick(items, a2, 0, 1)?.key, 'b2', '↓ по столбцу');
    assert.equal(pick(items, b1, 0, -1)?.key, 'a1', '↑ по столбцу');
    assert.equal(pick(items, b2, 1, 0), null, 'в крайнем ряду → вправо цели нет');
    assert.equal(pick(items, a1, 0, -1), null, 'из верхнего ряда ↑ цели нет');
  });

  it('sameRowOnly: ←/→ только к соседу своего ряда (крайние колонки, неполный ряд)', () => {
    // Сетка 3 колонки × 3 ряда; последний ряд неполный (одна карточка c1).
    //           a1(0) a2(105) a3(210)
    //           b1(0) b2(105) b3(210)
    //           c1(0)
    const a1 = box('a1', 0, 0);
    const a2 = box('a2', 105, 0);
    const a3 = box('a3', 210, 0);
    const b1 = box('b1', 0, 70);
    const b2 = box('b2', 105, 70);
    const b3 = box('b3', 210, 70);
    const c1 = box('c1', 0, 140);
    const items = [a1, a2, a3, b1, b2, b3, c1];
    const rowPick = (cur: Box, dx: -1 | 0 | 1): Box | null =>
      pickSpatialTarget(items, cur, dx, 0, (item) => item.key, cur.key, {
        lateral: 'overlap',
        sameRowOnly: true,
      });
    // Сосед есть — шаг к нему.
    assert.equal(rowPick(a1, 1)?.key, 'a2');
    assert.equal(rowPick(a2, 1)?.key, 'a3');
    assert.equal(rowPick(a2, -1)?.key, 'a1');
    assert.equal(rowPick(b3, -1)?.key, 'b2');
    // Крайняя правая/левая колонка — соседа нет.
    assert.equal(rowPick(a3, 1), null, 'правая колонка: → цели нет');
    assert.equal(rowPick(a1, -1), null, 'левая колонка: ← цели нет');
    // Неполный последний ряд: справа пусто. Без ограничения ряда карта нашла бы
    // «справа-сверху» (a2/b2) и прыгнула через ряд — соседом это не является.
    assert.equal(rowPick(c1, 1), null, 'неполный ряд: → цели нет (не прыгаем в верхний ряд)');
    assert.equal(
      pickSpatialTarget(items, c1, 1, 0, (item) => item.key, c1.key, { lateral: 'overlap' })?.key,
      'b2',
      'контроль: без sameRowOnly карта (и прежнее поведение) берёт справа-сверху',
    );
    // Один столбец: ←/→ целей нет ни у одной строки.
    const column = [box('s1', 0, 0, 400, 20), box('s2', 0, 30, 400, 60)];
    assert.equal(
      pickSpatialTarget(column, column[0]!, 1, 0, (item) => item.key, 's1', {
        lateral: 'overlap',
        sameRowOnly: true,
      }),
      null,
      'один столбец: → не перехватывается',
    );
  });

  it('боковой штраф: сущность на одной оси выигрывает у ближе по «вперёд»', () => {
    const cur = box('cur', 200, 200);
    const axis = box('axis', 210, 300);
    const diag = box('diag', 320, 280);
    assert.equal(pick([axis, diag], cur, 0, 1)?.key, 'axis');
  });

  it('текущая сущность сама целью не становится', () => {
    const cur = box('cur', 200, 200);
    assert.equal(pick([box('cur', 200, 200)], cur, 0, 1), null);
  });

  it('shouldDrawCurrentFrame: пунктир не рисуется на открытом в редакторе', () => {
    assert.equal(shouldDrawCurrentFrame('t1', null), true, 'нет открытого — пунктир есть');
    assert.equal(shouldDrawCurrentFrame('t1', 't2'), true, 'текущий ≠ открытый — обе рамки');
    assert.equal(shouldDrawCurrentFrame('t1', 't1'), false, 'текущий = открытый — только сплошная');
    assert.equal(shouldDrawCurrentFrame(null, 't1'), false, 'нет текущего — пунктира нет');
  });

  it('lateral «overlap»: заголовок во всю ширину выигрывает вертикаль у книжки своей колонки', () => {
    // Заголовок следующей группы (во всю ширину) прямо под текущей книжкой;
    // книжка той же колонки — чуть дальше. Центровая метрика берёт книжку
    // (бокового смещения нет), перекрытийная — заголовок (интервалы пересеклись).
    const header = box('header', 0, 100, 400, 20);
    const sameColBook = box('book', 305, 140, 100, 60);
    const cur = box('cur', 305, 30, 100, 60);
    assert.equal(
      pick(itemsWith(header, sameColBook), cur, 0, 1)?.key,
      'book',
      'по умолчанию (центры) — ближайшая книжка колонки',
    );
    assert.equal(
      pickSpatialTarget(itemsWith(header, sameColBook), cur, 0, 1, (i) => i.key, cur.key, {
        lateral: 'overlap',
      })?.key,
      'header',
      'по перекрытию — заголовок группы (e80da89f п.1)',
    );
  });
});

/** Хелпер: список боксов для точечной проверки метрики. */
function itemsWith(...boxes: Array<{ key: string; x: number; y: number; w: number; h: number }>): Array<{
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  return boxes;
}

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
      // Лист (элемент группы) свёрнутости не имеет — событие не перехватываем.
      if (entry.kind !== 'group') return false;
      spy.collapses.push({ key: entry.key, collapsed });
      return true;
    },
    onActivate: (entry) => spy.activations.push(`${entry.kind}:${entry.key}`),
  };
  const nav = createListNav<GroupedEntry>(root as unknown as HTMLElement, adapter);
  return { nav, spy };
}

function press(root: ShimElement, key: string, target?: ShimElement): void {
  // Фокус внутри списка кладёт его контекст на вершину стека диспетчера.
  root.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    target: target ?? root,
    preventDefault: (): void => undefined,
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
}

/** Нажатие с явными модификаторами (задача fd3d84f4, волна 1). */
function pressMods(root: ShimElement, key: string, mods: Record<string, boolean>): void {
  root.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
    target: root,
    preventDefault: (): void => undefined,
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
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

  it('Ctrl+↑/↓ сворачивают/разворачивают текущую группу; на листе — не перехватываются', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav, spy } = mount(root);
    press(root, 'ArrowDown');
    pressMods(root, 'ArrowUp', { ctrlKey: true });
    pressMods(root, 'ArrowDown', { ctrlKey: true });
    assert.deepEqual(spy.collapses, [
      { key: 'g1', collapsed: true },
      { key: 'g1', collapsed: false },
    ]);
    // Обычные ←/→ свёрнутость больше не трогают: в одноколоночном списке
    // соседей по ряду нет — событие остаётся необработанным.
    assert.equal(nav.handleKey('ArrowLeft'), false, '← в одной колонке не перехватывается');
    assert.equal(nav.handleKey('ArrowRight'), false, '→ в одной колонке не перехватывается');
    assert.equal(spy.collapses.length, 2, '←/→ свёрнутость не меняют');
    // Лист (элемент группы) свёрнутости не имеет: Ctrl+↑ и Ctrl+↓ — не наши.
    press(root, 'ArrowDown'); // текущая — элемент a
    assert.equal(nav.handleKey('ArrowUp', { ctrlKey: true }), false, 'Ctrl+↑ на листе не перехвачен');
    assert.equal(nav.handleKey('ArrowDown', { ctrlKey: true }), false, 'Ctrl+↓ на листе не перехвачен');
    assert.equal(spy.collapses.length, 2, 'лист свёрнутость не меняет');
    nav.destroy();
  });

  it('←/→ в сеточном списке: сосед по ряду; крайние колонки и неполный ряд — не перехватываются', () => {
    // Сетка в координатах окна: 3 колонки, последний ряд неполный.
    const cells = new Map<string, ShimElement>();
    const boxes = new Map<string, { x: number; y: number; w: number; h: number }>([
      ['a1', { x: 0, y: 0, w: 100, h: 60 }],
      ['a2', { x: 105, y: 0, w: 100, h: 60 }],
      ['a3', { x: 210, y: 0, w: 100, h: 60 }],
      ['b1', { x: 0, y: 70, w: 100, h: 60 }],
      ['b2', { x: 105, y: 70, w: 100, h: 60 }],
      ['c1', { x: 0, y: 140, w: 100, h: 60 }],
    ]);
    const root = new ShimElement('div', 'grid');
    for (const key of boxes.keys()) {
      const cell = new ShimElement('div', 'cell');
      cell.setAttribute('data-item', key);
      cells.set(key, cell);
      root.append(cell);
    }
    const keys = [...boxes.keys()];
    const nav = createListNav<{ kind: 'item'; key: string }>(root as unknown as HTMLElement, {
      entries: () => keys.map((key) => ({ kind: 'item', key })),
      tokenOf: (entry) => entry.key,
      elementOf: (entry) => (cells.get(entry.key) as unknown as HTMLElement) ?? null,
      applyHighlight: (entry) => {
        for (const el of root.querySelectorAll('.current')) el.classList.remove('current');
        if (entry !== null) cells.get(entry.key)?.classList.add('current');
      },
      boxOf: (entry) => boxes.get(entry.key) ?? null,
      useSpatialNav: () => true,
    });
    const at = (key: string): void => nav.setCurrent({ kind: 'item', key });
    // Без выделения соседа нет — ←/→ не перехватываются (↓/↑ работают как прежде).
    assert.equal(nav.handleKey('ArrowRight'), false, '→ без выделения не перехвачена');
    assert.equal(nav.handleKey('ArrowLeft'), false, '← без выделения не перехвачена');
    assert.equal(nav.current(), null);
    // Соседи по ряду: a1 → a2 → a3 и обратно.
    at('a1');
    assert.equal(nav.handleKey('ArrowRight'), true);
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a2' });
    assert.equal(nav.handleKey('ArrowRight'), true);
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a3' });
    // Крайняя правая колонка — справа соседа нет, клавиша не наша.
    assert.equal(nav.handleKey('ArrowRight'), false, 'правая колонка: → не перехватывается');
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a3' }, 'выделение не сдвинулось');
    assert.equal(nav.handleKey('ArrowLeft'), true);
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a2' });
    // Неполный последний ряд: справа пусто (в верхнем ряду «справа-сверху» —
    // не сосед, через ряд не прыгаем), слева тоже пусто.
    at('c1');
    assert.equal(nav.handleKey('ArrowRight'), false, 'неполный ряд: → не перехватывается');
    assert.equal(nav.handleKey('ArrowLeft'), false, 'неполный ряд: ← не перехватывается');
    assert.deepEqual(nav.current(), { kind: 'item', key: 'c1' });
    // В полном ряду ← от первой колонки — цели нет.
    at('b1');
    assert.equal(nav.handleKey('ArrowLeft'), false, 'левая колонка: ← не перехватывается');
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

  it('модификаторный Enter (Ctrl/Shift/Meta) активирует; Alt+Enter — нет, как прежде', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav, spy } = mount(root);
    press(root, 'ArrowDown'); // текущая — группа g1
    pressMods(root, 'Enter', { ctrlKey: true });
    pressMods(root, 'Enter', { shiftKey: true });
    pressMods(root, 'Enter', { metaKey: true });
    assert.deepEqual(
      spy.activations,
      ['group:g1', 'group:g1', 'group:g1'],
      'Ctrl/Shift/Meta+Enter активируют текущую сущность (прежний обработчик игнорировал модификаторы)',
    );
    // Прежний `resolveNavAction(key, { altKey })` при Alt даёт null — Alt+Enter не активировал.
    pressMods(root, 'Enter', { altKey: true });
    assert.equal(spy.activations.length, 3, 'Alt+Enter активации не даёт, как и раньше');
    nav.destroy();
  });

  it('в поле ввода стрелки навигацию не двигают', () => {
    const root = buildList([{ group: 'g1', items: ['a'] }]);
    const { nav } = mount(root);
    press(root, 'ArrowDown', new ShimElement('input', 'rename'));
    assert.equal(nav.current(), null);
    nav.destroy();
  });

  it('handleKey: клавиша исполняется без фокуса на списке (мост поля поиска)', () => {
    // Мост `lib/ui/search-nav` передаёт ↑/↓/Enter списку, пока фокус стоит в
    // поле поиска: нажатие синтетическое (target — не поле правки), поэтому
    // отсечка `isEditing` не должна глушить навигацию (ошибка be095da7).
    const root = buildList([{ group: 'g1', items: ['a', 'b'] }]);
    const { nav, spy } = mount(root);
    assert.equal(nav.handleKey('ArrowDown'), true, '↓ обработан');
    assert.deepEqual(nav.current(), { kind: 'group', key: 'g1' });
    assert.equal(nav.handleKey('ArrowDown'), true);
    assert.deepEqual(nav.current(), { kind: 'item', key: 'a' }, 'выделение дошло до первой строки');
    assert.equal(nav.handleKey('Enter'), true, 'Enter активирует текущую сущность');
    assert.deepEqual(spy.activations, ['item:a']);
    assert.equal(nav.handleKey('Tab'), false, 'клавиши вне правил ядра списку не принадлежат');
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

// ---------------------------------------------------------------------------
// Мост «поле поиска → навигация списка» (задача 15236418): ←/→ НЕ передаются
// (каретка поля), Ctrl+↑/↓ передаются с модификаторами (свёрнутость из поиска).
// ---------------------------------------------------------------------------

describe('lib/ui/search-nav: передача клавиш и модификаторов', () => {
  interface Forwarded {
    key: string;
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } | undefined;
  }

  function mountBridge(): { input: ShimElement; calls: Forwarded[]; unbind: () => void } {
    const calls: Forwarded[] = [];
    const input = new ShimElement('input', 'list-search');
    const unbind = bindSearchNav(input as unknown as HTMLInputElement, {
      handleKey: (key, modifiers) => {
        calls.push({ key, modifiers });
        return true;
      },
    });
    return { input, calls, unbind };
  }

  function dispatch(input: ShimElement, key: string, mods: Record<string, boolean> = {}): boolean {
    input.emit('focusin', {});
    const handled = keymap.dispatchKeyEvent({
      key,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...mods,
      target: input,
      preventDefault: (): void => undefined,
    } as unknown as KeyboardEvent);
    input.emit('focusout', {});
    return handled;
  }

  it('↑/↓/Enter и Ctrl+↑/↓ уходят в handleKey; модификаторы не теряются', () => {
    const { input, calls, unbind } = mountBridge();
    assert.equal(dispatch(input, 'ArrowDown'), true);
    assert.equal(dispatch(input, 'ArrowUp'), true);
    assert.equal(dispatch(input, 'Enter'), true);
    assert.equal(dispatch(input, 'ArrowDown', { ctrlKey: true }), true);
    assert.equal(dispatch(input, 'ArrowUp', { ctrlKey: true }), true);
    assert.deepEqual(
      calls.map((call) => call.key),
      ['ArrowDown', 'ArrowUp', 'Enter', 'ArrowDown', 'ArrowUp'],
      'Ctrl+↑/↓ доходят той же клавишей, а не теряются',
    );
    assert.equal(calls[0]?.modifiers?.ctrlKey, false, 'обычная ↓ — без Ctrl');
    assert.equal(calls[3]?.modifiers?.ctrlKey, true, 'Ctrl+↓ — с Ctrl (иначе фасад прочтёт как ↓)');
    assert.equal(calls[4]?.modifiers?.ctrlKey, true, 'Ctrl+↑ — с Ctrl');
    // ←/→ не входят в набор моста: в поле это клавиши каретки.
    assert.deepEqual([...SEARCH_NAV_KEYS], ['ArrowDown', 'ArrowUp', 'Enter', 'Ctrl+ArrowDown', 'Ctrl+ArrowUp']);
    assert.equal(dispatch(input, 'ArrowLeft'), false, '← полю, не списку');
    assert.equal(dispatch(input, 'ArrowRight'), false, '→ полю, не списку');
    assert.equal(calls.length, 5, '←/→ до списка не дошли');
    unbind();
    assert.equal(dispatch(input, 'ArrowDown'), false, 'после снятия моста клавиши не перехватываются');
  });
});
