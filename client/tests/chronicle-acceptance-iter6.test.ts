/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №6 (задача dbb9819c, версия
 * 0.10.1, слой 1229ad15). Диалог «Дата/период» (`lib/date-period-dialog.ts`) и
 * общий календарь (`lib/month-calendar.ts`) доведены до макетов по ИНТЕРАКТИВУ:
 *
 *  1) «С указанием времени» — кнопка в ОБОИХ режимах, дефолт 10:00;
 *  2) нижняя строка значения — РЕДАКТИРУЕМЫЕ поля ввода (дата/время), а не
 *     надпись; валидация и автоподгон «По» ≥ «С» обновляют выделение календаря;
 *  3) одиночный клик по дню обновляет поля (сетка не пересобирается на mousedown,
 *     иначе `click` теряется), drag по-прежнему ставит диапазон;
 *  4) клик по месяцу — ВЫПАДАЮЩИЙ поповер (высота диалога не меняется);
 *  5) клик по году — инлайн-поле (4 цифры) НА ТОМ ЖЕ месте, Enter/blur/Esc;
 *  6) кнопки «‹»/«○»/«›» работают интерактивно и видны в значении.
 *
 * Проверка поведения — DOM-шим (`tests/dom-shim.ts`, конвенция
 * `chronicle-acceptance-iter5.test.ts`). Каждый пункт краснел без фикса (см.
 * отчёт-хроно задачи dbb9819c).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура поля года идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Минимальный DOM-шим + перехват capture-`keydown` на `window`. */
function installShim(): { body: ShimElement; pressEscape: () => void } {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const keyHandlers: Array<(event: any) => void> = [];
  (globalThis as any).window = {
    setTimeout,
    clearTimeout,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: any) => void, capture?: boolean) => {
      if (type === 'keydown' && capture === true) keyHandlers.push(fn);
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
  };
  return {
    body,
    pressEscape: () => {
      const event = {
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation: () => undefined,
      };
      for (const handler of [...keyHandlers]) handler(event);
    },
  };
}

/** Первый элемент с классом (рекурсивно). */
function byClass(root: ShimElement, className: string): ShimElement | undefined {
  return root.querySelector(`.${className}`) ?? undefined;
}

/** Кнопка сегмента по подписи. */
function buttonByText(root: ShimElement, text: string): ShimElement | undefined {
  return root.querySelectorAll('button').find((b) => b.textContent === text);
}

/** Ячейка календаря по полной дате (`title`). */
function dayByDate(root: ShimElement, day: string): ShimElement | undefined {
  return root.querySelectorAll('.cal-day').find((d) => d.title === day);
}

/** Значение поля даты нижней строки (0 — «С», 1 — «По»). */
function dateInputValue(root: ShimElement, index: number): string {
  return root.querySelectorAll('.dpd-date')[index]?.value ?? '';
}

/** Значение поля времени нижней строки. */
function timeInputValue(root: ShimElement, index: number): string {
  return root.querySelectorAll('.dpd-time')[index]?.value ?? '';
}

async function buildDialog(
  initial: Record<string, unknown>,
  opts: Record<string, unknown> = {},
): Promise<{ handle: any; root: ShimElement }> {
  const { buildDatePeriodDialog } = await import(
    '../src/renderer/lib/date-period-dialog.js'
  );
  const handle = buildDatePeriodDialog({
    allowPeriod: true,
    allowTime: true,
    initial,
    ...opts,
  } as any);
  return { handle, root: handle.root as unknown as ShimElement };
}

// ---------------------------------------------------------------------------
// Пункт 1: «С указанием времени» в обоих режимах, дефолт 10:00
// ---------------------------------------------------------------------------

describe('приёмка №6, п.1: «С указанием времени» в обоих режимах', () => {
  it('кнопка есть в «Дата» и «Период», время по умолчанию 10:00, повтор скрывает', async () => {
    installShim();
    const { handle, root } = await buildDialog(
      { mode: 'date', from: '2026-09-10', to: '2026-09-10', hasTime: false },
      { allowPeriod: true, allowTime: true },
    );

    const toggle = byClass(root, 'dpd-time-toggle');
    assert.ok(toggle !== undefined, 'в режиме «Дата» кнопка есть');

    toggle!.click();
    assert.equal(root.querySelectorAll('.dpd-time').length, 1, 'в «Дата» — одно поле времени');
    assert.equal(timeInputValue(root, 0), '10:00', 'дефолт времени — 10:00, а не полночь');
    assert.equal(handle.getValue().hasTime, true);

    // Переключаемся в «Период» — кнопка обязана остаться.
    buttonByText(root, 'Период')!.click();
    assert.equal(handle.getMode(), 'period');
    assert.ok(byClass(root, 'dpd-time-toggle') !== undefined, 'в режиме «Период» кнопка есть');
    assert.equal(root.querySelectorAll('.dpd-time').length, 2, 'в «Период» — два поля времени');
    assert.equal(timeInputValue(root, 0), '10:00');
    assert.equal(timeInputValue(root, 1), '10:00');

    byClass(root, 'dpd-time-toggle')!.click();
    assert.equal(root.querySelectorAll('.dpd-time').length, 0, 'повторный клик скрывает время');
    assert.equal(handle.getValue().hasTime, false);
  });

  it('осмысленное время значения не затирается дефолтом', async () => {
    installShim();
    const { root } = await buildDialog(
      { mode: 'date', from: '2026-09-10', to: '2026-09-10', hasTime: true, fromTime: '08:30' },
      { allowTime: true },
    );
    assert.equal(timeInputValue(root, 0), '08:30', 'время из значения сохранено');
  });
});

// ---------------------------------------------------------------------------
// Пункт 2: нижняя строка — редактируемые поля ввода
// ---------------------------------------------------------------------------

describe('приёмка №6, п.2: нижняя строка значения — поля ввода', () => {
  it('«Дата»: поле даты (+ времени), а не текстовая надпись', async () => {
    installShim();
    const { root } = await buildDialog(
      { mode: 'date', from: '2026-09-10', to: '2026-09-10', hasTime: true, fromTime: '10:00' },
      { allowTime: true },
    );
    const valueLine = byClass(root, 'dpd-value')!;
    const inputs = valueLine.querySelectorAll('input');
    assert.equal(inputs.length, 2, 'поле даты + поле времени');
    assert.equal(inputs[0]!.tagName, 'input', 'дата — редактируемый input');
    assert.equal(inputs[0]!.readOnly, false, 'поле даты не «только чтение»');
    assert.equal(inputs[0]!.getAttribute('pattern'), '\\d{4}-\\d{2}-\\d{2}', 'шаблон даты');
    assert.equal(inputs[0]!.value, '2026-09-10', 'значение даты в поле');
    assert.equal(valueLine.querySelectorAll('span.dpd-date').length, 0, 'надписи-спана нет');
  });

  it('«Период»: поля «С», дефис, «По»; валидация и автоподгон в обе стороны', async () => {
    installShim();
    const { handle, root } = await buildDialog(
      { mode: 'period', from: '2026-09-10', to: '2026-09-20', hasTime: false },
      { allowPeriod: true },
    );
    assert.equal(root.querySelectorAll('.dpd-date').length, 2, 'две границы периода');
    assert.equal(root.querySelectorAll('.dpd-sep').length, 1, 'дефис между границами');
    assert.equal(dateInputValue(root, 0), '2026-09-10');
    assert.equal(dateInputValue(root, 1), '2026-09-20');

    // «С» вышел за «По» → «По» подтягивается к «С».
    const fromInput = root.querySelectorAll('.dpd-date')[0]!;
    fromInput.value = '2026-09-25';
    fromInput.emit('change');
    assert.equal(handle.getValue().from, '2026-09-25');
    assert.equal(handle.getValue().to, '2026-09-25', '«По» подтянулся к «С»');
    assert.equal(dateInputValue(root, 1), '2026-09-25', 'поле «По» обновилось вслед');

    // «По» ниже «С» → «С» подтягивается к «По».
    const toInput = root.querySelectorAll('.dpd-date')[1]!;
    toInput.value = '2026-09-12';
    toInput.emit('change');
    assert.equal(handle.getValue().from, '2026-09-12', '«С» подтянулся к «По»');
    assert.equal(handle.getValue().to, '2026-09-12');

    // Неверный формат — поле возвращает прежнее значение.
    const badInput = root.querySelectorAll('.dpd-date')[0]!;
    badInput.value = '2026-13-40';
    badInput.emit('change');
    assert.equal(badInput.value, '2026-09-12', 'некорректная дата не применяется');
    assert.equal(handle.getValue().from, '2026-09-12');
  });

  it('ввод дат обновляет выделение календаря', async () => {
    installShim();
    const { root } = await buildDialog(
      { mode: 'period', from: '2026-09-10', to: '2026-09-20', hasTime: false },
      { allowPeriod: true },
    );
    const toInput = root.querySelectorAll('.dpd-date')[1]!;
    toInput.value = '2026-09-28';
    toInput.emit('change');
    assert.ok(
      dayByDate(root, '2026-09-28')!.classList.contains('is-selected-to'),
      'новый конец выделен в календаре',
    );
    assert.ok(
      dayByDate(root, '2026-09-20')!.classList.contains('is-selected'),
      'дни внутри диапазона выделены',
    );
  });
});

// ---------------------------------------------------------------------------
// Пункт 3: клик по дню обновляет поля; drag не сломан
// ---------------------------------------------------------------------------

describe('приёмка №6, п.3: клик по дню обновляет нижние поля', () => {
  it('mousedown не пересобирает сетку; клик пишет день в поля; drag ставит диапазон', async () => {
    installShim();
    const { handle, root } = await buildDialog(
      { mode: 'date', from: '2026-09-10', to: '2026-09-10', hasTime: false },
      { allowPeriod: true, allowTime: true },
    );

    // Сетка не пересобирается при старте перетаскивания — иначе узел-цель
    // теряется и одиночный `click` по дню не доходит.
    const other = dayByDate(root, '2026-09-20')!;
    dayByDate(root, '2026-09-10')!.emit('mousedown');
    assert.equal(
      dayByDate(root, '2026-09-20'),
      other,
      'узел календаря сохраняется на mousedown (сетка не пересобирается)',
    );

    // Одиночный клик по дню обновляет нижние поля ввода.
    dayByDate(root, '2026-09-15')!.click();
    assert.equal(handle.getValue().from, '2026-09-15');
    assert.equal(handle.getValue().to, '2026-09-15');
    assert.equal(dateInputValue(root, 0), '2026-09-15', 'поле даты обновлено кликом по дню');

    // Drag по-прежнему ставит «С»/«По» и авто-переключает режим.
    dayByDate(root, '2026-09-10')!.emit('mousedown');
    dayByDate(root, '2026-09-20')!.emit('mousemove');
    dayByDate(root, '2026-09-20')!.emit('mouseup');
    assert.equal(handle.getValue().mode, 'period', 'drag включил режим «Период»');
    assert.equal(handle.getValue().from, '2026-09-10');
    assert.equal(handle.getValue().to, '2026-09-20');
    assert.equal(root.querySelectorAll('.dpd-date').length, 2, 'поля обеих границ');
    assert.equal(dateInputValue(root, 1), '2026-09-20', 'поле «По» обновлено drag’ом');
  });
});

// ---------------------------------------------------------------------------
// Пункт 4: месяц — выпадающий поповер
// ---------------------------------------------------------------------------

describe('приёмка №6, п.4: месяц — поповер, высота не меняется', () => {
  it('клик по месяцу открывает поповер; инлайн-раскрытия в диалоге нет', async () => {
    const { body } = installShim();
    const { root } = await buildDialog(
      { mode: 'date', from: '2020-01-15', to: '2020-01-15' },
      { allowPeriod: true },
    );
    const childrenBefore = root.childElementCount;

    assert.equal(root.querySelectorAll('.cal-months').length, 0, 'в диалоге списка месяцев нет');
    byClass(root, 'cal-month')!.click();

    const popover = body.querySelector('.ui-popover');
    assert.ok(popover !== null, 'список открыт ВЫПАДАЮЩИМ поповером');
    assert.equal(
      popover!.querySelectorAll('.cal-month-item').length,
      12,
      'в поповере 12 месяцев',
    );
    assert.equal(
      root.querySelectorAll('.cal-months').length,
      0,
      'диалог не расхлопывается инлайн-списком',
    );
    assert.equal(root.childElementCount, childrenBefore, 'высота диалога не изменилась');

    popover!
      .querySelectorAll('.cal-month-item')
      .find((item) => item.textContent === 'Май')!
      .click();
    assert.equal(byClass(root, 'cal-month')!.textContent, 'май', 'выбор месяца применён');
    assert.equal(body.querySelectorAll('.ui-popover').length, 0, 'поповер закрылся');
  });
});

// ---------------------------------------------------------------------------
// Пункт 5: год — инлайн-поле на месте
// ---------------------------------------------------------------------------

describe('приёмка №6, п.5: год — инлайн-поле (4 цифры)', () => {
  it('поле года встаёт на место подписи; Enter применяет, Esc отменяет', async () => {
    const { pressEscape } = installShim();
    const { root } = await buildDialog(
      { mode: 'date', from: '2020-01-15', to: '2020-01-15' },
      { allowPeriod: true },
    );
    const childrenBefore = root.childElementCount;
    const yearBtn = byClass(root, 'cal-year')!;

    yearBtn.click();
    const yearInput = byClass(root, 'cal-year-input')!;
    assert.equal(yearInput.tagName, 'input', 'год — поле ввода');
    assert.notEqual(yearInput.style.display, 'none', 'поле года раскрыто');
    assert.equal(
      yearInput.parent,
      byClass(root, 'cal-year-cell'),
      'поле стоит в ячейке года — на месте подписи, а не отдельной строкой',
    );
    assert.equal(yearBtn.style.display, 'none', 'подпись года скрыта на время ввода');
    assert.equal(root.childElementCount, childrenBefore, 'новая строка не добавилась');

    // Esc — отмена (и не закрывает диалог: гасится capture-слушателем).
    pressEscape();
    assert.equal(yearInput.style.display, 'none', 'поле года закрыто по Esc');
    assert.equal(yearBtn.textContent, '2020', 'год не изменился при отмене');

    // Enter — применение (через диспетчер: фокус кладёт контекст поля года).
    yearBtn.click();
    const again = byClass(root, 'cal-year-input')!;
    again.value = '2027';
    again.emit('focusin', {});
    keymap.dispatchKeyEvent({
      key: 'Enter',
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent);
    again.emit('focusout', {});
    assert.equal(yearBtn.textContent, '2027', 'год применён по Enter');
  });
});

// ---------------------------------------------------------------------------
// Пункт 6: кнопки «‹»/«○»/«›»
// ---------------------------------------------------------------------------

describe('приёмка №6, п.6: кнопки «‹»/«○»/«›»', () => {
  it('переключают месяц; «○» возвращает сегодняшний день в значение', async () => {
    installShim();
    const { todayLocal } = await import('../src/renderer/lib/dates.js');
    const { handle, root } = await buildDialog(
      { mode: 'date', from: '2020-01-15', to: '2020-01-15' },
      { allowPeriod: true },
    );
    const monthLabel = (): string => byClass(root, 'cal-month')!.textContent;

    byClass(root, 'cal-next')!.click();
    assert.equal(monthLabel(), 'фев', '«›» — месяц вперёд');
    byClass(root, 'cal-prev')!.click();
    assert.equal(monthLabel(), 'янв', '«‹» — месяц назад');

    byClass(root, 'cal-today')!.click();
    const today = todayLocal();
    const short = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    assert.equal(monthLabel(), short[Number(today.slice(5, 7)) - 1], '«○» показывает текущий месяц');
    assert.equal(handle.getValue().from, today, '«○» ставит сегодняшний день');
    assert.equal(dateInputValue(root, 0), today, '«○» обновляет поле значения');
  });
});
