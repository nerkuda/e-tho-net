/**
 * Флаг напоминаний в шапке мысли (0.16.1, задача 173f1540; элемент 24ad3735;
 * доработка по вердикту приёмки).
 *
 * Проверяется ПОВЕДЕНИЕ, а не разметка:
 *  - пустое состояние — ghost-команда «Напомнить…» видима и ведёт в редактор
 *    (другой точки создания первого напоминания в клиенте нет);
 *  - у каждого напоминания в меню СВОЯ подпись (повтор/момент);
 *  - «Отложить» считается от МОМЕНТА ВХОЖДЕНИЯ и адресует его (`occurrence_at`),
 *    иначе сервер отвечает 400 для вхождений дальше суток;
 *  - «Убрать» адресует то же вхождение;
 *  - `reminders.changed` обновляет подпись шапки (второй клиент/панель).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AnyRealtimeEvent, Reminder, ReminderListResult } from '@etn/shared';

import { shiftInstant } from '../src/renderer/lib/dates.js';
import { t } from '../src/renderer/lib/i18n.js';
import { routeRealtimeEvent, resetEventRouter } from '../src/renderer/lib/live/event-router.js';
import { reminderLabel } from '../src/renderer/lib/reminder-label.js';
import {
  createReminderFlag,
  resetReminderFlagsForTests,
  type ReminderEditorOpener,
} from '../src/renderer/editor/reminder-flag.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '00000000-0000-4000-8000-0000000000aa';
const DAY_MS = 86_400_000;

const body = new ShimElement('body');

/** Минимальный документ/окно: флаг и меню работают с DOM. */
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

/** Карточка напоминания с заданным ближайшим вхождением. */
function reminder(overrides: Partial<Reminder> = {}): Reminder {
  const anchor = new Date(Date.now() + 3 * DAY_MS).toISOString();
  return {
    id: 'r1',
    user_id: 'u1',
    subject_type: 'thought',
    subject_id: 't1',
    subject_state: 'active',
    kind: 'one',
    schedule: { type: 'once' },
    anchor_at: anchor,
    next_at: anchor,
    exceptions: {},
    state: 'active',
    created_at: anchor,
    updated_at: anchor,
    ...overrides,
  } as unknown as Reminder;
}

/** Выдача списка владельца. */
function listResult(reminders: Reminder[]): ReminderListResult {
  return { reminders, from: null, to: null };
}

/** Событие `reminders.changed` (персональное, приходит только владельцу). */
function remindersChanged(networkId = NET, seq = 3): AnyRealtimeEvent {
  return {
    type: 'reminders.changed',
    seq,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    audience: 'user',
    network_id: networkId,
    data: { action: 'updated', reminder_id: 'r1', reminder: reminder() },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Дождаться промисов запросов и отрисовки. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Прямые пункты меню (без подменю). */
function menuRows(menu: ShimElement): ShimElement[] {
  return menu.querySelectorAll(':scope > .menu-item');
}

/** Раскрытое подменю меню (одноуровневое, лежит внутри корня). */
function openSubmenu(menu: ShimElement): ShimElement | null {
  return menu.querySelectorAll(':scope > .menu-sub')[0] ?? null;
}

/** Пункт меню по вхождению подписи. */
function rowByLabel(menu: ShimElement, label: string): ShimElement | null {
  return menuRows(menu).find((row) => row.textContent.includes(label)) ?? null;
}

/** Раскрыть подменю пункта по подписи и вернуть его. */
function expand(menu: ShimElement, label: string): ShimElement {
  const row = rowByLabel(menu, label);
  assert.ok(row !== null, `пункт «${label}» есть в меню`);
  row!.emit('mouseenter');
  const sub = openSubmenu(menu);
  assert.ok(sub !== null, `подменю «${label}» раскрылось`);
  return sub!;
}

interface Calls {
  list: unknown[][];
  snooze: unknown[][];
  dismiss: unknown[][];
}

let calls: Calls;

/** Мост `window.etn` с записью вызовов напоминаний. */
function installBridge(result: () => ReminderListResult): void {
  (globalThis as any).window.etn = {
    reminders: {
      list: async (...args: unknown[]) => {
        calls.list.push(args);
        return result();
      },
      snooze: async (...args: unknown[]) => {
        calls.snooze.push(args);
        return {};
      },
      dismiss: async (...args: unknown[]) => {
        calls.dismiss.push(args);
        return {};
      },
      remove: async () => ({}),
    },
  };
}

beforeEach(() => {
  body.replaceChildren();
  installDom();
  resetReminderFlagsForTests();
  resetEventRouter();
  store.update({ networkId: NET });
  calls = { list: [], snooze: [], dismiss: [] };
});

afterEach(() => {
  resetReminderFlagsForTests();
  store.update({ networkId: null });
  delete (globalThis as any).window;
});

describe('флаг напоминаний — пустое состояние (блокер приёмки)', () => {
  it('без напоминаний показывает «Напомнить…» и открывает редактор', async () => {
    installBridge(() => listResult([]));
    const opened: unknown[] = [];
    const openEditor: ReminderEditorOpener = async (options) => {
      opened.push(options);
      return null;
    };
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor,
    });
    await flush();

    assert.equal(flag.root.hidden, false, 'флаг видим при нуле напоминаний');
    assert.equal(flag.root.textContent, t('reminder.addFlag'), 'это команда создания');

    flag.root.click();
    assert.equal(opened.length, 1, 'клик ведёт в редактор напоминания');
    assert.equal((opened[0] as { subjectId: string }).subjectId, 't1');
  });

  it('снятое напоминание не запирает пустое состояние', async () => {
    installBridge(() => listResult([reminder({ state: 'removed' as Reminder['state'] })]));
    const opened: unknown[] = [];
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async (options) => {
        opened.push(options);
        return null;
      },
    });
    await flush();
    assert.equal(flag.root.textContent, t('reminder.addFlag'), 'команда создания на месте');
    flag.root.click();
    assert.equal(opened.length, 1, 'клик ведёт в редактор, а не в меню снятого');
  });

  it('ошибка списка прячет флаг: команда не должна обещать недоступное сохранение', async () => {
    (globalThis as any).window.etn = {
      reminders: {
        list: async () => {
          throw new Error('нет связи');
        },
      },
    };
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();
    assert.equal(flag.root.hidden, true);
  });
});

describe('флаг напоминаний — меню и вхождения', () => {
  it('подпись напоминания своя у каждого пункта подменю', async () => {
    const once = reminder({ id: 'r1', kind: 'one' });
    const yearly = reminder({
      id: 'r2',
      kind: 'rule',
      schedule: { type: 'yearly', month: 3, day: 8 },
    });
    installBridge(() => listResult([once, yearly]));
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    flag.root.click();
    const menu = body.querySelector('.menu') as ShimElement | null;
    assert.ok(menu !== null, 'меню открылось');
    const labels = menuRows(menu!).map((row) => row.textContent);
    assert.ok(
      labels.some((label) => label.startsWith(reminderLabel(once))),
      `пункт «${reminderLabel(once)}»`,
    );
    assert.ok(
      labels.some((label) => label.startsWith(reminderLabel(yearly))),
      `пункт «${reminderLabel(yearly)}»`,
    );
    assert.equal(
      new Set([reminderLabel(once), reminderLabel(yearly)]).size,
      2,
      'подписи разных напоминаний различаются',
    );
  });

  it('«Отложить» считает until от вхождения и адресует его (200, не 400)', async () => {
    const occurrence = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const entry = reminder({ id: 'r1', next_at: occurrence, anchor_at: occurrence });
    installBridge(() => listResult([entry]));
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    flag.root.click();
    const menu = body.querySelector('.menu') as ShimElement | null;
    const sub = expand(menu!, reminderLabel(entry));
    const snooze = expand(sub, t('reminder.snoozeOccurrence'));
    const day = rowByLabel(snooze, t('tasks.shiftDay'));
    assert.ok(day !== null, 'сдвиг на сутки есть');
    day!.click();
    await flush();

    assert.equal(calls.snooze.length, 1, 'snooze вызван один раз');
    const [networkId, id, until, occurrenceAt] = calls.snooze[0]! as [
      string,
      string,
      string,
      string,
    ];
    assert.equal(networkId, NET);
    assert.equal(id, 'r1');
    assert.equal(occurrenceAt, occurrence, 'адрес вхождения — само вхождение');
    assert.equal(until, shiftInstant(occurrence, { days: 1 }), 'until = вхождение + сутки');
    assert.ok(
      Date.parse(until) > Date.parse(occurrence),
      'until строго позже вхождения (иначе сервер отвечает 400)',
    );
  });

  it('«Убрать» адресует то же вхождение', async () => {
    const occurrence = new Date(Date.now() + 5 * DAY_MS).toISOString();
    const entry = reminder({ id: 'r1', next_at: occurrence, anchor_at: occurrence });
    installBridge(() => listResult([entry]));
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    flag.root.click();
    const menu = body.querySelector('.menu') as ShimElement | null;
    const sub = expand(menu!, reminderLabel(entry));
    const dismiss = rowByLabel(sub, t('reminder.dismissOccurrence'));
    assert.ok(dismiss !== null);
    dismiss!.click();
    await flush();

    assert.equal(calls.dismiss.length, 1);
    const [networkId, id, occurrenceAt] = calls.dismiss[0]! as [string, string, string];
    assert.equal(networkId, NET);
    assert.equal(id, 'r1');
    assert.equal(occurrenceAt, occurrence);
  });
});

describe('флаг напоминаний — события', () => {
  it('reminders.changed обновляет подпись шапки', async () => {
    let current = listResult([]);
    installBridge(() => current);
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();
    assert.equal(flag.root.textContent, t('reminder.addFlag'));

    const entry = reminder();
    current = listResult([entry]);
    routeRealtimeEvent(remindersChanged());
    await flush();
    assert.equal(flag.root.textContent, reminderLabel(entry), 'подпись перечитана по событию');

    // Событие чужой сети — без перечитывания.
    const before = calls.list.length;
    routeRealtimeEvent(remindersChanged('00000000-0000-4000-8000-0000000000ff', 7));
    await flush();
    assert.equal(calls.list.length, before, 'чужое событие не перечитывает список');
  });
});
