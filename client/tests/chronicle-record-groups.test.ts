/**
 * Сворачиваемая запись ленты «Дневника» (0.10.2, задача 41ed99ab): чистые
 * помощники календаря (пороги точек), производный заголовок записи, признак
 * выходного дня и in-place-переключение тела записи на DOM-шиме.
 *
 * Требования — карточка 41ed99ab (пп.1, 2, 5): точки вместо счётчика; заголовок
 * из `title` либо первой непустой строки тела со снятием разметки (150 симв.);
 * сб/вс — отдельный токен; сворачивание записи не пересобирает ленту.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calendarDotCount,
} from '../src/renderer/lib/month-calendar.js';
import {
  EDITOR_RECORD_TITLE_MAX,
  RECORD_DISPLAY_TITLE_MAX,
  recordDisplayTitle,
  recordTitleFromBody,
} from '../src/renderer/lib/record-title.js';
import { isWeekend } from '../src/renderer/screens/chronicle/diary.js';
import {
  applyRecordCollapsed,
  applyRecordCollapsedForDay,
  dayOfCard,
  findRecordCard,
  recordCollapseKey,
} from '../src/renderer/screens/chronicle/record-groups.js';
import { ShimElement } from './dom-shim.js';

describe('календарь: пороги точек-индикаторов (задача 41ed99ab)', () => {
  it('0 записей — 0 точек; ≤50 — 1; 51…100 — 2; >100 — 3', () => {
    assert.equal(calendarDotCount(0), 0);
    assert.equal(calendarDotCount(1), 1);
    assert.equal(calendarDotCount(50), 1);
    assert.equal(calendarDotCount(51), 2);
    assert.equal(calendarDotCount(100), 2);
    assert.equal(calendarDotCount(101), 3);
    assert.equal(calendarDotCount(999), 3);
  });
});

describe('производный заголовок записи (задача 41ed99ab, п.2)', () => {
  it('непустой title — как есть', () => {
    assert.equal(recordDisplayTitle('Заголовок', '# тело'), 'Заголовок');
  });

  it('пустой title — первая непустая строка тела со снятием разметки', () => {
    assert.equal(recordTitleFromBody('\n  \n## День\nтекст'), 'День');
    assert.equal(recordTitleFromBody('- пункт списка'), 'пункт списка');
    assert.equal(recordTitleFromBody('3. нумерованный'), 'нумерованный');
    assert.equal(recordTitleFromBody('> - вложенно'), 'вложенно');
    assert.equal(recordDisplayTitle('', '* звёздочка'), 'звёздочка');
  });

  it('ни title, ни тела — пусто (вызывающий подставит «Пустая запись»)', () => {
    assert.equal(recordDisplayTitle('', ''), '');
    assert.equal(recordDisplayTitle(null, '\n\n'), '');
  });

  it('длинная строка обрезается по 150 символов с многоточием', () => {
    const long = 'a'.repeat(200);
    const shown = recordDisplayTitle(null, long);
    assert.equal(shown.length, RECORD_DISPLAY_TITLE_MAX + 1);
    assert.ok(shown.endsWith('…'));
  });

  it('серверная выжимка разэкранируется, чужое многоточие не двоится', () => {
    // Сервер отдаёт `snippet` HTML-экранированным (`escapeHtml`), а заголовок —
    // обычный текст: `&amp;` показывается как `&`, а не буквально.
    assert.equal(recordTitleFromBody('Rock &amp; Roll'), 'Rock & Roll');
    assert.equal(recordTitleFromBody('a &lt; b &gt; c'), 'a < b > c');
    // `snippet` уже мог быть обрезан сервером — второе многоточие не добавляется.
    const truncated = `${'a'.repeat(160)}…`;
    assert.equal(recordDisplayTitle(null, truncated), `${'a'.repeat(150)}…`);
  });

  it('лимит вкладки редактора — 250 символов, маркеры снимаются (задача 8e4a965f)', () => {
    // Тот же разбор, что у ленты, но со своим лимитом вкладки: «## Заголовок»
    // показывается без маркеров (DoD №2), длинная строка — 250 + «…».
    assert.equal(
      recordDisplayTitle(null, '## Запись без заголовка', EDITOR_RECORD_TITLE_MAX),
      'Запись без заголовка',
    );
    const shown = recordDisplayTitle(null, 'b'.repeat(300), EDITOR_RECORD_TITLE_MAX);
    assert.equal(shown.length, EDITOR_RECORD_TITLE_MAX + 1);
    assert.ok(shown.endsWith('…'));
  });
});

describe('выходной день (задача 41ed99ab, п.5)', () => {
  it('сб/вс — выходной, пн–пт — нет', () => {
    assert.equal(isWeekend('2026-09-26'), true); // суббота
    assert.equal(isWeekend('2026-09-27'), true); // воскресенье
    assert.equal(isWeekend('2026-09-25'), false); // пятница
    assert.equal(isWeekend('2026-09-28'), false); // понедельник
    assert.equal(isWeekend('мусор'), false);
  });
});

// ---------------------------------------------------------------------------
// In-place переключение записи
// ---------------------------------------------------------------------------

interface FakeFeed {
  root: ShimElement;
  card(day: string, id: string): ShimElement;
  title(day: string, id: string): ShimElement;
  body(day: string, id: string): ShimElement;
}

function buildFeed(days: Array<{ day: string; records: string[] }>): FakeFeed {
  const root = new ShimElement('div', 'chron-feed');
  for (const day of days) {
    const section = new ShimElement('div', 'diary-day');
    section.setAttribute('data-day', day.day);
    const list = new ShimElement('div', 'diary-day-list');
    for (const id of day.records) {
      const card = new ShimElement('div', 'diary-record');
      card.setAttribute('data-row-key', id);
      card.append(
        new ShimElement('button', 'diary-record-title'),
        new ShimElement('div', 'diary-record-body'),
      );
      list.append(card);
    }
    section.append(list);
    root.append(section);
  }
  const cardOf = (day: string, id: string): ShimElement =>
    root
      .querySelectorAll('.diary-day')
      .find((s) => s.getAttribute('data-day') === day)!
      .querySelectorAll('.diary-record')
      .find((c) => c.getAttribute('data-row-key') === id)!;
  return {
    root,
    card: cardOf,
    title: (day, id) => cardOf(day, id).querySelector('.diary-record-title')!,
    body: (day, id) => cardOf(day, id).querySelector('.diary-record-body')!,
  };
}

describe('applyRecordCollapsed: тело скрывается на месте (задача 41ed99ab, пп.3, 7)', () => {
  it('класс карточки, hidden тела и aria-expanded заголовка согласованы', () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const card = feed.card('2026-09-11', 'r1');
    const titleRef = feed.title('2026-09-11', 'r1');
    const bodyRef = feed.body('2026-09-11', 'r1');
    const labels = { collapse: 'Свернуть', expand: 'Развернуть' };

    applyRecordCollapsed(card as unknown as HTMLElement, true, labels);
    assert.ok(card.classList.contains('is-collapsed'), 'карточка свёрнута');
    assert.equal(bodyRef.hidden, true, 'тело скрыто');
    assert.equal(titleRef.getAttribute('aria-expanded'), 'false');
    assert.equal(titleRef.title, 'Развернуть');
    assert.ok(feed.title('2026-09-11', 'r1') === titleRef, 'узел заголовка не заменён');

    applyRecordCollapsed(card as unknown as HTMLElement, false, labels);
    assert.ok(!card.classList.contains('is-collapsed'), 'карточка развёрнута');
    assert.equal(bodyRef.hidden, false, 'тело показано');
    assert.equal(titleRef.getAttribute('aria-expanded'), 'true');
    assert.equal(titleRef.title, 'Свернуть');
    assert.ok(feed.body('2026-09-11', 'r1') === bodyRef, 'узел тела не заменён');
  });

  it('ключ вхождения различает копии записи в разных днях', () => {
    assert.notEqual(
      recordCollapseKey('2026-09-11', 'r1'),
      recordCollapseKey('2026-09-10', 'r1'),
    );
  });

  it('findRecordCard и dayOfCard находят вхождение и день', () => {
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1'] },
      { day: '2026-09-10', records: ['r1'] },
    ]);
    const found = findRecordCard(
      feed.root as unknown as HTMLElement,
      '2026-09-10',
      'r1',
    );
    assert.ok(found === (feed.card('2026-09-10', 'r1') as unknown as HTMLElement));
    assert.equal(dayOfCard(feed.card('2026-09-10', 'r1') as unknown as HTMLElement), '2026-09-10');
    assert.equal(
      findRecordCard(feed.root as unknown as HTMLElement, '2026-09-01', 'r1'),
      null,
    );
  });

  it('восстановление свёрнутости не зависит от DOM-предка карточки (регресс блокера 1)', () => {
    // При keyed-сборке карточка ещё НЕ вставлена в секцию дня — предка с
    // `data-day` нет, и `dayOfCard` вернул бы null. Свёрнутость обязана
    // примениться: день приходит параметром, а не из DOM.
    const card = new ShimElement('div', 'diary-record');
    card.setAttribute('data-row-key', 'r1');
    const title = new ShimElement('button', 'diary-record-title');
    const body = new ShimElement('div', 'diary-record-body');
    card.append(title, body);

    // Сохранённый ключ вхождения «день + id» (как из `diary_collapsed_records`).
    const saved = new Set([recordCollapseKey('2026-09-11', 'r1')]);
    assert.equal(dayOfCard(card as unknown as HTMLElement), null, 'предка дня нет');
    applyRecordCollapsed(card as unknown as HTMLElement, saved.has(recordCollapseKey('2026-09-11', 'r1')), {
      collapse: 'Свернуть',
      expand: 'Развернуть',
    });
    assert.ok(card.classList.contains('is-collapsed'), 'свёрнутость восстановлена');
    assert.equal(body.hidden, true, 'тело скрыто');
  });
});

describe('applyRecordCollapsedForDay: восстановление по явному дню (задача 8f9c9b12)', () => {
  const labels = { collapse: 'Свернуть', expand: 'Развернуть' };

  /** Откреплённая карточка записи: DOM-предка с `data-day` нет. */
  function detachedCard(id = 'r1'): {
    card: ShimElement;
    title: ShimElement;
    body: ShimElement;
  } {
    const card = new ShimElement('div', 'diary-record');
    card.setAttribute('data-row-key', id);
    const title = new ShimElement('button', 'diary-record-title');
    const body = new ShimElement('div', 'diary-record-body');
    card.append(title, body);
    return { card, title, body };
  }

  it('сворачивает откреплённую карточку по дню-параметру, не заглядывая в DOM', () => {
    // Путь `fillRecordCard`: карточка ещё не в ленте, `dayOfCard` вернул бы null.
    // Функция обязана работать от явного дня.
    const { card, title, body } = detachedCard();
    const saved = new Set([recordCollapseKey('2026-09-11', 'r1')]);
    assert.equal(dayOfCard(card as unknown as HTMLElement), null, 'предка дня нет');

    applyRecordCollapsedForDay(
      card as unknown as HTMLElement,
      '2026-09-11',
      'r1',
      saved,
      labels,
    );
    assert.ok(card.classList.contains('is-collapsed'), 'свёрнутость восстановлена');
    assert.equal(body.hidden, true, 'тело скрыто');
    assert.equal(title.getAttribute('aria-expanded'), 'false', 'заголовок помечен свёрнутым');
  });

  it('ключ вхождения решает: сохранённый день другого дня не сворачивает', () => {
    const { card } = detachedCard();
    const saved = new Set([recordCollapseKey('2026-09-10', 'r1')]);
    applyRecordCollapsedForDay(
      card as unknown as HTMLElement,
      '2026-09-11',
      'r1',
      saved,
      labels,
    );
    assert.ok(!card.classList.contains('is-collapsed'), 'запись развёрнута');
  });

  it('пустой набор состояний оставляет карточку развёрнутой', () => {
    const { card, body } = detachedCard();
    applyRecordCollapsedForDay(
      card as unknown as HTMLElement,
      '2026-09-11',
      'r1',
      new Set<string>(),
      labels,
    );
    assert.ok(!card.classList.contains('is-collapsed'));
    assert.equal(body.hidden, false);
  });
});

