/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №4 (задача fd9eef49,
 * версия 0.10.1, слой 1229ad15). Требования проверяются ПОВЕДЕНЧЕСКИ:
 *
 *  1) группа «Период» панели — ДВЕ строки: «С» и «По» каждая в своём
 *     контейнере-строке со своими контролами, раскладка колонкой (модификатор
 *     `pe-panel`), метка — фиксированная колонка, ширины контролов заданы явно;
 *  2) дефект «запись видна в неделе, но не в её дне»: клик календаря пишет
 *     токен, но ПЕРЕД запросом клиент раскрывает границы-токены в ЛОКАЛЬНЫЕ
 *     календарные даты наблюдателя — запись с временем внутри дня D видна и в
 *     выборке недели, и в выборке дня D (без раскрытия односекундный сдвиг
 *     UTC-суток уводил запись из её дня);
 *  3) контрольный прогон «применение периода фильтрует ленту» — на серверной
 *     стороне (`server/tests/chronicle-period-filter.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const PERIOD_CSS = read('styles/condition-combo.css');

/** Минимальный DOM-шим: хватает для сборки панельного контрола периода. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
  };
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
}

/** Рекурсивно ищет первый элемент с указанным классом. */
function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Пункт 1: раскладка группы «Период» — две строки
// ---------------------------------------------------------------------------

describe('приёмка №4, п.1: группа «Период» — две строки', () => {
  it('панельный контрол несёт модификатор раскладки и две строки-контейнера', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({ variant: 'panel', value: { from: '$today', to: '$today' } });
    const root = editor.root as unknown as ShimElement;

    assert.ok(
      root.classList.contains('pe-panel'),
      'панельный вариант помечен модификатором pe-panel (раскладка колонкой)',
    );

    const fields = findByClass(root, 'pe-fields');
    assert.ok(fields, 'есть контейнер полей');
    const rows = fields!.children.filter(
      (child) =>
        child.className.includes('pe-bound') || child.className.includes('pe-preset-bound'),
    );
    assert.equal(rows.length, 2, 'ровно две строки: «С» и «По»');

    // Каждая граница — своя строка: метка и контролы лежат в СВОЁМ контейнере.
    const tags = rows.map((row) => row.querySelectorAll('.pe-tag'));
    assert.equal(tags[0]!.length, 1, 'строка «С» несёт ровно одну метку');
    assert.equal(tags[1]!.length, 1, 'строка «По» несёт ровно одну метку');
    assert.equal(tags[0]![0]!.textContent, 'с');
    assert.equal(tags[1]![0]!.textContent, 'по');

    for (const row of rows) {
      assert.equal(row.querySelectorAll('.pe-preset-anchor').length, 1, 'комбобокс пресета — в своей строке');
      assert.equal(row.querySelectorAll('.pe-preset-num').length, 1, 'сдвиг ±N — в своей строке');
      assert.equal(row.querySelectorAll('.pe-preset-unit').length, 1, 'единица — в своей строке');
    }
  });

  it('в режиме «Даты» тоже по строке на границу', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({
      variant: 'panel',
      panelMode: 'dates',
      value: { from: '2026-09-10', to: '2026-09-12' },
    });
    const root = editor.root as unknown as ShimElement;
    const fields = findByClass(root, 'pe-fields')!;
    const rows = fields.children.filter((child) => child.className.includes('pe-bound'));
    assert.equal(rows.length, 2, 'две строки дат «С»/«По»');
    for (const row of rows) {
      assert.equal(row.querySelectorAll('.pe-date-input').length, 1, 'date-input — в своей строке');
      assert.equal(row.querySelectorAll('.pe-tag').length, 1, 'метка — в своей строке');
    }
  });

  it('CSS задаёт колонку, фиксированную метку и явные ширины контролов', () => {
    const fieldsRule = /\.pe-panel\s+\.pe-fields\s*\{([^}]*)\}/.exec(PERIOD_CSS);
    assert.ok(fieldsRule, 'есть правило раскладки полей панельного периода');
    assert.match(fieldsRule![1]!, /flex-direction:\s*column/, 'поля идут колонкой — по строке на границу');

    const tagRule = /\.pe-panel\s+\.pe-tag\s*\{([^}]*)\}/.exec(PERIOD_CSS);
    assert.ok(tagRule, 'есть правило метки границы');
    assert.match(tagRule![1]!, /width:\s*\d+px/, 'метка — фиксированная колонка');

    const rowRule = /\.pe-panel\s+\.pe-preset-bound\s*\{([^}]*)\}/.exec(PERIOD_CSS);
    assert.ok(rowRule, 'есть правило строки пресет-границы');
    assert.match(rowRule![1]!, /width:\s*100%/, 'строка занимает всю ширину панели');

    for (const cls of ['pe-preset-num', 'pe-preset-unit'] as const) {
      const rule = new RegExp(`\\.pe-panel\\s+\\.${cls}\\s*\\{([^}]*)\\}`).exec(PERIOD_CSS);
      assert.ok(rule, `есть правило ширины .${cls}`);
      assert.match(rule![1]!, /width:\s*\d+px/, `ширина .${cls} задана явно`);
    }
  });
});

// ---------------------------------------------------------------------------
// Пункт 2: запись видна и в неделе, и в своём дне
// ---------------------------------------------------------------------------

describe('приёмка №4, п.2: день недели не пуст', () => {
  it('запись у локальной полуночи видна и в выборке недели 39, и в выборке дня 26.09', async () => {
    const { periodValuesForRange, resolvePeriodForQuery, localDay } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    assert.equal(
      typeof resolvePeriodForQuery,
      'function',
      'клиент раскрывает границы периода перед запросом (иначе токен уйдёт на сервер как есть)',
    );

    // Запись «за 26 сентября», созданная у локальной полуночи: клиент хранит
    // полный инстанс, локальный день которого — 26.09 (для Москвы это
    // 2026-09-25T21:00:14.413Z). Именно такие записи выпадали из своего дня:
    // ни серверный токен (UTC-сутки), ни «голая дата» (сутки UTC) их не
    // покрывали. Инстанс строится через локальное время — тест не зависит от
    // пояса машины.
    const recordFrom = new Date(2026, 8, 26, 0, 0, 14, 413).toISOString();
    assert.equal(localDay(recordFrom), '2026-09-26', 'локальный день записи — 26.09');

    const todayLocalDate = '2026-09-27';
    const at = (iso: string): number => new Date(iso).getTime();
    const instantRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    // (а) клик по неделе 39 (21–27 сентября).
    const weekTokens = periodValuesForRange('2026-09-21', '2026-09-27', todayLocalDate, 'presets');
    const weekWire = resolvePeriodForQuery(weekTokens.from, weekTokens.to, todayLocalDate);
    assert.match(weekWire.from, instantRe, 'граница недели — полный UTC-инстанс');
    assert.match(weekWire.to, instantRe);
    assert.ok(
      at(weekWire.from) <= at(recordFrom) && at(recordFrom) <= at(weekWire.to),
      'запись за 26.09 видна в выборке недели 39',
    );

    // (б) клик по дню 26 сентября.
    const dayTokens = periodValuesForRange('2026-09-26', '2026-09-26', todayLocalDate, 'presets');
    assert.equal(dayTokens.from, '$today-1d', 'клик по дню пишет день-арифметику от локального дня');
    const dayWire = resolvePeriodForQuery(dayTokens.from, dayTokens.to, todayLocalDate);
    // Границы — ЛОКАЛЬНЫЕ сутки 26.09 (полные инстансы), а не сутки UTC.
    assert.match(dayWire.from, instantRe, 'граница дня — полный UTC-инстанс, а не «голая дата»');
    assert.match(dayWire.to, instantRe);
    assert.equal(localDay(dayWire.from), '2026-09-26', 'начало — локальные сутки 26.09');
    assert.equal(localDay(dayWire.to), '2026-09-26', 'конец — локальные сутки 26.09');
    assert.ok(
      at(dayWire.from) <= at(recordFrom) && at(recordFrom) <= at(dayWire.to),
      'запись за 26.09 видна в выборке дня 26.09',
    );
    assert.notEqual(weekTokens.from, '$today-1d', 'неделя даёт диапазон, а не одиночный день');
  });

  it('точные даты режима «Даты» раскрываются в локальные сутки, полные инстансы — как есть', async () => {
    const { periodValuesForRange, resolvePeriodForQuery, localDay } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    const dates = periodValuesForRange('2026-09-10', '2026-09-12', '2026-09-27', 'dates');
    const wire = resolvePeriodForQuery(dates.from, dates.to, '2026-09-27');
    assert.equal(localDay(wire.from), '2026-09-10', 'точная дата «С» — локальные сутки');
    assert.equal(localDay(wire.to), '2026-09-12', 'точная дата «По» — локальные сутки');
    // Переход к записи передаёт полные локальные сутки — не переписываем.
    assert.deepEqual(
      resolvePeriodForQuery(
        '2026-09-25T21:00:00.000Z',
        '2026-09-26T20:59:59.999Z',
        '2026-09-27',
      ),
      { from: '2026-09-25T21:00:00.000Z', to: '2026-09-26T20:59:59.999Z' },
    );
  });
});
