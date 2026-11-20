/**
 * «Календарь месяца»: номера недель и перетаскивание диапазона (0.16.1, задача
 * 3054fe86; элементы интерфейса 55b07702 «Календарь месяца в «Дневнике»» и
 * 80cd5ff9 «Диалог ввода даты/периода»).
 *
 * Проверяется поведение ОБЩЕГО компонента (`lib/month-calendar.ts`), а не его
 * потребителей: диалог «Дата/период» только включает `weekNumbers`/`onPickWeek`,
 * а календарь «Дневника» — `enableRangeDrag`/`onRangeChange`.
 *
 * Контракты:
 *   • номер недели — кнопка (Enter/Space нативны), клик сообщает ПЕРВЫЙ день
 *     недели сети (`firstDayOfWeek`), а не понедельник по умолчанию;
 *   • drag начинается только на ячейке дня — номер недели диапазон не
 *     запускает и не расширяет;
 *   • клик без движения — обычный выбор дня (`onPickDay`), drag — диапазон
 *     (`onRangeChange`), обратное направление нормализуется;
 *   • отпускание вне сетки и Esc отменяют жест: диапазон не применяется,
 *     выделение возвращается к прежнему, а click после отмены не выбирает день.
 *
 * Дом — DOM-шим (конвенция `date-period-dialog-dblclick.test.ts`); слушатели
 * окна собираются реестром, чтобы тест мог прислать «отпускание вне сетки» и Esc.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Слушатели окна, навешенные компонентом на время drag. */
type WindowListeners = Map<string, Array<(event: any) => void>>;

let windowListeners: WindowListeners;

function installShim(): void {
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    activeElement: new ShimElement('body'),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelector: (): null => null,
  };
  windowListeners = new Map();
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  win.addEventListener = (type: string, handler: (event: any) => void): void => {
    const list = windowListeners.get(type) ?? [];
    list.push(handler);
    windowListeners.set(type, list);
  };
  win.removeEventListener = (type: string, handler: (event: any) => void): void => {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((candidate) => candidate !== handler),
    );
  };
}

/** Прислать событие окна всем его слушателям (как браузер во время drag). */
function fireWindow(type: string, event: any = {}): void {
  for (const handler of [...(windowListeners.get(type) ?? [])]) handler(event);
}

interface CalendarOptions {
  from?: string;
  to?: string;
  firstDayOfWeek?: number;
  weekNumbers?: boolean;
  enableRangeDrag?: boolean;
}

/** Смонтировать календарь на ноябрь 2026 и собрать журнал событий. */
async function mountCalendar(options: CalendarOptions = {}): Promise<{
  root: ShimElement;
  calls: { days: string[]; weeks: string[]; ranges: Array<[string, string]> };
}> {
  installShim();
  const { buildMonthCalendar } = await import('../src/renderer/lib/month-calendar.js');
  const calls: { days: string[]; weeks: string[]; ranges: Array<[string, string]> } = {
    days: [],
    weeks: [],
    ranges: [],
  };
  const handle = buildMonthCalendar({
    month: { year: 2026, month: 11 },
    today: '2026-11-15',
    firstDayOfWeek: options.firstDayOfWeek ?? 1,
    weekNumbers: options.weekNumbers ?? true,
    enableRangeDrag: options.enableRangeDrag ?? true,
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    onPickDay: (day: string) => calls.days.push(day),
    onPickWeek: (day: string) => calls.weeks.push(day),
    onRangeChange: (from: string, to: string) => calls.ranges.push([from, to]),
  });
  return { root: handle.root as unknown as ShimElement, calls };
}

/** Кнопка дня по точной локальной дате (`title`: свойство либо атрибут). */
function dayButton(root: ShimElement, day: string): ShimElement {
  const node = root.findAll((candidate: ShimElement) => {
    if (!candidate.classList.contains('cal-day')) return false;
    const title = (candidate as unknown as { title?: string }).title;
    return (title ?? candidate.getAttribute('title')) === day;
  })[0];
  assert.notEqual(node, undefined, `в сетке есть день ${day}`);
  return node!;
}

/** Кнопки номеров недель. */
function weekButtons(root: ShimElement): ShimElement[] {
  return root.findAll((candidate: ShimElement) => candidate.classList.contains('cal-week'));
}

describe('календарь месяца: номера недель и drag-выделение (3054fe86)', () => {
  beforeEach(() => installShim());

  it('номер недели — кнопка, клик отдаёт первый день недели сети (пн)', async () => {
    const { root, calls } = await mountCalendar({ firstDayOfWeek: 1 });
    const weeks = weekButtons(root);
    assert.ok(weeks.length >= 5, 'колонка номеров недель отрисована');
    const week = weeks[2]!;
    assert.equal(
      (week.tagName ?? '').toLowerCase(),
      'button',
      'номер недели — кнопка словаря: Enter/Space работают нативно',
    );
    assert.ok(
      (week.getAttribute('aria-label') ?? '').length > 0,
      'у номера недели есть подпись для экранного диктора',
    );
    week.emit('click', {});
    // Неделя, в которую попадает 2026-11-10 (вторник): от ПЕРВОГО дня сети.
    assert.deepEqual(calls.weeks, ['2026-11-09']);
  });

  it('первый день недели сети учитывается (вс → вс)', async () => {
    const { root, calls } = await mountCalendar({ firstDayOfWeek: 7 });
    const week = weekButtons(root).find((node) =>
      node.getAttribute('aria-label')?.includes('2026-11-08'),
    );
    assert.notEqual(week, undefined, 'неделя с 2026-11-08 найдена по подписи');
    week!.emit('click', {});
    assert.deepEqual(calls.weeks, ['2026-11-08']);
  });

  it('клик без движения — обычный день, диапазона нет', async () => {
    const { root, calls } = await mountCalendar();
    const day = dayButton(root, '2026-11-10');
    day.emit('mousedown', { button: 0 });
    day.emit('mouseup', {});
    day.emit('click', { detail: 1 });
    assert.deepEqual(calls.days, ['2026-11-10']);
    assert.deepEqual(calls.ranges, []);
  });

  it('drag по дням ставит диапазон, click после него день не выбирает', async () => {
    const { root, calls } = await mountCalendar();
    const start = dayButton(root, '2026-11-10');
    const end = dayButton(root, '2026-11-12');
    start.emit('mousedown', { button: 0 });
    end.emit('mousemove', {});
    end.emit('mouseup', {});
    assert.deepEqual(calls.ranges, [['2026-11-10', '2026-11-12']]);
    assert.ok(start.classList.contains('is-selected'), 'начало выделено');
    assert.ok(end.classList.contains('is-selected'), 'конец выделен');
    end.emit('click', { detail: 1 });
    assert.deepEqual(calls.days, [], 'click завершения drag не выбирает день');
  });

  it('обратный drag нормализует диапазон', async () => {
    const { root, calls } = await mountCalendar();
    const start = dayButton(root, '2026-11-12');
    const end = dayButton(root, '2026-11-10');
    start.emit('mousedown', { button: 0 });
    end.emit('mousemove', {});
    end.emit('mouseup', {});
    assert.deepEqual(calls.ranges, [['2026-11-10', '2026-11-12']]);
    end.emit('click', { detail: 1 });
    assert.deepEqual(calls.days, []);
  });

  it('drag с номера недели диапазон не запускает — неделя остаётся кликом', async () => {
    const { root, calls } = await mountCalendar();
    const week = weekButtons(root)[2]!;
    const day = dayButton(root, '2026-11-12');
    week.emit('mousedown', { button: 0 });
    day.emit('mousemove', {});
    day.emit('mouseup', {});
    assert.deepEqual(calls.ranges, [], 'номер недели drag не начинает');
    assert.deepEqual(calls.days, []);
    assert.equal(windowListeners.get('mouseup')?.length ?? 0, 0, 'слушатели окна не навешены');
    week.emit('click', {});
    assert.deepEqual(calls.weeks, ['2026-11-09']);
  });

  it('отпускание вне сетки отменяет жест и возвращает прежнее выделение', async () => {
    const { root, calls } = await mountCalendar({ from: '2026-11-05', to: '2026-11-06' });
    const start = dayButton(root, '2026-11-10');
    const end = dayButton(root, '2026-11-12');
    start.emit('mousedown', { button: 0 });
    end.emit('mousemove', {});
    assert.ok(end.classList.contains('is-selected'), 'во время drag выделение показано');
    fireWindow('mouseup', {});
    assert.deepEqual(calls.ranges, [], 'вне сетки диапазон не применяется');
    assert.equal(start.classList.contains('is-selected'), false, 'выделение drag снято');
    assert.ok(dayButton(root, '2026-11-05').classList.contains('is-selected'), 'прежнее вернулось');
    end.emit('click', { detail: 1 });
    assert.deepEqual(calls.days, [], 'click после отмены день не выбирает');
  });

  it('Esc отменяет drag и гасит событие', async () => {
    const { root, calls } = await mountCalendar();
    const start = dayButton(root, '2026-11-10');
    const end = dayButton(root, '2026-11-12');
    start.emit('mousedown', { button: 0 });
    end.emit('mousemove', {});
    let prevented = false;
    let stopped = false;
    fireWindow('keydown', {
      key: 'Escape',
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        stopped = true;
      },
    });
    assert.equal(prevented, true, 'Esc не должен закрывать диалог вместе с отменой');
    assert.equal(stopped, true);
    assert.deepEqual(calls.ranges, []);
    assert.equal(windowListeners.get('mouseup')?.length ?? 0, 0, 'слушатели окна сняты');
    end.emit('click', { detail: 1 });
    assert.deepEqual(calls.days, [], 'click после Esc день не выбирает');
  });

  it('колонка номеров недель выключается опцией', async () => {
    const { root } = await mountCalendar({ weekNumbers: false });
    assert.equal(weekButtons(root).length, 0);
    assert.ok(root.classList.contains('cal--no-weeks'));
  });
});
