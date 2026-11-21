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

/** Подставить DOM и `window.etn` с подставным `tasks.list`. */
function shim(rows: Array<Record<string, unknown>> = []): { listCalls: () => number } {
  rowStore = [...rows];
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
  const stub = {
    tasks: {
      list: async () => {
        calls += 1;
        return { items: [...rowStore], nested: [], max_revision: 2 };
      },
    },
    thoughts: { get: async () => ({ id: 't1', title: 't1' }) },
    publications: { get: async () => ({ id: 'p1', title: 'p1' }) },
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
  return { listCalls: () => calls };
}

const { store } = await import('../src/renderer/state.js');
const { mountTaskList } = await import('../src/renderer/lib/ui/task-list.js');
const { resetEventRouter, routeRealtimeEvent } =
  await import('../src/renderer/lib/live/event-router.js');

/** Смонтировать панель редактора мысли (headless) и вернуть хэндл. */
async function mount(
  autoRefresh: boolean,
  actions: Record<string, unknown> = {},
): Promise<{ handle: any; host: ShimElement; destroy: () => void }> {
  store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
  const host = new ShimElement('div');
  const handle = mountTaskList(host as unknown as HTMLElement, {
    source: { kind: 'thought', ownerId: 't1' },
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

  it('правка без marked_for_deletion панель по корзине не перечитывает', async () => {
    const api = shim([taskRow(0)]);
    const { destroy } = await mount(false);
    const initial = api.listCalls();
    trashEvent(1, 'thought.updated', { id: 't1', version: 2, changes: { title: 'Новое' } });
    await wait(250);
    assert.equal(api.listCalls(), initial, 'смена названия — не событие корзины');
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
