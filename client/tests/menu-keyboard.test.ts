/**
 * Клавиатурный профиль общего меню (`options.keyboard`, 0.15.4, тех.проект
 * 43329662, задача 33ed043c, элемент 50299ca1, ADR 8f0e9412).
 *
 * Профиль обслуживает список выбора привязки дневниковой записи: контейнер —
 * ARIA `listbox`, строки — `option` с `aria-selected`, ↑/↓ двигают подсвеченный
 * пункт с ПРОПУСКОМ недоступных, Enter выбирает его, Esc закрывает меню. Клавиши
 * гасятся в существующем capture-слушателе `showMenuAt`: иначе стрелки
 * одновременно двигали бы список результатов/холст под меню.
 *
 * Зачем поведенческий тест (замечание приёмки 1): до него профиль проверялся
 * только GUI-сценарием стенда — потеря ↓/Enter оставалась незамеченной в
 * обычном прогоне. Здесь меню строится на общем DOM-шиме, а клавиши приходят
 * тем же путём, что из окна (capture-слушатель `window`).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type MenuModule = typeof import('../src/renderer/lib/menu.js');
type Listener = (event: any) => void;

let menu: MenuModule;
let body: ShimElement;
const windowListeners = new Map<string, Set<Listener>>();

/** Минимальное окружение окна: `document`, `window`, реестр слушателей. */
function installShim(): void {
  windowListeners.clear();
  body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (type: string, listener: Listener): void => {
    const set = windowListeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    windowListeners.set(type, set);
  };
  win.removeEventListener = (type: string, listener: Listener): void => {
    windowListeners.get(type)?.delete(listener);
  };
}

/** Клавиатурное событие окна и счётчики гашения. */
function keydown(key: string): { prevented: number; stopped: number } {
  const calls = { prevented: 0, stopped: 0 };
  const event = {
    type: 'keydown',
    key,
    target: body,
    repeat: false,
    preventDefault: (): void => {
      calls.prevented += 1;
    },
    stopImmediatePropagation: (): void => {
      calls.stopped += 1;
    },
  };
  for (const listener of [...(windowListeners.get('keydown') ?? [])]) listener(event);
  return calls;
}

/** Строки-пункты открытого меню (прямые дети корня). */
function rows(root: ShimElement): ShimElement[] {
  return root.querySelectorAll(':scope > .menu-item');
}

/** Состояние подсветки: `aria-selected` по строкам. */
function selected(root: ShimElement): boolean[] {
  return rows(root).map((row) => row.getAttribute('aria-selected') === 'true');
}

beforeEach(async () => {
  installShim();
  menu = await import('../src/renderer/lib/menu.js');
  menu.closeMenu();
});

describe('меню: клавиатурный профиль списка выбора (задача 33ed043c)', () => {
  it('ARIA: контейнер — listbox, строки — option, стартовая подсветка на первом пункте', () => {
    const root = menu.showMenuAt(
      10,
      10,
      [menu.menuAction('Первый'), menu.menuAction('Второй'), menu.menuAction('Третий')],
      { keyboard: true },
    ) as unknown as ShimElement;

    assert.equal(root.getAttribute('role'), 'listbox', 'контейнер объявлен списком выбора');
    assert.deepEqual(
      rows(root).map((row) => row.getAttribute('role')),
      ['option', 'option', 'option'],
      'каждая строка — пункт списка',
    );
    assert.deepEqual(
      selected(root),
      [true, false, false],
      'подсвечен первый пункт: курсор виден без первого нажатия стрелки',
    );
  });

  it('↓/↑ двигают подсветку и ПРОПУСКАЮТ недоступные пункты', () => {
    const root = menu.showMenuAt(
      10,
      10,
      [
        menu.menuAction('Первый'),
        menu.menuAction('Недоступный', undefined, { disabled: true }),
        menu.menuAction('Третий'),
      ],
      { keyboard: true },
    ) as unknown as ShimElement;

    assert.deepEqual(selected(root), [true, false, false], 'старт — первый доступный');

    const down = keydown('ArrowDown');
    assert.deepEqual(selected(root), [false, false, true], '↓ через недоступный — к третьему');
    assert.equal(down.prevented, 1, '↓ погашена: не двигает список под меню');
    assert.equal(down.stopped, 1, '↓ не доходит до слоёв ниже меню');

    keydown('ArrowUp');
    assert.deepEqual(selected(root), [true, false, false], '↑ возвращает на первый доступный');
  });

  it('↑/↓ на краю списка не заворачивают подсветку и не гасят клавишу', () => {
    const root = menu.showMenuAt(10, 10, [menu.menuAction('Первый'), menu.menuAction('Второй')], {
      keyboard: true,
    }) as unknown as ShimElement;

    const up = keydown('ArrowUp');
    assert.deepEqual(selected(root), [true, false], 'выше первого пункта двигаться некуда');
    assert.equal(up.prevented, 0, 'необработанная клавиша не гасится');

    keydown('ArrowDown');
    const down = keydown('ArrowDown');
    assert.deepEqual(selected(root), [false, true], 'на последнем пункте подсветка остаётся');
    assert.equal(down.prevented, 0, 'край списка — клавиша свободна');
  });

  it('Enter выбирает подсвеченный пункт и закрывает меню', () => {
    const chosen: string[] = [];
    const root = menu.showMenuAt(
      10,
      10,
      [
        menu.menuAction('Первый', () => chosen.push('первый')),
        menu.menuAction('Второй', () => chosen.push('второй')),
      ],
      { keyboard: true },
    ) as unknown as ShimElement;

    keydown('ArrowDown');
    const enter = keydown('Enter');

    assert.deepEqual(chosen, ['второй'], 'Enter выполняет команду подсвеченного пункта');
    assert.equal(menu.isMenuOpen(), false, 'выбор закрывает меню');
    assert.equal(enter.prevented, 1, 'Enter погашен — не активирует строку под меню');
    assert.equal(enter.stopped, 1, 'Enter не доходит до слоёв ниже меню');
    assert.equal(rows(root).length, 2, 'строки меню не пересобирались');
  });

  it('Esc закрывает меню списка выбора', () => {
    menu.showMenuAt(10, 10, [menu.menuAction('Первый')], { keyboard: true });
    assert.equal(menu.isMenuOpen(), true, 'меню открыто');

    const escape = keydown('Escape');
    assert.equal(menu.isMenuOpen(), false, 'Esc закрывает меню');
    assert.equal(escape.prevented, 1, 'Esc принадлежит меню, а не слоям под ним');
  });

  it('без `keyboard` профиль выключен: нет listbox и стрелки не гасятся', () => {
    const root = menu.showMenuAt(10, 10, [
      menu.menuAction('Первый'),
      menu.menuAction('Второй'),
    ]) as unknown as ShimElement;

    assert.equal(root.getAttribute('role'), null, 'обычное меню не объявляет себя списком');
    assert.deepEqual(
      rows(root).map((row) => row.getAttribute('aria-selected')),
      [null, null],
      'подсветки пунктов нет',
    );

    const down = keydown('ArrowDown');
    assert.equal(down.prevented, 0, 'стрелка остаётся слоям ниже меню');
    assert.equal(down.stopped, 0, 'событие не гасится');
  });

  it('недоступный пункт нельзя выбрать Enter-ом', () => {
    const chosen: string[] = [];
    menu.showMenuAt(
      10,
      10,
      [
        menu.menuAction('Только доступный', () => chosen.push('ok')),
        menu.menuAction('Недоступный', () => chosen.push('bad'), { disabled: true }),
      ],
      { keyboard: true },
    );

    keydown('ArrowDown');
    keydown('Enter');

    assert.deepEqual(chosen, ['ok'], 'Enter выбрал доступный пункт, недоступный пропущен');
  });
});
