/**
 * Блок «Связи дня» ленты «Дневника» (0.16.1, задача 710b68aa; требование
 * 1fb1047d, элемент интерфейса 8ecc30cd).
 *
 * Проверяется разбор ответа по дням и DOM-блок дня: факты идут первыми,
 * ссылки — после них; пустой блок скрыт; время цели и дата записи-источника на
 * месте; клики ведут к владельцу источника и к дню записи. Сеть и экранные
 * переходы подменены `DayLinksActions`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { DayLink, DayLinkSource, DayLinksResult } from '@etn/shared';

import {
  buildDayLinksBlock,
  groupDayLinks,
  renderDayLinks,
  withLinkDays,
} from '../src/renderer/screens/chronicle/day-links.js';
import { formatDayLabel, localDay } from '../src/renderer/screens/chronicle/diary.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный `CustomEvent` (DOM-шим не несёт глобального конструктора). */
class ShimCustomEvent {
  readonly type: string;
  readonly detail: unknown;

  constructor(type: string, init: { detail?: unknown } = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

/** Поднять DOM-глобалы, нужные фабрике облачков и `el`/`div`. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelector: (): null => null,
    activeElement: null,
  };
  (globalThis as any).CustomEvent = ShimCustomEvent;
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  // Облачко откладывает одиночный клик (`deferSingleClick`, 220 мс) — в тесте
  // откладываем на ближайший тик и ждём его: проверяется выбор действия, не таймер.
  win.setTimeout = (fn: () => void): unknown => setTimeout(fn, 0);
  win.clearTimeout = (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout);
}

/** Владелец-мысль источника. */
function owner(id: string, title: string): DayLinkSource {
  return {
    comment_id: `c-${id}`,
    line_no: 0,
    text: 'строка',
    kind: 'chronological',
    owner_type: 'thought',
    owner_id: id,
    owner_title: title,
    source_from: '2026-10-26T12:00:00.000Z',
    source_to: '2026-10-26T23:59:59.000Z',
    source_title: 'Запись',
  };
}

/** Наблюдения действий блока. */
interface Calls {
  thoughts: string[];
  /** Открытия на вкладке «Свойства»: `[мысль, свойство]`. */
  properties: Array<[string, string]>;
  sources: string[];
  days: string[];
}

/** Смонтировать блок с журналом действий. */
function mountBlock(): { block: ShimElement; calls: Calls } {
  installShim();
  const host = new ShimElement('div');
  const block = buildDayLinksBlock() as unknown as ShimElement;
  host.append(block);
  const calls: Calls = { thoughts: [], properties: [], sources: [], days: [] };
  return { block, calls };
}

/** Данные блока: один факт и две ссылки (запись и постоянный комментарий). */
function sample(): DayLinksResult {
  const chronological = owner('t-brat', 'Брат');
  const permanent: DayLinkSource = {
    ...chronological,
    comment_id: 'c-perm',
    line_no: 1,
    text: 'Созвон с мамой',
    kind: 'permanent',
    owner_id: 't-mama',
    owner_title: 'Мама',
    source_from: null,
    source_to: null,
    source_title: null,
  };
  const links: DayLink[] = [
    { day: '2026-11-02', time: null, source: chronological },
    { day: '2026-11-02', time: '09:30', source: permanent },
  ];
  return {
    facts: [
      {
        day: '2026-11-02',
        thought_id: 't-stol',
        title: 'Стол кухонный',
        property_id: 'p-bought',
        property_name: 'дата приобретения',
        value: '2026-11-02',
      },
    ],
    links,
  };
}

describe('связи дня: разбор ответа и блок дня (1fb1047d)', () => {
  beforeEach(() => installShim());

  it('ответ группируется по календарным дням', () => {
    const grouped = groupDayLinks(sample());
    const day = grouped.get('2026-11-02');
    assert.ok(day !== undefined);
    assert.equal(day.facts.length, 1);
    assert.equal(day.links.length, 2);
    assert.equal(grouped.size, 1);
  });

  it('пустой день — блок скрыт и без строк', () => {
    const { block } = mountBlock();
    renderDayLinks(block as unknown as HTMLElement, undefined, {
      openThought: () => undefined,
      openThoughtProperty: () => undefined,
      openSource: () => undefined,
      openSourceDay: () => undefined,
    });
    assert.equal(block.hidden, true);
    assert.equal(block.querySelectorAll('.diary-day-link').length, 0);
  });

  it('повторный рендер сохраняет узлы неизменённых строк (keyed-сверка)', () => {
    const { block } = mountBlock();
    const actions = {
      openThought: () => undefined,
      openThoughtProperty: () => undefined,
      openSource: () => undefined,
      openSourceDay: () => undefined,
    };
    const day = groupDayLinks(sample()).get('2026-11-02');
    renderDayLinks(block as unknown as HTMLElement, day, actions);
    const factRow = block.querySelector('.diary-day-link-fact');
    const linkRows = block.querySelectorAll('.diary-day-link-ref');
    renderDayLinks(block as unknown as HTMLElement, day, actions);
    assert.equal(block.querySelector('.diary-day-link-fact'), factRow, 'тот же узел строки факта');
    assert.equal(
      block.querySelector('.diary-day-link-ref'),
      linkRows[0],
      'тот же узел первой строки ссылки',
    );
    assert.equal(block.querySelectorAll('.diary-day-link-ref').length, 2, 'дублей нет');
  });

  it('факты — первыми, ссылки — после; время цели и дата источника на месте', () => {
    const { block } = mountBlock();
    renderDayLinks(block as unknown as HTMLElement, groupDayLinks(sample()).get('2026-11-02'), {
      openThought: () => undefined,
      openThoughtProperty: () => undefined,
      openSource: () => undefined,
      openSourceDay: () => undefined,
    });
    assert.equal(block.hidden, false);
    const facts = block.querySelector('.diary-day-links-facts');
    const list = block.querySelector('.diary-day-links-list');
    assert.ok(facts !== null && list !== null);
    assert.equal(
      block.children[0],
      facts,
      'датовые факты идут перед date-ссылками (порядок требования)',
    );
    assert.equal(facts.querySelectorAll('.diary-day-link-fact').length, 1);
    assert.equal(list.querySelectorAll('.diary-day-link-ref').length, 2);
    assert.equal(facts.querySelector('.diary-day-link-caption')?.textContent, 'дата приобретения');
    assert.equal(list.querySelector('.diary-day-link-time')?.textContent, '09:30');
    const sourceDate = formatDayLabel(localDay('2026-10-26T12:00:00.000Z'));
    assert.ok(
      Array.from(list.querySelectorAll('.diary-day-link-source-date')).some(
        (node) => node.textContent === sourceDate,
      ),
      'дата записи-источника показана',
    );
  });

  it('подпись свойства открывает мысль на вкладке «Свойства», облачко — как раньше (3054fe86)', async () => {
    const { block, calls } = mountBlock();
    const actions = {
      openThought: (id: string) => calls.thoughts.push(id),
      openThoughtProperty: (id: string, propertyId: string) =>
        calls.properties.push([id, propertyId]),
      openSource: () => undefined,
      openSourceDay: () => undefined,
    };
    renderDayLinks(
      block as unknown as HTMLElement,
      groupDayLinks(sample()).get('2026-11-02'),
      actions,
    );
    const caption = block.querySelector('.diary-day-link-caption') as unknown as ShimElement;
    // Подпись — НАСТОЯЩАЯ кнопка: Enter/Space работают нативно, а не за счёт
    // самодельного разбора клавиш. Некликабельный `span` тест красит.
    assert.equal(
      (caption.tagName ?? '').toLowerCase(),
      'button',
      'подпись свойства — кнопка словаря',
    );
    caption.click();
    assert.deepEqual(
      calls.properties,
      [['t-stol', 'p-bought']],
      'подпись ведёт к строке ЭТОГО свойства',
    );
    assert.deepEqual(calls.thoughts, [], 'облачко не нажимали — карточка не открывалась');
    // Облачко факта — прежний путь: карточка мысли без смены вкладки.
    const chip = block.querySelector('.prop-ref-cloud') as unknown as ShimElement;
    assert.ok(chip !== null, 'облачко мысли на месте');
    chip.click();
    // Одиночный клик облачка отложен — дожидаемся тика.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(calls.thoughts, ['t-stol']);
    assert.equal(calls.properties.length, 1, 'облачко не просит показа свойства');
  });

  it('сниппет записи ведёт к дню источника, постоянного комментария — к владельцу', () => {
    const { block, calls } = mountBlock();
    const actions = {
      openThought: (id: string) => calls.thoughts.push(id),
      openThoughtProperty: (id: string, propertyId: string) =>
        calls.properties.push([id, propertyId]),
      openSource: (source: DayLinkSource) => calls.sources.push(source.comment_id),
      openSourceDay: (day: string) => calls.days.push(day),
    };
    renderDayLinks(
      block as unknown as HTMLElement,
      groupDayLinks(sample()).get('2026-11-02'),
      actions,
    );
    const snippets = block.querySelectorAll('.diary-day-link-snippet') as unknown as ShimElement[];
    assert.equal(snippets.length, 2);
    snippets[0]!.click();
    assert.deepEqual(calls.days, [localDay('2026-10-26T12:00:00.000Z')]);
    snippets[1]!.click();
    assert.deepEqual(calls.sources, ['c-perm']);
    const date = block.querySelector('.diary-day-link-source-date') as unknown as ShimElement;
    date.click();
    assert.equal(calls.days.length, 2, 'дата источника — тот же переход к дню');
  });
});

describe('дни ленты: день только со «связями дня» (замечание 399c25d5)', () => {
  beforeEach(() => installShim());

  it('день без записей, но со связями, становится днём ленты в её порядке', () => {
    const links = groupDayLinks({
      facts: [],
      links: [{ day: '2026-11-11', time: null, source: owner('t-brat', 'Брат') }],
    });
    const days = withLinkDays(
      [
        { day: '2026-11-10', rows: [] },
        { day: '2026-11-12', rows: [] },
      ],
      links,
      {
        from: '2026-11-10',
        to: '2026-11-12',
        order: 'asc',
      },
    );
    assert.deepEqual(
      days.map((day) => day.day),
      ['2026-11-10', '2026-11-11', '2026-11-12'],
    );
    assert.deepEqual(days[1]!.rows, [], 'у добавленного дня записей нет — только связи');
  });

  it('день с записями не дублируется, день вне периода не добавляется', () => {
    const links = groupDayLinks({
      facts: [],
      links: [
        { day: '2026-11-10', time: null, source: owner('t-brat', 'Брат') },
        { day: '2026-12-01', time: null, source: owner('t-brat', 'Брат') },
      ],
    });
    const days = withLinkDays([{ day: '2026-11-10', rows: [] }], links, {
      from: '2026-11-01',
      to: '2026-11-30',
      order: 'desc',
    });
    assert.deepEqual(
      days.map((day) => day.day),
      ['2026-11-10'],
      'дубля нет, день вне применённого периода не показывается',
    );
  });

  it('«Убывание»: добавленный день встаёт по направлению ленты', () => {
    const links = groupDayLinks({
      facts: [],
      links: [{ day: '2026-11-11', time: null, source: owner('t-brat', 'Брат') }],
    });
    const days = withLinkDays([{ day: '2026-11-10', rows: [] }], links, {
      from: '2026-11-01',
      to: '2026-11-30',
      order: 'desc',
    });
    assert.deepEqual(
      days.map((day) => day.day),
      ['2026-11-11', '2026-11-10'],
    );
  });
});
