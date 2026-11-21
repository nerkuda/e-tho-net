/**
 * «Календарь месяца»: попап содержимого дня (0.16.1, пачка 9, задача ef6d1aab).
 *
 * Пользователь: всплывашка статистики дня оставалась висеть после ухода курсора
 * с календаря — приходилось кликать. Корень: `mouseleave` только отменял ещё не
 * открывшийся попап (`dayInfoOpen.cancel()`), а открытый закрывали лишь клик и
 * перерисовка сетки.
 *
 * Контракты (проверяются на общем компоненте `lib/month-calendar.ts`):
 *   • открытие — по наведению с задержкой 0.5 с (общий `createDelayedOpen`);
 *   • уход курсора с ячейки-источника ЗАКРЫВАЕТ открытый попап;
 *   • уход до истечения задержки отменяет показ (попап не появляется);
 *   • наведение на соседнюю дату открывает попап с её содержимым;
 *   • клик по дню закрывает попап, как и раньше.
 *
 * Дом — DOM-шим (конвенция `month-calendar-week-drag.test.ts`); попап монтируется
 * общим компонентом `lib/ui/popover` в `document.body`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { MonthCalendarDayCounts } from '../src/renderer/lib/month-calendar.js';

import { ShimElement } from './dom-shim.js';

const DAY_A = '2026-11-10';
const DAY_B = '2026-11-11';

let body: ShimElement;

function installShim(): void {
  const tag = (name: string): ShimElement => new ShimElement(name);
  (globalThis as any).document = {
    documentElement: tag('html'),
    createElement: tag,
    createElementNS: (_ns: string, name: string) => tag(name),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelector: (): null => null,
  };
  body = (globalThis as any).document.body as ShimElement;
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): void => undefined;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/** Открытые попапы (общий компонент `lib/ui/popover`). */
function popovers(): ShimElement[] {
  return body.findAll((node: ShimElement) => node.classList.contains('ui-popover'));
}

/** Заголовок верхнего попапа (`null` — попапа нет). */
function popoverTitle(): string | null {
  const top = popovers().at(-1);
  if (top === undefined) return null;
  return top.querySelector('.ui-popover-head')?.flatText().trim() ?? null;
}

/** Дождаться задержки показа попапа (500 мс) с запасом. */
async function afterOpenDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 620));
}

interface Mounted {
  root: ShimElement;
  picks: string[];
}

async function mountCalendar(): Promise<Mounted> {
  installShim();
  const { buildMonthCalendar } = await import('../src/renderer/lib/month-calendar.js');
  const picks: string[] = [];
  const counts: MonthCalendarDayCounts = {
    records: 2,
    tasks: 3,
    reminders: 1,
    facts: 4,
    overdue: 0,
  };
  const handle = buildMonthCalendar({
    month: { year: 2026, month: 11 },
    today: '2026-11-15',
    firstDayOfWeek: 1,
    dayInfo: () => counts,
    onPickDay: (day: string) => picks.push(day),
  });
  return { root: handle.root as unknown as ShimElement, picks };
}

/** Кнопка дня по точной локальной дате (`title` — дата ячейки). */
function dayButton(root: ShimElement, day: string): ShimElement {
  const node = root.findAll((candidate: ShimElement) => {
    if (!candidate.classList.contains('cal-day')) return false;
    const title = (candidate as unknown as { title?: string }).title;
    return (title ?? candidate.getAttribute('title')) === day;
  })[0];
  assert.notEqual(node, undefined, `в сетке есть день ${day}`);
  return node!;
}

/** Навести курсор на ячейку (mouseenter). */
function hover(button: ShimElement): void {
  button.emit('mouseenter');
}

/** Увести курсор с ячейки (mouseleave). */
function leave(button: ShimElement): void {
  button.emit('mouseleave');
}

describe('календарь месяца: попап содержимого дня (ef6d1aab)', () => {
  beforeEach(() => installShim());

  it('наведение открывает попап с задержкой 0.5 с, уход курсора закрывает открытый', async () => {
    const { root } = await mountCalendar();
    const cell = dayButton(root, DAY_A);

    hover(cell);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(popovers().length, 0, 'до истечения задержки попапа нет');

    await afterOpenDelay();
    assert.equal(popovers().length, 1, 'попап открылся по наведению');
    assert.match(popoverTitle() ?? '', new RegExp(DAY_A), 'попап относится к наведённой дате');

    leave(cell);
    assert.equal(popovers().length, 0, 'курсор ушёл с даты-источника — попап погас без клика');
  });

  it('уход курсора до истечения задержки отменяет показ', async () => {
    const { root } = await mountCalendar();
    const cell = dayButton(root, DAY_A);

    hover(cell);
    await new Promise((resolve) => setTimeout(resolve, 150));
    leave(cell);
    await afterOpenDelay();

    assert.equal(popovers().length, 0, 'отложенный показ отменён — попап не всплыл');
  });

  it('наведение на соседнюю дату переоткрывает попап с её содержимым', async () => {
    const { root } = await mountCalendar();
    const first = dayButton(root, DAY_A);
    const second = dayButton(root, DAY_B);

    hover(first);
    await afterOpenDelay();
    assert.match(popoverTitle() ?? '', new RegExp(DAY_A), 'первый попап — по дате A');

    leave(first);
    assert.equal(popovers().length, 0, 'уход закрыл попап даты A');

    hover(second);
    await afterOpenDelay();
    assert.equal(popovers().length, 1, 'соседняя дата открыла попап');
    assert.match(popoverTitle() ?? '', new RegExp(DAY_B), 'содержимое относится к дате B');
  });

  it('клик по дню закрывает попап (прежнее поведение сохранено)', async () => {
    const { root, picks } = await mountCalendar();
    const cell = dayButton(root, DAY_A);

    hover(cell);
    await afterOpenDelay();
    assert.equal(popovers().length, 1, 'попап открыт');

    cell.click();
    assert.equal(popovers().length, 0, 'клик по дню погасил попап');
    assert.deepEqual(picks, [DAY_A], 'день при этом выбран');
  });
});
