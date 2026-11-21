/**
 * Диалог даты/периода: номера недель (0.16.1, задача 3054fe86; элемент
 * интерфейса 80cd5ff9).
 *
 * Колонка номеров недель включена (`weekNumbers: true`), клик по номеру
 * выделяет ВСЮ неделю от первого дня сети и переводит диалог в режим «Период»;
 * в режиме одной даты периода нет — берётся первый день недели. Номер недели —
 * кнопка словаря, поэтому Enter/Space работают нативно (тест проверяет, что это
 * `<button>`, а не `span` с обработчиком).
 *
 * Дом — минимальный DOM-шим (конвенция `date-period-dialog-dblclick.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

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
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.dispatchEvent = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/** Нажать «ОК» футера — диалог отдаёт текущее значение. */
function pressOk(): void {
  const body = (globalThis as any).document.body as ShimElement;
  const ok = body.findAll((node: ShimElement) => node.classList.contains('ui-btn--primary'))[0];
  assert.notEqual(ok, undefined, 'в диалоге есть основная кнопка');
  ok!.emit('click', {});
}

/** Кнопки номеров недель в открытом диалоге. */
function weekButtons(): ShimElement[] {
  const body = (globalThis as any).document.body as ShimElement;
  return body.findAll((node: ShimElement) => node.classList.contains('cal-week'));
}

describe('диалог даты/периода: номера недель (3054fe86)', () => {
  it('клик по номеру недели ставит период из семи суток и режим «Период»', async () => {
    installShim();
    const { openDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
    const promise = openDatePeriodDialog({
      allowPeriod: true,
      allowTime: false,
      firstDayOfWeek: 1,
    });

    const weeks = weekButtons();
    assert.ok(weeks.length >= 5, 'колонка номеров недель видна в диалоге');
    const week = weeks.find((node) => node.getAttribute('aria-label')?.includes('2026-11-09'));
    // Найти неделю по подписи нельзя до выбора месяца: диалог открывается на
    // текущем месяце. Берём номер недели и проверяем связку по значению дня.
    const target = week ?? weeks[2]!;
    assert.equal(
      (target.tagName ?? '').toLowerCase(),
      'button',
      'номер недели — кнопка: Enter/Space работают нативно',
    );
    const firstDay = String(
      (target.getAttribute('aria-label') ?? '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
    );
    assert.match(firstDay, /^\d{4}-\d{2}-\d{2}$/, 'подпись недели содержит её первый день');

    target.emit('click', {});
    pressOk();
    const value = await promise;
    assert.notEqual(value, null);
    assert.equal(value!.mode, 'period', 'клик по неделе включает режим периода');
    assert.equal(value!.from, firstDay, 'период начинается с первого дня недели');
    assert.equal(
      value!.to,
      new Date(Date.parse(`${firstDay}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10),
      'период — ровно семь суток',
    );
  });

  it('в режиме одной даты номер недели выбирает её первый день', async () => {
    installShim();
    const { openDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
    const promise = openDatePeriodDialog({ allowPeriod: false, allowTime: false });

    const weeks = weekButtons();
    assert.ok(weeks.length >= 5, 'номера недель видны и без режима периода');
    const target = weeks[2]!;
    const firstDay = String(
      (target.getAttribute('aria-label') ?? '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
    );
    target.emit('click', {});
    pressOk();
    const value = await promise;
    assert.notEqual(value, null);
    assert.equal(value!.mode, 'date');
    assert.equal(value!.from, firstDay, 'периода нет — берётся первый день недели');
    assert.equal(value!.to, firstDay);
  });
});
