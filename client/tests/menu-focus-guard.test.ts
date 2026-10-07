/**
 * Регресс-тест ошибки `64b18420` «Команда контекстного меню комментария не
 * применяется — поле уходит в просмотр» (0.12.1).
 *
 * Причина: защита фокуса (`guardCommentMenuFocus`) вешала `mousedown →
 * preventDefault()` только на строки `.menu-item`, существовавшие на момент
 * открытия меню. Подменю строятся ЛЕНИВО на `mouseenter` (`lib/menu.ts`,
 * `buildMenu`) и попадают в DOM уже после открытия, поэтому их строки не
 * перехватывали `mousedown`: клик уводил фокус из CodeMirror → `focusout` →
 * `showView`, команда не применялась.
 *
 * Фикс — общий механизм меню `guardMenuFocus` (`lib/menu.ts`): ОДИН
 * делегированный обработчик на контейнере меню в фазе capture гасит `mousedown`
 * по любой строке-потомку `.menu-item`, включая лениво построенные подменю
 * любого уровня вложенности.
 *
 * Проверяется контракт:
 *  - `mousedown` по строке ленивого подменю (и вложенного подменю) гасится —
 *    фокус поля не уходит, поле не переходит в просмотр;
 *  - строка появляется в DOM уже ПОСЛЕ установки защиты, а команда по клику
 *    всё равно применяется;
 *  - защита точечная: клик по разделителю (`menu-sep`, не `.menu-item`)
 *    не гасится.
 *
 * DOM-shimmed, как соседние lib-ui-тесты (`menu-content.test.ts`).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type MenuModule = typeof import('../src/renderer/lib/menu.js');

let menu: MenuModule;
let body: ShimElement;

function installShim(): void {
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
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Строка `.menu-item` по подписи (текст лежит в `span.menu-item-label`). */
function rowByLabel(root: ShimElement, label: string): ShimElement {
  const row = root
    .querySelectorAll('.menu-item')
    .find((item) => item.flatText().includes(label));
  assert.ok(row !== undefined, `строка «${label}» обязана быть в меню`);
  return row;
}

/**
 * Драйверы события от корня меню вниз к цели — как фаза capture в браузере.
 * Шим не умеет всплытие/захват, поэтому обходим цепочку родителей до корня
 * и вызываем слушателей `mousedown` каждого узла в порядке capture.
 */
function dispatchDownCapture(root: ShimElement, target: ShimElement): any {
  const event: any = {
    type: 'mousedown',
    button: 0,
    target,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {},
  };
  const path: ShimElement[] = [];
  let current: ShimElement | null = target;
  while (current !== null) {
    path.push(current);
    if (current === root) break;
    current = current.parent;
  }
  for (const node of path.reverse()) {
    for (const listener of [...(node.listeners['mousedown'] ?? [])]) listener(event);
  }
  return event;
}

beforeEach(async () => {
  installShim();
  menu = (await import('../src/renderer/lib/menu.js')) as MenuModule;
});

describe('guardMenuFocus: защита фокуса строк меню (64b18420)', () => {
  it('гасит mousedown по строке ленивого подменю, построенного после установки защиты', () => {
    const ran: string[] = [];
    const root = menu.showMenuAt(10, 10, [
      {
        label: 'Прочие блочные',
        submenu: [{ label: 'Заголовок 1', onClick: () => ran.push('h1') }],
      },
    ]) as unknown as ShimElement;

    // Защита ставится ДО того, как подменю построено (как в боевом потоке).
    menu.guardMenuFocus(root as unknown as HTMLElement);
    const submenuBefore = root.querySelectorAll('.menu-sub');
    assert.equal(submenuBefore.length, 0, 'подменю строится лениво, а не при открытии');

    // Наведение на родителя строит подменю — строки попадают в DOM ПОСЛЕ guard.
    rowByLabel(root, 'Прочие блочные').emit('mouseenter');
    const submenu = root.querySelectorAll('.menu-sub')[0];
    assert.ok(submenu !== undefined, 'подменю построено на mouseenter');
    const child = rowByLabel(submenu, 'Заголовок 1');

    const event = dispatchDownCapture(root, child);
    assert.equal(
      event.defaultPrevented,
      true,
      'клик по ленивой строке не должен забирать фокус (иначе showView)',
    );

    // Команда применяется тем же кликом.
    child.click();
    assert.deepEqual(ran, ['h1'], 'команда пункта подменю применяется');
    assert.equal(menu.isMenuOpen(), false, 'меню закрывается после выбора пункта');
  });

  it('гасит mousedown по строке вложенного подменю любого уровня', () => {
    const root = menu.showMenuAt(10, 10, [
      {
        label: 'Первый уровень',
        submenu: [
          {
            label: 'Второй уровень',
            submenu: [{ label: 'Глубокий пункт', onClick: () => undefined }],
          },
        ],
      },
    ]) as unknown as ShimElement;
    menu.guardMenuFocus(root as unknown as HTMLElement);

    rowByLabel(root, 'Первый уровень').emit('mouseenter');
    const level1 = root.querySelectorAll('.menu-sub')[0]!;
    rowByLabel(level1, 'Второй уровень').emit('mouseenter');
    const level2 = level1.querySelectorAll('.menu-sub')[0]!;
    const deep = rowByLabel(level2, 'Глубокий пункт');

    const event = dispatchDownCapture(root, deep);
    assert.equal(event.defaultPrevented, true, 'вложенное подменю тоже защищено');
  });

  it('гасит mousedown по обычной строке верхнего уровня', () => {
    const root = menu.showMenuAt(10, 10, [
      { label: 'Жирный', onClick: () => undefined },
    ]) as unknown as ShimElement;
    menu.guardMenuFocus(root as unknown as HTMLElement);
    const event = dispatchDownCapture(root, rowByLabel(root, 'Жирный'));
    assert.equal(event.defaultPrevented, true);
  });

  it('не гасит mousedown по разделителю — защита точечная', () => {
    const root = menu.showMenuAt(10, 10, [
      { label: 'Жирный', onClick: () => undefined },
      { label: '—' },
    ]) as unknown as ShimElement;
    menu.guardMenuFocus(root as unknown as HTMLElement);
    const separator = root.children[1]!;
    assert.ok(separator.className.includes('menu-sep'));
    const event = dispatchDownCapture(root, separator);
    assert.equal(event.defaultPrevented, false, 'разделитель — не строка меню');
  });
});
