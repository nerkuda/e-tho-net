/**
 * Итерация приёмки №8 (0.10.1) — приёмочные тесты пяти пунктов чек-листа
 * задания `eb3c743d-4f45-4f5e-aea1-cd0795363602`.
 *
 * 1. Время из диалога сохраняется: `getValue()` РЕАЛЬНОГО модального диалога
 *    (`lib/date-period-dialog.ts`, `openDatePeriodDialog` → `showDialog`) читает
 *    «живые» поля, а не кэш состояния. Сценарий потери: пользователь ввёл время
 *    и подтвердил «ОК» без потери фокуса полем (Ctrl/Cmd+Enter — программный
 *    клик подтверждающей кнопки), событие `change` не отработало — введённое
 *    время обязано попасть в результат. Плюс экран переводит значение диалога
 *    его же помощником `resolveDatePeriodInstants` (одна реализация конверсии).
 * 2. Спокойная лента: созданная из слота запись вставляется НА МЕСТЕ
 *    (`insertCreatedRecord` → `replaceWith(card)`), без полной перерисовки;
 *    `insertRowByDay` держит порядок по дню и направлению.
 * 3. Сортировка «Убывание»: `groupByLocalDays` уважает `order`, дни — по
 *    направлению, записи внутри — серверный порядок выбранного направления.
 * 4. Панель «Период», режим «Даты»: компонентное поле `lib/date-field.ts`
 *    (редактируемый ввод + календарь + крестик), автоподгон «С» ≤ «По».
 * 5. Локаль: заголовок группы дат — «Четверг, 24 сентября 2026» без «г.».
 *
 * Часть проверок — чистая логика и реальные компоненты на DOM-шиме (как
 * `period-editor.test.ts`); часть — структурная по исходнику экрана (сам модуль
 * рендерера недоступен под Node без Electron-каркаса).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { formatDatePeriodValue, resolveDatePeriodInstants } from '../src/renderer/lib/date-period-dialog.js';
import { instantToLocalDate, instantToLocalTime } from '../src/renderer/lib/period-editor.js';
import { groupByLocalDays } from '../src/renderer/screens/chronicle/diary.js';
import type { ChronicleRow } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

const DIARY = '../src/renderer/screens/chronicle/diary.js';

/** Помощники, добавленные в итерации №8, — через динамический импорт: на
 * дереве без фиксов их ещё нет, и каждый тест падает поимённо (а не отказом
 * загрузки всего файла). */
async function diary(): Promise<{
  compareDays: (a: string, b: string, order?: 'asc' | 'desc') => number;
  formatDayLabel: (day: string) => string;
  insertRowByDay: (
    list: readonly ChronicleRow[],
    row: ChronicleRow,
    order?: 'asc' | 'desc',
  ) => ChronicleRow[];
}> {
  return (await import(DIARY)) as never;
}

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts');
const PERIOD_EDITOR = resolve(RENDERER, 'lib', 'period-editor.ts');
const DATE_PERIOD_DIALOG = resolve(RENDERER, 'lib', 'date-period-dialog.ts');

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Минимальный DOM-шим: хватает для диалога и полей `lib/ui`. */
function installShim(): void {
  const body = new ShimElement('body');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['setTimeout'] = setTimeout;
  win['clearTimeout'] = clearTimeout;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
}

function bodyShim(): ShimElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).document.body as ShimElement;
}

function first(root: ShimElement, selector: string): ShimElement | undefined {
  return root.querySelector(selector) ?? undefined;
}

/** Строка ленты с одной датой (обе границы равны). */
function row(id: string, day: string): ChronicleRow {
  const from = `${day}T10:00:00.000Z`;
  return {
    id,
    title: id,
    valid_from: from,
    valid_to: from,
    use_time: false,
    version: 1,
    created_at: from,
    updated_at: from,
    created_by: 'u',
    updated_by: 'u',
    snippet: '',
    body_html: '',
    targets: [],
  };
}

// ---------------------------------------------------------------------------
// П.1 — время из диалога
// ---------------------------------------------------------------------------

describe('приёмка №8, п.1: время из диалога доходит до записи', () => {
  it('«ОК» без потери фокуса полем времени: getValue() читает живое поле (10:15)', async () => {
    installShim();
    const { openDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
    const promise = openDatePeriodDialog({
      allowPeriod: true,
      allowTime: true,
      initial: { mode: 'date', from: '2026-09-26', to: '2026-09-26', hasTime: false },
    });
    const backdrop = bodyShim().children.find((c) => c.classList.contains('dialog-backdrop'));
    assert.ok(backdrop !== undefined, 'модальный диалог открыт');
    const toggle = first(backdrop!, '.dpd-time-toggle');
    assert.ok(toggle !== undefined, 'кнопка «С указанием времени» доступна');
    toggle!.click();
    const timeInput = first(backdrop!, '.dpd-time');
    assert.ok(timeInput !== undefined, 'поле времени появилось');
    // Пользователь ВВОДИТ время и сразу подтверждает: `change` НЕ эмитируем —
    // так выглядит подтверждение без потери фокуса полем (Ctrl/Cmd+Enter,
    // программный клик основной кнопки — штатный путь `showDialog`).
    timeInput!.value = '10:15';
    const ok = backdrop!
      .querySelectorAll('.ui-btn')
      .find((b) => b.textContent === 'ОК');
    assert.ok(ok !== undefined, 'кнопка «ОК» есть');
    ok!.click();
    const result = await promise;
    assert.ok(result !== null, 'диалог вернул значение');
    assert.equal(result!.hasTime, true, 'время включено');
    assert.equal(result!.fromTime, '10:15', 'введённое время попало в значение');
  });

  it('значение диалога → инстансы записи: время 10:15, use_time=true, подпись «дата + время»', async () => {
    const previous = { from: '2026-09-26T07:30:45.123Z', to: '2026-09-26T07:30:45.123Z' };
    const value = {
      mode: 'date' as const,
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: true,
      fromTime: '10:15',
      toTime: '10:15',
    };
    const { from, to } = resolveDatePeriodInstants(value, previous);
    assert.equal(instantToLocalDate(from), '2026-09-26', 'дата сохранена');
    assert.equal(instantToLocalTime(from), '10:15', 'время инстанса — 10:15 наблюдателя');
    assert.match(from, /:45\.123Z$/, 'секунды/мс исходного инстанса сохранены');
    assert.equal(to, from, 'в режиме «Дата» конец равен началу (valid_to непуст)');
    assert.equal(value.hasTime, true, 'use_time уйдёт true');
    assert.equal(
      formatDatePeriodValue({ ...value, hasTime: true }),
      '2026-09-26 10:15',
      'подпись записи в ленте — дата со временем',
    );
  });

  it('экран переводит значение диалога его же помощником (одна реализация)', () => {
    const src = source(CHRONICLE);
    assert.match(src, /resolveDatePeriodInstants\(value,\s*previous\)/);
    assert.ok(!src.includes('setInstantTime(base.from'), 'своя копия конверсии устранена');
    // Диалог отдаёт «живое» значение — поля читаются в `getValue()`.
    assert.match(source(DATE_PERIOD_DIALOG), /function commitLiveInputs\(/);
    assert.match(source(DATE_PERIOD_DIALOG), /commitLiveInputs\(\);/);
  });
});

// ---------------------------------------------------------------------------
// П.2 — спокойная лента
// ---------------------------------------------------------------------------

describe('приёмка №8, п.2: создание записи не дёргает ленту', () => {
  it('insertRowByDay держит порядок: убывание вставляет по направлению', async () => {
    const { insertRowByDay } = await diary();
    const asc = [row('a', '2026-09-10'), row('c', '2026-09-20')];
    assert.deepEqual(
      insertRowByDay(asc, row('b', '2026-09-15'), 'asc').map((r) => r.id),
      ['a', 'b', 'c'],
      'возрастание — новая запись по своему дню',
    );
    const desc = [row('c', '2026-09-20'), row('a', '2026-09-10')];
    assert.deepEqual(
      insertRowByDay(desc, row('b', '2026-09-15'), 'desc').map((r) => r.id),
      ['c', 'b', 'a'],
      'убывание — новая запись по своему дню',
    );
  });

  it('экран вставляет созданную запись на месте слота, без полной перерисовки', () => {
    const src = source(CHRONICLE);
    assert.match(src, /insertCreatedRecord\(localRow\)/, 'созданная запись вставляется локально');
    assert.match(src, /slotRoot!\.replaceWith\(card\)/, 'слот превращается в карточку на месте');
    assert.match(src, /async function localRowFromComment\(/, 'строка собирается из ответа создания');
    assert.match(src, /pendingReconcile = true/, 'следующая дозагрузка идёт согласованием');
    assert.match(
      src,
      /if \(pendingReconcile\) \{\s*keepFeedScroll = true;\s*await reload\(\);/,
      'дозагрузка учитывает допущение (и не сбрасывает прокрутку)',
    );
    // Немедленная полная перезагрузка сразу после создания устранена.
    assert.ok(
      !/slot = null;\s*state\.root\.remove\(\);\s*await reload\(\);\s*syncCalendar\(\);\s*return created;/.test(
        src,
      ),
      'создание не перезагружает ленту целиком',
    );
  });
});

// ---------------------------------------------------------------------------
// П.3 — сортировка «Убывание»
// ---------------------------------------------------------------------------

describe('приёмка №8, п.3: сортировка «Убывание» уважается группировкой', () => {
  const rows = [row('a', '2026-09-10'), row('b', '2026-09-20'), row('c', '2026-09-15')];

  it('дни идут по направлению: desc — первый день самый поздний', async () => {
    const { compareDays } = await diary();
    const desc = groupByLocalDays(rows, { order: 'desc' });
    assert.deepEqual(desc.map((d) => d.day), ['2026-09-20', '2026-09-15', '2026-09-10']);
    const asc = groupByLocalDays(rows, { order: 'asc' });
    assert.deepEqual(asc.map((d) => d.day), ['2026-09-10', '2026-09-15', '2026-09-20']);
    assert.equal(compareDays('2026-09-10', '2026-09-20', 'desc'), 1);
    assert.equal(compareDays('2026-09-10', '2026-09-20', 'asc'), -1);
  });

  it('записи внутри дня сохраняют серверный порядок входа (не пересортировываются)', () => {
    const sameDay = [row('x', '2026-09-15'), row('y', '2026-09-15')];
    const grouped = groupByLocalDays(sameDay, { order: 'desc' });
    assert.deepEqual(grouped[0]!.rows.map((r) => r.id), ['x', 'y']);
  });

  it('экран передаёт направление отбора в группировку', () => {
    const src = source(CHRONICLE);
    assert.match(src, /const order = getFilterState\(\)\.order/, 'направление берётся из отбора');
    assert.match(src, /groupByLocalDays\(rows, \{ from, to, order \}\)/, 'направление доходит до группировки');
  });
});

// ---------------------------------------------------------------------------
// П.4 — компонентные поля дат панели «Период»
// ---------------------------------------------------------------------------

describe('приёмка №8, п.4: компонентное поле даты (ввод + календарь + очистка)', () => {
  it('поле несёт ввод, кнопку-календарь и очистку; валидация и очистка работают', async () => {
    installShim();
    const { dateField } = await import('../src/renderer/lib/date-field.js');
    const seen: string[] = [];
    const handle = dateField({
      value: '2026-09-10',
      ariaLabel: 'Дата',
      onPick: async () => '2026-10-01',
      onChange: (v) => seen.push(v),
    });
    const root = handle.root as unknown as ShimElement;
    assert.equal(first(root, '.date-field-input')?.value, '2026-09-10');
    assert.ok(first(root, '.date-field-pick') !== undefined, 'есть кнопка-календарь');
    const clear = first(root, '.date-field-clear');
    assert.ok(clear !== undefined, 'есть крестик очистки');
    assert.equal(clear!.hidden, false, 'непустое поле — крестик виден');

    // корректный ввод применяется
    const input = handle.input as unknown as ShimElement;
    input.value = '2026-09-25';
    input.emit('change');
    assert.equal(handle.value(), '2026-09-25');
    // некорректный — откат, onChange не зовётся
    const before = seen.length;
    input.value = '2026-13-40';
    input.emit('change');
    assert.equal(handle.value(), '2026-09-25', 'невалидный ввод откатывается');
    assert.equal(seen.length, before, 'откат не порождает onChange');

    // календарь применяет результат
    first(root, '.date-field-pick')!.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(handle.value(), '2026-10-01', 'дата из календаря применена');

    // очистка
    first(root, '.date-field-clear')!.click();
    assert.equal(handle.value(), '', 'поле очищено');
    assert.equal(seen.at(-1), '', 'очистка сообщает пустое значение');
  });

  it('панель «Даты»: правка одной границы автоподгоняет противоположную', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({ variant: 'panel', panelMode: 'dates' });
    const root = editor.root as unknown as ShimElement;
    // «С» позже «По» → «По» подтягивается к «С».
    let fields = root.querySelectorAll('.date-field-input');
    fields[0]!.value = '2026-09-20';
    fields[0]!.emit('change');
    fields = root.querySelectorAll('.date-field-input');
    fields[1]!.value = '2026-09-10';
    fields[1]!.emit('change');
    assert.deepEqual(
      { from: editor.getValue().from, to: editor.getValue().to },
      { from: '2026-09-10', to: '2026-09-10' },
      '«По» < «С» двигает «С»',
    );
    // «По» раньше «С» → «С» подтягивается... обратный случай.
    fields = root.querySelectorAll('.date-field-input');
    fields[0]!.value = '2026-09-30';
    fields[0]!.emit('change');
    assert.deepEqual(
      { from: editor.getValue().from, to: editor.getValue().to },
      { from: '2026-09-30', to: '2026-09-30' },
      '«С» > «По» двигает «По»',
    );
  });

  it('панель строит поля дат общим компонентом, а не самодельной разметкой', () => {
    const src = source(PERIOD_EDITOR);
    assert.match(src, /import \{ dateField \} from '\.\/date-field\.js'/);
    assert.match(src, /const field = dateField\(\{/);
    assert.match(src, /setPeriodFrom\(value, dateOnly\(to\.text\), value\)/);
    assert.match(src, /setPeriodTo\(dateOnly\(from\.text\), value, value\)/);
  });
});

// ---------------------------------------------------------------------------
// П.5 — локаль заголовка группы дат
// ---------------------------------------------------------------------------

describe('приёмка №8, п.5: заголовок группы дат без «г.»', () => {
  it('«Четверг, 24 сентября 2026» — без сокращения года', async () => {
    const { formatDayLabel } = await diary();
    const label = formatDayLabel('2026-09-24');
    assert.equal(label, 'Четверг, 24 сентября 2026');
    assert.ok(!label.includes('г.'), 'без «г.» на конце');
    assert.ok(!label.includes(' г'), 'без отдельного «г»');
  });

  it('экран берёт подпись дня из общего помощника, год не форматируется через Intl', () => {
    const src = source(CHRONICLE);
    assert.match(src, /label: formatDayLabel\(day\)/);
    assert.ok(!/year:\s*'numeric'/.test(src), 'Intl-год с «г.» в экране не используется');
  });
});
