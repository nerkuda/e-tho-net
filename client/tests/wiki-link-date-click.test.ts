/**
 * Делегированный клик по date-чипу в ПРОСМОТРЕ (0.16.1, задача 9ec9d72a;
 * требование 31fe2cc9).
 *
 * Контракт: общий обработчик клика по wiki-ссылке (`initWikiLinkNavigation`)
 * распознаёт date-чип по `data-wiki-date` ДО имени мысли и отдаёт дату в
 * единый вход `clickDateChip` (`md-live.ts`) — тот же, что у `mousedown` в
 * редакторе. Без этой ветки клик по чипу в просмотре молчит (вердикт приёмки:
 * отключение ветки не красило ни один тест).
 *
 * Здесь же — связка «обработчик по умолчанию открывает день»: проверяется
 * ПОВЕДЕНИЕМ (регистрация обработчика + передача даты в шов открытия), без
 * чтения исходника регуляркой.
 */

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { WIKI_LINK_DATE_ATTR } from '@etn/markdown';

import {
  clickDateChip,
  setDateChipClickHandler,
  setLegacyWikiLinkClickHandler,
} from '../src/renderer/editor/md-live.js';
import {
  initWikiLinkNavigation,
  openDayFromChip,
  resetWikiLinkNavigationForTests,
} from '../src/renderer/editor/wiki-link.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Listener {
  type: string;
  fn: (event: any) => void;
}

const listeners: Listener[] = [];

/** Минимальный документ: нужен только `addEventListener` для делегирования. */
function installDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: (type: string, fn: (event: any) => void) => {
      listeners.push({ type, fn });
    },
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  (globalThis as any).HTMLElement = ShimElement;
}

/** Спан просмотра: date-чип (`wiki-link wiki-link-date` + `data-wiki-date`). */
function dateChip(date = '2026-11-02'): ShimElement {
  const chip = new ShimElement('span');
  chip.className = 'wiki-link wiki-link-date';
  chip.setAttribute(WIKI_LINK_DATE_ATTR, date);
  // Шим `closest` ищет от родителя — отдаём сам узел на селектор ссылки.
  (chip as any).closest = (selector: string): ShimElement | null =>
    selector === '.wiki-link' ? chip : null;
  return chip;
}

/** Спан просмотра обычной ссылки (не дата). */
function thoughtLink(): ShimElement {
  const link = new ShimElement('span');
  link.className = 'wiki-link';
  (link as any).closest = (selector: string): ShimElement | null =>
    selector === '.wiki-link' ? link : null;
  return link;
}

/** Прогнать синтетический клик по зарегистрированным обработчикам. */
function click(target: unknown): void {
  const event = { target, defaultPrevented: false, preventDefault: () => undefined };
  for (const listener of listeners.filter((item) => item.type === 'click')) listener.fn(event);
}

before(() => {
  installDom();
  initWikiLinkNavigation();
});

beforeEach(() => {
  // Навигация по умолчанию ставит `openDayFromChip` — в тестах подменяем шпионом.
  setDateChipClickHandler((date) => dates.push(date));
});

afterEach(() => {
  dates.length = 0;
  setDateChipClickHandler(null);
  setLegacyWikiLinkClickHandler(null);
});

const dates: string[] = [];

describe('клик по date-чипу в просмотре открывает день (31fe2cc9)', () => {
  it('делегированный click отдаёт дату единому входу `clickDateChip`', () => {
    click(dateChip('2026-11-02'));
    assert.deepEqual(dates, ['2026-11-02'], 'обработчик дня получил ISO-дату чипа');
  });

  it('обычная wiki-ссылка клик по дате не вызывает', () => {
    click(thoughtLink());
    assert.deepEqual(dates, [], 'дата не подменяет переход по мысли');
  });

  it('отключённый обработчик дня — дата в мысль не превращается', () => {
    setDateChipClickHandler(null);
    click(dateChip('2026-11-03'));
    assert.deepEqual(dates, []);
  });

  it('чип-виджет live-preview (md-widget) в просмотре не переходит (M6)', () => {
    const chip = dateChip('2026-11-04');
    chip.className = 'md-widget wiki-link wiki-link-date';
    (chip as any).closest = (selector: string): unknown => {
      if (selector === '.wiki-link') return chip;
      if (selector === '.cm-editor') return new ShimElement('div');
      return null;
    };
    click(chip);
    assert.deepEqual(dates, [], 'виджет в редакторе раскрывает исходник, а не открывает день');
  });
});

describe('связка «обработчик по умолчанию → openChronicleDay»', () => {
  it('навигация регистрирует обработчик дня, и он открывает день', () => {
    // Регистрация проверяется ПОВЕДЕНИЕМ: без обработчика `clickDateChip`
    // возвращает `false`. Дата невалидна намеренно — реальный
    // `openChronicleDay` вышел бы в «Дневник», а юнит-тесту это не нужно.
    setDateChipClickHandler(null);
    resetWikiLinkNavigationForTests();
    initWikiLinkNavigation();
    assert.equal(clickDateChip('не-дата'), true, 'навигация поставила обработчик дня');

    // Поведение обработчика: дата уходит в открытие дня (шов `open`).
    const opened: string[] = [];
    openDayFromChip('2026-11-03', async (day) => {
      opened.push(day);
    });
    assert.deepEqual(opened, ['2026-11-03'], 'обработчик открывает ДЕНЬ чипа');

    // Вернуть шпион, чтобы порядок тестов файла не зависел от этого блока.
    setDateChipClickHandler((date) => dates.push(date));
  });
});
