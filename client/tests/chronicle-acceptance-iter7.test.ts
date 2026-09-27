/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №7 (задача c4a7e9e3,
 * версия 0.10.1, слой 1229ad15). Полировка диалога «Дата/период»
 * (`lib/date-period-dialog.ts`):
 *
 *  1) строка значения — ОДНА строка: все контролы (дата/время/дефис) сиблинги
 *     в контейнере `.dpd-value`, переносов (flex-wrap) и промежуточных
 *     контейнеров между ними нет; поля узкие фиксированной ширины
 *     (дата ≈ 110–120px, время ≈ 90–104px; ширина времени уточнена ошибкой
 *     c4eea7aa — 70px не вмещало `HH:MM` вместе с иконкой-пикером), а не на всю
 *     ширину диалога;
 *  2) «С указанием времени» — НАСТОЯЩАЯ кнопка словаря `lib/ui/button`
 *     (`button.ui-btn--secondary`), включённое состояние залито акцентом
 *     (`.ui-btn--secondary.ui-btn--active`), а не ghost-надпись.
 *
 * Проверка — DOM-шим (`tests/dom-shim.ts`) + собранный CSS
 * (`tests/renderer-css.ts`). Каждый пункт краснел без фикса (см. отчёт-хроно
 * задачи c4a7e9e3).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { readRendererCss } from './renderer-css.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

/** CSS прикладного слоя (манифест `styles.css` — там chronicle.css). */
const CSS = readRendererCss().replace(/\/\*[\s\S]*?\*\//g, '');
/** CSS словаря кнопок (подключается не манифестом, а `lib/ui/register.ts`). */
const BUTTON_CSS = readFileSync(resolve(RENDERER, 'lib', 'ui', 'button.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Тело правила CSS, в списке селекторов которого есть точный (комментарии сняты). */
function cssBlock(source: string, selector: string): string {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return match[2]!;
  }
  assert.fail(`нет правила ${selector}`);
}

/** Число из `свойство: <N>px` (px — единица измерения ширины полей). */
function px(decl: string, property: string): number {
  const match = new RegExp(`${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(decl);
  assert.ok(match !== null, `нет ${property}: <N>px в «${decl.trim()}»`);
  return Number(match[1]);
}

/** Минимальный DOM-шим: хватает для сборки диалога и календаря. */
function installShim(): void {
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
  (globalThis as any).window = {
    setTimeout,
    clearTimeout,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
  };
}

/** Элементы-сиблинги строки значения (без текстовых узлов). */
function valueLineChildren(root: ShimElement): ShimElement[] {
  const line = root.querySelector('.dpd-value');
  assert.ok(line !== null, 'есть строка значения .dpd-value');
  return line!.children.filter((child) => child.tagName !== '#text');
}

/** Класс-контрол строки значения (`dpd-date`/`dpd-time`/`dpd-sep`). */
function controlKind(child: ShimElement): string {
  return ['dpd-date', 'dpd-time', 'dpd-sep'].find((c) => child.classList.contains(c)) ?? '';
}

/** Строка значения — ОДНА линия: контролы не переносятся. */
function assertSingleRow(): void {
  const line = cssBlock(CSS, '.dpd-value');
  assert.match(line, /flex-wrap:\s*nowrap/, 'строка значения не переносится на другую линию');
  assert.ok(!/flex-wrap:\s*wrap/.test(line), 'flex-wrap: wrap запрещён');
}

async function buildDialog(initial: Record<string, unknown>): Promise<ShimElement> {
  const { buildDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
  const handle = buildDatePeriodDialog({
    allowPeriod: true,
    allowTime: true,
    initial,
  } as any);
  return handle.root as unknown as ShimElement;
}

// ---------------------------------------------------------------------------
// Пункт 1: строка значения — одна строка, узкие поля
// ---------------------------------------------------------------------------

describe('приёмка №7, п.1: строка значения в одну линию', () => {
  it('«Дата»: [дата][время] — прямые сиблинги одного контейнера-строки', async () => {
    installShim();
    const root = await buildDialog({
      mode: 'date',
      from: '2026-09-10',
      to: '2026-09-10',
      hasTime: true,
      fromTime: '10:00',
    });
    const children = valueLineChildren(root);
    assert.deepEqual(
      children.map(controlKind),
      ['dpd-date', 'dpd-time'],
      'поля даты и времени — соседние контролы одной строки',
    );
    const line = root.querySelector('.dpd-value')!;
    for (const child of children) {
      assert.equal(child.parent, line, 'контрол — прямой потомок строки, без обёртки-контейнера');
    }
    assert.equal(root.querySelectorAll('.dpd-times').length, 0, 'нет промежуточного контейнера времени');
    assertSingleRow();
  });

  it('«Период»: [дата][время][-][дата][время] — все сиблинги одной строки', async () => {
    installShim();
    const root = await buildDialog({
      mode: 'period',
      from: '2026-09-10',
      to: '2026-09-20',
      hasTime: true,
      fromTime: '10:00',
      toTime: '12:30',
    });
    const children = valueLineChildren(root);
    assert.deepEqual(
      children.map(controlKind),
      ['dpd-date', 'dpd-time', 'dpd-sep', 'dpd-date', 'dpd-time'],
      'границы, время и дефис — сиблинги одной строки',
    );
    const line = root.querySelector('.dpd-value')!;
    for (const child of children) {
      assert.equal(child.parent, line, 'контрол — прямой потомок строки, без обёртки-контейнера');
    }
    assertSingleRow();
  });

  it('CSS: строка значения не переносится и контролы не растягиваются', () => {
    const line = cssBlock(CSS, '.dpd-value');
    assert.match(line, /display:\s*flex/, 'строка — flex-контейнер');
    assertSingleRow();
    assert.match(line, /align-items:\s*center/, 'контролы выровнены по центру строки');

    const date = cssBlock(CSS, '.dpd-value .dpd-date');
    const dateWidth = px(date, 'width');
    assert.ok(dateWidth >= 110 && dateWidth <= 120, `ширина даты ~110–120px (получено ${dateWidth})`);
    assert.ok(!/width:\s*100%/.test(date), 'поле даты не на всю ширину');

    const time = cssBlock(CSS, '.dpd-value .dpd-time');
    const timeWidth = px(time, 'width');
    // Ширина времени уточнена ошибкой c4eea7aa: 70px не вмещало `HH:MM`
    // вместе с нативной иконкой-пикером Chromium. Новый диапазон — 90–104px.
    assert.ok(timeWidth >= 90 && timeWidth <= 104, `ширина времени ~90–104px (получено ${timeWidth})`);
    assert.ok(!/width:\s*100%/.test(time), 'поле времени не на всю ширину');

    const sep = cssBlock(CSS, '.dpd-sep');
    assert.ok(!/flex-grow/.test(sep) && !/flex:\s*1/.test(sep), 'дефис — узкий разделитель');
  });
});

// ---------------------------------------------------------------------------
// Пункт 2: «С указанием времени» — настоящая кнопка
// ---------------------------------------------------------------------------

describe('приёмка №7, п.2: «С указанием времени» — кнопка со состоянием «включено»', () => {
  it('элемент — button словаря (secondary), а не текстовая метка', async () => {
    installShim();
    const root = await buildDialog({ mode: 'date', from: '2026-09-10', to: '2026-09-10' });
    const toggle = root.querySelector('.dpd-time-toggle');
    assert.ok(toggle !== null, 'переключатель есть');
    assert.equal(toggle!.tagName, 'button', 'элемент — кнопка');
    assert.ok(toggle!.classList.contains('ui-btn'), 'кнопка словаря lib/ui');
    assert.ok(toggle!.classList.contains('ui-btn--secondary'), 'роль secondary — видимая кнопка');
    assert.ok(
      !toggle!.classList.contains('ui-btn--ghost'),
      'не ghost-надпись, а настоящая кнопка',
    );
  });

  it('состояние «включено» — класс ui-btn--active, CSS заливает акцентом', async () => {
    installShim();
    const root = await buildDialog({ mode: 'date', from: '2026-09-10', to: '2026-09-10' });
    const toggle = root.querySelector('.dpd-time-toggle')!;
    assert.ok(!toggle.classList.contains('ui-btn--active'), 'выключено — без активного класса');

    toggle.click();
    assert.ok(toggle.classList.contains('ui-btn--active'), 'включено — активный класс');
    toggle.click();
    assert.ok(!toggle.classList.contains('ui-btn--active'), 'повторный клик снимает активное состояние');

    const active = cssBlock(BUTTON_CSS, '.ui-btn--secondary.ui-btn--active');
    assert.match(active, /background:\s*var\(--accent\)/, 'включённая кнопка залита акцентом');
    assert.match(active, /color:\s*var\(--accent-fg\)/, 'текст — на акцентной заливке');
  });
});
