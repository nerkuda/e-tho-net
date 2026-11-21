/**
 * Автоперечитывание панели «Задачи» на событие комментария (0.16.1, уточнение
 * 2026-11-19, пункт 4).
 *
 * **Что было.** Панель редактора мысли показывала новую задачу только после
 * смены мысли: сохранение комментария публиковало `comment.updated`, но панель
 * ждала ручного маркера «Обновить».
 *
 * **Что стало.** Опция `autoRefreshOnCommentChange` (включена зоной «Задачи»
 * редактора) перечитывает панель по событию комментария с дебаунсом: несколько
 * событий одной записи дают ОДИН запрос. Панель «Дневника» опцию не включает —
 * у неё прежний маркер «Обновить».
 *
 * Тест монтирует настоящий `mountTaskList` с подставным мостом `window.etn`,
 * гонит событие через реальный маршрутизатор (`routeRealtimeEvent`) и считает
 * сетевые вызовы панели.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { TaskListSource } from '../src/renderer/lib/ui/task-list.js';

import { ShimElement } from './dom-shim.js';

/** Дождаться промисов загрузки панели. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Подождать дебаунс автоперечитывания (150 мс) с запасом. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Строка проекции с полями, которые читает модель панели. */
function taskRow(lineNo: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment_id: 'c1',
    line_no: lineNo,
    text: `задача ${lineNo}`,
    period_from: null,
    period_to: null,
    due: '2026-11-20',
    auto_period: false,
    done: false,
    subject_thoughts: [],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: 1,
    parsed_revision: 1,
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'chronological',
    ...overrides,
  };
}

/** Текущая выдача `tasks.list` — тест меняет её между «Обновить». */
let rowStore: Array<Record<string, unknown>> = [];

/** Канон субъектов страницы (`TaskListPage.subjects`) текущей выдачи. */
let subjectStore: Array<Record<string, unknown>> = [];
/** Отдаёт ли подставной сервер поле `subjects` (иначе — ответ старого сервера). */
let subjectsReported = false;

/** Удержание ответа ближайшего `tasks.list` — тест «полёта» тихого перечитывания. */
let listGate: Promise<void> | null = null;

/**
 * Задержать ответ ближайшего `tasks.list`: вернуть функцию освобождения.
 * Нужно, чтобы увидеть кадр «запрос ещё в полёте» (доработка по вердикту
 * 35656dfb: облачко не должно проваливаться в «(недоступна)»).
 */
function holdList(): () => void {
  let release!: () => void;
  listGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    listGate = null;
    release();
  };
}

/** Подставить DOM и `window.etn` с подставным `tasks.list`. */
function shim(
  rows: Array<Record<string, unknown>> = [],
  subjects: Array<Record<string, unknown>> | null = null,
): { listCalls: () => number; thoughtGets: () => number } {
  rowStore = [...rows];
  subjectsReported = subjects !== null;
  subjectStore = (subjects ?? []).map((subject) => ({ ...subject }));
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    querySelectorAll: (): [] => [],
    contains: (node: unknown) => body.contains(node as ShimElement | null),
  };
  (ShimElement.prototype as any).ownerDocument = (globalThis as any).document;

  let calls = 0;
  let thoughtGets = 0;
  const stub = {
    tasks: {
      list: async () => {
        calls += 1;
        const gate = listGate;
        if (gate !== null) await gate;
        return {
          items: [...rowStore],
          nested: [],
          max_revision: 2,
          ...(subjectsReported
            ? { subjects: subjectStore.map((subject) => ({ ...subject })) }
            : {}),
        };
      },
    },
    thoughts: {
      get: async (_networkId: string, id: string) => {
        thoughtGets += 1;
        return { id, title: id };
      },
    },
    publications: { get: async () => ({ id: 'p1', title: 'p1' }) },
    reminders: {
      list: async () => ({ reminders: [], from: null, to: null }),
    },
    ui: { getState: async () => null, setState: async () => undefined },
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.etn = stub;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  win.localStorage = {
    getItem: () => null,
    setItem: (): void => undefined,
    removeItem: (): void => undefined,
  };
  (globalThis as any).etn = stub;
  return { listCalls: () => calls, thoughtGets: () => thoughtGets };
}

const { store } = await import('../src/renderer/state.js');
const { mountTaskList } = await import('../src/renderer/lib/ui/task-list.js');
const { resetEventRouter, routeRealtimeEvent } =
  await import('../src/renderer/lib/live/event-router.js');
const { t } = await import('../src/renderer/lib/i18n.js');

/** Смонтировать панель (headless) и вернуть хэндл. */
async function mount(
  autoRefresh: boolean,
  actions: Record<string, unknown> = {},
  source: TaskListSource = { kind: 'thought', ownerId: 't1' },
): Promise<{ handle: any; host: ShimElement; destroy: () => void }> {
  store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
  const host = new ShimElement('div');
  const handle = mountTaskList(host as unknown as HTMLElement, {
    source,
    view: {
      headless: true,
      autoRefreshOnCommentChange: autoRefresh,
      renderText: (node, row) => {
        node.textContent = row.text;
      },
    },
    actions,
  });
  await flush();
  return { handle, host, destroy: () => handle.destroy() };
}

/** Кнопка «Обновить» шапки headless-панели. */
function refreshButton(handle: any): ShimElement {
  return (handle.headActions() as ShimElement[]).find((node) =>
    node.classList.contains('ui-task-panel-refresh'),
  )!;
}

/** Узлы строк панели в порядке показа. */
function rowsOf(host: ShimElement): ShimElement[] {
  return host.querySelectorAll('[data-row-key]') as unknown as ShimElement[];
}

/** Тексты строк панели. */
function texts(host: ShimElement): string[] {
  return rowsOf(host).map((node) => node.querySelector('.ui-task-row-text')?.textContent ?? '');
}

/** Событие чужой правки записи в сети — через реальный маршрутизатор. */
function commentUpdated(seq: number): void {
  routeRealtimeEvent({
    type: 'comment.updated',
    network_id: 'n1',
    seq,
    data: { id: 'c1', version: 2, kind: 'chronological', owner_type: 'thought', owner_id: 't1' },
  } as any);
}

beforeEach(() => {
  resetEventRouter();
});

describe('панель задач: автоперечитывание на событие комментария (пункт 4)', () => {
  it('с включённой опцией событие комментария перечитывает панель', async () => {
    const api = shim();
    const { destroy } = await mount(true);
    const initial = api.listCalls();
    assert.ok(initial >= 1, 'стартовая загрузка прошла');
    commentUpdated(1);
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'событие дало ровно один перезапрос');
    destroy();
  });

  it('без опции событие панель не перечитывает (Дневник остаётся на ручном «Обновить»)', async () => {
    const api = shim();
    const { destroy } = await mount(false);
    const initial = api.listCalls();
    commentUpdated(1);
    await wait(250);
    assert.equal(api.listCalls(), initial, 'перезапроса нет');
    destroy();
  });

  it('пачка событий одной записи склеивается в ОДИН перезапрос', async () => {
    const api = shim();
    const { destroy } = await mount(true);
    const initial = api.listCalls();
    commentUpdated(1);
    commentUpdated(2);
    commentUpdated(3);
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'дебаунс склеил пачку');
    destroy();
  });
});

describe('панель задач: перечитывание патчит только изменившиеся строки (пачка 4, п.2)', () => {
  beforeEach(() => {
    resetEventRouter();
  });

  it('в зоне редактора событие не серит строки и не зажигает «Обновить»', async () => {
    const api = shim([taskRow(0), taskRow(1)]);
    const { handle, host, destroy } = await mount(true);
    const first = rowsOf(host)[0]!;
    commentUpdated(1);
    await flush();
    assert.equal(
      first.classList.contains('is-stale'),
      false,
      'строка не мигает серым: перечитывание само принесёт свежее состояние',
    );
    assert.equal(
      refreshButton(handle).classList.contains('is-stale'),
      false,
      '«Обновить» не зажигается и не гаснет сама — это не действие человека',
    );
    await wait(250);
    assert.equal(api.listCalls(), 2, 'событие дало одно перечитывание');
    destroy();
  });

  it('«Обновить» перечитывает список keyed: пересобирается только изменённая строка', async () => {
    shim([taskRow(0), taskRow(1), taskRow(2)]);
    const { handle, host, destroy } = await mount(true);
    const before = rowsOf(host);
    const beforeTexts = texts(host);
    // В источнике поправили текст ОДНОЙ строки (второй).
    rowStore[1] = taskRow(1, { text: 'задача 1 — правка' });
    refreshButton(handle).click();
    await flush();
    const after = rowsOf(host);
    assert.deepEqual(
      after.map((node, index) => node === before[index]),
      [true, true, true],
      'узлы всех строк сохранены: полной пересборки списка нет',
    );
    assert.deepEqual(
      texts(host),
      [beforeTexts[0], 'задача 1 — правка', beforeTexts[2]],
      'обновлён текст только изменённой строки',
    );
    destroy();
  });

  it('без автоперечитывания событие по-прежнему зажигает маркер (Дневник)', async () => {
    shim([taskRow(0)]);
    const { handle, destroy } = await mount(false);
    commentUpdated(1);
    await flush();
    assert.equal(
      refreshButton(handle).classList.contains('is-stale'),
      true,
      'панель «Дневника» работает штатным маркером «Обновить»',
    );
    destroy();
  });
});

/** Событие «корзина/удаление» через реальный маршрутизатор. */
function trashEvent(seq: number, type: string, data: Record<string, unknown>): void {
  routeRealtimeEvent({ type, network_id: 'n1', seq, data } as any);
}

describe('панель задач: корзина и удаление мысли (пачка 11, задача 173e8368)', () => {
  it('удаление мысли перечитывает панель БЕЗ маркера «Обновить» (обе панели)', async () => {
    const api = shim([taskRow(0)]);
    const { handle, host, destroy } = await mount(false);
    const initial = api.listCalls();
    const row = rowsOf(host)[0]!;

    trashEvent(1, 'thought.deleted', { id: 't1' });
    await flush();
    assert.equal(
      row.classList.contains('is-stale'),
      false,
      'строка не сереет: строки просто исчезают по перечитыванию',
    );
    assert.equal(
      refreshButton(handle).classList.contains('is-stale'),
      false,
      '«Обновить» не зажигается — пользователь ничего не нажимал',
    );

    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'событие дало ровно одно перечитывание');
    destroy();
  });

  it('помещение в корзину и возврат перечитывают панель так же тихо', async () => {
    const api = shim([taskRow(0)]);
    const { handle, destroy } = await mount(false);
    const initial = api.listCalls();

    trashEvent(1, 'thought.updated', {
      id: 't1',
      version: 2,
      changes: { marked_for_deletion: true },
    });
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'корзина — перечитывание');
    assert.equal(refreshButton(handle).classList.contains('is-stale'), false);

    trashEvent(2, 'thought.updated', {
      id: 't1',
      version: 3,
      changes: { marked_for_deletion: false },
    });
    await wait(250);
    assert.equal(api.listCalls(), initial + 2, 'возврат из корзины — перечитывание');

    // Смена самой настройки «показывать содержимое корзины» — тоже перечитывание.
    trashEvent(3, 'user-preference.updated', { key: 'show_trash', value: false });
    await wait(250);
    assert.equal(api.listCalls(), initial + 3);
    destroy();
  });

  it('каскад событий удаления склеивается в один перезапрос', async () => {
    const api = shim([taskRow(0)]);
    const { destroy } = await mount(true);
    const initial = api.listCalls();
    trashEvent(1, 'thought.deleted', { id: 't1' });
    trashEvent(2, 'link.deleted', { id: 'l1' });
    trashEvent(3, 'publication.trashed', { id: 'p1' });
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'дебаунс склеил каскад');
    destroy();
  });

  it('правка без полей корзины и визуала панель не перечитывает', async () => {
    const api = shim([taskRow(0)]);
    const { destroy } = await mount(false);
    const initial = api.listCalls();
    // Синонимы не меняют ни видимость корзины, ни облачка — перечитывать нечего.
    trashEvent(1, 'thought.updated', { id: 't1', version: 2, changes: { synonyms: ['x'] } });
    await wait(250);
    assert.equal(api.listCalls(), initial, 'смена синонимов — не событие корзины/визуала');
    destroy();
  });
});

describe('панель задач: облачко удалённой мысли (пачка 11, пункт 4)', () => {
  /** Переопределить `thoughts.get`: удалённая мысль отвечает `NOT_FOUND`. */
  function thoughtsGet(deadId: string): void {
    const stub = (globalThis as any).window.etn;
    stub.thoughts.get = async (_networkId: string, id: string) => {
      if (id === deadId) throw { code: 'NOT_FOUND' };
      return { id, title: id };
    };
  }

  it('клик по облачку удалённой мысли — no-op, действий у облачка нет', async () => {
    const opened: unknown[] = [];
    shim([taskRow(0, { subject_thoughts: ['dead'] })]);
    thoughtsGet('dead');
    const { host, destroy } = await mount(false, { openSubject: (s: unknown) => opened.push(s) });

    const chips = host.querySelectorAll('[data-id="dead"]') as unknown as ShimElement[];
    assert.equal(chips.length, 1, 'облачко субъекта отрисовано');
    const chip = chips[0]!;
    assert.equal(chip.hasListeners(), false, 'жестов у мёртвого облачка нет');

    chip.click();
    await wait(300);
    assert.deepEqual(opened, [], 'переход в удалённую мысль не выполняется');
    destroy();
  });

  it('до ответа перечитывания меню и клик облачка удалённой мысли уже недоступны', async () => {
    const opened: unknown[] = [];
    shim([taskRow(0, { subject_thoughts: ['live'] })]);
    const stub = (globalThis as any).window.etn;
    stub.thoughts.get = async (_networkId: string, id: string) => ({ id, title: id });
    const { host, destroy } = await mount(false, { openSubject: (s: unknown) => opened.push(s) });
    const alive = host.querySelectorAll('[data-id="live"]')[0]!;
    assert.equal(alive.hasListeners(), true, 'до удаления у облачка есть действия и меню');

    // Перечитывание зависает на ответе `/tasks`: окно «до ответа» держится явно.
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    stub.tasks.list = () => pending;

    trashEvent(1, 'thought.deleted', { id: 'live' });
    await flush();

    // Сразу после события, ещё без ответа списка: строка на месте (до тихой
    // перезагрузки), но облачко уже без действий и контекстного меню.
    const dead = host.querySelectorAll('[data-id="live"]')[0]!;
    assert.equal(dead.hasListeners(), false, 'жестов и меню у облачка нет сразу');
    dead.click();
    assert.deepEqual(opened, [], 'клик по облачку удалённой мысли — no-op');
    assert.equal(rowsOf(host).length, 1, 'строка живёт до перечитывания');

    // Запрос `tasks.list` ушёл, ответа всё ещё нет — состояние то же.
    await wait(200);
    const stillDead = host.querySelectorAll('[data-id="live"]')[0]!;
    assert.equal(stillDead.hasListeners(), false, 'до ответа /tasks меню недоступно');

    release({ items: [], nested: [], max_revision: 3 });
    await flush();
    await wait(50);
    assert.equal(rowsOf(host).length, 0, 'после ответа строка исчезла');
    destroy();
  });

  it('облачко живой мысли действия сохраняет', async () => {
    const opened: unknown[] = [];
    shim([taskRow(0, { subject_thoughts: ['live'] })]);
    thoughtsGet('dead');
    const { host, destroy } = await mount(false, { openSubject: (s: unknown) => opened.push(s) });

    const chips = host.querySelectorAll('[data-id="live"]') as unknown as ShimElement[];
    assert.equal(chips.length, 1, 'облачко живого субъекта отрисовано');
    assert.equal(chips[0]!.hasListeners(), true, 'у живой мысли жесты есть');
    destroy();
  });
});

/** Канон субъекта страницы (`ThoughtRef`) с заданным визуалом. */
function thoughtRef(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    icon_color: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

/** Событие чужой правки визуала мысли — через реальный маршрутизатор. */
function thoughtVisualUpdated(seq: number, id: string, changes: Record<string, unknown>): void {
  routeRealtimeEvent({
    type: 'thought.updated',
    network_id: 'n1',
    seq,
    data: { id, version: 2, changes },
  } as any);
}

/** Клик по кнопке как браузер: `currentTarget` нужен обработчику меню. */
function press(button: ShimElement): void {
  button.emit('click', {
    target: button,
    currentTarget: button,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

/** Облачко мысли с данным id внутри узла (корень `prop-ref-cloud`). */
function cloudOf(host: ShimElement | null, id: string): ShimElement | undefined {
  return host?.querySelectorAll(`[data-id="${id}"]`)[0] as unknown as ShimElement | undefined;
}

describe('панель задач: облачка связанных мыслей из канона страницы (739eb698)', () => {
  it('строка и список «…» рисуют название, иконку, цвета и стиль БЕЗ запроса мысли', async () => {
    const api = shim(
      [taskRow(0, { subject_thoughts: ['s1', 's2'] })],
      [
        thoughtRef('s1', 'Первая', {
          icon: '⭐',
          fg_color: '#ff0000',
          bg_color: '#00ffee',
          font_bold: true,
        }),
        thoughtRef('s2', 'Вторая', {
          icon: '🔥',
          fg_color: '#0000ff',
          font_italic: true,
        }),
      ],
    );
    const { host, destroy } = await mount(false);
    const row = rowsOf(host)[0]!;

    const first = cloudOf(row, 's1')!;
    assert.ok(first, 'облачко первой мысли в строке');
    assert.equal(first.querySelector('.prc-title')?.textContent, 'Первая', 'название, а не id');
    assert.equal(first.querySelector('.mini-icon')?.textContent, '⭐', 'иконка мысли');
    assert.equal(first.style.color, '#ff0000', 'цвет шрифта');
    assert.equal(first.style.background, '#00ffee', 'цвет фона');
    assert.equal(first.classList.contains('font-bold'), true, 'стиль шрифта');

    const more = row.querySelector('.ui-task-row-subjects')!.querySelector('button')!;
    press(more);
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const items = body.querySelectorAll('.menu-item');
    assert.equal(items.length, 1, 'в списке «…» — вторая мысль');
    const second = cloudOf(items[0]!, 's2')!;
    assert.ok(second, 'пункт списка — облачко, а не голая строка');
    assert.equal(second.querySelector('.prc-title')?.textContent, 'Вторая');
    assert.equal(second.querySelector('.mini-icon')?.textContent, '🔥');
    assert.equal(second.style.color, '#0000ff');
    assert.equal(second.classList.contains('font-italic'), true);
    assert.equal(second.hasListeners(), false, 'пункт — визуальное облачко без жестов');

    assert.equal(api.thoughtGets(), 0, 'канон страницы: мысль по id не запрашивалась');
    destroy();
  });

  it('недоступная мысль — понятная деградация вместо сырого id (строка и список)', async () => {
    shim(
      [
        taskRow(0, { subject_thoughts: ['ghost'] }),
        taskRow(1, { subject_thoughts: ['alive', 'ghost2'] }),
      ],
      [thoughtRef('alive', 'Живая', { icon: '⭐' })],
    );
    const stub = (globalThis as any).window.etn;
    stub.thoughts.get = async (_networkId: string, id: string) => {
      if (id.startsWith('ghost')) throw { code: 'NOT_FOUND' };
      return thoughtRef(id, 'Живая');
    };
    const { host, destroy } = await mount(false);

    const ghost = cloudOf(host, 'ghost')!;
    assert.ok(ghost, 'облачко недоступной мысли на месте');
    assert.equal(
      ghost.querySelector('.prc-title')?.textContent,
      t('tasks.subjectUnavailable'),
      'вместо сырого id — понятная подпись',
    );
    assert.notEqual(ghost.querySelector('.prc-title')?.textContent, 'ghost');

    // Вторая строка: недоступная мысль живёт в списке «…» — деградирует так же.
    const row = rowsOf(host)[1]!;
    const more = row.querySelector('.ui-task-row-subjects')!.querySelector('button')!;
    press(more);
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body.querySelectorAll('.menu-item')[0]!;
    assert.equal(
      cloudOf(item, 'ghost2')?.querySelector('.prc-title')?.textContent,
      t('tasks.subjectUnavailable'),
      'пункт списка деградирует так же',
    );
    destroy();
  });

  it('смена визуала: тихое перечитывание и перерисовка ТОЛЬКО строк этой мысли', async () => {
    const api = shim(
      [taskRow(0, { subject_thoughts: ['s1'] }), taskRow(1, { subject_thoughts: ['s2'] })],
      [thoughtRef('s1', 'Первая', { icon: '⭐' }), thoughtRef('s2', 'Вторая', { icon: '🔥' })],
    );
    const { handle, host, destroy } = await mount(false);
    const rowsBefore = rowsOf(host);
    const neighbourCloud = cloudOf(rowsBefore[1]!, 's2');
    const initial = api.listCalls();

    // Мысль s1 сменила название, иконку, цвет и стиль — штатное `thought.updated`.
    subjectStore[0] = thoughtRef('s1', 'Первая (новая)', {
      icon: '🌙',
      fg_color: '#00ff00',
      font_italic: true,
    });
    thoughtVisualUpdated(1, 's1', {
      title: 'Первая (новая)',
      icon: '🌙',
      fg_color: '#00ff00',
      font_italic: true,
    });
    await flush();
    assert.equal(
      rowsOf(host)[0]!.classList.contains('is-stale'),
      false,
      'строка не сереет: перечитывание тихое',
    );
    assert.equal(
      refreshButton(handle).classList.contains('is-stale'),
      false,
      'маркер «Обновить» не зажигается — действие не человека',
    );

    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'одно тихое перечитывание на событие');

    const rowsAfter = rowsOf(host);
    assert.deepEqual(
      rowsAfter.map((node, index) => node === rowsBefore[index]),
      [true, true],
      'строки не пересобраны — keyed-сверка',
    );
    assert.equal(cloudOf(rowsAfter[1]!, 's2'), neighbourCloud, 'соседняя строка не тронута');

    const updated = cloudOf(rowsAfter[0]!, 's1')!;
    assert.equal(updated.querySelector('.prc-title')?.textContent, 'Первая (новая)');
    assert.equal(updated.querySelector('.mini-icon')?.textContent, '🌙');
    assert.equal(updated.style.color, '#00ff00');
    assert.equal(updated.classList.contains('font-italic'), true);

    // «Обновить» после смены визуала (например, моей) — тоже свежие облачка.
    subjectStore[0] = thoughtRef('s1', 'Ещё новее', { icon: '🌞', bg_color: '#123456' });
    refreshButton(handle).click();
    await flush();
    const refreshed = cloudOf(rowsOf(host)[0]!, 's1')!;
    assert.equal(refreshed.querySelector('.prc-title')?.textContent, 'Ещё новее');
    assert.equal(refreshed.querySelector('.mini-icon')?.textContent, '🌞');
    assert.equal(refreshed.style.background, '#123456');
    destroy();
  });

  it('панель «Дневника» (период) перечитывает визуал так же тихо', async () => {
    const api = shim(
      [taskRow(0, { subject_thoughts: ['s1'] })],
      [thoughtRef('s1', 'Первая', { icon: '⭐' })],
    );
    const { handle, host, destroy } = await mount(
      false,
      {},
      {
        kind: 'period',
        getPeriod: () => ({ from: '2026-11-01', to: '2026-11-30' }),
      },
    );
    const initial = api.listCalls();
    assert.equal(initial, 4, 'период: четыре среза одним проходом');

    subjectStore[0] = thoughtRef('s1', 'Первая (новая)', { icon: '🌙' });
    thoughtVisualUpdated(1, 's1', { title: 'Первая (новая)', icon: '🌙' });
    await flush();
    assert.equal(refreshButton(handle).classList.contains('is-stale'), false, 'без маркера');
    await wait(250);
    assert.equal(api.listCalls(), initial + 4, 'все срезы периода перечитаны один раз');
    assert.equal(
      cloudOf(rowsOf(host)[0]!, 's1')?.querySelector('.mini-icon')?.textContent,
      '🌙',
      'облачко «Дневника» обновилось',
    );
    destroy();
  });

  it('событие чужой мысли вне субъектов панели не перечитывает список', async () => {
    const api = shim([taskRow(0, { subject_thoughts: ['s1'] })], [thoughtRef('s1', 'Первая')]);
    const { destroy } = await mount(false);
    const initial = api.listCalls();
    thoughtVisualUpdated(1, 'stranger', { icon: '🌙' });
    await wait(250);
    assert.equal(api.listCalls(), initial, 'панель не знает эту мысль — перечитывать нечего');
    destroy();
  });

  it('на время тихого перечитывания облачко показывает ПРЕЖНИЙ вид, а не «(недоступна)»', async () => {
    const api = shim(
      [taskRow(0, { subject_thoughts: ['s1'] })],
      [thoughtRef('s1', 'Первая', { icon: '⭐' })],
    );
    const { handle, host, destroy } = await mount(false);
    const initial = api.listCalls();
    assert.equal(
      cloudOf(rowsOf(host)[0]!, 's1')?.querySelector('.prc-title')?.textContent,
      'Первая',
      'исходное облачко',
    );

    // Мысль сменила название и иконку; ответ `tasks.list` удержан — смотрим
    // кадр «запрос в полёте» (вердикт 35656dfb, блокер).
    subjectStore[0] = thoughtRef('s1', 'Первая (новая)', { icon: '🌙' });
    const release = holdList();
    thoughtVisualUpdated(1, 's1', { title: 'Первая (новая)', icon: '🌙' });
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'тихое перечитывание стартовало');

    const inFlight = cloudOf(rowsOf(host)[0]!, 's1')!;
    assert.equal(
      inFlight.querySelector('.prc-title')?.textContent,
      'Первая',
      'пока ответа нет — прежний вид облачка',
    );
    assert.equal(inFlight.querySelector('.mini-icon')?.textContent, '⭐', 'прежняя иконка');
    assert.notEqual(
      inFlight.querySelector('.prc-title')?.textContent,
      t('tasks.subjectUnavailable'),
      '«(недоступна)» на время перечитывания не показывается',
    );
    assert.equal(
      refreshButton(handle).classList.contains('is-stale'),
      false,
      'маркер «Обновить» не зажигается',
    );

    release();
    await flush();
    const after = cloudOf(rowsOf(host)[0]!, 's1')!;
    assert.equal(
      after.querySelector('.prc-title')?.textContent,
      'Первая (новая)',
      'после ответа — новый вид',
    );
    assert.equal(after.querySelector('.mini-icon')?.textContent, '🌙', 'новая иконка');
    destroy();
  });

  it('открытый список «…» обновляет пункты при смене визуала (не статичный снимок)', async () => {
    shim(
      [taskRow(0, { subject_thoughts: ['s1', 's2'] })],
      [thoughtRef('s1', 'Первая'), thoughtRef('s2', 'Вторая', { icon: '🔥' })],
    );
    const { host, destroy } = await mount(false);
    const row = rowsOf(host)[0]!;
    press(row.querySelector('.ui-task-row-subjects')!.querySelector('button')!);
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const opened = body.querySelectorAll('.menu-item')[0]!;
    assert.equal(cloudOf(opened, 's2')?.querySelector('.prc-title')?.textContent, 'Вторая');

    subjectStore[1] = thoughtRef('s2', 'Вторая (новая)', { icon: '🌙' });
    thoughtVisualUpdated(2, 's2', { title: 'Вторая (новая)', icon: '🌙' });
    await wait(250);
    await flush();

    const items = body.querySelectorAll('.menu-item');
    assert.equal(items.length, 1, 'меню осталось открытым');
    const updated = cloudOf(items[0]!, 's2')!;
    assert.equal(
      updated.querySelector('.prc-title')?.textContent,
      'Вторая (новая)',
      'пункт «…» показывает новый вид без переоткрытия меню',
    );
    assert.equal(updated.querySelector('.mini-icon')?.textContent, '🌙', 'иконка обновлена');
    destroy();
  });
});
