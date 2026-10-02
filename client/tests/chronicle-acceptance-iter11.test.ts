/**
 * Итерация приёмки №11 (0.10.1), задача 45df70ed — интеракционные тесты трёх
 * клиентских пунктов чек-листа на DOM-шиме (симуляция клавиш/кликов) плюс
 * поведенческие тесты новых помощников.
 *
 * 1. Поле «мысли» по Tab (ошибка 02b4d513): после Enter на записи Tab выделяет
 *    САМУ кнопку «+ мысль» (`.diary-chip-add`), а не пустую область-контейнер.
 * 2. Клавиатура после разворачивания группы (ошибка ab78e7b5): после
 *    перерисовки ленты (в т.ч. in-place сворачивания/разворачивания) фокус
 *    возвращается к текущей сущности, стрелки снова двигают выделение
 *    (требование 165323a7, «Устойчивость»).
 * 3. Прокрутка (ошибка 407b1827): сворачивание/разворачивание группы меняет
 *    ленту НА МЕСТЕ (узлы не пересобираются), а перерисовка с сохранением
 *    прокрутки не сбрасывает позицию (`preserveScroll`, lib/ui/scroll-anchor.ts).
 *
 * Требование 165323a7 актуализировано ДО кода (итерация №11).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDayCollapsed, findDaySection } from '../src/renderer/screens/chronicle/day-groups.js';
import { preserveScroll } from '../src/renderer/lib/ui/scroll-anchor.js';
import { ShimElement } from './dom-shim.js';

// ---------------------------------------------------------------------------
// Каркас ленты на DOM-шиме
// ---------------------------------------------------------------------------

interface FakeFeed {
  root: ShimElement;
  /** Пересобрать секции дней заново (имитация полной перерисовки ленты). */
  render(): void;
  section(day: string): ShimElement;
  cardIn(day: string, id: string): ShimElement;
  date(id: string): ShimElement;
  addThought(id: string): ShimElement;
  chipsBox(id: string): ShimElement;
  body(id: string): ShimElement;
}

interface DaySpec {
  day: string;
  records: string[];
  collapsed?: boolean;
}

function buildFeed(spec: DaySpec[]): FakeFeed {
  const root = new ShimElement('div', 'chron-feed-wrap');
  const list = new ShimElement('div', 'chron-feed');
  root.append(list);

  const buildSections = (): void => {
    list.replaceChildren();
    for (const day of spec) {
      const section = new ShimElement('div', 'diary-day');
      section.setAttribute('data-day', day.day);
      if (day.collapsed === true) section.classList.add('is-collapsed');
      const head = new ShimElement('button', 'diary-day-head');
      const dayList = new ShimElement('div', 'diary-day-list');
      dayList.hidden = day.collapsed === true;
      for (const id of day.records) {
        const card = new ShimElement('div', 'diary-record');
        card.setAttribute('data-row-key', id);
        const cardHead = new ShimElement('div', 'diary-record-head');
        cardHead.append(
          new ShimElement('button', 'diary-record-date'),
          new ShimElement('div', 'diary-record-chips'),
          new ShimElement('button', 'diary-chip-add'),
        );
        card.append(
          cardHead,
          new ShimElement('input', 'diary-record-title'),
          new ShimElement('div', 'diary-record-body'),
        );
        dayList.append(card);
      }
      section.append(head, dayList);
      list.append(section);
    }
  };
  buildSections();

  const sectionOf = (day: string): ShimElement =>
    root.querySelectorAll('.diary-day').find((s) => s.getAttribute('data-day') === day)!;
  const cardOf = (id: string): ShimElement =>
    root.querySelectorAll('.diary-record').find((c) => c.getAttribute('data-row-key') === id)!;
  const inCard = (id: string, selector: string): ShimElement => cardOf(id).querySelector(selector)!;
  return {
    root,
    render: buildSections,
    section: sectionOf,
    cardIn: (day, id) =>
      sectionOf(day)
        .querySelectorAll('.diary-record')
        .find((c) => c.getAttribute('data-row-key') === id)!,
    date: (id) => inCard(id, '.diary-record-date'),
    addThought: (id) => inCard(id, '.diary-chip-add'),
    chipsBox: (id) => inCard(id, '.diary-record-chips'),
    body: (id) => inCard(id, '.diary-record-body'),
  };
}

function press(root: ShimElement, key: string, target?: ShimElement, shift = false): void {
  root.emit('keydown', {
    key,
    shiftKey: shift,
    target: target ?? root,
    preventDefault: () => undefined,
  });
}

async function navModule(): Promise<typeof import('../src/renderer/screens/chronicle/feed-nav.js')> {
  return import('../src/renderer/screens/chronicle/feed-nav.js');
}

/** Временно подменить глобальный `document` (feed-nav читает его при подключении). */
function withDocument<T>(activeElement: unknown, run: () => T): T {
  const prev = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    activeElement,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  try {
    return run();
  } finally {
    if (prev === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = prev;
  }
}

// ---------------------------------------------------------------------------
// П.1 — поле «мысли» по Tab: сама кнопка «+ мысль»
// ---------------------------------------------------------------------------

describe('приёмка №11, п.1: Tab выделяет кнопку «+ мысль» (02b4d513)', () => {
  it('Enter на записи → Tab: выделена кнопка «+ мысль», а не контейнер', async () => {
    const { attachFeedNav, FEED_NAV_ELEMENT_CLASS } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const added: string[] = [];
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
      onAddThought: (id) => added.push(id),
    });

    press(feed.root, 'ArrowDown'); // группа дня
    press(feed.root, 'ArrowDown'); // запись
    press(feed.root, 'Enter'); // вход в поля → дата/период
    assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'выделена дата');

    press(feed.root, 'Tab'); // → мысли
    assert.ok(
      feed.addThought('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
      'выделена сама кнопка «+ мысль»',
    );
    assert.ok(
      !feed.chipsBox('r1').classList.contains(FEED_NAV_ELEMENT_CLASS),
      'пустой контейнер привязок не выделен',
    );

    press(feed.root, 'Enter'); // Enter на поле «мысли» — выбор мысли
    assert.deepEqual(added, ['r1'], 'Enter на кнопке открывает выбор мысли');
  });

  it('Tab и Shift+Tab ходят по кругу: дата → мысли → заголовок → комментарий', async () => {
    const { attachFeedNav, FEED_NAV_ELEMENT_CLASS } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown');
    press(feed.root, 'Enter'); // дата
    const has = (el: ShimElement): boolean => el.classList.contains(FEED_NAV_ELEMENT_CLASS);

    press(feed.root, 'Tab');
    assert.ok(has(feed.addThought('r1')), 'мысли');
    press(feed.root, 'Tab');
    assert.ok(has(feed.cardIn('2026-09-11', 'r1').querySelector('.diary-record-title')!), 'заголовок');
    press(feed.root, 'Tab');
    assert.ok(has(feed.body('r1')), 'комментарий');
    press(feed.root, 'Tab');
    assert.ok(has(feed.date('r1')), 'по кругу — снова дата');

    press(feed.root, 'Tab', undefined, true); // Shift+Tab → комментарий
    assert.ok(has(feed.body('r1')), 'Shift+Tab вернулся к комментарию');
  });
});

// ---------------------------------------------------------------------------
// П.2 — навигация после перерисовки ленты
// ---------------------------------------------------------------------------

describe('приёмка №11, п.2: после перерисовки стрелки снова двигают выделение (ab78e7b5)', () => {
  it('полная перерисовка: refresh возвращает фокус к текущей сущности, стрелки работают', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1'] },
      { day: '2026-09-10', records: ['r2'] },
    ]);
    await withDocument(null, async () => {
      const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
        onSetDayCollapsed: () => undefined,
        onEditBody: () => undefined,
      });

      press(feed.root, 'ArrowDown'); // текущая — группа 2026-09-11
      assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' });

      // Полная перерисовка ленты: прежние узлы (и фокус на них) уничтожены.
      feed.render();
      handle.refresh();

      const head = feed.section('2026-09-11').querySelector('.diary-day-head')!;
      assert.ok(
        head.classList.contains(FEED_NAV_CURRENT_CLASS),
        'выделение текущей группы переприменено',
      );
      assert.ok(head.focused, 'фокус вернулся в ленту к текущей сущности');

      // Навигация продолжается тем же видимым порядком.
      press(feed.root, 'ArrowDown');
      assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });
    });
  });

  it('in-place разворачивание группы: узлы не пересобираются, стрелки идут дальше', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1'], collapsed: true },
      { day: '2026-09-10', records: ['r2'] },
    ]);
    const toggles: Array<[string, boolean]> = [];
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: (day, collapsed) => toggles.push([day, collapsed]),
      onEditBody: () => undefined,
    });
    press(feed.root, 'ArrowDown'); // текущая — свёрнутая группа 2026-09-11
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' });
    const headRef = feed.section('2026-09-11').querySelector('.diary-day-head')!;

    press(feed.root, 'Enter'); // Enter — развернуть группу
    assert.deepEqual(toggles, [['2026-09-11', false]], 'экран получил команду развернуть');

    // Экран делает это НА МЕСТЕ и переприменяет выделение — имитируем.
    applyDayCollapsed(feed.section('2026-09-11') as unknown as HTMLElement, false, {
      expand: 'Развернуть',
      collapse: 'Свернуть',
    });
    handle.refresh();
    assert.ok(
      feed.section('2026-09-11').querySelector('.diary-day-head') === headRef,
      'узел заголовка не заменён (in-place)',
    );
    assert.ok(headRef.classList.contains(FEED_NAV_CURRENT_CLASS), 'группа осталась текущей');

    press(feed.root, 'ArrowDown'); // теперь запись развёрнутой группы
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });
  });

  it('клик вне ленты гасит навигацию: refresh не тянет фокус обратно', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    const prev = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      activeElement: null,
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((fn) => fn !== handler);
      },
    };
    try {
      const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
        onSetDayCollapsed: () => undefined,
        onEditBody: () => undefined,
      });
      press(feed.root, 'ArrowDown');
      // Клик по календарю (вне ленты) приходит документному перехватчику.
      const calendar = new ShimElement('button', 'chron-cal-day');
      for (const dispatch of listeners['click'] ?? []) dispatch({ target: calendar });

      feed.render();
      const head = feed.section('2026-09-11').querySelector('.diary-day-head')!;
      head.focused = false;
      handle.refresh();
      assert.ok(head.classList.contains(FEED_NAV_CURRENT_CLASS), 'выделение сохранено');
      assert.equal(head.focused, false, 'фокус не украден у другой панели');

      handle.destroy();
      assert.equal((listeners['click'] ?? []).length, 0, 'слушатель документа снят');
    } finally {
      if (prev === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// П.3 — сворачивание/разворачивание НА МЕСТЕ и сохранение прокрутки
// ---------------------------------------------------------------------------

describe('приёмка №11, п.3: группа переключается на месте, прокрутка сохраняется', () => {
  it('applyDayCollapsed: узлы не заменяются, классы/hidden/aria согласованы', () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const section = feed.section('2026-09-11');
    const headRef = section.querySelector('.diary-day-head')!;
    const listRef = section.querySelector('.diary-day-list')!;
    const labels = { expand: 'Развернуть', collapse: 'Свернуть' };

    applyDayCollapsed(section as unknown as HTMLElement, true, labels);
    assert.ok(section.classList.contains('is-collapsed'), 'секция свёрнута');
    assert.ok(headRef.classList.contains('is-collapsed'), 'заголовок помечен свёрнутым');
    assert.equal(listRef.hidden, true, 'список скрыт');
    assert.equal(headRef.getAttribute('aria-expanded'), 'false', 'aria-expanded = false');
    assert.equal(headRef.title, 'Развернуть', 'подсказка «Развернуть»');

    assert.ok(section.querySelector('.diary-day-head') === headRef, 'тот же узел заголовка');
    assert.ok(section.querySelector('.diary-day-list') === listRef, 'тот же узел списка');

    applyDayCollapsed(section as unknown as HTMLElement, false, labels);
    assert.ok(!section.classList.contains('is-collapsed'), 'секция развёрнута');
    assert.equal(listRef.hidden, false, 'список показан');
    assert.equal(headRef.getAttribute('aria-expanded'), 'true', 'aria-expanded = true');
    assert.equal(headRef.title, 'Свернуть', 'подсказка «Свернуть»');
  });

  it('findDaySection находит секцию по ключу дня', () => {
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1'] },
      { day: '2026-09-10', records: ['r2'] },
    ]);
    assert.ok(
      findDaySection(feed.root as unknown as HTMLElement, '2026-09-10') ===
        (feed.section('2026-09-10') as unknown as HTMLElement),
    );
    assert.equal(findDaySection(feed.root as unknown as HTMLElement, '2026-09-01'), null);
  });

  it('preserveScroll: перерисовка не сбрасывает позицию прокрутки', () => {
    const container = new ShimElement('div', 'chron-feed-wrap');
    container.scrollTop = 120;
    container.scrollHeight = 1000;
    container.clientHeight = 200;
    preserveScroll(container as unknown as HTMLElement, () => {
      container.scrollTop = 0; // имитация пересборки содержимого
    });
    assert.equal(container.scrollTop, 120, 'позиция прокрутки восстановлена');
  });
});

// ---------------------------------------------------------------------------
// П.2 (регресс): selectRecord по ещё НЕ загруженной записи взводит навигацию
// ---------------------------------------------------------------------------

describe('регресс ab78e7b5: переход к записи взводит навигацию до её появления', () => {
  it('selectRecord отсутствующей карточки: refresh возвращает фокус к догруженной записи', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    // День есть, записи ещё нет: `loadUntilRecord` принёс страницы без неё.
    const spec: DaySpec[] = [{ day: '2026-09-11', records: [] }];
    const feed = buildFeed(spec);
    await withDocument(null, async () => {
      const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
        onSetDayCollapsed: () => undefined,
        onEditBody: () => undefined,
      });

      handle.selectRecord('r1', '2026-09-11');
      // Выделение поставлено сразу (карточка может появиться позже)...
      assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });
      assert.equal(feed.root.querySelectorAll('.diary-record').length, 0, 'карточки в DOM пока нет');

      // ...запись догрузилась и попала в ленту — refresh обязан вернуть фокус.
      spec[0]!.records.push('r1');
      feed.render();
      handle.refresh();

      const card = feed.cardIn('2026-09-11', 'r1');
      assert.ok(card.classList.contains(FEED_NAV_CURRENT_CLASS), 'выделение переприменено');
      assert.equal(card.focused, true, 'фокус вернулся к текущей записи (стрелки снова двигают)');
    });
  });
});
