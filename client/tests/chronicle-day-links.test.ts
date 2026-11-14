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
  sources: string[];
  days: string[];
}

/** Смонтировать блок с журналом действий. */
function mountBlock(): { block: ShimElement; calls: Calls } {
  installShim();
  const host = new ShimElement('div');
  const block = buildDayLinksBlock() as unknown as ShimElement;
  host.append(block);
  const calls: Calls = { thoughts: [], sources: [], days: [] };
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

  it('сниппет записи ведёт к дню источника, постоянного комментария — к владельцу', () => {
    const { block, calls } = mountBlock();
    const actions = {
      openThought: (id: string) => calls.thoughts.push(id),
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
