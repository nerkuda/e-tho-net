/**
 * «Создать задачу на сегодня» из строки напоминания (0.16.1, пачка 4, пункты
 * 3–5; требование `7fcdf583`).
 *
 * **Что проверяется.**
 *  • запись-цель — СТРОГО ДНЕВНАЯ запись сегодняшнего дня, а не первая
 *    накрывающая сегодня (период «Задачник на неделю» не трогается);
 *  • дневной записи нет — создаётся запись дня (владелец HOME, сутки от начала
 *    до конца дня);
 *  • идемпотентность: существующая задача субъекта за сегодня не дублируется,
 *    отменённой строке возвращается маркер, а не добавляется вторая;
 *  • двойное нажатие, пока запись в полёте, не даёт двух строк;
 *  • после создания — переход к строке (`openCreatedTask`) и подтверждение
 *    «Создана задача на <дата>» в зоне сообщений.
 *
 * Панель монтируется настоящим `mountTaskList` с подставным `window.etn`; DOM —
 * общий шим. Даты фикстур строятся от локального «сегодня», чтобы тест не
 * зависел от дня прогона.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Промисы панели: загрузка, операция, перечитывание. */
async function flush(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const { formatDate, t } = await import('../src/renderer/lib/i18n.js');
const { localDayEnd, localDayStart, addDays, todayLocal } =
  await import('../src/renderer/lib/dates.js');
const { resetHomeCache } = await import('../src/renderer/lib/home.js');
const { mountStatusMessage } = await import('../src/renderer/lib/status-message.js');
const { store } = await import('../src/renderer/state.js');
const { mountTaskList } = await import('../src/renderer/lib/ui/task-list.js');
const { resetEventRouter } = await import('../src/renderer/lib/live/event-router.js');

/** Запись «Дневника» (хроно-комментарий) для подставной сети. */
interface FakeRecord {
  id: string;
  kind: 'chronological' | 'permanent';
  body_md: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  use_time: boolean;
}

/** Что панель сделала с сетью. */
interface Calls {
  updates: Array<{ id: string; body_md: string; version: number }>;
  created: Array<Record<string, unknown>>;
}

/** Поднять DOM и подставную сеть: записи дня и напоминание о мысли. */
function shim(records: FakeRecord[], options: { gate?: Promise<void> } = {}): Calls {
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
    head: new ShimElement('head'),
  };
  (ShimElement.prototype as any).ownerDocument = (globalThis as any).document;

  const calls: Calls = { updates: [], created: [] };
  const today = todayLocal();
  const stub = {
    tasks: {
      list: async () => ({ items: [], nested: [], max_revision: 0 }),
      patch: async () => ({ results: [], revisions: [] }),
    },
    reminders: {
      list: async () => ({
        reminders: [
          {
            id: 'r1',
            subject_type: 'thought',
            subject_id: '11111111-1111-4111-8111-111111111111',
            schedule: { type: 'once' },
            occurrences: [
              { occurrence_at: `${today}T09:00:00.000Z`, until: null, status: 'active' },
            ],
          },
        ],
        from: localDayStart(today),
        to: localDayEnd(today),
      }),
    },
    comments: {
      list: async () => {
        if (options.gate !== undefined) await options.gate;
        return records.map((record) => ({ ...record }));
      },
      get: async (_networkId: string, id: string) => {
        const record = records.find((item) => item.id === id);
        if (record === undefined) throw new Error(`нет записи ${id}`);
        return { ...record };
      },
      update: async (
        _networkId: string,
        id: string,
        input: { body_md?: string },
        version: number,
      ) => {
        calls.updates.push({ id, body_md: input.body_md ?? '', version });
        const record = records.find((item) => item.id === id);
        if (record !== undefined) {
          record.body_md = input.body_md ?? record.body_md;
          record.version += 1;
        }
        return { ...(record ?? { id }), version: (record?.version ?? version) + 0 };
      },
      createMulti: async (
        _networkId: string,
        _targets: unknown,
        input: Record<string, unknown>,
      ) => {
        calls.created.push(input);
        return { id: 'new-record', kind: 'chronological', version: 1, ...input };
      },
    },
    thoughts: { get: async (id: string) => ({ id, title: `Мысль ${id}` }) },
    publications: { get: async (id: string) => ({ id, title: id }) },
    structures: { query: async () => ({ items: [{ id: 'home' }] }) },
    ui: { getState: async () => null, setState: async (): Promise<void> => undefined },
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
  return calls;
}

/** Запись дня за сегодня (сутки целиком). */
function todayRecord(id: string, body_md = ''): FakeRecord {
  const today = todayLocal();
  return {
    id,
    kind: 'chronological',
    body_md,
    version: 1,
    valid_from: localDayStart(today),
    valid_to: localDayEnd(today),
    use_time: false,
  };
}

/** Запись-ПЕРИОД, накрывающая сегодня (например, «Задачник на неделю»). */
function periodRecord(id: string, body_md = ''): FakeRecord {
  const today = todayLocal();
  const from = addDays(today, -3);
  const to = addDays(today, 3);
  return {
    id,
    kind: 'chronological',
    body_md,
    version: 1,
    valid_from: localDayStart(from),
    valid_to: localDayEnd(to),
    use_time: false,
  };
}

/** Смонтировать панель «Дневника» с напоминаниями и журналом переходов. */
async function mount(): Promise<{
  host: ShimElement;
  opened: Array<{ commentId: string; lineNo: number }>;
  status: { textContent: string; title: string };
  destroy: () => void;
}> {
  store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
  const host = new ShimElement('div');
  const opened: Array<{ commentId: string; lineNo: number }> = [];
  const today = todayLocal();
  const handle = mountTaskList(host as unknown as HTMLElement, {
    source: { kind: 'period', getPeriod: () => ({ from: today, to: today }) },
    view: { reminders: true, renderText: (node, row) => (node.textContent = row.text) },
    actions: { openCreatedTask: (ref) => opened.push(ref) },
  });
  await flush();
  const status = { textContent: '', title: '' };
  mountStatusMessage(status);
  return { host, opened, status, destroy: () => handle.destroy() };
}

/** Нажать «Создать задачу на сегодня» у строки напоминания. */
function clickCreate(host: ShimElement): void {
  const button = host.querySelector('.ui-reminder-create-task') as unknown as ShimElement | null;
  assert.ok(button, 'кнопка «Создать задачу на сегодня» у строки напоминания');
  button!.emit('click', {
    target: button,
    currentTarget: button,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

beforeEach(() => {
  resetEventRouter();
  resetHomeCache();
});

describe('«Создать задачу на сегодня»: запись-цель и строка (пачка 4, пункты 3–5)', () => {
  it('пишет в СТРОГО ДНЕВНУЮ запись сегодня, а не в период, накрывающий сегодня', async () => {
    const period = periodRecord('period-1', '- [ ] задача недели [[2026-11-17]]');
    const daily = todayRecord('daily-1');
    const calls = shim([period, daily]);
    const h = await mount();
    try {
      clickCreate(h.host);
      await flush();
      assert.equal(calls.updates.length, 1, 'тело записи обновлено один раз');
      assert.equal(calls.updates[0]!.id, 'daily-1', 'цель — дневная запись, а не период');
      assert.equal(
        calls.updates[0]!.body_md,
        `- [ ] [[#11111111-1111-4111-8111-111111111111]] [[${todayLocal()}]]`,
        'строка задачи: ID-ссылка субъекта + date-ссылка сегодня',
      );
      assert.deepEqual(
        h.opened,
        [{ commentId: 'daily-1', lineNo: 0 }],
        'после создания — переход к строке записи',
      );
      assert.equal(
        h.status.textContent,
        t('tasks.createdForToday', [formatDate(new Date(`${todayLocal()}T00:00:00`))]),
        'подтверждение «Создана задача на <дата>»',
      );
    } finally {
      h.destroy();
    }
  });

  it('повторный клик не плодит дубль: строка уже есть — только переход и подтверждение', async () => {
    const line = `- [ ] [[#11111111-1111-4111-8111-111111111111]] [[${todayLocal()}]]`;
    const calls = shim([todayRecord('daily-1', `вчерашнее\n${line}`)]);
    const h = await mount();
    try {
      clickCreate(h.host);
      await flush();
      assert.equal(calls.updates.length, 0, 'тело записи не переписано');
      assert.deepEqual(
        h.opened,
        [{ commentId: 'daily-1', lineNo: 1 }],
        'переход к существующей строке',
      );
    } finally {
      h.destroy();
    }
  });

  it('отменённой строке возвращается маркер, а не добавляется вторая', async () => {
    const canceled = `- [[#11111111-1111-4111-8111-111111111111]] [[${todayLocal()}]]`;
    const calls = shim([todayRecord('daily-1', canceled)]);
    const h = await mount();
    try {
      clickCreate(h.host);
      await flush();
      assert.equal(calls.updates.length, 1, 'одна правка записи');
      assert.equal(
        calls.updates[0]!.body_md,
        `- [ ] [[#11111111-1111-4111-8111-111111111111]] [[${todayLocal()}]]`,
        'та же строка снова стала задачей, вторая строка не появилась',
      );
      assert.equal(
        calls.updates[0]!.body_md.split('\n').length,
        1,
        'строк в записи не прибавилось',
      );
      assert.deepEqual(h.opened, [{ commentId: 'daily-1', lineNo: 0 }]);
    } finally {
      h.destroy();
    }
  });

  it('дневной записи нет — создаётся запись дня (владелец HOME, сутки целиком)', async () => {
    const calls = shim([periodRecord('period-1')]);
    const h = await mount();
    try {
      clickCreate(h.host);
      await flush();
      assert.equal(calls.updates.length, 0, 'период не трогается');
      assert.equal(calls.created.length, 1, 'создана ровно одна запись');
      const created = calls.created[0]!;
      assert.equal(created['kind'], 'chronological');
      assert.equal(
        created['body_md'],
        `- [ ] [[#11111111-1111-4111-8111-111111111111]] [[${todayLocal()}]]`,
      );
      assert.equal(created['valid_from'], localDayStart(todayLocal()), 'начало суток дня');
      assert.equal(created['valid_to'], localDayEnd(todayLocal()), 'конец суток дня');
      assert.equal(created['use_time'], false);
      assert.deepEqual(
        h.opened,
        [{ commentId: 'new-record', lineNo: 0 }],
        'переход к новой строке',
      );
    } finally {
      h.destroy();
    }
  });

  it('двойное нажатие, пока запись в полёте, даёт одну строку', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = shim([todayRecord('daily-1')], { gate });
    const h = await mount();
    try {
      clickCreate(h.host);
      clickCreate(h.host);
      release();
      await flush();
      assert.equal(calls.updates.length, 1, 'второй клик игнорирован, дубля нет');
    } finally {
      h.destroy();
    }
  });
});
