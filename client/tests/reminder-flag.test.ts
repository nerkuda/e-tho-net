/**
 * Флаг напоминаний в шапке мысли (0.16.1, задача 173f1540; элемент 24ad3735;
 * доработка по вердикту приёмки).
 *
 * Проверяется ПОВЕДЕНИЕ, а не разметка:
 *  - пустое состояние — ghost-команда «Напомнить…» видима и ведёт в редактор
 *    (другой точки создания первого напоминания в клиенте нет);
 *  - у каждого напоминания в меню СВОЯ подпись (повтор/момент);
 *  - «Отложить»/«Убрать» адресуют ближайшее ВИДИМОЕ вхождение (`occurrence_at`),
 *    а `until` считается от момента ПОКАЗА: после snooze `next_at` — уже момент
 *    показа, и адрес `next_at` сервер отвергает 409 (блокер репроверки);
 *  - цепочка «snooze → dismiss → повторный snooze» проходит без 409;
 *  - вхождений не осталось — пункты «Отложить»/«Убрать» недоступны;
 *  - `reminders.changed` обновляет подпись шапки (второй клиент/панель).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  computeNextAt,
  firstOccurrenceOnOrAfter,
  nextCandidate,
  type AnyRealtimeEvent,
  type Reminder,
  type ReminderException,
  type ReminderListResult,
} from '@etn/shared';

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

/** Отказ сервера «нет активного вхождения» — 409 (как `noActiveOccurrence`). */
function serverConflict(): Error {
  return Object.assign(new Error('the reminder has no active occurrence to process.'), {
    status: 409,
  });
}

/** Граница текущих UTC-суток — нижняя граница поиска вхождения (как на сервере). */
function utcDayStartMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/**
 * Подставной сервер напоминаний: правила `activeOccurrence`/snooze/dismiss из
 * `server/src/domain/reminder-service.ts` на том же движке `@etn/shared`
 * (`firstOccurrenceOnOrAfter`/`nextCandidate`/`computeNextAt`).
 *
 * Нужен, чтобы цепочка команд флага проверялась на НАСТОЯЩЕМ отказе 409, а не
 * на «вызове с такими аргументами»: адрес не-вхождения и адрес уже убранного
 * вхождения сервер отвергает, и регрессия обязана красить тест.
 */
function installStatefulBridge(initial: Reminder): {
  failures: unknown[];
  exceptions: Map<number, ReminderException>;
  nextAt: () => string | null;
} {
  const schedule = initial.schedule;
  const anchorMs = Date.parse(initial.anchor_at);
  const exceptions = new Map<number, ReminderException>();
  const failures: unknown[] = [];
  const nextAt = (): string | null => computeNextAt(schedule, anchorMs, exceptions, Date.now());

  /** Карта исключений в виде DTO (`exceptions`: UTC-момент → исключение). */
  const exceptionsDto = (): Record<string, ReminderException> => {
    const out: Record<string, ReminderException> = {};
    for (const [ms, exception] of exceptions) out[new Date(ms).toISOString()] = exception;
    return out;
  };

  /** Вхождение под команду: явный адрес проверяется по расписанию, как на сервере. */
  const resolve = (requested?: string): number => {
    if (requested !== undefined) {
      const atMs = Date.parse(requested);
      if (firstOccurrenceOnOrAfter(schedule, anchorMs, atMs) !== atMs) throw serverConflict();
      if (exceptions.get(atMs)?.kind === 'dismiss') throw serverConflict();
      return atMs;
    }
    const candidate = nextCandidate(schedule, anchorMs, exceptions, utcDayStartMs(Date.now()));
    if (candidate === null) throw serverConflict();
    return candidate.occurrence_at;
  };

  (globalThis as any).window.etn = {
    reminders: {
      list: async () =>
        listResult([{ ...initial, next_at: nextAt(), exceptions: exceptionsDto() }]),
      snooze: async (...args: unknown[]) => {
        calls.snooze.push(args);
        try {
          const [, , until, requested] = args as [string, string, string, string | undefined];
          const occurrenceMs = resolve(requested);
          const untilMs = Date.parse(until);
          if (!(untilMs > Date.now()) || !(untilMs > occurrenceMs)) throw new Error('until');
          exceptions.set(occurrenceMs, {
            kind: 'snooze',
            until: new Date(untilMs).toISOString(),
          });
        } catch (err) {
          failures.push(err);
          throw err;
        }
        return {};
      },
      dismiss: async (...args: unknown[]) => {
        calls.dismiss.push(args);
        try {
          const [, , requested] = args as [string, string, string | undefined];
          exceptions.set(resolve(requested), { kind: 'dismiss' });
        } catch (err) {
          failures.push(err);
          throw err;
        }
        return {};
      },
      remove: async () => ({}),
    },
  };
  return { failures, exceptions, nextAt };
}

/**
 * Напоминание «каждые 3 дня в 00:00 UTC»: вхождение СЕГОДНЯ уже прошло (или
 * ровно сейчас), ближайшее — через трое суток. Такой ряд ловит подмену адреса:
 * серверное «ближайшее от начала суток» указывает на прошедшее вхождение, а
 * флаг обязан адресовать то, что показано как ближайшее.
 */
function everyThreeDaysReminder(): Reminder {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const anchor = new Date(todayStart).toISOString();
  return reminder({
    id: 'r1',
    kind: 'rule',
    schedule: { type: 'every_days', every: 3 },
    anchor_at: anchor,
    next_at: new Date(todayStart + 3 * DAY_MS).toISOString(),
  });
}

/** Открыть меню флага и вернуть его корень. */
function openFlagMenu(flag: { root: HTMLButtonElement }): ShimElement {
  flag.root.click();
  const menu = body.querySelector('.menu') as ShimElement | null;
  assert.ok(menu !== null, 'меню флага открылось');
  return menu;
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

  it('вхождений не осталось: «Отложить»/«Убрать» недоступны, подменю не раскрывается', async () => {
    const anchor = new Date(Date.now() + 3 * DAY_MS).toISOString();
    // Единственное вхождение уже убрано: `next_at` = null и исключение dismiss.
    const entry = reminder({
      id: 'r1',
      next_at: null,
      anchor_at: anchor,
      exceptions: { [anchor]: { kind: 'dismiss' } },
    });
    installBridge(() => listResult([entry]));
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    const sub = expand(openFlagMenu(flag), reminderLabel(entry));
    const snoozeRow = rowByLabel(sub, t('reminder.snoozeOccurrence'));
    assert.ok(snoozeRow !== null, 'пункт «Отложить» есть в меню');
    assert.ok(
      snoozeRow!.classList.contains('menu-item-disabled'),
      '«Отложить» помечен недоступным',
    );
    snoozeRow!.emit('mouseenter');
    assert.equal(
      sub.querySelectorAll(':scope > .menu-sub').length,
      0,
      'подменю недоступного пункта не раскрывается',
    );

    const dismissRow = rowByLabel(sub, t('reminder.dismissOccurrence'));
    assert.ok(dismissRow !== null, 'пункт «Убрать» есть в меню');
    assert.ok(dismissRow!.classList.contains('menu-item-disabled'), '«Убрать» помечен недоступным');
    dismissRow!.click();
    await flush();
    assert.equal(calls.dismiss.length, 0, 'клик по недоступному пункту команду не шлёт');
  });
});

describe('флаг напоминаний — цепочка вхождений (регресс 409)', () => {
  it('snooze → dismiss → повторный snooze проходят без 409', async () => {
    const entry = everyThreeDaysReminder();
    const server = installStatefulBridge(entry);
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    const occurrence = Date.parse(entry.next_at!);

    // 1. «Отложить» на сутки: адрес — момент вхождения, until — момент показа + сутки.
    const snoozeOne = expand(
      expand(openFlagMenu(flag), reminderLabel(entry)),
      t('reminder.snoozeOccurrence'),
    );
    const dayRow = rowByLabel(snoozeOne, t('tasks.shiftDay'));
    assert.ok(dayRow !== null, 'сдвиг на сутки есть');
    dayRow!.click();
    await flush();

    assert.deepEqual(server.failures, [], 'первый snooze не получил отказа сервера');
    const firstUntil = new Date(occurrence + DAY_MS).toISOString();
    assert.deepEqual(server.exceptions.get(occurrence), {
      kind: 'snooze',
      until: firstUntil,
    });
    assert.equal(server.nextAt(), firstUntil, 'после snooze next_at — момент показа');

    // 2. «Убрать» отложенное вхождение: адрес тот же момент вхождения, не `next_at`.
    const dismissRow = rowByLabel(
      expand(openFlagMenu(flag), reminderLabel(entry)),
      t('reminder.dismissOccurrence'),
    );
    assert.ok(dismissRow !== null, 'пункт «Убрать» есть в меню');
    dismissRow!.click();
    await flush();

    assert.deepEqual(server.failures, [], 'убрать отложенное вхождение — без 409');
    assert.deepEqual(server.exceptions.get(occurrence), { kind: 'dismiss' });
    const nextOccurrence = occurrence + 3 * DAY_MS;
    assert.equal(server.nextAt(), new Date(nextOccurrence).toISOString());

    // 3. Повторный «Отложить» уже следующее вхождение — тем же способом.
    const snoozeTwo = expand(
      expand(openFlagMenu(flag), reminderLabel(entry)),
      t('reminder.snoozeOccurrence'),
    );
    const dayRowTwo = rowByLabel(snoozeTwo, t('tasks.shiftDay'));
    assert.ok(dayRowTwo !== null, 'сдвиг на сутки есть и после уборки');
    dayRowTwo!.click();
    await flush();

    assert.deepEqual(server.failures, [], 'повторный snooze — без 409');
    assert.deepEqual(server.exceptions.get(nextOccurrence), {
      kind: 'snooze',
      until: new Date(nextOccurrence + DAY_MS).toISOString(),
    });
    assert.equal(server.nextAt(), new Date(nextOccurrence + DAY_MS).toISOString());
    assert.equal(calls.snooze.length, 2, 'две команды «Отложить»');
    assert.equal(calls.dismiss.length, 1, 'одна команда «Убрать»');
  });

  it('повторный snooze сразу после snooze адресует то же вхождение', async () => {
    // Разделение покрытия (приёмка 0.16.1): регресс «snooze без адреса вхождения
    // берёт ближайшее» ловит ИМЕННО эта цепочка — после первого snooze `next_at`
    // = until, а ближайшее вхождение уже НЕ равно адресуемому. Цепочка
    // «snooze → dismiss → повторный snooze» на том же регрессе остаётся зелёной:
    // после dismiss ближайшее вхождение снова совпадает с адресованным, и
    // отсутствие проброса occurrence_at маскируется. Не «упрощайте» этот
    // тест до одной цепочки — вторая половина покрытия держится здесь.
    const entry = everyThreeDaysReminder();
    const server = installStatefulBridge(entry);
    const flag = createReminderFlag({
      networkId: NET,
      thoughtId: 't1',
      thoughtTitle: 'Мысль',
      openEditor: async () => null,
    });
    await flush();

    const occurrence = Date.parse(entry.next_at!);
    const snoozeDay = (): void => {
      const sub = expand(
        expand(openFlagMenu(flag), reminderLabel(entry)),
        t('reminder.snoozeOccurrence'),
      );
      const row = rowByLabel(sub, t('tasks.shiftDay'));
      assert.ok(row !== null, 'сдвиг на сутки есть');
      row!.click();
    };

    snoozeDay();
    await flush();
    const firstUntil = new Date(occurrence + DAY_MS).toISOString();
    assert.deepEqual(server.failures, [], 'первый snooze без отказа сервера');
    assert.equal(server.nextAt(), firstUntil);

    // Второе «Отложить»: `next_at` теперь момент показа, адрес — то же вхождение.
    snoozeDay();
    await flush();

    assert.deepEqual(server.failures, [], 'повторный snooze после snooze — без 409');
    assert.deepEqual(server.exceptions.get(occurrence), {
      kind: 'snooze',
      until: new Date(occurrence + 2 * DAY_MS).toISOString(),
    });
    assert.equal(calls.snooze.length, 2);
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
