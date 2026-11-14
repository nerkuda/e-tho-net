/**
 * Чистые помощники контекстного меню date-чипа (0.16.1, задача 9ec9d72a;
 * элемент интерфейса c85ca40d, сценарий P5).
 *
 * Без DOM проверяется вся арифметика адресации и переноса, на которой держится
 * меню: адрес ссылки по смещению/порядковому номеру в `body_md`, сдвиг цели
 * (время сохраняется, алиас автора не теряется), единый сдвиг всех ссылок
 * строки и нормализация 31-го числа (та же, что у серверной операции `move`).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { EtnError } from '@etn/shared';

import {
  __testing,
  chipSourceOffset,
  dateSpanByOffset,
  dateSpanByOrdinal,
  dateSpanOnLine,
  dayDelta,
  replaceSpanTarget,
  shiftLineDates,
  shiftSpanTarget,
  taskLineAt,
} from '../src/renderer/editor/date-chip-menu.js';
import { t } from '../src/renderer/lib/i18n.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

// ---------------------------------------------------------------------------
// Порядковый номер чипа (HTML ленты без source-map)
// ---------------------------------------------------------------------------

test('dateSpanByOrdinal: чипы адресуются в порядке body_md, с номером строки', () => {
  const body = 'запись\n- [ ] задача [[2026-11-02]]..[[2026-11-05]]\nещё [[2026-11-06]]';
  const first = dateSpanByOrdinal(body, 0);
  assert.ok(first);
  assert.equal(first.lineNo, 1);
  assert.equal(first.span.parts.date, '2026-11-02');
  assert.equal(first.lineText, '- [ ] задача [[2026-11-02]]..[[2026-11-05]]');

  assert.equal(dateSpanByOrdinal(body, 1)?.span.parts.date, '2026-11-05');
  assert.equal(dateSpanByOrdinal(body, 2)?.span.parts.date, '2026-11-06');
  assert.equal(dateSpanByOrdinal(body, 3), null);
  assert.equal(dateSpanByOrdinal(body, -1), null);
});

test('dateSpanByOrdinal: ссылка с временем и алиасом разбирается как date-ссылка', () => {
  const body = '[[2026-11-02 14:30]] и [[2026-11-03|третье]]';
  assert.deepEqual(dateSpanByOrdinal(body, 0)?.span.parts, { date: '2026-11-02', time: '14:30' });
  assert.equal(dateSpanByOrdinal(body, 1)?.span.parts.date, '2026-11-03');
  // Не-date ссылка не считается чипом: `[[#uuid]]` и `[[Имя]]` в ordinal не входят.
  assert.equal(dateSpanByOrdinal('[[#8e0d670e-de61-4da7-b13e-9232cd1c6ca5]]', 0), null);
  assert.equal(dateSpanByOrdinal('[[Имя мысли]]', 0), null);
});

test('dateSpanByOrdinal: `[[…]]` внутри ограды кода не считается чипом', () => {
  const body = ['```', '[[2026-11-01]]', '```', 'настоящая [[2026-11-02]]'].join('\n');
  const found = dateSpanByOrdinal(body, 0);
  assert.ok(found);
  assert.equal(found.span.parts.date, '2026-11-02', 'первый чип — после ограды');
  assert.equal(found.lineNo, 3);
  assert.equal(dateSpanByOrdinal(body, 1), null);
});

// ---------------------------------------------------------------------------
// Адрес строки панели «Задачи и напоминания» (`comment_id:line_no`)
// ---------------------------------------------------------------------------

test('dateSpanOnLine: строка адресуется ключом, номер чипа — внутри строки', () => {
  const body = 'предисловие [[2026-10-01]]\n- [ ] задача [[2026-11-02]]..[[2026-11-05]]';
  assert.equal(dateSpanOnLine(body, 0, 0)?.span.parts.date, '2026-10-01');
  assert.equal(dateSpanOnLine(body, 1, null)?.span.parts.date, '2026-11-02', 'без номера — первая');

  const second = dateSpanOnLine(body, 1, 1);
  assert.ok(second);
  assert.equal(second.lineNo, 1);
  assert.equal(second.span.parts.date, '2026-11-05', 'номер чипа считается внутри строки');

  assert.equal(dateSpanOnLine(body, 1, 2), null, 'в строке всего две ссылки');
  assert.equal(dateSpanOnLine(body, 7, 0), null, 'строки нет');
  assert.equal(dateSpanOnLine(body, -1, 0), null);
});

// ---------------------------------------------------------------------------
// Абсолютное смещение (source-map просмотра)
// ---------------------------------------------------------------------------

test('dateSpanByOffset: смещение внутри цели даёт правильную строку и ссылку', () => {
  const body = 'текст\n[[2026-11-02]]';
  const at = body.indexOf('2026-11-02');
  const found = dateSpanByOffset(body, at);
  assert.ok(found);
  assert.equal(found.lineNo, 1);
  assert.equal(found.span.parts.date, '2026-11-02');
  assert.equal(dateSpanByOffset(body, body.indexOf('текст')), null);
});

test('dateSpanByOffset: смещение в алиасе тоже находит ссылку (алиас = source-map)', () => {
  const body = 'см. [[2026-11-02|второе ноября]]';
  const found = dateSpanByOffset(body, body.indexOf('второе'));
  assert.ok(found, 'алиас лежит внутри диапазона ссылки');
  assert.equal(found.span.parts.date, '2026-11-02');
});

test('dateSpanByOffset: отрицательное смещение и смещение за концом — null', () => {
  const body = '[[2026-11-02]]';
  assert.equal(dateSpanByOffset(body, -1), null);
  assert.equal(dateSpanByOffset(body, body.length + 10), null);
});

// ---------------------------------------------------------------------------
// Сдвиг дат
// ---------------------------------------------------------------------------

/** Реальная date-ссылка строки — источник span'ов для проверок сдвига. */
function spanOf(line: string, ordinal = 0) {
  const found = dateSpanByOrdinal(line, ordinal);
  assert.ok(found, `в строке нет date-ссылки: ${line}`);
  return found.span;
}

test('shiftSpanTarget: дни и месяцы, время HH:MM сохраняется', () => {
  const bare = spanOf('[[2026-11-02]]');
  assert.equal(shiftSpanTarget(bare, { days: 1 }), '2026-11-03');
  assert.equal(shiftSpanTarget(bare, { days: 7 }), '2026-11-09');
  assert.equal(shiftSpanTarget(bare, { months: 1 }), '2026-12-02');

  const timed = spanOf('[[2026-11-02 14:30]]');
  assert.equal(shiftSpanTarget(timed, { days: 1 }), '2026-11-03 14:30');
});

test('shiftSpanTarget: 31-е → последний день месяца (как у серверной move)', () => {
  assert.equal(shiftSpanTarget(spanOf('[[2026-01-31]]'), { months: 1 }), '2026-02-28');
  assert.equal(shiftSpanTarget(spanOf('[[2026-03-31]]'), { months: 1 }), '2026-04-30');
});

test('shiftLineDates: единый сдвиг всех ссылок строки; алиас автора сохраняется', () => {
  const next = shiftLineDates('- [ ] [[2026-11-02]]..[[2026-11-05|конец]]', { days: 1 });
  assert.equal(next, '- [ ] [[2026-11-03]]..[[2026-11-06|конец]]');
  assert.equal(shiftLineDates('строка без дат', { days: 1 }), null);
});

test('replaceSpanTarget: меняется только цель, скобки и алиас остаются', () => {
  const line = 'см. [[2026-11-02|второе ноября]] дальше';
  const span = dateSpanByOrdinal(line, 0)!;
  const next = replaceSpanTarget(line, span.span, '2026-12-01');
  assert.equal(next, 'см. [[2026-12-01|второе ноября]] дальше');
});

test('dayDelta: разница календарных дат и безопасный ноль на мусоре', () => {
  assert.equal(dayDelta('2026-11-02', '2026-11-05'), 3);
  assert.equal(dayDelta('2026-11-05', '2026-11-02'), -3);
  assert.equal(dayDelta('не дата', '2026-11-02'), 0);
});

// ---------------------------------------------------------------------------
// Строка задачи: режим «все ссылки строки»
// ---------------------------------------------------------------------------

test('taskLineAt: задача находится по номеру строки body_md (1-based парсер ↔ 0-based адрес)', () => {
  const body = 'текст\n- [ ] задача [[2026-11-02]]\n- [ ] вторая';
  const task = taskLineAt(body, 1);
  assert.ok(task);
  assert.equal(task.isTask, true);
  assert.equal(task.periodFrom, '2026-11-02');
  assert.equal(taskLineAt(body, 0), null, 'обычный текст — не задача');
  assert.equal(taskLineAt(body, 9), null, 'строки нет');
});

test('taskLineAt: вложенный пункт чек-листа — не задача (перенос одной ссылкой)', () => {
  const body = '- [ ] задача [[2026-11-02]]\n  - [ ] подпункт';
  assert.equal(taskLineAt(body, 0)?.isTask, true);
  assert.equal(taskLineAt(body, 1), null, 'subtask не считается строкой-задачей');
});

// ---------------------------------------------------------------------------
// Смещение чипа из DOM
// ---------------------------------------------------------------------------

test('chipSourceOffset: data-md-start из source-map, мусор — null', () => {
  const chip = new ShimElement('span');
  chip.setAttribute('data-md-start', '12');
  assert.equal(chipSourceOffset(chip), 12);

  const empty = new ShimElement('span');
  assert.equal(chipSourceOffset(empty), null);

  const broken = new ShimElement('span');
  broken.setAttribute('data-md-start', 'x');
  assert.equal(chipSourceOffset(broken), null);

  const negative = new ShimElement('span');
  negative.setAttribute('data-md-start', '-3');
  assert.equal(chipSourceOffset(negative), null);
});

// ---------------------------------------------------------------------------
//Интеграция переноса (вердикт приёмки 0.16.1): строка-задача — ВСЕ ссылки,
// не-задача — одна; просмотр идёт серверной операцией, конфликт ревизии честно
// сообщается. Без DOM-меню и диалога: проверяется применение переноса.
// ---------------------------------------------------------------------------

/** Минимальный DOM: тосты `notice` кладутся в `document.body`. */
function installDom(): ShimElement {
  const body = new ShimElement('body');
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // Адресация чипа в строке панели проверяет `instanceof HTMLElement` — как в
  // браузере: шим-элемент объявляется глобальным конструктором.
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  // Таймеры не запускаем: тост живёт в DOM до конца теста.
  let nextTimer = 0;
  win['setTimeout'] = () => ++nextTimer;
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return body;
}

interface FakeCalls {
  get: string[];
  patch: Array<{ networkId: string; payload: Record<string, unknown> }>;
  update: Array<{ networkId: string; id: string; changes: { body_md: string }; version: number }>;
}

/** Подменить мост `etn`: комментарий-источник и журнал записей. */
function fakeEtn(
  comment: { id: string; version: number; body_md: string },
  patch?: (payload: Record<string, unknown>) => Promise<unknown>,
): FakeCalls {
  const calls: FakeCalls = { get: [], patch: [], update: [] };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const api = {
    comments: {
      get: async (_networkId: string, id: string) => {
        calls.get.push(id);
        return comment;
      },
      update: async (
        networkId: string,
        id: string,
        changes: { body_md: string },
        version: number,
      ) => {
        calls.update.push({ networkId, id, changes, version });
        return {};
      },
    },
    tasks: {
      patch: async (networkId: string, payload: Record<string, unknown>) => {
        calls.patch.push({ networkId, payload });
        if (patch !== undefined) return patch(payload);
        return { results: [{ ok: true }] };
      },
    },
  };
  // `lib/etn` читает мост из `window.etn`, если `window` существует, иначе из
  // `globalThis` — DOM-шим заводит `window` (таймеры тостов), поэтому пишем в оба.
  (globalThis as any).etn = api;
  const win = (globalThis as any).window as Record<string, unknown> | undefined;
  if (win !== undefined) win['etn'] = api;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return calls;
}

/** Контекст чипа в просмотре: адрес ссылки — по абсолютному смещению. */
function viewChip(body: string, date = '2026-11-02'): Record<string, unknown> {
  return {
    kind: 'view',
    commentId: 'c1',
    offset: body.indexOf(date),
    ordinal: null,
    lineNo: null,
  };
}

/** Чип в строке панели «Задачи и напоминания»: ключ строки — `comment_id:line_no`. */
function panelChip(rowKey: string, date = '2026-11-02'): ShimElement {
  const card = new ShimElement('div');
  card.setAttribute('data-row-key', rowKey);
  const chip = new ShimElement('span');
  chip.classList.add('wiki-link', 'wiki-link-date');
  chip.setAttribute('data-wiki-date', date);
  card.append(chip);
  return chip;
}

/** Контекст чипа в правке: однострочный документ и журнал изменений буфера. */
function editorChip(doc: string): {
  ctx: Record<string, unknown>;
  changes: Array<Record<string, unknown>>;
} {
  const changes: Array<Record<string, unknown>> = [];
  const view = {
    state: {
      doc: {
        lineAt: () => ({ from: 0, text: doc, number: 1 }),
        toString: () => doc,
      },
    },
    dispatch: (spec: { changes?: Array<Record<string, unknown>> }) => {
      changes.push(...(spec.changes ?? []));
    },
  };
  return { ctx: { kind: 'editor', view, linkFrom: doc.indexOf('[[') }, changes };
}

let body: ShimElement;

beforeEach(() => {
  body = installDom();
  store.update({ networkId: 'n1' });
});

test('просмотр: перенос строки-задачи — один PATCH /tasks op move с ревизией', async () => {
  const text = '- [ ] задача [[2026-11-02]]..[[2026-11-05]]';
  const calls = fakeEtn({ id: 'c1', version: 7, body_md: text });

  await __testing.moveChip(viewChip(text) as never, { days: 1 });

  assert.equal(calls.update.length, 0, 'строку-задачу не правит comments.update');
  assert.equal(calls.patch.length, 1, 'ровно одна серверная операция');
  const payload = calls.patch[0]!.payload as { ops: Array<Record<string, unknown>> };
  assert.equal(payload.ops.length, 1);
  assert.deepEqual(
    payload.ops[0],
    {
      comment_id: 'c1',
      line_no: 0,
      action: 'move',
      days: 1,
      expected_revision: 7,
    },
    'единый сдвиг строки задан адресом строки и оптимистичной ревизией',
  );
  assert.equal(calls.patch[0]!.networkId, 'n1');
});

test('панель: чип строки задачи адресуется ключом comment_id:line_no', async () => {
  // В body_md есть дата ДО строки задачи: порядковый номер чипа по всему
  // документу указал бы на чужую строку — адрес обязан идти по ключу строки.
  const text = 'предисловие [[2026-10-01]]\n- [ ] задача [[2026-11-02]]';
  const calls = fakeEtn({ id: 'c9', version: 4, body_md: text });
  const ctx = __testing.chipContext(panelChip('c9:1') as unknown as HTMLElement);

  await __testing.moveChip(ctx as never, { days: 7 });

  assert.deepEqual(calls.get, ['c9'], 'в comments.get уходит id комментария, а не ключ строки');
  assert.equal(calls.update.length, 0, 'строку-задачу правит серверная операция');
  assert.equal(calls.patch.length, 1, 'ровно одна серверная операция');
  const payload = calls.patch[0]!.payload as { ops: Array<Record<string, unknown>> };
  assert.deepEqual(
    payload.ops[0],
    {
      comment_id: 'c9',
      line_no: 1,
      action: 'move',
      days: 7,
      expected_revision: 4,
    },
    'адрес операции — строка панели, а не номер чипа во всём body_md',
  );
});

test('просмотр: не-задача — правится ТОЛЬКО кликнутая ссылка', async () => {
  const text = 'см. [[2026-11-02]] и [[2026-11-05]]';
  const calls = fakeEtn({ id: 'c1', version: 7, body_md: text });

  await __testing.moveChip(viewChip(text) as never, { days: 1 });

  assert.equal(calls.patch.length, 0, 'серверная модель задач не трогается');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]!.changes.body_md, 'см. [[2026-11-03]] и [[2026-11-05]]');
  assert.equal(calls.update[0]!.version, 7);
});

test('просмотр: конфликт ревизии (409) — подсказка «обновите»', async () => {
  const text = '- [ ] [[2026-11-02]]';
  fakeEtn({ id: 'c1', version: 7, body_md: text }, async () => {
    throw new EtnError('VERSION_CONFLICT', 'stale');
  });

  await __testing.moveChip(viewChip(text) as never, { days: 1 });

  assert.ok(body.textContent.includes(t('wikiLink.dateMenu.stale')), 'показан текст «обновите»');
});

test('просмотр: «Изменить дату» на задаче — PATCH со сдвигом на разницу дней', async () => {
  const text = '- [ ] [[2026-11-02]]..[[2026-11-05]]';
  const calls = fakeEtn({ id: 'c1', version: 7, body_md: text });

  await __testing.applyDateChange(viewChip(text) as never, '2026-11-02', '2026-11-20');

  const payload = calls.patch[0]!.payload as { ops: Array<Record<string, unknown>> };
  assert.deepEqual(
    payload.ops[0],
    {
      comment_id: 'c1',
      line_no: 0,
      action: 'move',
      days: 18,
      expected_revision: 7,
    },
    'период сохраняется: сдвиг на 18 дней для всей строки',
  );
});

test('просмотр: «Изменить дату» на не-задаче — одна ссылка через comments.update', async () => {
  const text = 'см. [[2026-11-02]] и [[2026-11-20]]';
  const calls = fakeEtn({ id: 'c1', version: 7, body_md: text });

  await __testing.applyDateChange(viewChip(text) as never, '2026-11-02', '2026-11-10');

  assert.equal(calls.patch.length, 0);
  assert.equal(calls.update[0]!.changes.body_md, 'см. [[2026-11-10]] и [[2026-11-20]]');
});

test('правка: перенос строки-задачи сдвигает ОБЕ date-ссылки', async () => {
  const doc = '- [ ] задача [[2026-11-02]]..[[2026-11-05]]';
  const { ctx, changes } = editorChip(doc);

  await __testing.moveChip(ctx as never, { days: 1 });

  assert.equal(changes.length, 2, 'обе ссылки строки');
  assert.deepEqual(changes.map((change) => change['insert']).sort(), ['2026-11-03', '2026-11-06']);
});

test('правка: не-задача сдвигает только кликнутую ссылку', async () => {
  const doc = 'см. [[2026-11-02]] и [[2026-11-05]]';
  const { ctx, changes } = editorChip(doc);

  await __testing.moveChip(ctx as never, { days: 1 });

  assert.equal(changes.length, 1);
  assert.equal(changes[0]!['insert'], '2026-11-03');
});

test('правка: «Изменить дату» на задаче — выбранная дата + сдвиг остальных', async () => {
  const doc = '- [ ] задача [[2026-11-02]]..[[2026-11-05]]';
  const { ctx, changes } = editorChip(doc);

  await __testing.applyDateChange(ctx as never, '2026-11-02', '2026-11-20');

  assert.equal(changes.length, 2, 'период сохраняется: сдвинуты обе ссылки');
  assert.deepEqual(changes.map((change) => change['insert']).sort(), ['2026-11-20', '2026-11-23']);
});

test('правка: «Изменить дату» на не-задаче — меняется один чип', async () => {
  const doc = 'см. [[2026-11-02]] и [[2026-11-05]]';
  const { ctx, changes } = editorChip(doc);

  await __testing.applyDateChange(ctx as never, '2026-11-02', '2026-11-20');

  assert.equal(changes.length, 1);
  assert.equal(changes[0]!['insert'], '2026-11-20');
});
