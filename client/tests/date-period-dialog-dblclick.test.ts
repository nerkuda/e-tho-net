/**
 * Диалог даты/периода: выбор дня ДВОЙНЫМ кликом (ошибка 609deba0 п.4).
 *
 * Двойной клик распознаётся по счётчику нажатий (`MouseEvent.detail >= 2`), а не
 * нативным `dblclick`: после первого клика сетка календаря пересобирается
 * (`render()`), узел дня заменяется, и браузер `dblclick` не присылает — та же
 * грабля, что у списков/таблиц (`lib/ui/table-grid.ts`, ошибка d1a009fa).
 * Одиночный клик только выбирает день; двойной — подтверждает выбор (закрывает
 * диалог, как «ОК»).
 *
 * Дом — минимальный DOM-шим (конвенция `date-period-dialog-layout.test.ts`).
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
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });
}

describe('диалог даты/периода: двойной клик по дню (ошибка 609deba0 п.4)', () => {
  it('двойной клик выбирает день и подтверждает диалог', async () => {
    installShim();
    const { openDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
    const promise = openDatePeriodDialog({ allowPeriod: false, allowTime: false });

    const body = (globalThis as any).document.body as ShimElement;
    const day = body.findAll((node) => node.classList.contains('cal-day'))[0];
    assert.notEqual(day, undefined, 'в сетке календаря есть дни');
    const dayNode = day!;
    const picked = String(dayNode.title ?? dayNode.getAttribute('title') ?? '');
    assert.match(picked, /^\d{4}-\d{2}-\d{2}$/, 'у дня есть локальная дата в title');

    // Одиночный клик — только выбор дня (диалог ещё открыт).
    dayNode.emit('click', { detail: 1 });
    // Двойной клик — активация: значение дня уходит наружу, диалог закрывается.
    dayNode.emit('click', { detail: 2 });

    const value = await promise;
    assert.notEqual(value, null, 'двойной клик подтверждает выбор (не «Отмена»)');
    assert.equal(value!.mode, 'date');
    assert.equal(value!.from, picked, 'подтверждён выбранный днём день');
    assert.equal(value!.to, picked);

    // Диалог обязан ЗАКРЫТЬСЯ: активация дня подтверждает выбор без нажатия
    // «ОК», а закрывает диалог каркас (`showDialog`), не сам день. Без явного
    // закрытия диалог оставался на экране с уже принятым решением.
    assert.equal(
      body.findAll((node) => node.classList.contains('dialog-backdrop')).length,
      0,
      'после двойного клика подложка диалога удалена из DOM',
    );
  });
});
