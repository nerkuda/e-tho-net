/**
 * Индикатор напоминаний в облачке и бейдж «сегодня» (0.16.1, задача 173f1540;
 * элементы ba827eb6 и 23887005).
 *
 * Индикатор: одна ячейка ⏰ на все напоминания субъекта, первая в ряду; её
 * состояние берётся из кэша списка владельца. Бейдж: число «сегодня +
 * просрочено» по тому же списку, ноль — скрыт, клик — переход на сегодня,
 * пересчёт — ТОЛЬКО по `reminders.changed` (персональное событие владельца).
 * `comment.*` набор строк владельца не меняет: напоминание адресует
 * мысль/публикацию (`reminder-service.ts`, видимость — `active`/
 * `marked_for_deletion` субъекта), текст комментария в счёт не входит
 * (ошибка 39d78d2a).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AnyRealtimeEvent, Reminder, ReminderListResult } from '@etn/shared';

import { resetEventRouter, routeRealtimeEvent } from '../src/renderer/lib/live/event-router.js';
import {
  REMINDER_INDICATOR_CLASS,
  reminderIndicatorCell,
  reminderIndicatorInternals,
  refreshReminderIndicators,
  resetReminderIndicators,
  syncReminderIndicatorCells,
} from '../src/renderer/lib/reminder-indicators.js';
import { mountReminderTodayBadge } from '../src/renderer/screens/chronicle/reminder-badge.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '00000000-0000-4000-8000-0000000000aa';
const DAY_MS = 86_400_000;

const body = new ShimElement('body');

/** Минимальный документ/окно: бейдж и покраска ячеек работают с DOM. */
function installDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (selector: string) => body.querySelector(selector),
    activeElement: null,
  };
  (globalThis as any).HTMLElement = ShimElement;
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
}

/** Карточка напоминания (все поля, которые читают поверхности). */
function reminder(overrides: Partial<Reminder> = {}): Reminder {
  const anchor = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    id: 'r1',
    subject_type: 'thought',
    subject_id: 't1',
    kind: 'one',
    schedule: { type: 'once' },
    anchor_at: anchor,
    next_at: anchor,
    exceptions: {},
    state: 'active',
    created_at: anchor,
    updated_at: anchor,
    occurrences: [{ occurrence_at: anchor, status: 'active', until: null }],
    ...overrides,
  } as unknown as Reminder;
}

/** Выдача списка с одним напоминанием и заданными вхождениями. */
function listResult(occurrences: Reminder['occurrences']): ReminderListResult {
  return {
    reminders: [reminder({ occurrences })],
    from: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    to: new Date(Date.now() + DAY_MS).toISOString(),
  };
}

/** Событие `reminders.changed` (персональное, приходит только владельцу). */
function remindersChanged(networkId = NET): AnyRealtimeEvent {
  return {
    type: 'reminders.changed',
    seq: 1,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'user',
    data: { action: 'created', reminder_id: 'r1', reminder: reminder() },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Событие `comment.updated` — правка «самого релевантного на вид» вида. */
function commentUpdated(networkId = NET): AnyRealtimeEvent {
  return {
    type: 'comment.updated',
    seq: 10,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data: {
      id: 'c1',
      owner_id: 't1',
      owner_type: 'thought',
      kind: 'permanent',
      changes: { body_md: 'текст' },
      version: 2,
    },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Событие `thought.updated` с полями видимости субъекта напоминания. */
function thoughtUpdated(changes: Record<string, unknown>, networkId = NET): AnyRealtimeEvent {
  return {
    type: 'thought.updated',
    seq: 11,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data: { id: 't1', changes, version: 2 },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Событие `publication.trashed`/`.restored` — корзина субъекта-публикации. */
function publicationLifecycle(type: 'publication.trashed' | 'publication.restored'): AnyRealtimeEvent {
  return {
    type,
    seq: 12,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data: { id: 'p1' },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Событие `user-preference.updated` — пользовательская настройка сети. */
function prefUpdated(key: string, value: unknown): AnyRealtimeEvent {
  return {
    type: 'user-preference.updated',
    seq: 13,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'user',
    data: { key, value },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Дождаться промисов запроса списка. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  body.replaceChildren();
  installDom();
  store.update({ networkId: NET });
  // Дедуп по seq — модульное состояние: без сброса событие теста с тем же seq,
  // что у предыдущего, считалось бы опоздавшим и не дошло до подписок.
  resetEventRouter();
  resetReminderIndicators();
});

afterEach(() => {
  resetReminderIndicators();
  store.update({ networkId: null });
  delete (globalThis as any).window;
});

describe('индикатор напоминаний в облачке (ba827eb6)', () => {
  it('есть напоминание — ячейка активна, нет — приглушена', () => {
    reminderIndicatorInternals.setCache([reminder()]);
    const active = reminderIndicatorCell('t1', 'Мысль');
    assert.ok(active.classList.contains('active'), 'напоминание есть — индикатор активен');
    assert.ok(!active.classList.contains('dim'));

    const empty = reminderIndicatorCell('t2', 'Другая мысль');
    assert.ok(empty.classList.contains('dim'), 'напоминаний нет — индикатор приглушён');
  });

  it('ячейка — Ctrl-триггер предпросмотра списка напоминаний', () => {
    const cell = reminderIndicatorCell('t1', 'Мысль');
    assert.equal(cell.dataset['hpKind'], 'reminder');
    assert.equal(cell.dataset['hpOwnerType'], 'thought');
    assert.equal(cell.dataset['hpOwnerId'], 't1');
    assert.equal(cell.dataset['hpTitle'], 'Мысль');
  });

  it('смена видимости субъекта перечитывает индикаторы облачка (ошибка 71cb791e)', async () => {
    let loads = 0;
    let current: Reminder[] = [reminder()];
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return { reminders: current, from: null, to: null };
        },
      },
    };
    // Стартовая загрузка ставит подписку; корзина субъекта приходит штатным
    // `thought.updated`, а `reminders.changed` на неё сервер не публикует.
    await refreshReminderIndicators();
    const before = loads;
    current = [];
    routeRealtimeEvent(thoughtUpdated({ marked_for_deletion: true }));
    await flush();
    assert.equal(loads, before + 1, 'видимость субъекта изменилась — кэш перечитан');
  });

  it('покраска перерисовывает уже отрисованные облачка из кэша', () => {
    reminderIndicatorInternals.setCache([reminder()]);
    const cloud = new ShimElement('div');
    cloud.className = 'cloud';
    cloud.dataset['id'] = 't1';
    const main = new ShimElement('div');
    main.className = 'cloud-main';
    const ind = new ShimElement('div');
    ind.className = 'cloud-ind';
    ind.append(reminderIndicatorCell('t1', 'Мысль') as unknown as ShimElement);
    main.append(ind);
    cloud.append(main);
    body.append(cloud);

    syncReminderIndicatorCells();
    const cell = cloud.querySelectorAll(`.${REMINDER_INDICATOR_CLASS.replace(' ', '.')}`)[0];
    assert.ok(cell?.classList.contains('active'), 'кэш применён к отрисованному облачку');
  });
});

describe('бейдж «сегодня» на закладке «Дневник» (23887005)', () => {
  it('считает сегодняшние и просроченные вхождения, ноль — скрывает бейдж', async () => {
    const calls: unknown[] = [];
    (globalThis as any).window.etn = {
      reminders: {
        list: async (_networkId: string, _query: unknown) => {
          calls.push(_query);
          return listResult([
            // сегодня (час назад) и просрочка (вчера) — считаются;
            {
              occurrence_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              status: 'active',
              until: null,
            },
            {
              occurrence_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
              status: 'active',
              until: null,
            },
            // через десять дней — ещё не «сегодня».
            {
              occurrence_at: new Date(Date.now() + 10 * DAY_MS).toISOString(),
              status: 'active',
              until: null,
            },
          ]);
        },
      },
    };

    const button = new ShimElement('button');
    let opened = 0;
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => {
        opened += 1;
      },
    });
    await flush();

    const node = button.querySelectorAll('.view-tab-badge')[0];
    assert.ok(node !== undefined, 'бейдж смонтирован в закладку');
    assert.equal(node?.textContent, '2', 'сегодня + просрочка');
    assert.notEqual(node?.hidden, true, 'ненулевой счётчик показывает бейдж');
    // Видимостью владеет ТОЛЬКО атрибут `hidden`: класс `.hidden` из токенов
    // (`display:none !important`) не снимался вместе с атрибутом и оставлял
    // бейдж невидимым (блокер приёмки 173f1540).
    assert.equal(node?.classList.contains('hidden'), false, 'класса hidden нет');
    assert.notEqual(node?.style.display, 'none', 'стиль не прячет бейдж');

    node?.emit('click', { stopPropagation: (): void => undefined } as any);
    assert.equal(opened, 1, 'клик по бейджу открывает сегодня');

    // Ноль — бейдж скрыт (элемент 23887005).
    (globalThis as any).window.etn.reminders.list = async () => listResult([]);
    routeRealtimeEvent(remindersChanged());
    await flush();
    assert.equal(node?.hidden, true, 'ноль скрывает бейдж');
    assert.equal(node?.classList.contains('hidden'), false, 'скрытие — только атрибутом');

    teardown();
    assert.equal(button.querySelectorAll('.view-tab-badge').length, 0, 'teardown снимает бейдж');
    assert.ok(calls.length >= 1, 'окно запроса передано списку');
  });

  it('правка комментария счётчик не пересчитывает (ошибка 39d78d2a)', async () => {
    let loads = 0;
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return listResult([]);
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    await flush();
    const before = loads;
    // «Самая релевантная на вид» правка: СВОЙ постоянный комментарий и
    // `changes.body_md`. Счёт бейджа идёт по строкам `reminders` (субъект —
    // мысль/публикация), текст комментария в него не входит — пересчёт был
    // вхолостую на каждое событие каждого участника сети.
    routeRealtimeEvent(commentUpdated());
    await flush();
    assert.equal(loads, before, 'comment.updated не перечитывает список владельца');
    teardown();
  });

  it('корзина субъекта пересчитывает бейдж (ошибка 71cb791e)', async (t) => {
    let loads = 0;
    let current = listResult([
      {
        occurrence_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        status: 'active',
        until: null,
      },
    ]);
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return current;
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    t.after(teardown);
    await flush();
    const node = button.querySelectorAll('.view-tab-badge')[0];
    assert.equal(node?.textContent, '1', 'напоминание видимо — счёт 1');

    // Корзина субъекта: сервер уже не отдаёт строку (listReminders фильтрует
    // marked_for_deletion), но `reminders.changed` на это действие не приходит.
    current = listResult([]);
    const before = loads;
    routeRealtimeEvent(thoughtUpdated({ marked_for_deletion: true }));
    await flush();
    assert.equal(loads, before + 1, 'thought.updated с marked_for_deletion перечитывает список');
    assert.equal(node?.hidden, true, 'счётчик обнулился — бейдж скрыт');
  });

  it('корзина субъекта-публикации пересчитывает бейдж (ошибка 71cb791e)', async (t) => {
    let loads = 0;
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return listResult([]);
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    t.after(teardown);
    await flush();
    const before = loads;
    // Напоминание адресует и публикацию: её корзина меняет набор строк тем же
    // правилом видимости — класс, а не случай (reminder-service subjectVisibility).
    routeRealtimeEvent(publicationLifecycle('publication.trashed'));
    await flush();
    assert.equal(loads, before + 1, 'publication.trashed перечитывает список владельца');
  });

  it('«показывать неактуальные» пересчитывает бейдж (ошибка 71cb791e)', async (t) => {
    let loads = 0;
    let current = listResult([]);
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return current;
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    t.after(teardown);
    await flush();
    const node = button.querySelectorAll('.view-tab-badge')[0];
    assert.equal(node?.hidden, true, 'неактуальные скрыты — счёт 0');

    // Настройка сети решает, отдаёт ли сервер строки неактуальных субъектов
    // (show_inactive в listReminders) — счётчик обязан перечитаться.
    current = listResult([
      {
        occurrence_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        status: 'active',
        until: null,
      },
    ]);
    const before = loads;
    routeRealtimeEvent(prefUpdated('show_inactive', true));
    await flush();
    assert.equal(loads, before + 1, 'смена show_inactive перечитывает список владельца');
    assert.equal(node?.textContent, '1', 'счётчик обновился по настройке');
  });

  it('правка без смены видимости субъекта счётчик не пересчитывает (граница 39d78d2a)', async (t) => {
    let loads = 0;
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return listResult([]);
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    t.after(teardown);
    await flush();
    const before = loads;
    // Заголовок/синонимы видимость субъекта не меняют: лишнего запроса нет.
    routeRealtimeEvent(thoughtUpdated({ title: 'Новое имя', synonyms: ['x'] }));
    routeRealtimeEvent(prefUpdated('show_trash', true));
    await flush();
    assert.equal(loads, before, 'события вне видимости субъекта список не перечитывают');
  });

  it('reminders.changed пересчитывает счётчик (персональное событие владельца)', async () => {
    let loads = 0;
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return listResult([]);
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    await flush();
    const before = loads;
    routeRealtimeEvent(remindersChanged());
    await flush();
    assert.equal(loads, before + 1, 'reminders.changed перечитывает список владельца');
    teardown();
  });

  it('событие чужой сети бейдж не пересчитывает', async () => {
    let loads = 0;
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          loads += 1;
          return listResult([]);
        },
      },
    };
    const button = new ShimElement('button');
    const teardown = mountReminderTodayBadge(button as unknown as HTMLElement, {
      openToday: () => undefined,
    });
    await flush();
    const before = loads;
    routeRealtimeEvent(remindersChanged('00000000-0000-4000-8000-0000000000ff'));
    await flush();
    assert.equal(loads, before, 'чужое событие не перечитывает список');
    teardown();
  });
});
