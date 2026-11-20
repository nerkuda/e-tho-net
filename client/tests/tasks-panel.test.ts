/**
 * Компонента панели «Задачи и напоминания» `lib/ui/task-panel.ts` (0.16.1,
 * задача 64f7976a; элементы f76ed829/15f8ea2f/498f23e0).
 *
 * Проверяется поведение, которое нельзя выразить чистой моделью:
 *  • секции и строки строятся по снимку, unknown-узлы переживают повторный
 *    render (keyed-сверка);
 *  • чекбокс — одиночный клик, без режима правки; на серой строке он работает,
 *    а правка текста — нет (ошибка d318a647);
 *  • панель, группы и секции сворачиваются штатной группой `lib/ui/collapsible`,
 *    счётчики видны и в свёрнутом виде, состояние читается у экрана (d0801eea);
 *  • «Перенести на дату» доступно бессрочной строке, «Сделать бессрочной» —
 *    только строке с датами (ошибки 3f9ea2ee/3cef7466);
 *  • «Обновить» подсвечивается при устаревании, «Отменить» скрыта без команды;
 *  • двойной клик по тексту открывает инлайн-правку, Escape отменяет её через
 *    общий диспетчер клавиш (ADR b420b08c), сохраняет — Enter/`editLine`.
 *
 * DOM — общий шим `./dom-shim.js`; подписи берутся из словаря (`t()`), поэтому
 * тексты сверяются тем же вызовом, а структурные правила — по классам и данным.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { t } from '../src/renderer/lib/i18n.js';
import {
  TASK_PANEL_SECTION_CLASS,
  mountTaskPanel,
  staleTaskRowOf,
  type ReminderPanelRow,
  type TaskPanelActions,
  type TaskPanelOptions,
  type TaskPanelRow,
  type TaskPanelView,
  type TaskRowEditor,
  type TaskRowEditorFactory,
  type TaskRowEditorOptions,
} from '../src/renderer/lib/ui/task-panel.js';
import { replaceTaskLine } from '../src/renderer/lib/ui/task-panel-model.js';
import { todayLocal } from '../src/renderer/lib/dates.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный `CustomEvent`: шиму нужен `type`, продукту — `detail`. */
class ShimCustomEvent {
  readonly type: string;
  readonly detail: unknown;
  readonly bubbles: boolean;

  constructor(type: string, init: { detail?: unknown; bubbles?: boolean } = {}) {
    this.type = type;
    this.detail = init.detail;
    this.bubbles = init.bubbles === true;
  }
}

/** Поднять минимальные глобалы DOM: без них фасады `el`/`div` не построят узлы. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    // Навигация списка (`createListNav`) вешает глобальные слушатели на
    // документ; в тесте они не срабатывают, но обязаны существовать.
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelector: (): null => null,
    activeElement: null,
  };
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).HTMLElement = ShimElement;
  // Меню (`showMenuAt`) позиционируется по `window` и вешает слушатели.
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
}

/** Наблюдения вызовов действий панели за один прогон. */
interface Calls {
  refresh: number;
  undo: number;
  showDone: boolean[];
  toggles: Array<{ key: string; done: boolean }>;
  edits: Array<{ key: string; text: string }>;
  rowCommands: string[];
  bulk: Array<{ command: string; filter: unknown; shift?: unknown }>;
  reminderActions: string[];
  reminderGroupDismiss: string[];
  days: string[];
  rawLines: number;
  /** Высоты панели, записанные экраном (пункт B ТЗ 2026-11-17). */
  panelHeights: number[];
  /** Открытые поля правки строки: панель отдаёт данные фабрике компоненты. */
  rowEditors: Array<{ options: TaskRowEditorOptions; root: ShimElement }>;
}

/**
 * Подделка компоненты редактирования комментария: панель получает поле
 * ФАБРИКОЙ (§1 ТЗ 2026-11-18), поэтому её собственные тесты проверяют проводку
 * «двойной клик → сырая строка → сохранение/закрытие», а поведение Ctrl+Enter,
 * Tab/Shift+Tab и CM6 — тест самой компоненты (`task-row-editor.test.ts`).
 */
function fakeRowEditor(calls: Calls): TaskRowEditorFactory {
  return (options: TaskRowEditorOptions): TaskRowEditor => {
    const root = new ShimElement('div', 'md-field ui-task-row-md');
    for (const cls of options.classes) root.classList.add(cls);
    calls.rowEditors.push({ options, root });
    return {
      root: root as unknown as HTMLElement,
      focus: () => undefined,
      dispose: () => root.remove(),
    };
  };
}

/** Сохранить открытую правку так, как это делает компонента: `save` → `closed`. */
async function commitRowEditor(calls: Calls, md: string): Promise<void> {
  const editor = calls.rowEditors[calls.rowEditors.length - 1];
  assert.ok(editor, 'поле правки открыто');
  if (await editor.options.save(md)) editor.options.closed();
  await flush();
}

/** Строка панели (view-модель) с адресом проекции. */
function taskRow(overrides: Partial<TaskPanelRow> = {}): TaskPanelRow {
  return {
    key: 'c1:0',
    commentId: 'c1',
    ownerType: 'thought',
    ownerId: 't1',
    lineNo: 0,
    text: 'задача',
    done: false,
    stale: false,
    subtask: false,
    periodFrom: null,
    due: '2026-11-14',
    kind: 'permanent',
    subjectThoughts: [],
    subjectId: null,
    day: '2026-11-14',
    overdue: false,
    children: [],
    ...overrides,
  };
}

/** Снимок панели с одной секцией и одной подгруппой. */
function panelView(rows: TaskPanelRow[], overrides: Partial<TaskPanelView> = {}): TaskPanelView {
  return {
    stale: false,
    periodFilter: { scope: 'open', from: '2026-11-14', to: '2026-11-20', today: '2026-11-14' },
    canUndo: false,
    showDone: false,
    counters: { open: rows.length, done: 0 },
    reminderCount: 0,
    taskSections: [
      {
        key: 'period',
        title: 'section-main',
        subgroups: [
          {
            key: 'date:2026-11-14',
            title: '14.11.2026',
            kind: 'dates',
            filter: { scope: 'open', from: '2026-11-14', to: '2026-11-14' },
            rows,
          },
        ],
      },
    ],
    reminderSections: [],
    loading: false,
    error: null,
    ...overrides,
  };
}

/** Смонтировать панель с журналом вызовов и хостом шима. */
function mount(
  rows: TaskPanelRow[] = [taskRow()],
  overrides: Partial<TaskPanelActions> = {},
  options: TaskPanelOptions = {},
): {
  host: ShimElement;
  calls: Calls;
  render: (view: TaskPanelView) => void;
  destroy: () => void;
} {
  installShim();
  keymap.keymapInternals.reset();
  const host = new ShimElement('div');
  const calls: Calls = {
    refresh: 0,
    undo: 0,
    showDone: [],
    toggles: [],
    edits: [],
    rowCommands: [],
    bulk: [],
    reminderActions: [],
    reminderGroupDismiss: [],
    days: [],
    rawLines: 0,
    panelHeights: [],
    rowEditors: [],
  };
  const actions: TaskPanelActions = {
    refresh: () => {
      calls.refresh += 1;
    },
    undo: () => {
      calls.undo += 1;
    },
    setShowDone: (show) => {
      calls.showDone.push(show);
    },
    toggle: (row, done) => {
      calls.toggles.push({ key: row.key, done });
    },
    loadRawLine: async (row) => {
      calls.rawLines += 1;
      return `- [ ] ${row.text}`;
    },
    editLine: async (row, text) => {
      calls.edits.push({ key: row.key, text });
      return true;
    },
    rowCommand: (row, command, shift) => {
      calls.rowCommands.push(`${row.key}:${command}`);
      if (shift !== undefined) calls.rowCommands.push(JSON.stringify(shift));
    },
    bulk: (filter, command, shift) => {
      calls.bulk.push({ command, filter, shift });
    },
    reminderAction: (row, action, until) => {
      calls.reminderActions.push(`${row.key}:${action}${until === undefined ? '' : `:${until}`}`);
    },
    reminderGroupDismiss: (title, rows) => {
      calls.reminderGroupDismiss.push(`${title}:${rows.map((row) => row.key).join(',')}`);
    },
    pickDate: async () => '2026-11-20',
    pickDateTime: async () => '2026-11-20T12:00:00.000Z',
    openDay: (day) => {
      calls.days.push(day);
    },
    renderText: (node, row) => {
      node.textContent = row.text;
    },
    // Высота панели (пункт B ТЗ 2026-11-17): экран хранит её сам, панель читает.
    panelHeight: () => calls.panelHeights[calls.panelHeights.length - 1] ?? null,
    setPanelHeight: (height) => {
      calls.panelHeights.push(height);
    },
  };
  const handle = mountTaskPanel(
    host as unknown as HTMLElement,
    { ...actions, ...overrides },
    {
      createRowEditor: fakeRowEditor(calls),
      ...options,
    },
  );
  handle.render(panelView(rows));
  return {
    host,
    calls,
    render: (view) => handle.render(view),
    destroy: () => handle.destroy(),
  };
}

const rowsOf = (host: ShimElement): ShimElement[] =>
  host.querySelectorAll('[data-row-key]') as unknown as ShimElement[];

/** Подпись пункта меню без служебной стрелки подменю (`▸`). */
function menuLabel(node: ShimElement): string {
  return node.flatText().trim().replace(/\s*▸$/, '');
}

/** Строка открытого меню по её подписи (меню и подменю рисуются одним списком). */
function menuRowByLabel(root: ShimElement, label: string): ShimElement {
  const row = root.querySelectorAll('.menu-item').find((node) => menuLabel(node) === label.trim());
  assert.ok(row, `пункт «${label}» есть в меню`);
  return row as unknown as ShimElement;
}

/** Снимок панели с одной группой напоминаний (строки — в подгруппе даты). */
function remindersView(rows: ReminderPanelRow[]): TaskPanelView {
  return panelView([], {
    reminderCount: rows.length,
    reminderSections: [
      {
        key: 'today',
        title: 'Сегодня',
        subgroups: [
          { key: 'date:2026-11-14', title: '14.11.2026', kind: 'dates', filter: {}, rows },
        ],
      },
    ],
  });
}

/** Открыть меню команд строки напоминания; корень меню живёт в `document.body`. */
function openReminderMenu(host: ShimElement): ShimElement {
  const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
  const button = host.querySelector('.ui-reminder-row-menu') as unknown as ShimElement;
  assert.ok(button, 'у строки напоминания есть меню команд');
  button.emit('click', {
    target: button,
    currentTarget: button,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
  const root = body.querySelector('.menu') as unknown as ShimElement | null;
  assert.ok(root, 'меню строки открыто');
  return root;
}

/** Открыть подменю «Отложить…» и вернуть сам список подменю. */
function openSnoozeSubmenu(host: ShimElement): ShimElement {
  const root = openReminderMenu(host);
  menuRowByLabel(root, t('tasks.snoozeReminder')).emit('mouseenter');
  const sub = root.querySelector('.menu-sub') as unknown as ShimElement | null;
  assert.ok(sub, 'подменю «Отложить…» строится по наведению (ленивая сборка меню)');
  return sub;
}

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const TASK_PANEL_CSS = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'ui', 'task-panel.css');

/**
 * Тела правил, в списке селекторов которых есть РОВНО `selector`. Один и тот же
 * класс в файле объявлен несколькими блоками (базовая раскладка + состояния),
 * поэтому карта «селектор → тело» потеряла бы часть правил.
 */
function ruleBodies(css: string, selector: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) bodies.push(match[2]!);
  }
  return bodies;
}

/** Дождаться промисов загрузки сырой строки и ответа `editLine`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('панель задач: секции, строки и счётчики (6762adb0)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('секции идут в порядке снимка, строки — по ключу проекции', () => {
    const { host, destroy } = mount([
      taskRow(),
      taskRow({ key: 'c1:1', lineNo: 1, text: 'вторая' }),
    ]);
    const sections = host.querySelectorAll(`.${TASK_PANEL_SECTION_CLASS}`);
    assert.deepEqual(
      sections.map((section) => section.getAttribute('data-section')),
      ['period'],
    );
    assert.deepEqual(
      host.querySelectorAll('[data-row-key]').map((row) => row.getAttribute('data-row-key')),
      ['c1:0', 'c1:1'],
    );
    destroy();
  });

  it('счётчики группы и количество строк в подгруппе на месте', () => {
    const { host, render, destroy } = mount([taskRow(), taskRow({ key: 'c1:1', lineNo: 1 })]);
    const counters = host.querySelector('.ui-task-group-counters');
    // Формат заголовка группы — DoD E: «Задачи (n открыто · n выполнено)»;
    // скобки — часть строки словаря (замечание проверки 2026-11-17).
    assert.equal(counters?.textContent, '(2 открыто · 0 выполнено)');
    render(panelView([taskRow()]));
    assert.equal(host.querySelector('.ui-task-subgroup-count')?.textContent, '1');
    destroy();
  });

  it('чекбокс — одиночный клик: включает задачу без режима правки', () => {
    const { host, calls, destroy } = mount();
    const check = host.querySelector('.ui-task-row-check') as unknown as ShimElement;
    assert.equal(check.type, 'checkbox');
    check.checked = true;
    check.emit('change');
    assert.deepEqual(calls.toggles, [{ key: 'c1:0', done: true }]);
    assert.equal(host.querySelector('.ui-task-row-edit'), null, 'правка не открывается');
    destroy();
  });

  it('серая строка: чекбокс работает, правка текста не открывается', () => {
    const { host, calls, destroy } = mount([taskRow({ stale: true })]);
    const row = rowsOf(host)[0]!;
    assert.ok(row.classList.contains('is-stale'));
    const check = row.querySelector('.ui-task-row-check') as unknown as ShimElement;
    assert.equal(
      check.disabled,
      false,
      'чекбокс — команда, а не правка текста: он работает и на серой строке (d318a647)',
    );
    check.checked = true;
    check.emit('change');
    assert.deepEqual(calls.toggles, [{ key: 'c1:0', done: true }], 'клик ушёл в экран');
    const text = row.querySelector('.ui-task-row-text') as unknown as ShimElement;
    text.emit('dblclick', {});
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'текст серой строки не правится');
    destroy();
  });

  it('staleTaskRowOf: находит серую строку из её чипа, у свежей — null', () => {
    const { host, destroy } = mount([
      taskRow({ stale: true }),
      taskRow({ key: 'c1:1', lineNo: 1 }),
    ]);
    const rows = rowsOf(host);
    const staleText = rows[0]!.querySelector('.ui-task-row-text') as unknown as ShimElement;
    assert.equal(
      staleTaskRowOf(staleText as unknown as HTMLElement),
      rows[0],
      'маркер серой строки — в её узле (один источник для меню строки и меню чипа)',
    );
    const freshText = rows[1]!.querySelector('.ui-task-row-text') as unknown as ShimElement;
    assert.equal(staleTaskRowOf(freshText as unknown as HTMLElement), null, 'свежая строка — null');
    destroy();
  });

  it('массовая команда «за период» адресует период ленты, а не всю сеть', () => {
    const { host, calls, destroy } = mount();
    const menuButton = host.querySelector('.ui-task-group-menu') as unknown as ShimElement;
    menuButton.emit('click', {
      target: menuButton,
      currentTarget: menuButton,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.cancelAllPeriod')));
    assert.ok(item, 'пункт «Отменить все невыполненные за период» в меню');
    item!.click();
    assert.equal(calls.bulk.length, 1);
    assert.deepEqual(calls.bulk[0]!.filter, {
      scope: 'open',
      from: '2026-11-14',
      to: '2026-11-20',
      today: '2026-11-14',
    });
    assert.equal(calls.bulk[0]!.command, 'cancel-all');
    destroy();
  });

  it('групповая команда «Отменить все напоминания» адресует вхождения группы', () => {
    const rows: ReminderPanelRow[] = [
      {
        key: 'r1:2026-11-14T09:00:00.000Z',
        reminderId: 'r1',
        subjectType: 'thought',
        subjectId: 't1',
        title: 'Мысль',
        moment: '2026-11-14T09:00:00.000Z',
        occurrenceAt: '2026-11-14T09:00:00.000Z',
        status: 'active',
        repeat: 'однократно',
        day: '2026-11-14',
      },
      {
        key: 'r2:2026-11-14T10:00:00.000Z',
        reminderId: 'r2',
        subjectType: 'thought',
        subjectId: 't2',
        title: 'Вторая',
        moment: '2026-11-14T10:00:00.000Z',
        occurrenceAt: '2026-11-14T10:00:00.000Z',
        status: 'active',
        repeat: 'ежегодно 8 марта',
        day: '2026-11-14',
      },
    ];
    const { host, calls, render, destroy } = mount([]);
    render(
      panelView([], {
        reminderCount: rows.length,
        reminderSections: [
          {
            key: 'today',
            title: 'Сегодня',
            subgroups: [
              {
                key: 'date:2026-11-14',
                title: '14.11.2026',
                kind: 'dates',
                filter: {},
                rows,
              },
            ],
          },
        ],
      }),
    );
    const reminderGroup = host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
    const menuButton = reminderGroup.querySelector(
      '.ui-task-subgroup-menu',
    ) as unknown as ShimElement;
    assert.ok(menuButton, 'у подгруппы напоминаний есть меню команд');
    menuButton.emit('click', {
      target: menuButton,
      currentTarget: menuButton,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('reminder.groupDismiss')));
    assert.ok(item, 'пункт «Отменить все напоминания по группе» в меню');
    item!.click();
    assert.deepEqual(calls.reminderGroupDismiss, [
      `14.11.2026:${rows.map((row) => row.key).join(',')}`,
    ]);
    destroy();
  });

  it('меню строки напоминания: «Изменить расписание» и адрес вхождения', () => {
    const rows: ReminderPanelRow[] = [
      {
        key: 'r1:2026-11-14T09:00:00.000Z',
        reminderId: 'r1',
        subjectType: 'thought',
        subjectId: 't1',
        title: 'Мысль',
        moment: '2026-11-14T09:00:00.000Z',
        occurrenceAt: '2026-11-14T09:00:00.000Z',
        status: 'active',
        repeat: 'однократно',
        day: '2026-11-14',
      },
    ];
    const { host, calls, render, destroy } = mount([]);
    render(
      panelView([], {
        reminderCount: rows.length,
        reminderSections: [
          {
            key: 'today',
            title: 'Сегодня',
            subgroups: [
              { key: 'date:2026-11-14', title: '14.11.2026', kind: 'dates', filter: {}, rows },
            ],
          },
        ],
      }),
    );
    const reminderGroup = host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
    const menuButton = reminderGroup.querySelector(
      '.ui-reminder-row-menu',
    ) as unknown as ShimElement;
    assert.ok(menuButton, 'у строки напоминания есть меню команд');
    menuButton.emit('click', {
      target: menuButton,
      currentTarget: menuButton,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const edit = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('reminder.editSchedule')));
    assert.ok(edit, 'пункт «Изменить расписание» в меню строки');
    edit!.click();
    assert.deepEqual(calls.reminderActions, [`${rows[0]!.key}:edit-schedule`]);
    destroy();
  });

  /** Вхождение напоминания для проверок «сегодня» (момент показа = вхождения). */
  function reminderRow(moment: string): ReminderPanelRow {
    return {
      key: `r1:${moment}`,
      reminderId: 'r1',
      subjectType: 'thought',
      subjectId: 't1',
      title: 'Мысль',
      moment,
      occurrenceAt: moment,
      status: 'active',
      repeat: 'однократно',
      day: '2026-11-14',
    };
  }

  /** Момент сегодняшних суток со временем суток `iso` (ожидаемый «сегодня»). */
  function todayAt(iso: string, base: Date): number {
    const source = new Date(iso);
    return new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      source.getHours(),
      source.getMinutes(),
      source.getSeconds(),
      source.getMilliseconds(),
    ).getTime();
  }

  it('меню строки напоминания: пять команд и подменю «Отложить…» от момента вхождения', async (test) => {
    const rows: ReminderPanelRow[] = [
      {
        key: 'r1:2026-11-14T09:00:00.000Z',
        reminderId: 'r1',
        subjectType: 'thought',
        subjectId: 't1',
        title: 'Мысль',
        moment: '2026-11-14T09:00:00.000Z',
        occurrenceAt: '2026-11-14T09:00:00.000Z',
        status: 'active',
        repeat: 'однократно',
        day: '2026-11-14',
      },
    ];
    const key = rows[0]!.key;
    // Пункт «сегодня» зависит от ТЕКУЩИХ локальных суток, поэтому «сейчас»
    // фиксируется: сегодняшний час вхождения должен быть ещё впереди, иначе
    // пункт штатно недоступен (см. следующий кейс).
    const now = new Date('2026-11-20T06:00:00.000Z');
    /** Сегодняшние сутки со временем суток вхождения — ожидаемый `until`. */
    const expectedToday = new Date(todayAt(rows[0]!.moment, now)).toISOString();
    test.mock.timers.enable({ apis: ['Date'] });
    test.mock.timers.setTime(now.getTime());
    const { host, calls, render, destroy } = mount([]);
    render(remindersView(rows));

    // Пять команд плана (план тестирования 7e12f589, «напоминания можно
    // переносить / создать задачу / отменить»). Разделитель `.menu-sep` строкой
    // меню не считается.
    const topLevel = openReminderMenu(host)
      .querySelectorAll('.menu-item')
      .map((node) => menuLabel(node));
    assert.deepEqual(
      topLevel,
      [
        t('tasks.openSubject'),
        t('reminder.editSchedule'),
        t('tasks.dismissReminder'),
        t('tasks.snoozeReminder'),
        t('tasks.createTask'),
      ],
      'меню строки: источник, расписание, отмена, отложить, создать задачу',
    );

    // Каждая команда адресует ВХОЖДЕНИЕ: ключ строки содержит `occurrence_at`.
    for (const [label, action] of [
      [t('tasks.openSubject'), 'open-subject'],
      [t('reminder.editSchedule'), 'edit-schedule'],
      [t('tasks.dismissReminder'), 'dismiss'],
      [t('tasks.createTask'), 'create-task'],
    ] as const) {
      menuRowByLabel(openReminderMenu(host), label).click();
      assert.equal(
        calls.reminderActions[calls.reminderActions.length - 1],
        `${key}:${action}`,
        `команда «${label}» адресует вхождение напоминания`,
      );
    }

    // Подменю «Отложить…»: «сегодня» (план 7e12f589) + относительные сдвиги,
    // считаемые ОТ МОМЕНТА вхождения (`shiftIso(row.moment, …)`); абсолютный
    // пункт — диалог даты и времени.
    const sub = openSnoozeSubmenu(host);
    assert.deepEqual(
      sub.querySelectorAll('.menu-item').map((node) => menuLabel(node)),
      [
        t('tasks.snoozeToday'),
        t('tasks.shiftDay'),
        t('tasks.shiftWeek'),
        t('tasks.shiftMonth'),
        t('tasks.snoozeDateTime'),
      ],
      '«сегодня», три относительных сдвига и «на дату…»',
    );

    // «Сегодня» — ТЕКУЩИЕ сутки с часом вхождения: дата сегодняшняя, время из
    // `row.moment` (сервер принимает `until` строго в будущем и позже вхождения).
    menuRowByLabel(openSnoozeSubmenu(host), t('tasks.snoozeToday')).click();
    assert.equal(
      calls.reminderActions[calls.reminderActions.length - 1],
      `${key}:snooze:${expectedToday}`,
      '«сегодня» — сегодняшняя дата со временем вхождения',
    );
    assert.ok(
      Date.parse(expectedToday) > Date.parse(rows[0]!.moment),
      'ожидаемый момент позже вхождения — сервер команду примет',
    );

    menuRowByLabel(openSnoozeSubmenu(host), t('tasks.shiftDay')).click();
    assert.equal(
      calls.reminderActions[calls.reminderActions.length - 1],
      `${key}:snooze:2026-11-15T09:00:00.000Z`,
      '«следующий день» — момент + 1 день',
    );

    menuRowByLabel(openSnoozeSubmenu(host), t('tasks.shiftMonth')).click();
    assert.equal(
      calls.reminderActions[calls.reminderActions.length - 1],
      `${key}:snooze:2026-12-14T09:00:00.000Z`,
      '«на месяц» — календарный месяц от момента',
    );

    menuRowByLabel(openSnoozeSubmenu(host), t('tasks.snoozeDateTime')).click();
    await flush();
    assert.equal(
      calls.reminderActions[calls.reminderActions.length - 1],
      `${key}:snooze:2026-11-20T12:00:00.000Z`,
      '«на дату…» — выбранные дата и время, тоже вхождение',
    );
    destroy();
  });

  it('«сегодня» недоступен, когда сегодняшний час вхождения уже прошёл', async (test) => {
    const moment = '2026-11-14T09:00:00.000Z';
    // «Сейчас» — минутой позже сегодняшнего часа вхождения (в любом поясе):
    // сервер отклонит `until` не в будущем (`snoozeReminder`), и меню такую
    // команду не предлагает.
    test.mock.timers.enable({ apis: ['Date'] });
    test.mock.timers.setTime(todayAt(moment, new Date('2026-11-20T06:00:00.000Z')) + 60_000);

    const { host, calls, render, destroy } = mount([]);
    render(remindersView([reminderRow(moment)]));
    const today = menuRowByLabel(openSnoozeSubmenu(host), t('tasks.snoozeToday'));

    assert.equal(
      today.classList.contains('menu-item-disabled'),
      true,
      'пункт «сегодня» недоступен: момент уже прошёл',
    );
    today.click();
    assert.deepEqual(calls.reminderActions, [], 'команда не отправлена — сервер её отклонил бы');
    destroy();
  });

  it('«сегодня» недоступен для вхождения будущих суток: отложить можно только вперёд', async (test) => {
    const moment = '2026-12-01T09:00:00.000Z';
    // «Сейчас» — за час ДО сегодняшнего часа вхождения: значение в будущем, но
    // раньше самого вхождения, а `until` обязан быть строго позже него.
    test.mock.timers.enable({ apis: ['Date'] });
    test.mock.timers.setTime(todayAt(moment, new Date('2026-11-20T06:00:00.000Z')) - 3_600_000);

    const { host, calls, render, destroy } = mount([]);
    render(remindersView([reminderRow(moment)]));
    const today = menuRowByLabel(openSnoozeSubmenu(host), t('tasks.snoozeToday'));

    assert.equal(
      today.classList.contains('menu-item-disabled'),
      true,
      'перенос «назад» сервер не примет — пункт недоступен',
    );
    today.click();
    assert.deepEqual(calls.reminderActions, [], 'команда не отправлена');
    destroy();
  });

  it('«Обновить» подсвечивается при устаревании, «Отменить» — только при наличии команды', () => {
    const { host, calls, render, destroy } = mount();
    const refresh = host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
    const undo = host.querySelector('.ui-task-panel-undo') as unknown as ShimElement;
    assert.equal(refresh.classList.contains('is-stale'), false);
    assert.equal(undo.hidden, true);
    render(panelView([taskRow()], { stale: true, canUndo: true }));
    assert.equal(refresh.classList.contains('is-stale'), true, 'данные устарели — подсветка');
    assert.equal(undo.hidden, false);
    refresh.click();
    undo.click();
    assert.equal(calls.refresh, 1);
    assert.equal(calls.undo, 1);
    destroy();
  });
});

describe('панель задач: сворачивание блоков и команды дат (d0801eea/3f9ea2ee/3cef7466)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  /** Состояние свёрнутости «экрана» и журнал записей о нём. */
  interface CollapseState {
    map: Map<string, boolean>;
    saved: Array<[string, boolean]>;
  }

  /** Смонтировать панель с состоянием свёрнутости, живущим вне компоненты. */
  function mountCollapsible(rows: TaskPanelRow[] = [taskRow()]): {
    host: ShimElement;
    calls: Calls;
    state: CollapseState;
    render: (view: TaskPanelView) => void;
    destroy: () => void;
  } {
    const state: CollapseState = { map: new Map(), saved: [] };
    const mounted = mount(rows, {
      collapsedOf: (key) => state.map.get(key),
      setCollapsed: (key, value) => {
        state.map.set(key, value);
        state.saved.push([key, value]);
      },
    });
    return {
      host: mounted.host,
      calls: mounted.calls,
      state,
      render: mounted.render,
      destroy: mounted.destroy,
    };
  }

  it('панель сворачивается в одну шапку, состояние спрашивается у экрана', () => {
    const { host, state, render, destroy } = mountCollapsible();
    const head = host.querySelector('.ui-task-panel-head') as unknown as ShimElement;
    const panelRoot = host.querySelector('.ui-task-panel') as unknown as ShimElement;
    assert.ok(host.querySelector('.ui-task-panel-body'), 'по умолчанию панель развёрнута');
    head.click();
    assert.deepEqual(state.saved, [['panel', true]], 'свёрнутость записана состоянием экрана');
    assert.equal(
      host.querySelector('.ui-task-panel-body'),
      null,
      'свёрнутая панель — только шапка',
    );
    // Класс свёрнутой панели (пункт 1 уточнения 2026-11-19): CSS снимает
    // сохранённую слайдером высоту, пустого места под шапкой нет.
    assert.ok(panelRoot.classList.contains('is-collapsed'), 'класс `is-collapsed` поставлен');
    assert.ok(host.querySelector('.ui-task-panel-head'), 'шапка осталась');
    // Сохранённое состояние приходит АСИНХРОННО (`ui_state`): следующая отрисовка
    // обязана применить его к уже построенной панели.
    state.map.set('panel', false);
    render(panelView([taskRow()]));
    assert.ok(host.querySelector('.ui-task-panel-body'), 'развёрнутость из состояния применена');
    assert.ok(!panelRoot.classList.contains('is-collapsed'), 'класс `is-collapsed` снят');
    destroy();
  });

  it('группа сворачивается: счётчики видны и в свёрнутом виде', () => {
    const { host, state, destroy } = mountCollapsible([
      taskRow(),
      taskRow({ key: 'c1:1', lineNo: 1 }),
    ]);
    const group = host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
    const head = group.querySelector('.ui-task-group-head') as unknown as ShimElement;
    const counters = group.querySelector('.ui-task-group-counters') as unknown as ShimElement;
    assert.equal(counters.textContent, t('tasks.counters', [2, 0]));
    head.click();
    assert.deepEqual(state.saved, [['group:tasks', true]]);
    assert.equal(
      group.querySelector('.ui-task-group-sections'),
      null,
      'тело группы «Задачи периода» снято',
    );
    assert.equal(rowsOf(host).length, 0, 'строки свёрнутой группы не показаны');
    assert.equal(
      group.querySelector('.ui-task-group-counters')?.textContent,
      t('tasks.counters', [2, 0]),
      'счётчики остались в шапке',
    );
    destroy();
  });

  it('секция сворачивается, счётчик строк остаётся в её шапке', () => {
    const { host, state, destroy } = mountCollapsible();
    const head = host.querySelector('.ui-task-section-head') as unknown as ShimElement;
    const count = head.querySelector('.ui-task-section-count') as unknown as ShimElement;
    assert.equal(count.textContent, '(1)', 'счётчик секции до сворачивания');
    head.click();
    assert.deepEqual(state.saved, [['section:task:period', true]]);
    assert.equal(rowsOf(host).length, 0, 'строки свёрнутой секции не показаны');
    assert.equal(
      (host.querySelector('.ui-task-section-head') as unknown as ShimElement).querySelector(
        '.ui-task-section-count',
      )?.textContent,
      '(1)',
      'счётчик секции виден и в свёрнутом виде',
    );
    destroy();
  });

  it('у бессрочной строки «Перенести на дату» доступно, «Сделать бессрочной» — нет', async () => {
    const { host, calls, destroy } = mountCollapsible([
      taskRow({ key: 'c1:2', lineNo: 2, due: null, periodFrom: null, day: null }),
    ]);
    const button = host.querySelector('.ui-task-row-menu') as unknown as ShimElement;
    button.emit('click', {
      target: button,
      currentTarget: button,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const undate = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.undateRow')));
    assert.ok(undate, 'пункт «Сделать бессрочной» в меню строки');
    assert.ok(undate!.classList.contains('menu-item-disabled'), 'у строки без дат он недоступен');
    // Подменю «Перенести на…» открывается и для бессрочной строки (3f9ea2ee).
    const move = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.moveRow')));
    assert.ok(move, 'пункт «Перенести на…» в меню строки');
    assert.ok(!move!.classList.contains('menu-item-disabled'), 'перенос доступен без дат');
    move!.emit('mouseenter');
    const dateItem = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.moveDate')));
    assert.ok(dateItem, 'пункт «на дату» в подменю переноса');
    dateItem!.click();
    await flush();
    assert.deepEqual(
      calls.rowCommands,
      ['c1:2:move', JSON.stringify({ date: '2026-11-20' })],
      'экран получает перенос на выбранную дату',
    );
    destroy();
  });

  it('меню «Перенести» строки предлагает «на сегодня» (пункт 2 уточнения 2026-11-19)', () => {
    const { host, calls, destroy } = mount();
    const button = host.querySelector('.ui-task-row-menu') as unknown as ShimElement;
    button.emit('click', {
      target: button,
      currentTarget: button,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const move = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.moveRow')));
    assert.ok(move, 'пункт «Перенести на…» в меню строки');
    move!.emit('mouseenter');
    const today = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.shiftToday')));
    assert.ok(today, 'в подменю переноса есть абсолютный пункт «на сегодня»');
    today!.click();
    assert.deepEqual(
      calls.rowCommands,
      ['c1:0:move', JSON.stringify({ date: todayLocal() })],
      'перенос «на сегодня» идёт абсолютной датой локальных суток',
    );
    destroy();
  });

  it('«Открыть источник» есть у хроно-строки БЕЗ дат (пункт 3 ТЗ 2026-11-18)', async () => {
    const { host, calls, destroy } = mount(
      [
        taskRow({
          kind: 'chronological',
          due: null,
          periodFrom: null,
          day: null,
          text: 'задача из записи',
        }),
      ],
      {
        openRowSource: (row) => {
          calls.days.push(`source:${row.key}`);
        },
      },
    );
    const button = host.querySelector('.ui-task-row-menu') as unknown as ShimElement;
    button.emit('click', {
      target: button,
      currentTarget: button,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.openSource')));
    assert.ok(item, 'команда «Открыть источник» доступна строке записи без дат');
    item!.click();
    await flush();
    assert.deepEqual(calls.days, ['source:c1:0'], 'переход адресован строке, а не дню');
    destroy();
  });

  it('облачка строк отключаются флагом: зона «Задачи» редактора мысли (пачка 4, п.1)', () => {
    const rendered: string[] = [];
    const { host, destroy } = mount(
      [taskRow({ subjectThoughts: ['t1', 't2'] })],
      {
        renderSubject: (node, subject) => {
          rendered.push(subject.id);
          node.textContent = subject.id;
        },
      },
      { rowSubjectClouds: false },
    );
    const row = rowsOf(host)[0]!;
    assert.equal(
      row.querySelector('.ui-task-row-subject-cloud'),
      null,
      'облачков субъектов у строки нет',
    );
    assert.equal(
      row.querySelector('.ui-task-row-subjects'),
      null,
      'слота облачков в DOM тоже нет — он не занимает место в строке',
    );
    assert.deepEqual(rendered, [], 'экран даже не просили нарисовать облачко');
    destroy();
  });

  it('перечитывание показанного списка не показывает статус загрузки (пачка 4, п.2)', () => {
    const view = panelView([taskRow(), taskRow({ key: 'c1:1', lineNo: 1 })]);
    const { host, render, destroy } = mount([taskRow(), taskRow({ key: 'c1:1', lineNo: 1 })]);
    const status = host.querySelector('.ui-task-panel-status') as unknown as ShimElement;
    assert.equal(status.hidden, true, 'список показан — строки загрузки нет');
    const rowsBefore = rowsOf(host);
    // «Обновить»: загрузка идёт, список УЖЕ есть — он не должен съезжать вниз от
    // появившейся перед ним строки загрузки, а строки не пересобираются.
    render({ ...view, loading: true });
    assert.equal(status.hidden, true, 'статус загрузки не появился над показанным списком');
    const rowsAfter = rowsOf(host);
    assert.deepEqual(
      rowsAfter.map((node, index) => node === rowsBefore[index]),
      [true, true],
      'узлы строк сохранены keyed-сверкой',
    );
    // Первая загрузка (показывать нечего) — статус обязателен.
    const empty = mount([]);
    const emptyStatus = empty.host.querySelector('.ui-task-panel-status') as unknown as ShimElement;
    empty.render({ ...panelView([]), loading: true });
    assert.equal(emptyStatus.hidden, false, 'пустая панель показывает признак загрузки');
    empty.destroy();
    destroy();
  });

  it('рядом с датой строки — ОДНО облачко и кнопка «…» со списком остальных (пачка 6, п.2)', () => {
    const rendered: string[] = [];
    const opened: string[] = [];
    const { host, destroy } = mount([taskRow({ subjectThoughts: ['t1', 't2', 't3'] })], {
      renderSubject: (node, subject, options) => {
        rendered.push(`${subject.id}:${options?.interactive === false ? 'visual' : 'live'}`);
        node.textContent = subject.id;
      },
      openSubject: (subject) => opened.push(subject.id),
    });
    const row = rowsOf(host)[0]!;
    const clouds = row.querySelectorAll('.ui-task-row-subject-cloud');
    assert.equal(clouds.length, 1, 'в строке ОДНО облачко — первой связанной мысли');
    assert.equal(clouds[0]!.flatText(), 't1', 'облачко первой мысли');
    assert.deepEqual(rendered, ['t1:live'], 'облачко строки — с жестами (клик/двойной клик)');

    const subjectsSlot = row.querySelector('.ui-task-row-subjects')!;
    const more = subjectsSlot.querySelector('button') as unknown as ShimElement;
    assert.ok(more, 'кнопка «…» рядом с облачком');
    assert.equal(more.flatText().trim(), '…', 'кнопка — троеточие (словарь lib/ui)');
    assert.equal(
      more.title,
      t('tasks.moreSubjects', ['2']),
      'подсказка называет число мыслей, ушедших в список',
    );

    more.emit('click', {
      target: more,
      currentTarget: more,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const menu = body.querySelector('.menu') as unknown as ShimElement | null;
    assert.ok(menu, 'список остальных мыслей открыт');
    assert.deepEqual(
      menu.querySelectorAll('.menu-item').map((node) => menuLabel(node)),
      ['t2', 't3'],
      'в списке — только остальные мысли, в порядке строки',
    );
    assert.deepEqual(
      rendered,
      ['t1:live', 't2:visual', 't3:visual'],
      'пункты списка — визуальные облачка без жестов: действие делает сам пункт',
    );

    menuRowByLabel(menu, 't2').click();
    assert.deepEqual(opened, ['t2'], 'клик по пункту открывает свою мысль в редакторе');
    destroy();
  });

  it('одна связанная мысль — кнопки «…» нет (списку не из чего состоять)', () => {
    const opened: string[] = [];
    const { host, destroy } = mount([taskRow({ subjectThoughts: ['t1'] })], {
      renderSubject: (node, subject) => {
        node.textContent = subject.id;
      },
      openSubject: (subject) => opened.push(subject.id),
    });
    const row = rowsOf(host)[0]!;
    assert.equal(row.querySelectorAll('.ui-task-row-subject-cloud').length, 1, 'облачко одно');
    assert.equal(
      row.querySelector('.ui-task-row-subjects')!.querySelector('button'),
      null,
      'кнопка «…» не нужна: список был бы пуст',
    );
    assert.deepEqual(opened, [], 'переходов нет');
    destroy();
  });

  it('у строки с датами «Сделать бессрочной» доступна и уходит командой строки', () => {
    const { host, calls, destroy } = mountCollapsible();
    const button = host.querySelector('.ui-task-row-menu') as unknown as ShimElement;
    button.emit('click', {
      target: button,
      currentTarget: button,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const undate = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.undateRow')));
    assert.ok(undate);
    assert.ok(!undate!.classList.contains('menu-item-disabled'));
    undate!.click();
    assert.deepEqual(calls.rowCommands, ['c1:0:undate']);
    destroy();
  });

  it('массовая команда «Сделать бессрочными» есть в меню группы и уходит фильтром', () => {
    const { host, calls, destroy } = mountCollapsible();
    const menuButton = host.querySelector('.ui-task-subgroup-menu') as unknown as ShimElement;
    menuButton.emit('click', {
      target: menuButton,
      currentTarget: menuButton,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.undateAllGroup')));
    assert.ok(item, 'пункт «Сделать бессрочными по этой группе» в меню подгруппы');
    item!.click();
    assert.equal(calls.bulk.length, 1);
    assert.equal(calls.bulk[0]!.command, 'undate-all');
    destroy();
  });

  it('у группы из строк хроно-записей массовой «Сделать бессрочными» нет', () => {
    const { host, destroy } = mountCollapsible([
      taskRow({ kind: 'chronological', due: '2026-11-14' }),
    ]);
    const menuButton = host.querySelector('.ui-task-subgroup-menu') as unknown as ShimElement;
    menuButton.emit('click', {
      target: menuButton,
      currentTarget: menuButton,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(t('tasks.undateAllGroup')));
    assert.equal(item, undefined, 'период записи вернул бы пере-парс — команды нет');
    destroy();
  });
});

describe('панель задач: инлайн-правка строки компонентой комментария (пункт 1 ТЗ 2026-11-18)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('двойной клик отдаёт фабрике СЫРУЮ строку источника, отмена закрывает без записи', async () => {
    // `row.text` — снапшот БЕЗ маркера; в поле обязан попасть `body_md`.
    const { host, calls, destroy } = mount([taskRow({ text: 'задача' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    assert.ok(row.querySelector('.ui-task-row-edit'), 'поле правки открылось');
    assert.equal(calls.rawLines, 1, 'сырую строку читает экран, а не снапшот');
    assert.equal(calls.rowEditors.length, 1, 'поле создаёт фабрика компоненты, а не панель');
    assert.equal(
      calls.rowEditors[0]?.options.md,
      '- [ ] задача',
      'в поле — СЫРАЯ строка с маркером',
    );
    // Отмена (Esc) — жест самой компоненты: поле закрывается без записи.
    calls.rowEditors[0]?.options.closed();
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'правка закрыта');
    assert.deepEqual(calls.edits, [], 'отмена не сохраняет');
    destroy();
  });

  it('сохранение из компоненты записывает СЫРУЮ строку через `editLine` и закрывает правку', async () => {
    const { host, calls, destroy } = mount([taskRow({ text: 'старый' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    await commitRowEditor(calls, '- [x] новый');
    assert.deepEqual(calls.edits, [{ key: 'c1:0', text: '- [x] новый' }]);
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'после сохранения правка закрыта');
    destroy();
  });

  it('сквозная правка: сырая строка сохраняется в body_md вместе с маркером', async () => {
    let body = '- [ ] задача [[2026-11-14]]\n- [x] вторая';
    const { host, calls, destroy } = mount([taskRow({ text: 'задача [[2026-11-14]]' })], {
      loadRawLine: async () => body.split('\n')[0]!,
      editLine: async (row, raw) => {
        const next = replaceTaskLine(body, row.lineNo, raw);
        assert.notEqual(next, null);
        body = next!;
        return true;
      },
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    assert.equal(calls.rowEditors[0]?.options.md, '- [ ] задача [[2026-11-14]]');
    await commitRowEditor(calls, '- [ ] задача перенесена [[2026-11-15]]');
    assert.deepEqual(
      body.split('\n'),
      ['- [ ] задача перенесена [[2026-11-15]]', '- [x] вторая'],
      'маркер задачи и соседняя строка не потеряны',
    );
    destroy();
  });

  it('отказ экрана оставляет правку открытой (текст не теряется)', async () => {
    const { host, calls, destroy } = mount([taskRow()], {
      editLine: async () => false,
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    const editor = calls.rowEditors[0]!;
    // Компонента сохраняет сама и закрывает поле только при успехе (§1).
    assert.equal(await editor.options.save('- [ ] изменённая'), false);
    assert.ok(row.querySelector('.ui-task-row-edit'), 'при отказе поле осталось в правке');
    destroy();
  });

  it('строка, открытая в правке, переживает повторный render панели', async () => {
    const { host, render, destroy } = mount([taskRow()]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    assert.ok(row.querySelector('.ui-task-row-edit'));
    render(panelView([taskRow({ stale: true })], { stale: true }));
    assert.ok(row.querySelector('.ui-task-row-edit'), 'правка не сброшена перерисовкой списка');
    destroy();
  });
});

/** Снимок панели редактора мысли: плоские секции «активные» + «выполненные». */
function flatView(active: TaskPanelRow[], done: TaskPanelRow[]): TaskPanelView {
  return {
    stale: false,
    periodFilter: { scope: 'open', thought_id: 't1', today: '2026-11-14' },
    canUndo: false,
    showDone: true,
    counters: { open: active.length, done: done.length },
    reminderCount: 0,
    taskSections: [
      ...(active.length > 0
        ? [{ key: 'active', title: '', flat: true, subgroups: [], rows: active }]
        : []),
      ...(done.length > 0
        ? [
            {
              key: 'done',
              title: t('tasks.doneGroup'),
              flat: true,
              collapsible: true,
              collapsed: true,
              subgroups: [],
              rows: done,
            },
          ]
        : []),
    ],
    reminderSections: [],
    loading: false,
    error: null,
  };
}

/** Смонтировать headless-панель (панель редактора мысли, элемент f3893859). */
function mountHeadless(
  view: TaskPanelView,
  overrides: Partial<TaskPanelActions> = {},
): {
  host: ShimElement;
  calls: Calls;
  headActions: HTMLElement[];
  render: (view: TaskPanelView) => void;
  destroy: () => void;
} {
  installShim();
  keymap.keymapInternals.reset();
  const host = new ShimElement('div');
  const calls: Calls = {
    refresh: 0,
    undo: 0,
    showDone: [],
    toggles: [],
    edits: [],
    rowCommands: [],
    bulk: [],
    reminderActions: [],
    reminderGroupDismiss: [],
    days: [],
    rawLines: 0,
    panelHeights: [],
    rowEditors: [],
  };
  const actions: TaskPanelActions = {
    refresh: () => {
      calls.refresh += 1;
    },
    undo: () => {
      calls.undo += 1;
    },
    setShowDone: (show) => {
      calls.showDone.push(show);
    },
    toggle: (row, done) => {
      calls.toggles.push({ key: row.key, done });
    },
    loadRawLine: async (row) => `- [ ] ${row.text}`,
    editLine: async (row, text) => {
      calls.edits.push({ key: row.key, text });
      return true;
    },
    rowCommand: (row, command) => {
      calls.rowCommands.push(`${row.key}:${command}`);
    },
    bulk: (filter, command) => {
      calls.bulk.push({ command, filter });
    },
    reminderAction: () => undefined,
    reminderGroupDismiss: () => undefined,
    pickDate: async () => null,
    pickDateTime: async () => null,
    openDay: (day) => {
      calls.days.push(day);
    },
    openRowSource: (row) => {
      calls.days.push(`source:${row.key}`);
    },
    renderText: (node, row) => {
      node.textContent = row.text;
    },
    ...overrides,
  };
  const handle = mountTaskPanel(host as unknown as HTMLElement, actions, {
    headless: true,
    createRowEditor: fakeRowEditor(calls),
  });
  handle.render(view);
  return {
    host,
    calls,
    headActions: handle.headActions(),
    render: (next) => handle.render(next),
    destroy: () => handle.destroy(),
  };
}

describe('панель редактора мысли: headless, плоские секции (f3893859)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('своей шапки и групп-обёрток нет; активные строки — плоским списком', () => {
    const { host, destroy } = mountHeadless(
      flatView([taskRow(), taskRow({ key: 'c1:1', lineNo: 1, text: 'вторая' })], []),
    );
    assert.equal(host.querySelector('.ui-task-panel-head'), null, 'шапку даёт группа редактора');
    assert.equal(host.querySelector('.ui-task-group'), null, 'обёрток групп нет');
    assert.deepEqual(
      rowsOf(host).map((row) => row.getAttribute('data-row-key')),
      ['c1:0', 'c1:1'],
    );
    destroy();
  });

  it('выполненные — в свёрнутой секции «Выполненные задачи (n)», раскрывается кликом', () => {
    const { host, destroy } = mountHeadless(
      flatView([taskRow()], [taskRow({ key: 'c1:1', lineNo: 1, done: true })]),
    );
    const section = host.querySelector('.ui-task-flat-collapsible') as unknown as ShimElement;
    assert.ok(section, 'секция выполненных построена');
    assert.equal(
      section.querySelector('.ui-task-section-count')?.textContent,
      '(1)',
      'счётчик секции — количество выполненных',
    );
    assert.equal(rowsOf(host).length, 1, 'свёрнутая секция строк не показывает');
    (section.querySelector('.ui-task-flat-head') as unknown as ShimElement).click();
    assert.equal(rowsOf(host).length, 2, 'раскрытая секция показывает выполненные');
    destroy();
  });

  it('выполненная после «Обновить» строка доезжает до СВЁРНУТОЙ секции (блокер приёмки)', () => {
    const { host, render, destroy } = mountHeadless(
      flatView([taskRow()], [taskRow({ key: 'c1:1', lineNo: 1, done: true, text: 'старая' })]),
    );
    const section = host.querySelector('.ui-task-flat-collapsible') as unknown as ShimElement;
    assert.equal(section.querySelector('.ui-task-section-count')?.textContent, '(1)');
    // «Обновить» при свёрнутой секции: её тело снято с экрана, но строки обязаны
    // обновиться — до правки update искал контейнер строк в DOM и не находил.
    render(
      flatView(
        [taskRow()],
        [
          taskRow({ key: 'c1:1', lineNo: 1, done: true, text: 'старая' }),
          taskRow({ key: 'c1:2', lineNo: 2, done: true, text: 'новая' }),
        ],
      ),
    );
    assert.equal(
      section.querySelector('.ui-task-section-count')?.textContent,
      '(2)',
      'счётчик свёрнутой секции обновился',
    );
    (section.querySelector('.ui-task-flat-head') as unknown as ShimElement).click();
    assert.deepEqual(
      rowsOf(section).map((row) => row.getAttribute('data-row-key')),
      ['c1:1', 'c1:2'],
      'раскрытая секция показывает новую строку',
    );
    destroy();
  });

  it('headActions: «Отменить», «Обновить» и «⋮» отдаются наружу и работают', () => {
    let menuCalls = 0;
    const { calls, headActions, destroy } = mountHeadless(flatView([taskRow()], []), {
      headMenu: () => {
        menuCalls += 1;
        return [];
      },
    });
    assert.equal(
      headActions.length,
      3,
      'кнопки шапки: «Отменить» (скрыта без команды), «Обновить» и «⋮»',
    );
    const undo = headActions[0] as unknown as ShimElement;
    assert.equal(undo.classList.contains('ui-task-panel-undo'), true, 'первая — «Отменить»');
    assert.equal(undo.hidden, true, 'без массовой команды «Отменить» скрыта');
    headActions[1]!.click();
    assert.equal(calls.refresh, 1);
    (headActions[2] as unknown as ShimElement).emit('click', {
      target: headActions[2],
      currentTarget: headActions[2],
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    assert.equal(menuCalls, 1, 'меню «⋮» спрашивает экран');
    destroy();
  });

  it('счётчики публикуются событием etn:set-count на корне панели', () => {
    const { host, render, destroy } = mountHeadless(flatView([taskRow()], []));
    const root = host.querySelector('.ui-task-panel') as unknown as ShimElement;
    const seen: string[] = [];
    root.addEventListener('etn:set-count', (event: { detail?: string }) => {
      if (typeof event.detail === 'string') seen.push(event.detail);
    });
    render(flatView([taskRow(), taskRow({ key: 'c1:1', lineNo: 1 })], [taskRow({ key: 'c2:0' })]));
    assert.deepEqual(seen, [t('tasks.counters', [2, 1])]);
    destroy();
  });

  it('клик по чипу даты открывает запись-источник, а не день ленты', () => {
    const { host, calls, destroy } = mountHeadless(flatView([taskRow()], []));
    const chip = host.querySelector('.ui-task-row-date') as unknown as ShimElement;
    chip.click();
    assert.deepEqual(calls.days, ['source:c1:0']);
    destroy();
  });
});

// ---------------------------------------------------------------------------
// 0.16.1, замечания пользователя 2026-11-17 (задача 01998381): пункты B, C, D, E, F.
// ---------------------------------------------------------------------------

describe('панель задач: вложенные строки строки-задачи (пункт F)', () => {
  it('строка с детьми по умолчанию СВЁРНУТА, каретка раскрывает и сворачивает', () => {
    const children = [
      { key: 'c1:1', lineNo: 1, text: 'пункт чек-листа', depth: 1, checkbox: true },
      { key: 'c1:2', lineNo: 2, text: 'вложенный текст', depth: 1, checkbox: false },
    ];
    const { host, destroy } = mount([taskRow({ children })]);
    const row = host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
    assert.equal(
      host.findAll('ui-task-row-children').length,
      0,
      'по умолчанию вложенные строки свёрнуты',
    );
    const caret = row.querySelector('.ui-task-row-caret') as unknown as ShimElement;
    assert.ok(caret, 'у строки с детьми есть каретка раскрытия');
    assert.equal(caret.getAttribute('aria-expanded'), 'false');

    caret.click();
    const expandedCaret = row.querySelector('.ui-task-row-caret') as unknown as ShimElement;
    const visible = host.findAll('ui-task-child-row').map((node) => node.flatText().trim());
    assert.deepEqual(
      visible,
      ['пункт чек-листа', '•вложенный текст'],
      'раскрытие показывает детей; обычная строка — с маркером списка (пункт 5)',
    );
    // Маркер рисует ТОЛЬКО не-чекбоксная строка (0.16.1, уточнение 2026-11-19,
    // пункт 5): проекция хранит текст без маркера, панель восстанавливает вид
    // списка. У пункта чек-листа маркера нет — у него контрол отметки.
    const markers = host.findAll('ui-task-child-marker');
    assert.equal(markers.length, 1, 'маркер — только у обычной вложенной строки');
    assert.equal(markers[0]!.flatText(), '•');
    assert.equal(expandedCaret.getAttribute('aria-expanded'), 'true', 'каретка сообщает состояние');

    expandedCaret.click();
    assert.equal(host.findAll('ui-task-row-children').length, 0, 'повторный клик сворачивает');
    destroy();
  });

  it('строка без детей не сворачивается: каретки и блока детей нет', () => {
    const { host, destroy } = mount([taskRow()]);
    assert.equal(host.findAll('ui-task-row-caret').length, 0);
    assert.equal(host.findAll('ui-task-row-children').length, 0);
    destroy();
  });
});

describe('панель задач: напоминания плоским списком и просрочка (пункты C и D)', () => {
  function reminderRow(key: string, moment: string, overdue = false): ReminderPanelRow {
    return {
      key: `${key}:${moment}`,
      reminderId: key,
      subjectType: 'thought',
      subjectId: 't1',
      title: `Мысль ${key}`,
      moment,
      occurrenceAt: moment,
      status: 'active',
      repeat: '',
      day: moment.slice(0, 10),
      ...(overdue ? { overdue: true } : {}),
    };
  }

  it('плоская секция рисует облачка строк без подгрупп', () => {
    const rows = [
      reminderRow('r1', '2026-11-17T09:00:00.000Z'),
      reminderRow('r2', '2026-11-17T10:00:00.000Z'),
    ];
    const clouds: string[] = [];
    const { host, render, destroy } = mount([], {
      renderSubject: (node, subject) => {
        clouds.push(subject.title);
        const chip = new ShimElement('span', 'prop-ref-cloud');
        const title = new ShimElement('span', 'prc-title');
        title.textContent = subject.title;
        chip.append(title);
        node.append(chip as unknown as Node);
      },
    });
    render(
      panelView([], {
        reminderCount: rows.length,
        reminderSections: [{ key: 'today', title: 'Сегодня', flat: true, subgroups: [], rows }],
      }),
    );
    const group = host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
    assert.ok(group, 'группа напоминаний на панели');
    assert.equal(group.findAll('ui-task-subgroup').length, 0, 'плоская секция без подгрупп');
    assert.deepEqual(
      group.findAll('prc-title').map((node) => node.flatText().trim()),
      ['Мысль r1', 'Мысль r2'],
      'каждая строка — облачко мысли',
    );
    assert.deepEqual(clouds, ['Мысль r1', 'Мысль r2'], 'облачко рисует экран (renderSubject)');
    destroy();
  });

  it('чекбокс вхождения отдаёт `reminderDone` — dismiss, а серия остаётся (пункт 7)', () => {
    const rows = [
      reminderRow('r1', '2026-11-17T09:00:00.000Z'),
      reminderRow('r2', '2026-11-16T09:00:00.000Z', true),
    ];
    const done: string[] = [];
    const { host, render, destroy } = mount([], {
      reminderDone: (row) => done.push(row.key),
    });
    render(
      panelView([], {
        reminderCount: rows.length,
        reminderSections: [{ key: 'all', title: '', flat: true, subgroups: [], rows }],
      }),
    );
    const checks = host.findAll('ui-reminder-row-check');
    assert.equal(checks.length, 2, 'чекбокс есть у каждого вхождения, включая просроченное');
    const check = checks[1]!;
    check.checked = true;
    check.emit('change', { target: check });
    assert.deepEqual(done, [rows[1]!.key], 'отметка — команда `reminderDone` (dismiss)');
    // Контрол односторонний: снятие отметки не возвращает вхождение.
    check.checked = false;
    check.emit('change', { target: check });
    assert.deepEqual(done, [rows[1]!.key], 'снятие отметки — no-op');
    destroy();
  });

  it('просроченная строка и её дата — класс is-overdue (красный)', () => {
    const rows = [reminderRow('r1', '2026-11-16T09:00:00.000Z', true)];
    const { host, render, destroy } = mount([]);
    render(
      panelView([], {
        reminderCount: 1,
        reminderSections: [
          { key: 'overdue', title: 'Просрочено', flat: true, subgroups: [], rows },
        ],
      }),
    );
    assert.equal(
      host.findAll('ui-reminder-row').filter((node) => node.className.includes('is-overdue'))
        .length,
      1,
      'просроченное вхождение помечено',
    );
    destroy();
  });

  it('счётчик вхождений склоняется: «3 вхождения», а не «3 вхождений»', () => {
    // Замечание проверки 2026-11-17: счётчик был неграмотным («3 вхождений»).
    // Плюральный ключ `plurals.reminderOccurrence` даёт форму по числу.
    const rows = [
      reminderRow('r1', '2026-11-17T09:00:00.000Z'),
      reminderRow('r2', '2026-11-17T10:00:00.000Z'),
      reminderRow('r3', '2026-11-17T11:00:00.000Z'),
    ];
    const { host, render, destroy } = mount([]);
    render(
      panelView([], {
        reminderCount: rows.length,
        reminderSections: [{ key: 'today', title: 'Сегодня', flat: true, subgroups: [], rows }],
      }),
    );
    const group = host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
    const counters = group.querySelector('.ui-task-group-counters');
    assert.equal(counters?.textContent, '3 вхождения', 'форма для 3 — «вхождения»');
    destroy();
  });
});

describe('панель задач: заголовки групп и облачка (пункт E)', () => {
  it('группа-дата получает календарик, группа-мысль — облачко', () => {
    const views: string[] = [];
    const { host, render, destroy } = mount([], {
      renderSubject: (node, subject) => {
        views.push(subject.title);
        const chip = new ShimElement('span', 'prop-ref-cloud');
        const title = new ShimElement('span', 'prc-title');
        title.textContent = subject.title;
        chip.append(title);
        node.append(chip as unknown as Node);
      },
    });
    render(
      panelView([taskRow()], {
        taskSections: [
          {
            key: 'period',
            title: 'section-main',
            subgroups: [
              {
                key: 'date:2026-11-14',
                title: '14.11.2026',
                kind: 'dates',
                filter: {},
                rows: [taskRow()],
                icon: 'calendar',
              },
              {
                key: 'thought:t1',
                title: 'Мысль',
                kind: 'thoughts',
                filter: { scope: 'open', thought_id: 't1' },
                rows: [taskRow({ key: 'c2:0', subjectId: 't1' })],
                subject: { kind: 'thought', id: 't1', title: 'Мысль' },
              },
            ],
          },
        ],
      }),
    );
    const icons = host.findAll('ui-task-subgroup-icon');
    assert.equal(icons.length, 2, 'слот значка есть у каждой подгруппы');
    assert.equal(
      icons.filter((node) => !node.hidden && node.childElementCount > 0).length,
      1,
      'календарик ровно у группы-даты',
    );
    assert.deepEqual(views, ['Мысль'], 'облачко рисуется только у группы-мысли');
    const titles = host.findAll('ui-task-subgroup-title').map((node) => node.flatText().trim());
    assert.deepEqual(titles, ['14.11.2026', ''], 'у группы-мысли заголовок-строка скрыт');
    destroy();
  });
});

describe('панель задач: высота панели (пункт B)', () => {
  it('без сохранённой высоты переменная не ставится (работает CSS-умолчание)', () => {
    const { host, calls, render, destroy } = mount([taskRow()], { panelHeight: () => null });
    const root = host.querySelector('.ui-task-panel') as unknown as ShimElement;
    assert.equal(root.style.getPropertyValue('--task-panel-height'), '', 'высота по умолчанию');
    render(panelView([taskRow()]));
    assert.equal(root.style.getPropertyValue('--task-panel-height'), '', 'умолчание не перебито');
    assert.equal(calls.panelHeights.length, 0, 'без драга высота не пишется');
    destroy();
  });

  it('handle: свёрнутость из настроек, высота читается и применяется', () => {
    installShim();
    keymap.keymapInternals.reset();
    const host = new ShimElement('div');
    let height: number | null = 320;
    let collapsed = false;
    const handle = mountTaskPanel(
      host as unknown as HTMLElement,
      {
        refresh: () => undefined,
        undo: () => undefined,
        setShowDone: () => undefined,
        collapsedOf: () => collapsed,
        toggle: () => undefined,
        loadRawLine: async () => '',
        editLine: async () => true,
        rowCommand: () => undefined,
        bulk: () => undefined,
        reminderAction: () => undefined,
        reminderGroupDismiss: () => undefined,
        pickDate: async () => null,
        pickDateTime: async () => null,
        openDay: () => undefined,
        renderText: (node, row) => {
          node.textContent = row.text;
        },
        panelHeight: () => height,
        setPanelHeight: (next) => {
          height = next;
        },
      } as TaskPanelActions,
    );
    handle.render(panelView([taskRow()]));
    const root = host.querySelector('.ui-task-panel') as unknown as ShimElement;
    assert.equal(handle.panelHeight(), 320, 'высота читается из настроек экрана');
    assert.equal(
      root.style.getPropertyValue('--task-panel-height'),
      '320px',
      'высота выставлена переменной панели',
    );
    handle.setPanelHeight(480);
    assert.equal(handle.panelHeight(), 480, 'новая высота записана экрану');
    assert.equal(root.style.getPropertyValue('--task-panel-height'), '480px');

    collapsed = true;
    handle.render(panelView([taskRow()]));
    assert.equal(handle.panelCollapsed(), true, 'панель сообщает свёрнутость экрану');
    handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// 0.16.1, замечания пользователя 2026-11-18 (задача 7446eb25): пункты 3 и 4.
// ---------------------------------------------------------------------------

describe('панель задач: блочная правка строки-задачи (замечание 3 ТЗ 2026-11-18)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  /** Строка задачи с двумя вложенными строками (пункт чек-листа и текст). */
  const withChildren = (): TaskPanelRow =>
    taskRow({
      children: [
        { key: 'c1:1', lineNo: 1, text: 'пункт', depth: 1, checkbox: true, done: false },
        { key: 'c1:2', lineNo: 2, text: 'текст', depth: 1, checkbox: false, done: false },
      ],
    });

  it('двойной клик по строке с детьми открывает правку ВСЕГО блока компонентой', async () => {
    const block = '- [ ] задача\n  - [ ] пункт\n  текст';
    const { host, calls, destroy } = mount([withChildren()], {
      loadRawBlock: async (row) => ({ start: row.lineNo, end: 2, text: block }),
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    assert.ok(row.querySelector('.ui-task-row-block-edit'), 'открылось поле блочной правки');
    // Многострочное поле растягивает строку: чекбокс обязан оставаться у ПЕРВОЙ
    // строки текста — класс `is-editing` (пункт 3 уточнения 2026-11-19).
    assert.ok(row.classList.contains('is-editing'), 'строка правки помечена `is-editing`');
    assert.equal(calls.rowEditors[0]?.options.md, block, 'в поле — строка задачи И дети');
    assert.ok(
      calls.rowEditors[0]?.options.classes.includes('ui-task-row-block-edit'),
      'поле помечено классом блочной правки',
    );
    assert.equal(calls.rawLines, 0, 'блочная правка не читает одну строку: блок читает экран');
    destroy();
  });

  it('сохранение блока передаёт диапазон до последнего ребёнка и закрывает поле', async () => {
    const saved: Array<{ start: number; end: number; text: string }> = [];
    const { host, calls, destroy } = mount([withChildren()], {
      loadRawBlock: async () => ({
        start: 0,
        end: 2,
        text: '- [ ] задача\n  - [ ] пункт\n  текст',
      }),
      editBlock: async (_row, range, text) => {
        saved.push({ start: range.start, end: range.end, text });
        return true;
      },
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    await commitRowEditor(calls, '- [ ] задача\n  - [x] пункт\n  текст');
    assert.deepEqual(
      saved,
      [{ start: 0, end: 2, text: '- [ ] задача\n  - [x] пункт\n  текст' }],
      'сохранён весь блок строки-задачи включительно с вложенными строками',
    );
    assert.equal(
      row.querySelector('.ui-task-row-block-edit'),
      null,
      'после сохранения поле закрыто',
    );
    assert.ok(!row.classList.contains('is-editing'), 'после сохранения строка не в правке');
    destroy();
  });
});

describe('панель задач: пункт чек-листа под задачей (замечание 4 ТЗ 2026-11-18)', () => {
  const children = [
    { key: 'c1:1', lineNo: 1, text: 'пункт', depth: 1, checkbox: true, done: true },
    { key: 'c1:2', lineNo: 2, text: 'текст', depth: 1, checkbox: false, done: false },
  ];

  it('пункт чек-листа — чекбокс с отметкой источника, обычная строка — без контрола', () => {
    const { host, destroy } = mount([taskRow({ children })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
    const check = row.querySelector('.ui-task-child-check') as unknown as ShimElement;
    assert.ok(check, 'у пункта чек-листа есть настоящий чекбокс');
    assert.equal(check.checked, true, 'отметка взята из снапшота, а не выдумана панелью');
    assert.equal(
      row.querySelectorAll('.ui-task-child-check').length,
      1,
      'у обычной вложенной строки контрола нет',
    );
    destroy();
  });

  it('клик по чекбоксу пункта отдаёт команду экрану (`toggleChild`)', () => {
    const toggles: Array<{ key: string; child: number; done: boolean }> = [];
    const { host, destroy } = mount([taskRow({ children })], {
      toggleChild: (row, child, done) => {
        toggles.push({ key: row.key, child: child.lineNo, done });
      },
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
    const check = row.querySelector('.ui-task-child-check') as unknown as ShimElement;
    check.checked = false;
    check.emit('change', { target: check });
    assert.deepEqual(toggles, [{ key: 'c1:0', child: 1, done: false }]);
    destroy();
  });

  it('вложенные строки 2–3 уровня: маркер панели у текста, чекбоксы у пунктов', () => {
    const { host, destroy } = mount([
      taskRow({
        children: [
          {
            key: 'c1:1',
            lineNo: 1,
            text: 'пункт на первом уровне',
            depth: 1,
            checkbox: true,
            done: true,
          },
          { key: 'c1:2', lineNo: 2, text: 'текст второго уровня', depth: 2, checkbox: false },
          { key: 'c1:3', lineNo: 3, text: 'пункт третьего уровня', depth: 3, checkbox: true },
        ],
      }),
    ]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();

    const children = row.querySelectorAll('.ui-task-child-row');
    assert.deepEqual(
      children.map((node) => node.dataset['depth']),
      ['1', '2', '3'],
      'уровень вложенности строки приходит из проекции',
    );
    assert.deepEqual(
      children.map((node) => node.querySelector('.ui-task-child-text')!.flatText().trim()),
      ['пункт на первом уровне', 'текст второго уровня', 'пункт третьего уровня'],
      'тексты вложенных строк на месте',
    );
    assert.equal(
      row.querySelectorAll('.ui-task-child-check').length,
      2,
      'чекбокс есть ровно у пунктов чек-листа (уровни 1 и 3)',
    );
    assert.equal(
      row.querySelectorAll('.ui-task-child-marker').length,
      1,
      'маркер панели получает только обычная строка списка',
    );

    // Фактическое поведение (0.16.1): вложенные строки панели — плоские
    // `.ui-task-child-row` с маркером «•» и штатным чекбоксом. Проекция хранит
    // строку без вида списка и без номера, поэтому `ul`/`ol` единого рендерера
    // (`renderMarkdownWithWikiLinks`) здесь недостижимы: нумерованные пункты
    // показываются тем же «•». Расхождение с пунктом (г) плана — в отчёте.
    assert.equal(row.querySelectorAll('ul').length, 0, 'списка `ul` панель не строит');
    assert.equal(row.querySelectorAll('ol').length, 0, 'нумерованного `ol` панель не строит');
    destroy();
  });
});

// ---------------------------------------------------------------------------
// План тестирования 7e12f589 (0.16.1, задача 0161068d): добор покрытия панели.
// ---------------------------------------------------------------------------

describe('панель задач: кнопки строки видны при наведении и фокусе (план 7e12f589)', () => {
  it('`.ui-task-row-actions` скрыт базово и показывается на `:hover`/`:focus-within`', () => {
    const css = fs.readFileSync(TASK_PANEL_CSS, 'utf8');

    const base = ruleBodies(css, '.ui-task-row-actions');
    assert.ok(
      base.some((body) => /opacity:\s*0\b/.test(body)),
      'базовое правило скрывает кнопки строки (`opacity: 0`)',
    );
    assert.ok(
      base.some((body) => /display:\s*flex\b/.test(body)),
      'кнопки строки — flex-ряд (раскладка не ломается при показе)',
    );

    const hover = ruleBodies(css, '.ui-task-row:hover .ui-task-row-actions');
    assert.ok(
      hover.some((body) => /opacity:\s*1\b/.test(body)),
      'наведение на строку показывает её кнопки',
    );
    const focus = ruleBodies(css, '.ui-task-row:focus-within .ui-task-row-actions');
    assert.ok(
      focus.some((body) => /opacity:\s*1\b/.test(body)),
      'фокус внутри строки (клавиатура) показывает кнопки тоже',
    );
  });
});

describe('панель задач: группа «Задачи» и секции без записи ui_state (план 7e12f589)', () => {
  it('группа развёрнута по умолчанию: свёрнутость — только пользовательский персист', () => {
    const { host, destroy } = mount([taskRow()]);
    const group = host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
    assert.ok(group, 'группа «Задачи» в панели есть');
    assert.equal(
      group.querySelector('.ui-task-caret')!.classList.contains('collapsed'),
      false,
      'без записи ui_state каретка не свёрнута',
    );
    assert.ok(group.querySelector('.ui-task-group-sections') !== null, 'тело группы построено');
    destroy();
  });

  it('секции «Без срока» → «Срочные»: штатные сворачиваемые секции со счётчиками', () => {
    const collapses: string[] = [];
    const { host, render, destroy } = mount([taskRow()], {
      setCollapsed: (key, collapsed) => collapses.push(`${key}:${collapsed}`),
    });
    render(
      panelView([], {
        taskSections: [
          {
            key: 'undated',
            title: t('tasks.sectionUndated'),
            subgroups: [],
            rows: [taskRow({ due: null, periodFrom: null })],
          },
          {
            key: 'urgent',
            title: t('tasks.sectionUrgent'),
            subgroups: [],
            rows: [taskRow(), taskRow({ key: 'c1:1', lineNo: 1, text: 'вторая' })],
          },
        ],
      }),
    );
    const sections = host.querySelectorAll(`.${TASK_PANEL_SECTION_CLASS}`);
    // Секции сюда подаёт САМ тест: проверяется, что панель рисует их в порядке
    // снимка со счётчиками. Порядок «Без срока» → «Срочные» собирает
    // `periodTaskSections`, и его стережёт тест экрана
    // (`tasks-panel-screen.test.ts`).
    assert.deepEqual(
      sections.map((section) => section.getAttribute('data-section')),
      ['undated', 'urgent'],
      'порядок секций снимка сохранён',
    );
    assert.deepEqual(
      sections.map((section) => section.querySelector('.ui-task-section-title')!.flatText().trim()),
      [t('tasks.sectionUndated'), t('tasks.sectionUrgent')],
      'подписи секций из словаря',
    );
    assert.deepEqual(
      sections.map((section) => section.querySelector('.ui-task-section-count')!.textContent),
      ['(1)', '(2)'],
      'счётчик секции — число её строк, виден и в свёрнутом виде',
    );
    // Форма — ШТАТНАЯ секция дизайн-системы (пункт 1 пачки 6): шапка и каретка
    // секций с подгруппами, а не flat-вариант «Выполненных задач».
    assert.deepEqual(
      sections.map((section) => section.querySelectorAll('.ui-task-section-head').length),
      [1, 1],
      'у секции шапка дизайн-системы `.ui-task-section-head`',
    );
    assert.deepEqual(
      sections.map((section) => section.classList.contains('ui-task-flat')),
      [false, false],
      'flat-формы у секций «Без срока»/«Срочные» нет',
    );
    // По умолчанию развёрнуты; свёрнутость пишется штатным `collapsedGroups`.
    assert.deepEqual(
      sections.map((section) =>
        section.querySelector('.ui-task-caret')!.classList.contains('collapsed'),
      ),
      [false, false],
      'без записи ui_state секции развёрнуты',
    );
    sections[0]!.querySelector('.ui-task-section-head')!.emit('click', {
      target: sections[0]!.querySelector('.ui-task-section-head'),
      currentTarget: sections[0]!.querySelector('.ui-task-section-head'),
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
    assert.deepEqual(
      collapses,
      ['section:task:undated:true'],
      'свёрнутость уходит в штатный персист панели',
    );
    assert.equal(
      sections[0]!.querySelector('.ui-task-caret')!.classList.contains('collapsed'),
      true,
      'каретка секции показывает свёрнутость',
    );
    destroy();
  });
});
