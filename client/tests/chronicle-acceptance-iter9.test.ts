/**
 * Итерация приёмки №9 (0.10.1), пункт 2 — клавиатурная навигация ленты
 * «Дневника» (требование 165323a7): текущая группа/запись, стрелки по видимому
 * порядку, Enter/«влево»/«вправо» на группе, шаг Enter'ом по элементам записи и
 * вход в правку текста; в режиме правки навигация молчит.
 *
 * Проверяется ИНТЕРАКЦИОННО — на контроллере `feed-nav.ts` через DOM-шим:
 * симуляция keydown/кликов, проверка выделения, сворачивания и входа в
 * редактирование. Контроллер вынесен из экрана именно ради такой проверки.
 *
 * Пункт 1 (класс записи в сортировке) — `chronicle-acceptance-iter9-order.test.ts`
 * и серверные `chronicle-service.test.ts` / `guard-chronicle-parity.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Сборка фрагмента ленты: день → заголовок + список карточек записей. */
interface FakeFeed {
  root: ShimElement;
  section(day: string): ShimElement;
  head(day: string): ShimElement;
  card(id: string): ShimElement;
  date(id: string): ShimElement;
  chips(id: string): ShimElement;
  title(id: string): ShimElement;
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
    root
      .querySelectorAll('.diary-day')
      .find((s) => s.getAttribute('data-day') === day)!;
  const cardOf = (id: string): ShimElement =>
    root
      .querySelectorAll('.diary-record')
      .find((c) => c.getAttribute('data-row-key') === id)!;
  return {
    root,
    section: sectionOf,
    head: (day) => sectionOf(day).querySelector('.diary-day-head')!,
    card: cardOf,
    date: (id) => cardOf(id).querySelector('.diary-record-date')!,
    chips: (id) => cardOf(id).querySelector('.diary-record-chips')!,
    title: (id) => cardOf(id).querySelector('.diary-record-title')!,
    body: (id) => cardOf(id).querySelector('.diary-record-body')!,
  };
}

async function navModule(): Promise<typeof import('../src/renderer/screens/chronicle/feed-nav.js')> {
  return import('../src/renderer/screens/chronicle/feed-nav.js');
}

/** Нажатие клавиши на ленте; `target` — узел, где случилось событие. */
function press(root: ShimElement, key: string, target?: ShimElement, shift = false): void {
  let prevented = false;
  root.emit('keydown', {
    key,
    shiftKey: shift,
    target: target ?? root,
    preventDefault: () => {
      prevented = true;
    },
  });
  void prevented;
}

function attach(
  root: ShimElement,
  calls: Array<{ day: string; collapsed: boolean }>,
  edits: string[],
): Promise<{ handle: import('../src/renderer/screens/chronicle/feed-nav.js').FeedNavHandle }> {
  return navModule().then(({ attachFeedNav }) => ({
    handle: attachFeedNav(root as unknown as HTMLElement, {
      onSetDayCollapsed: (day, collapsed) => calls.push({ day, collapsed }),
      onEditBody: (recordId) => edits.push(recordId),
    }),
  }));
}

describe('приёмка №9, п.2: клавиатурная навигация ленты', () => {
  it('стрелки вниз/вверх идут по видимому порядку: группа перед своими записями', async () => {
    const { attachFeedNav, FEED_NAV_CURRENT_CLASS } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1', 'r2'] },
      { day: '2026-09-10', records: ['r3'] },
    ]);
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });

    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' });
    assert.ok(feed.head('2026-09-11').classList.contains(FEED_NAV_CURRENT_CLASS), 'группа выделена');

    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });
    assert.ok(feed.card('r1').classList.contains(FEED_NAV_CURRENT_CLASS), 'запись выделена');
    assert.ok(!feed.head('2026-09-11').classList.contains(FEED_NAV_CURRENT_CLASS), 'выделение снято с группы');

    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r2' });

    // Через границу групп: r2 → заголовок следующего дня → его запись.
    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-10' });
    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r3' });

    // Граница ленты: дальше «вниз» ничего не меняет.
    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r3' });

    press(feed.root, 'ArrowUp');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-10' });
  });

  it('записи свёрнутой группы пропускаются', async () => {
    const { attachFeedNav } = await navModule();
    const feed = buildFeed([
      { day: '2026-09-11', records: ['r1', 'r2'] },
      { day: '2026-09-10', records: ['r3'] },
    ]);
    feed.section('2026-09-11').classList.add('is-collapsed');
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: () => undefined,
    });
    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' });
    press(feed.root, 'ArrowDown');
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-10' }, 'записи свёрнутой группы пропущены');
  });

  it('Enter на группе сворачивает/разворачивает; «влево»/«вправо» — тоже', async () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const calls: Array<{ day: string; collapsed: boolean }> = [];
    const { handle } = await attach(feed.root, calls, []);
    press(feed.root, 'ArrowDown'); // выбрать группу
    press(feed.root, 'Enter');
    assert.deepEqual(calls.at(-1), { day: '2026-09-11', collapsed: true }, 'Enter развёрнутой группы сворачивает');
    // Группа теперь свёрнута (экран это сделал бы; в шиме отметим сами).
    feed.section('2026-09-11').classList.add('is-collapsed');
    handle.refresh();
    press(feed.root, 'Enter');
    assert.deepEqual(calls.at(-1), { day: '2026-09-11', collapsed: false }, 'Enter свёрнутой группы разворачивает');

    press(feed.root, 'ArrowLeft');
    assert.deepEqual(calls.at(-1), { day: '2026-09-11', collapsed: true }, '«влево» сворачивает');
    press(feed.root, 'ArrowRight');
    assert.deepEqual(calls.at(-1), { day: '2026-09-11', collapsed: false }, '«вправо» разворачивает');
  });

  it('Enter входит в поля, Tab/Shift+Tab ходят по полям, Enter — действие поля', async () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const edits: string[] = [];
    const dates: string[] = [];
    const thoughts: string[] = [];
    const { attachFeedNav, FEED_NAV_ELEMENT_CLASS, FEED_NAV_CURRENT_CLASS } = await navModule();
    const handle = attachFeedNav(feed.root as unknown as HTMLElement, {
      onSetDayCollapsed: () => undefined,
      onEditBody: (id) => edits.push(id),
      onEditDates: (id) => dates.push(id),
      onAddThought: (id) => thoughts.push(id),
    });
    press(feed.root, 'ArrowDown'); // группа
    press(feed.root, 'ArrowDown'); // запись
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' });

    press(feed.root, 'Enter'); // вход в режим полей
    assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'первое поле — дата/период');

    press(feed.root, 'Enter'); // действие поля «дата»
    assert.deepEqual(dates, ['r1'], 'Enter на дате открывает диалог');

    press(feed.root, 'Tab');
    assert.ok(feed.chips('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab → мысли');
    press(feed.root, 'Enter');
    assert.deepEqual(thoughts, ['r1'], 'Enter на мыслях открывает выбор мысли');

    press(feed.root, 'Tab');
    assert.ok(feed.title('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab → заголовок');
    press(feed.root, 'Enter');
    assert.equal(feed.title('r1').focused, true, 'Enter на заголовке входит в правку');
    press(feed.root, 'Escape', feed.title('r1')); // Esc из правки заголовка — назад к полям
    assert.equal(feed.title('r1').focused, false, 'правка заголовка завершена');
    assert.ok(feed.title('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'выделение поля сохранено');

    press(feed.root, 'Tab');
    assert.ok(feed.body('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab → комментарий достижим');
    press(feed.root, 'Enter');
    assert.deepEqual(edits, ['r1'], 'Enter на комментарии входит в правку текста');

    // По кругу и назад.
    press(feed.root, 'Tab');
    assert.ok(feed.date('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'Tab с комментария — снова дата');
    press(feed.root, 'Tab', undefined, true);
    assert.ok(feed.body('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'Shift+Tab с даты — комментарий');

    // Esc — выход из режима полей, запись остаётся текущей «единой строкой».
    press(feed.root, 'Escape');
    assert.ok(!feed.body('r1').classList.contains(FEED_NAV_ELEMENT_CLASS), 'выделение поля снято');
    assert.ok(feed.card('r1').classList.contains(FEED_NAV_CURRENT_CLASS), 'выделение записи сохранено');
  });

  it('в режиме правки стрелки/Enter не двигают навигацию, Esc возвращает фокус', async () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1', 'r2'] }]);
    const { handle } = await attach(feed.root, [], []);
    press(feed.root, 'ArrowDown');
    press(feed.root, 'ArrowDown'); // r1
    const title = feed.title('r1');
    press(feed.root, 'ArrowDown', title); // правка заголовка — навигация молчит
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' }, 'текущая запись не сменилась');
    press(feed.root, 'Enter', title);
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' }, 'Enter в поле не шагает по элементам');
    // Esc — выход: поле теряет фокус, фокус возвращается в навигацию записи.
    press(feed.root, 'Escape', title);
    assert.equal(title.focused, false, 'поле вышло из правки');
    assert.equal(feed.card('r1').focused, true, 'фокус вернулся в навигацию записи');
  });

  it('клик по карточке делает её текущей, клик по заголовку — текущей группу', async () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1'] }]);
    const { handle } = await attach(feed.root, [], []);
    feed.root.emit('click', { target: feed.chips('r1') });
    assert.deepEqual(handle.current(), { kind: 'record', key: 'r1' }, 'клик по карточке делает её текущей');
    feed.root.emit('click', { target: feed.head('2026-09-11') });
    assert.deepEqual(handle.current(), { kind: 'day', key: '2026-09-11' }, 'клик по заголовку делает группу текущей');
  });

  it('выделение сохраняется при перерисовке и сбрасывается, если сущность исчезла', async () => {
    const feed = buildFeed([{ day: '2026-09-11', records: ['r1', 'r2'] }]);
    const { handle } = await attach(feed.root, [], []);
    const { FEED_NAV_CURRENT_CLASS } = await navModule();
    feed.root.emit('click', { target: feed.card('r2') });
    handle.refresh();
    assert.ok(feed.card('r2').classList.contains(FEED_NAV_CURRENT_CLASS), 'выделение восстановлено');
    // Перерисовка без r2 — сущность исчезла.
    feed.card('r2').remove();
    handle.refresh();
    assert.equal(handle.current(), null, 'исчезнувшая сущность сбрасывает выделение');
  });

  it('экран подключает контроллер к ленте и передаёт homeId в локальную вставку', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'chronicle', 'chronicle.ts'),
      'utf8',
    );
    assert.match(src, /attachFeedNav\(feedWrap, \{/, 'лента подключает контроллер навигации');
    assert.match(src, /feedWrap\.tabIndex = 0/, 'лента фокусируема для клавиатуры');
    assert.match(src, /feedNav\?\.refresh\(\)/, 'после перерисовки выделение переприменяется');
    assert.match(
      src,
      /insertRowByDay\(rows, row, getFilterState\(\)\.order, homeId\)/,
      'экран передаёт homeId — класс записи считается как на сервере',
    );
  });
});
