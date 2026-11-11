/**
 * Переполнение чипов привязок в строке-записи (0.15.4, тех.проект 43329662,
 * задача 33ed043c, элемент 554e3129, ADR 8f0e9412; сценарий S4 «Переполнение
 * чипов привязок»).
 *
 * Контракт (замечание приёмки 2 — до него обвязка проверялась только регулярками
 * сторожа, а стенд с двумя чипами переполнения не создаёт):
 *  - чипы, не поместившиеся по ширине полосы, уходят в кнопку «+N» (N — их
 *    число), а не теряются;
 *  - кнопка «+N» — отдельная цель клика: её нажатие раскрывает список
 *    непоместившихся привязок (профиль `keyboard` — ARIA `listbox`);
 *  - выбор пункта списка открывает ИМЕННО ту привязку, которая ушла в остаток;
 *  - потолок строк-записей «Показано N из M» — тот же модуль и та же клиентская
 *    константа `RECORD_ROWS_LIMIT` (визуальный паттерн, не серверный механизм).
 *
 * Ширины в шиме: полоса `.record-row-chips` сообщает управляемую ширину
 * (`clientWidth`), чип и кнопка — прямоугольник по умолчанию (100 px). План
 * раскладки считает общий чистый `planHistoryChips` — проверяется РЕЗУЛЬТАТ:
 * сколько чипов осталось на полосе, сколько ушло в «+N» и куда ведёт пункт.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { ChronicleTarget } from '@etn/shared';

import { createRecordRow } from '../src/renderer/lib/record-row.js';
import { planRecordCap, RECORD_ROWS_LIMIT } from '../src/renderer/lib/chip-overflow.js';
import type { RecordTargetRef } from '../src/renderer/lib/record-targets.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NETWORK = '00000000-0000-4000-8000-00000000000a';
const OWNER = '55555555-5555-4555-8555-555555555555';
const COMMENT = '66666666-6666-4666-8666-666666666666';
const FROM = '2026-11-10T09:15:00.000Z';
const TO = '2026-11-10T10:45:00.000Z';

/** Ширина полосы чипов, которую «измеряет» шим (реальную раскладку он не считает). */
let stripWidth = 250;

// Шим не знает `clientWidth` (в браузере его отдаёт раскладка): полоса чипов
// получает управляемую ширину, прочие элементы — нулевую (как вне документа).
Object.defineProperty(ShimElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: ShimElement) {
    return this.className.includes('record-row-chips') ? stripWidth : 0;
  },
});

/** Привязка-мысль строки-записи. */
function thoughtTarget(index: number): ChronicleTarget {
  return {
    kind: 'thought',
    thought: {
      id: `11111111-1111-4111-8111-00000000000${index}`,
      title: `Привязка ${index}`,
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      icon_attachment_id: null,
      active: true,
      marked_for_deletion: false,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    },
  };
}

/** Полное окружение: документ, окно, тело для портала меню. */
function installDom(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener ??= () => undefined;
  win.removeEventListener ??= () => undefined;
  return body;
}

/** Полоса чипов строки-записи. */
function chipsHost(handle: { el: HTMLElement }): ShimElement {
  const host = handle.el.querySelector('.record-row-chips');
  assert.ok(host !== null, 'полоса чипов `.record-row-chips` на месте');
  return host as unknown as ShimElement;
}

/** Кнопка «+N» в полосе (последний ребёнок, если остаток есть). */
function moreButton(host: ShimElement): ShimElement {
  const last = host.children[host.children.length - 1] as ShimElement | undefined;
  assert.ok(last !== undefined, 'в полосе есть дети');
  assert.equal(last.classList.contains('record-row-more'), true, 'последний элемент полосы — «+N»');
  return last;
}

/** Число непоместившихся чипов из подписи кнопки «+N». */
function restCount(more: ShimElement): number {
  const match = /^\+(\d+)$/u.exec((more.textContent ?? '').trim());
  assert.ok(match !== null, `подпись кнопки — «+N», получено «${more.textContent}»`);
  return Number(match[1]);
}

/** Показанные на полосе чипы (без кнопки «+N»). */
function shownChips(host: ShimElement): ShimElement[] {
  return host.children.filter(
    (child) =>
      child.classList.contains('chron-chip') && !child.classList.contains('record-row-more'),
  ) as ShimElement[];
}

beforeEach(() => {
  installDom();
  stripWidth = 250;
});

describe('переполнение чипов привязок строки-записи (S4, задача 33ed043c)', () => {
  it('чипы сверх лимита уходят в «+N»: часть видна, остаток посчитан', () => {
    const targets = [1, 2, 3, 4, 5].map(thoughtTarget);
    const handle = createRecordRow(
      {
        commentId: COMMENT,
        validFrom: FROM,
        validTo: TO,
        useTime: false,
        snippet: 'Текст записи.',
        targets,
        ownerType: 'thought',
        ownerId: OWNER,
      },
      {
        networkId: NETWORK,
        visibility: { homeId: null, showInactive: false, showTrash: false },
        onOpen: () => undefined,
      },
    );

    const host = chipsHost(handle);
    const shown = shownChips(host);
    const more = moreButton(host);
    const rest = restCount(more);

    assert.ok(shown.length > 0, 'полоса не пуста: часть чипов помещается');
    assert.ok(rest > 0, 'узкая полоса: часть чипов не помещается');
    assert.equal(shown.length + rest, targets.length, 'ни один чип не потерян: полоса + остаток');
    assert.ok(
      (more.textContent ?? '') !== `+${targets.length}`,
      'в «+N» уходит только остаток, а не все чипы',
    );
    handle.destroy();
  });

  it('клик «+N» раскрывает список остатка (ARIA listbox) и открывает выбранную привязку', () => {
    const targets = [1, 2, 3, 4, 5].map(thoughtTarget);
    const opened: RecordTargetRef[] = [];
    const body = (globalThis as any).document.body as ShimElement;
    const handle = createRecordRow(
      {
        commentId: COMMENT,
        validFrom: FROM,
        validTo: TO,
        useTime: false,
        snippet: 'Текст записи.',
        targets,
        ownerType: 'thought',
        ownerId: OWNER,
      },
      {
        networkId: NETWORK,
        visibility: { homeId: null, showInactive: false, showTrash: false },
        onOpen: (target) => opened.push(target),
      },
    );

    const host = chipsHost(handle);
    const shown = shownChips(host);
    const more = moreButton(host);
    const rest = restCount(more);

    more.click();

    const menuRoot = body.children[body.children.length - 1] as ShimElement | undefined;
    assert.ok(menuRoot !== undefined, 'меню остатка открыто');
    assert.equal(menuRoot.classList.contains('menu'), true, 'портал меню — `.menu`');
    assert.equal(menuRoot.getAttribute('role'), 'listbox', 'список выбора — клавиатурный профиль');
    const items = menuRoot.querySelectorAll(':scope > .menu-item');
    assert.equal(items.length, rest, 'в списке ровно непоместившиеся привязки');

    // Первый пункт остатка — привязка сразу за последней показанной.
    (items[0] as ShimElement).click();

    assert.equal(opened.length, 1, 'выбор пункта — одно открытие');
    const expected = targets[shown.length] as ChronicleTarget;
    assert.deepEqual(
      opened[0],
      { kind: 'thought', id: expected.kind === 'thought' ? expected.thought.id : '' },
      'открывается ИМЕННО привязка из остатка, а не первая на полосе',
    );
    handle.destroy();
  });

  it('потолок «Показано N из M» — общая константа обвязки', () => {
    assert.equal(RECORD_ROWS_LIMIT, 20, 'N — клиентская константа, сервер отдаёт все строки');

    const plan = planRecordCap(Array.from({ length: RECORD_ROWS_LIMIT + 2 }, (_v, i) => i));

    assert.equal(plan.shown.length, RECORD_ROWS_LIMIT, 'срез по умолчанию');
    assert.equal(plan.total, RECORD_ROWS_LIMIT + 2, 'M — число строк в ответе');
    assert.equal(
      plan.caption,
      `Показано ${RECORD_ROWS_LIMIT} из ${RECORD_ROWS_LIMIT + 2}`,
      'подпись называет N и M',
    );
  });
});
