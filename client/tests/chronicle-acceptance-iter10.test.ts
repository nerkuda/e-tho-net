/**
 * Итерация приёмки №10 (0.10.1), задача 197b3b05 — интеракционные тесты
 * четырёх пунктов чек-листа на контроллере `feed-nav.ts` (DOM-шим, симуляция
 * клавиш и кликов) и на чистой логике экрана.
 *
 * 1. Повторяющиеся записи (ошибка 7af3101e): единица навигации и клика —
 *    вхождение «день + запись»; стрелки выбирают копию в группе текущего дня,
 *    клик выделяет нажатую копию, граница ленты считается по вхождениям.
 * 2. Поля записи (ошибка 02b4d513): Enter входит в поля (первое — дата/период),
 *    Tab/Shift+Tab ходят дата → мысли → заголовок → комментарий, Enter —
 *    действие поля, Esc/клик вне — выход из режима полей.
 * 3. Поле комментария достижимо Tab-ом, Enter на нём — вход в правку
 *    (проверяется здесь и в iter9 обновлённым сценарием полей).
 * 4. Вставка картинок из буфера (ошибка 8f090884): цель вложения — первая
 *    привязанная мысль записи, иначе HOME; поле правки записи получает
 *    `attachmentsOwner`.
 *
 * Требование 165323a7 актуализировано ДО кода (итерация №10).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { ChronicleTarget, ThoughtRef } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

// ---------------------------------------------------------------------------
// Каркас ленты на DOM-шиме
// ---------------------------------------------------------------------------

interface FakeFeed {
  root: ShimElement;
  section(day: string): ShimElement;
  cardIn(day: string, id: string): ShimElement;
  date(id: string): ShimElement;
  body(id: string): ShimElement;
}

function buildFeed(spec: Array<{ day: string; records: string[] }>): FakeFeed {
  const root = new ShimElement('div', 'chron-feed-wrap');
  const list = new ShimElement('div', 'chron-feed');
  root.append(list);
  for (const day of spec) {
    const section = new ShimElement('div', 'diary-day');
    section.setAttribute('data-day', day.day);
    const head = new ShimElement('button', 'diary-day-head');
    const dayList = new ShimElement('div', 'diary-day-list');
    for (const id of day.records) {
      const card = new ShimElement('div', 'diary-record');
      card.setAttribute('data-row-key', id);
      const cardHead = new ShimElement('div', 'diary-record-head');
      cardHead.append(new ShimElement('button', 'diary-record-date'));
      cardHead.append(new ShimElement('div', 'diary-record-chips'));
      const title = new ShimElement('input', 'diary-record-title');
      const body = new ShimElement('div', 'diary-record-body');
      card.append(cardHead, title, body);
      dayList.append(card);
    }
    section.append(head, dayList);
    list.append(section);
  }
  const sectionOf = (day: string): ShimElement =>
    root.querySelectorAll('.diary-day').find((s) => s.getAttribute('data-day') === day)!;
  return {
    root,
    section: sectionOf,
    cardIn: (day, id) =>
      sectionOf(day).querySelectorAll('.diary-record').find((c) => c.getAttribute('data-row-key') === id)!,
    date: (id) => root.querySelectorAll('.diary-record').find((c) => c.getAttribute('data-row-key') === id)!.querySelector('.diary-record-date')!,
    body: (id) => root.querySelectorAll('.diary-record').find((c) => c.getAttribute('data-row-key') === id)!.querySelector('.diary-record-body')!,
  };
}

async function navModule(): Promise<typeof import('../src/renderer/screens/chronicle/feed-nav.js')> {
  return import('../src/renderer/screens/chronicle/feed-nav.js');
}

function press(root: ShimElement, key: string, target?: ShimElement, shift = false): void {
  root.emit('keydown', {
    key,
    shiftKey: shift,
    target: target ?? root,
    preventDefault: () => undefined,
  });
}

// ---------------------------------------------------------------------------
// П.1 — повторяющиеся записи: вхождение «день + запись»
// ---------------------------------------------------------------------------

describe('приёмка №10, п.1: навигация различает копии повторяющейся записи', () => {
  it('стрелки идут по вхождениям, а не по первой копии id', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['long'] },
      { day: '2026-09-10', records: ['long'] },
    ]);
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown'); // группа 09-11
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' });
    press(feed.root, 'ArrowDown'); // вхождение записи в 09-11
    assert.deepEqual(handle.current(), { kind: 'record', key: 'long' });
    assert.ok(
      feed.cardIn('2026-09-11', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'выделена копия в группе 09-11',
    );
    assert.ok(
      !feed.cardIn('2026-09-10', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'копия 09-10 не выделена',
    );

    press(feed.root, 'ArrowDown'); // группа 09-10
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-10' });
    press(feed.root, 'ArrowDown'); // вхождение записи в 09-10
    assert.deepEqual(handle.current(), { kind: 'record', key: 'long' });
    assert.ok(
      feed.cardIn('2026-09-10', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'выделена копия в группе 09-10',
    );
    assert.ok(
      !feed.cardIn('2026-09-11', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'копия 09-11 потеряла выделение',
    );

    // Граница ленты: последнее вхождение — «вниз» ничего не меняет (регресс
    // старого поведения: по id навигация вернулась бы к первой копии).
    press(feed.root, 'ArrowDown');
    assert.ok(
      feed.cardIn('2026-09-10', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'на границе выделение не уехало к первой копии',
    );

    press(feed.root, 'ArrowUp');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-10' });
  });

  it('клик выделяет нажатую копию, а не первую', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['long'] },
      { day: '2026-09-10', records: ['long'] },
    ]);
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    feed.root.emit('click', { target: feed.cardIn('2026-09-10', 'long') });
    assert.deepEqual(handle.current(), { kind: 'record', key: 'long' });
    assert.ok(
      feed.cardIn('2026-09-10', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'выделена нажатая копия',
    );
    assert.ok(
      !feed.cardIn('2026-09-11', 'long').classList.contains(FEED_NAV_CURRENT_CLASS),
      'первая копия не выделена',
    );
  });
});

// ---------------------------------------------------------------------------
// П.2/П.3 — поля записи: Tab/Shift+Tab, комментарий, выход Esc/кликом
// ---------------------------------------------------------------------------

describe('приёмка №10, п.2–3: режим полей записи', () => {
  it('клик вне записи выходит из режима полей, выделение записи цело', async () => {
    const { attachFeedNav, FEED_NAV_ELEMENT_CLASS, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // запись
    press(feed.root, 'Enter'); // вход в поля
    assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS));

    feed.root.emit('click', { target: feed.root }); // клик вне записи и группы
    assert.ok(
      !feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
      'выделение поля снято',
    );
    assert.ok(
      feed.cardIn('2026-09-11', 'r1').classList.contains(FEED_NAV_CURRENT_CLASS),
      'запись осталась текущей «единой строкой»',
    );
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });
  });

  it('клик вне ленты снимает режим полей; клик по полю записи — не снимает', async () => {
    // Документ-шим: feed-nav вешает на документ перехват «клик вне ленты».
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((fn) => fn !== handler);
      },
    };
    try {
      const { attachFeedNav, FEED_NAV_ELEMENT_CLASS, FEED_NAV_CURRENT_CLASS } = await navModule();
      const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
      const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
        onSetDayCollapsed: () => undefined,
        onEditBody: () => undefined,
      });
      press(feed.root, 'ArrowDown');
      press(feed.root, 'ArrowDown'); // запись
      press(feed.root, 'Enter'); // режим полей → дата
      assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS));

      // Клик по полю ТЕКУЩЕЙ записи режим полей не сбрасывает.
      feed.root.emit('click', { target: feed.date('r1') });
      assert.ok(
        feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
        'клик по полю записи сохранил режим полей',
      );
      assert.ok(feed.cardIn('2026-09-11', 'r1').classList.contains(FEED_NAV_CURRENT_CLASS));

      // Клик вне ленты (календарь/панель отбора) — выход из режима полей.
      const calendar = new ShimElement('button', 'chron-cal-day');
      for (const dispatch of listeners['click'] ?? []) dispatch({ target: calendar });
      assert.ok(
        !feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
        'клик вне ленты снял режим полей',
      );
      assert.ok(
        feed.cardIn('2026-09-11', 'r1').classList.contains(FEED_NAV_CURRENT_CLASS),
        'выделение записи сохранено',
      );
      assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });

      // destroy снимает слушатель документа.
      handle.destroy();
      assert.equal((listeners['click'] ?? []).length, 0, 'слушатель документа снят');
    } finally {
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
    }
  });

  it('Tab не входит в поля до Enter, а после Esc снова обычная навигация', async () => {
    const { attachFeedNav } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1', 'r2'] }]);
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // r1
    press(feed.root, 'Tab'); // без режима полей Tab навигацию не двигает
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' }, 'Tab вне режима полей проигнорирован');
  });

  it('Enter на комментарии входит в правку (достижим Tab-ом)', async () => {
    const { attachFeedNav } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const edits: string[] = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: (id) => edits.push(id),
    });
    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown');
    press(feed.root, 'Enter'); // поля → дата
    press(feed.root, 'Tab');
    press(feed.root, 'Tab');
    press(feed.root, 'Tab'); // комментарий
    press(feed.root, 'Enter');
    assert.deepEqual(edits, ['r1'], 'Enter на поле комментария открывает правку');
  });
});

// ---------------------------------------------------------------------------
// П.4 — вставка картинок: владелец вложения
// ---------------------------------------------------------------------------

describe('приёмка №10, п.4: владелец вложения для вставки из буфера', () => {
  const thought = (id: string): ChronicleTarget =>
    ({ kind: 'thought', thought: { id, title: id } as ThoughtRef }) as ChronicleTarget;
  const link = (): ChronicleTarget => ({ kind: 'link', link: {} }) as unknown as ChronicleTarget;

  it('первая привязанная мысль (первый thought-чипс), HOME не в счёт', async () => {
    const { attachmentOwnerForRow } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    assert.deepEqual(
      attachmentOwnerForRow([thought('home'), thought('a'), thought('b')], 'home'),
      { ownerType: 'thought', ownerId: 'a' },
      'первый видимый thought-чипс',
    );
  });

  it('после HOME первым идёт чипс-связь: мысль выбирается среди привязок', async () => {
    const { attachmentOwnerForRow } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    assert.deepEqual(
      attachmentOwnerForRow([thought('home'), link(), thought('b')], 'home'),
      { ownerType: 'thought', ownerId: 'b' },
      'связь пропускается, берётся мысль',
    );
  });

  it('нет привязок-мыслей — цель HOME; нет и HOME — null', async () => {
    const { attachmentOwnerForRow } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    assert.deepEqual(attachmentOwnerForRow([thought('home')], 'home'), {
      ownerType: 'thought',
      ownerId: 'home',
    });
    assert.deepEqual(attachmentOwnerForRow([thought('home'), link()], 'home'), {
      ownerType: 'thought',
      ownerId: 'home',
    });
    assert.equal(attachmentOwnerForRow([], null), null);
  });

  it('поле правки записи получает attachmentsOwner, псевдо-запись — тоже', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'chronicle', 'chronicle.ts'),
      'utf8',
    );
    assert.match(src, /attachmentOwnerForRow\(row\.targets, homeId\)/, 'владелец считается помощником');
    assert.match(src, /\.\.\.\(owner !== null \? \{ attachmentsOwner: owner \} : \{\}\)/, 'поле записи получает владельца');
    assert.match(
      src,
      /attachmentsOwner: \{ ownerType: 'thought' as const, ownerId: slotOwnerId \}/,
      'псевдо-запись тоже умеет вставлять файлы',
    );
  });

  it('экран подключает навигацию к диалогу даты и выбору мысли', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'chronicle', 'chronicle.ts'),
      'utf8',
    );
    assert.match(src, /onEditDates: \(_id, card\) => editCardDates\(card\)/, 'Enter на дате открывает диалог');
    assert.match(src, /onAddThought: \(id\) => void pickAndAttach\(id\)/, 'Enter на мыслях открывает выбор');
  });
});
