/**
 * Клавиатурная навигация по сворачиваемой записи «Дневника» (0.10.2, задача
 * 41ed99ab, требование 165323a7 в новой редакции): ←/→ на поле «заголовок» в
 * просмотре сворачивают/разворачивают ТЕЛО записи и оставляют фокус на
 * заголовке; поле «комментарий» доступно только у развёрнутой записи (Tab с
 * заголовка в свёрнутой уходит на «дата/период»); Enter на заголовке входит в
 * правку заголовка.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachFeedNav,
  FEED_NAV_ELEMENT_CLASS,
} from '../src/renderer/screens/chronicle/feed-nav.js';
import { applyRecordCollapsed } from '../src/renderer/screens/chronicle/record-groups.js';
import { ShimElement } from './dom-shim.js';

interface Feed {
  root: ShimElement;
  card: ShimElement;
  title: ShimElement;
  body: ShimElement;
  date: ShimElement;
}

function buildFeed(collapsed = false): Feed {
  const root = new ShimElement('div', 'chron-feed-wrap');
  const section = new ShimElement('div', 'diary-day');
  section.setAttribute('data-day', '2026-09-11');
  const list = new ShimElement('div', 'diary-day-list');
  const card = new ShimElement('div', 'diary-record');
  card.setAttribute('data-row-key', 'r1');
  const head = new ShimElement('div', 'diary-record-head');
  const date = new ShimElement('button', 'diary-record-date');
  const chips = new ShimElement('div', 'diary-record-chips');
  const add = new ShimElement('button', 'diary-chip-add');
  const title = new ShimElement('button', 'diary-record-title');
  const body = new ShimElement('div', 'diary-record-body');
  head.append(date, chips, add);
  card.append(head, title, body);
  if (collapsed) {
    applyRecordCollapsed(card as unknown as HTMLElement, true, {
      collapse: 'Свернуть',
      expand: 'Развернуть',
    });
  }
  list.append(card);
  section.append(list);
  root.append(section);
  return { root, card, title, body, date };
}

function press(root: ShimElement, key: string, shift = false): void {
  root.emit('keydown', {
    key,
    shiftKey: shift,
    target: root,
    preventDefault: () => undefined,
  });
}

/** Дойти стрелками до записи и войти в режим полей (курсор на «дата/период»). */
function enterRecord(root: ShimElement): void {
  press(root, 'ArrowDown'); // группа дня
  press(root, 'ArrowDown'); // запись
  press(root, 'Enter'); // режим полей — дата/период
}

/** Дойти до поля «заголовок» (дата → мысли → заголовок). */
function toTitle(root: ShimElement): void {
  enterRecord(root);
  press(root, 'Tab'); // мысли
  press(root, 'Tab'); // заголовок
}

describe('навигация по сворачиваемой записи (задача 41ed99ab, пп.3, 5)', () => {
  it('← на заголовке сворачивает тело, фокус остаётся на заголовке', () => {
    const feed = buildFeed();
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    assert.ok(feed.title.classList.contains(FEED_NAV_ELEMENT_CLASS), 'текущее поле — заголовок');

    press(feed.root, 'ArrowLeft');
    assert.deepEqual(calls, [['2026-09-11', 'r1', true]], 'запрос свернуть тело');
    // Экран сворачивает на месте — имитируем и убеждаемся, что фокус на заголовке.
    applyRecordCollapsed(feed.card as unknown as HTMLElement, true, {
      collapse: 'Свернуть',
      expand: 'Развернуть',
    });
    assert.equal(feed.title.focused, true, 'фокус остался на заголовке');
  });

  it('→ на заголовке разворачивает тело', () => {
    const feed = buildFeed(true);
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    press(feed.root, 'ArrowRight');
    assert.deepEqual(calls, [['2026-09-11', 'r1', false]], 'запрос развернуть тело');
  });

  it('в свёрнутой записи Tab с заголовка уходит на «дата/период» (тело недоступно)', () => {
    const feed = buildFeed(true);
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    press(feed.root, 'Tab');
    assert.ok(feed.date.classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab вернулся на дату');
    assert.ok(!feed.body.classList.contains(FEED_NAV_ELEMENT_CLASS));
  });

  it('в развёрнутой записи Tab с заголовка идёт в тело комментария', () => {
    const feed = buildFeed();
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    press(feed.root, 'Tab');
    assert.ok(feed.body.classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab перешёл в тело');
  });

  it('Enter на заголовке входит в правку заголовка', () => {
    const feed = buildFeed();
    const edited: string[] = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: () => undefined,
      onEditTitle: (id) => edited.push(id),
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    press(feed.root, 'Enter');
    assert.deepEqual(edited, ['r1'], 'экран получил команду правки заголовка');
  });
});
