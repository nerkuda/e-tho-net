/**
 * Облачка привязок НЕСОХРАНЁННОЙ дневниковой записи (ошибка 78d600c9).
 *
 * Симптом заказчика: на экране «Дневник» добавили запись, набрали заголовок
 * (запись ещё не сохранена — карточка в единой правке), затем добавили мысли
 * через «+ мысль» — в верхней части карточки (облачка привязок) они НЕ
 * появлялись до сохранения записи.
 *
 * Причина: `updateRecordCard` при открытой правке карточки выходил сразу, чтобы
 * не отсоединять живой редактор, и вместе с полями «замораживал» шапку —
 * облачка привязок и дату/период, которые к правке не относятся. Теперь в правке
 * карточка не пересобирается, но шапка синхронизируется со свежей строкой
 * модели (`createRecordChips` + `RecordHead.setDayLabel`).
 *
 * Тест двойной:
 *  • ПОВЕДЕНЧЕСКИЙ — контейнер облачков исполняется на DOM-шиме: добавленная
 *    мысль появляется в ТОМ ЖЕ контейнере без пересборки, снятая уходит;
 *    подпись даты обновляется на месте;
 *  • СТРУКТУРНЫЙ — проводка экрана: в правке `updateRecordCard` зовёт
 *    `syncHead` и НЕ пересобирает карточку; `fillRecordCard` связывает
 *    `syncHead` с облачками и датой. Модуль экрана под Node не импортируется
 *    (тянет Electron-каркас), поэтому проводка проверяется по исходнику —
 *    конвенция тестов «Дневника» (`chronicle-record-collapse`).
 *
 * Мутационная проба: возврат прежнего `if (…editing() === true) return;`
 * краснит структурную часть, а отсутствие `chips.sync` в `syncHead` — обе.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);
const RECORD_HEAD = fs.readFileSync(
  path.join(RENDERER, 'screens', 'chronicle', 'record-head.ts'),
  'utf8',
);

/** Минимальный DOM-шим для исполнения компонента шапки (как в guard-тесте). */
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
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
}

/** Тело функции по её объявлению (стиль файла: `}` в первой колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

/** Строка записи для контейнера облачков (используются id и targets). */
function row(id: string, thoughtIds: readonly string[]): never {
  return {
    id,
    targets: thoughtIds.map((thoughtId) => ({
      kind: 'thought' as const,
      thought: { id: thoughtId, title: `Мысль ${thoughtId}` },
    })),
  } as never;
}

/** Фальшивое облачко: проверяем состав и перерисовку, а не вид мысли. */
function fakeChip(target: { kind: string; thought?: { title: string } }): ShimElement {
  const chip = new ShimElement('span', 'fake-chip');
  chip.textContent = target.kind === 'thought' ? target.thought?.title ?? '' : 'link';
  return chip;
}

/** Заголовки облачков в контейнере по порядку. */
function chipTexts(box: ShimElement): string[] {
  return box.children.map((child) => child.textContent);
}

describe('облачка привязок несохранённой записи (ошибка 78d600c9)', () => {
  it('добавленная мысль появляется в ТОМ ЖЕ контейнере сразу, без пересборки', async () => {
    installShim();
    const { createRecordChips } = await import(
      '../src/renderer/screens/chronicle/record-head.js'
    );
    const handle = createRecordChips({
      row: row('rec-1', ['home']),
      // HOME — служебная первичная привязка, облачка не несёт (c81964c7).
      homeId: () => 'home',
      buildChip: fakeChip as never,
    });
    const box = handle.box as unknown as ShimElement;
    assert.equal(box.className, 'diary-record-chips', 'контейнер шапки карточки');
    assert.deepEqual(chipTexts(box), [], 'HOME в облачках не показан');

    // «+ мысль» к несохранённой записи: строка модели пришла со свежими targets.
    handle.sync(row('rec-1', ['home', 't1']));
    assert.equal(handle.box as unknown as ShimElement, box, 'узел контейнера сохранён');
    assert.deepEqual(chipTexts(box), ['Мысль t1'], 'мысль видна сразу, без сохранения записи');

    handle.sync(row('rec-1', ['home', 't1', 't2']));
    assert.deepEqual(chipTexts(box), ['Мысль t1', 'Мысль t2'], 'вторая мысль добавлена на месте');

    handle.sync(row('rec-1', ['home', 't2']));
    assert.deepEqual(chipTexts(box), ['Мысль t2'], 'снятая привязка ушла из шапки');
  });

  it('подпись даты/периода обновляется на месте (шапка вне правки)', async () => {
    installShim();
    const { buildRecordHead } = await import(
      '../src/renderer/screens/chronicle/record-head.js'
    );
    const head = buildRecordHead({
      dayLabel: '1 октября 2026',
      onDateClick: () => undefined,
      chips: new ShimElement('div'),
      onAddThought: () => undefined,
      trailing: new ShimElement('button'),
      title: { value: '', label: 'Пустая запись', editHint: 'Правка', placeholder: 'Заголовок' },
    } as never);
    const rowNode = head.row as unknown as ShimElement;
    const dateNode = head.date as unknown as ShimElement;
    assert.ok(rowNode.children[0] === dateNode, 'дата — первый элемент строки полей');

    head.setDayLabel('2 октября 2026');
    assert.equal(dateNode.textContent, '2 октября 2026', 'подпись сменилась без пересборки');
    assert.ok(rowNode.children[0] === dateNode, 'узел даты тот же');
  });

  it('в правке updateRecordCard синхронизирует шапку и НЕ пересобирает карточку', () => {
    const fn = functionBody(CHRONICLE, 'function updateRecordCard(');
    const sync = fn.indexOf('editor.syncHead(row)');
    const refill = fn.indexOf('fillRecordCard(card, row, day)');
    assert.ok(sync >= 0, 'правка зовёт syncHead со свежей строкой модели');
    assert.ok(refill > sync, 'вне правки — прежняя полная пересборка карточки');
    assert.doesNotMatch(
      fn,
      /editing\(\) === true\) return;/,
      'правка не «замораживает» дату и облачка привязок',
    );
  });

  it('fillRecordCard связывает syncHead с облачками и датой', () => {
    const fn = functionBody(CHRONICLE, 'function fillRecordCard(');
    assert.match(
      fn,
      /const chips = createRecordChips\(\{ row, homeId: \(\) => homeId, buildChip \}\)/,
      'облачка — контейнер компонента шапки',
    );
    assert.match(fn, /chips: chips\.box/, 'контейнер вставлен в строку полей');
    assert.match(fn, /row\.targets = next\.targets;/, 'свежие привязки попадают в строку карточки');
    assert.match(fn, /chips\.sync\(row\)/, 'облачка перерисовываются на месте');
    // Порядок обязателен: `chips.sync` читает `row.targets`, поэтому строка
    // модели обновляется ДО перерисовки (иначе облачка показывают старый набор).
    const targetsAt = fn.indexOf('row.targets = next.targets;');
    const syncAt = fn.indexOf('chips.sync(row)');
    assert.ok(
      targetsAt >= 0 && syncAt > targetsAt,
      'привязки обновлены до перерисовки облачков',
    );
    assert.match(fn, /head\.setDayLabel\(recordDateLabel\(row\)\)/, 'дата/период синхронизируются');
  });

  it('компонент шапки экспортирует перерисовку облачков (не своя копия в экране)', () => {
    assert.match(RECORD_HEAD, /export function createRecordChips\(/);
    assert.doesNotMatch(
      CHRONICLE,
      /function repaintChips\(|function buildChipsRow\(/,
      'своих копий перерисовки облачков у экрана нет',
    );
  });
});
