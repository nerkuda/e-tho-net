/**
 * Клавиатурная навигация по сворачиваемой записи «Дневника» (0.10.2, задача
 * 41ed99ab, требование 165323a7 в новой редакции): Ctrl+↑/↓ на поле «заголовок»
 * в просмотре сворачивают/разворачивают ТЕЛО записи и оставляют фокус на
 * заголовке; поле «комментарий» доступно только у развёрнутой записи (Tab с
 * заголовка в свёрнутой уходит на «дата/период»); Enter на заголовке входит в
 * правку заголовка. Прежняя роль ←/→ перешла к Ctrl+↑/↓ (решение пользователя
 * 2026-10-25): ←/→ в одноколоночной ленте соседей не имеют и не перехватываются.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  attachFeedNav,
  FEED_NAV_CURRENT_CLASS,
  FEED_NAV_ELEMENT_CLASS,
} from '../src/renderer/screens/chronicle/feed-nav.js';
import { applyRecordCollapsed } from '../src/renderer/screens/chronicle/record-groups.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура ленты — через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

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

function press(root: ShimElement, key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  root.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: modifiers.ctrlKey === true,
    shiftKey: modifiers.shiftKey === true,
    target: root,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
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
  it('Ctrl+↑ на заголовке сворачивает тело, фокус остаётся на заголовке', () => {
    const feed = buildFeed();
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    assert.ok(feed.title.classList.contains(FEED_NAV_ELEMENT_CLASS), 'текущее поле — заголовок');

    // Обычная ← в одноколоночной ленте соседей не имеет — событие не наше.
    press(feed.root, 'ArrowLeft');
    assert.deepEqual(calls, [], 'обычная ← свёрнутость не трогает');

    press(feed.root, 'ArrowUp', { ctrlKey: true });
    assert.deepEqual(calls, [['2026-09-11', 'r1', true]], 'запрос свернуть тело');
    // Экран сворачивает на месте — имитируем и убеждаемся, что фокус на заголовке.
    applyRecordCollapsed(feed.card as unknown as HTMLElement, true, {
      collapse: 'Свернуть',
      expand: 'Развернуть',
    });
    assert.equal(feed.title.focused, true, 'фокус остался на заголовке');
  });

  it('Ctrl+↓ на заголовке разворачивает тело', () => {
    const feed = buildFeed(true);
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });
    toTitle(feed.root);
    press(feed.root, 'ArrowRight');
    assert.deepEqual(calls, [], 'обычная → свёрнутость не трогает');
    press(feed.root, 'ArrowDown', { ctrlKey: true });
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

// ---------------------------------------------------------------------------
// Задача 9cdede6b: Ctrl+↑/↓ сворачивают запись ЦЕЛИКОМ из навигации по ленте
// (прежняя роль ←/→ — решение пользователя 2026-10-25)
// ---------------------------------------------------------------------------

const LABELS = { collapse: 'Свернуть', expand: 'Развернуть' };

interface Feed2 {
  root: ShimElement;
  card: (id: string) => ShimElement;
  title: (id: string) => ShimElement;
  body: (id: string) => ShimElement;
  date: (id: string) => ShimElement;
  chips: (id: string) => ShimElement;
}

/** Лента дня с двумя записями — чтобы проверить и переход ↓ после ←/→. */
function buildFeed2(): Feed2 {
  const root = new ShimElement('div', 'chron-feed-wrap');
  const section = new ShimElement('div', 'diary-day');
  section.setAttribute('data-day', '2026-09-11');
  const head = new ShimElement('button', 'diary-day-head');
  const list = new ShimElement('div', 'diary-day-list');
  for (const id of ['r1', 'r2']) {
    const card = new ShimElement('div', 'diary-record');
    card.setAttribute('data-row-key', id);
    const cardHead = new ShimElement('div', 'diary-record-head');
    cardHead.append(new ShimElement('button', 'diary-record-date'));
    cardHead.append(new ShimElement('div', 'diary-record-chips'));
    cardHead.append(new ShimElement('button', 'diary-chip-add'));
    const title = new ShimElement('button', 'diary-record-title');
    const body = new ShimElement('div', 'diary-record-body');
    card.append(cardHead, title, body);
    list.append(card);
  }
  section.append(head, list);
  root.append(section);
  const cardOf = (id: string): ShimElement =>
    root.querySelectorAll('.diary-record').find((c) => c.getAttribute('data-row-key') === id)!;
  return {
    root,
    card: cardOf,
    title: (id) => cardOf(id).querySelector('.diary-record-title')!,
    body: (id) => cardOf(id).querySelector('.diary-record-body')!,
    date: (id) => cardOf(id).querySelector('.diary-record-date')!,
    chips: (id) => cardOf(id).querySelector('.diary-chip-add')!,
  };
}

/** Нажатие с произвольной целью (для проверки режима правки текста). */
function pressKey(
  root: ShimElement,
  key: string,
  target?: ShimElement,
  modifiers: { ctrlKey?: boolean } = {},
): void {
  root.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: modifiers.ctrlKey === true,
    shiftKey: false,
    target: target ?? root,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
}

describe('запись целиком: Ctrl+↑/↓ сворачивают/разворачивают из навигации (9cdede6b)', () => {
  it('↑/↓ выделяет запись; Ctrl+↑ сворачивает тело, Ctrl+↓ разворачивает — без входа в поля', () => {
    const feed = buildFeed2();
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown'); // группа дня
    press(feed.root, 'ArrowDown'); // запись r1 — выделена целиком
    assert.ok(
      feed.card('r1').classList.contains(FEED_NAV_CURRENT_CLASS),
      'запись выделена стрелками',
    );
    // Режим полей НЕ активен — ни одно поле не подсвечено.
    assert.ok(
      !feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
      'входа в поля не было',
    );

    // Числа до: тело видимо, карточка не свёрнута.
    assert.equal(feed.body('r1').hidden, false, 'до Ctrl+↑ тело видимо');
    assert.equal(feed.card('r1').classList.contains('is-collapsed'), false);

    const bodyNode = feed.body('r1');
    press(feed.root, 'ArrowLeft'); // обычная ← — соседей нет, свёрнутость не трогает
    assert.deepEqual(calls, [], 'обычная ← свёрнутость не трогает');
    press(feed.root, 'ArrowUp', { ctrlKey: true });
    assert.deepEqual(calls, [['2026-09-11', 'r1', true]], 'запрос свернуть тело записи');
    // Экран сворачивает на месте — имитируем и сверяем числа.
    applyRecordCollapsed(feed.card('r1') as unknown as HTMLElement, true, LABELS);
    assert.equal(feed.body('r1').hidden, true, 'после Ctrl+↑ тело скрыто');
    assert.equal(feed.card('r1').classList.contains('is-collapsed'), true, 'карточка свёрнута');
    assert.equal(feed.body('r1'), bodyNode, 'тело — тот же узел (переключение на месте)');

    press(feed.root, 'ArrowDown', { ctrlKey: true });
    assert.deepEqual(calls[1], ['2026-09-11', 'r1', false], 'запрос развернуть тело записи');
    applyRecordCollapsed(feed.card('r1') as unknown as HTMLElement, false, LABELS);
    assert.equal(feed.body('r1').hidden, false, 'после Ctrl+↓ тело снова видимо');
    assert.equal(feed.card('r1').classList.contains('is-collapsed'), false);
  });

  it('после Ctrl+↑/↓ выделение остаётся на записи, ↓ двигает его дальше (фокус не потерян)', () => {
    const feed = buildFeed2();
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (_day, _id, collapsed) =>
        applyRecordCollapsed(feed.card('r1') as unknown as HTMLElement, collapsed, LABELS),
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // r1
    press(feed.root, 'ArrowUp', { ctrlKey: true }); // свернуть r1 целиком
    assert.ok(
      feed.card('r1').classList.contains(FEED_NAV_CURRENT_CLASS),
      'выделение осталось на r1',
    );
    assert.equal(feed.title('r1').focused, true, 'фокус остался в ленте (на заголовке r1)');

    press(feed.root, 'ArrowDown'); // следующая запись
    assert.ok(
      feed.card('r2').classList.contains(FEED_NAV_CURRENT_CLASS),
      '↓ после Ctrl+↑/↓ двигает выделение дальше',
    );
    assert.ok(!feed.card('r1').classList.contains(FEED_NAV_CURRENT_CLASS));
  });

  it('на прочих полях записи (дата/период, мысли) Ctrl+↑/↓ свёрнутость не трогают', () => {
    const feed = buildFeed2();
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // r1
    press(feed.root, 'Enter'); // режим полей → дата/период
    assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS));

    press(feed.root, 'ArrowUp', { ctrlKey: true });
    press(feed.root, 'ArrowDown', { ctrlKey: true });
    assert.deepEqual(calls, [], 'на поле «дата/период» сочетания свёрнутость не трогают');

    press(feed.root, 'Tab'); // мысли
    assert.ok(feed.chips('r1').classList.contains(FEED_NAV_ELEMENT_CLASS));
    press(feed.root, 'ArrowUp', { ctrlKey: true });
    assert.deepEqual(calls, [], 'на поле «мысли» сочетания свёрнутость не трогают');

    press(feed.root, 'Tab'); // заголовок
    press(feed.root, 'ArrowUp', { ctrlKey: true });
    assert.deepEqual(
      calls,
      [['2026-09-11', 'r1', true]],
      'на поле «заголовок» прежнее поведение сохранено (Ctrl+↑)',
    );
  });

  it('в правке текста Ctrl+↑/↓ и ←/→ принадлежат редактору — лента молчит', () => {
    const feed = buildFeed2();
    const calls: Array<[string, string, boolean]> = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onSetRecordCollapsed: (day, id, collapsed) => calls.push([day, id, collapsed]),
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // r1
    const input = new ShimElement('input', 'diary-record-title-input');
    pressKey(feed.root, 'ArrowLeft', input);
    pressKey(feed.root, 'ArrowRight', input);
    pressKey(feed.root, 'ArrowUp', input, { ctrlKey: true });
    pressKey(feed.root, 'ArrowDown', input, { ctrlKey: true });
    assert.deepEqual(calls, [], 'в поле правки сочетания не сворачивают запись');
  });
});
