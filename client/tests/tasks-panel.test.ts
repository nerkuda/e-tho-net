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
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { t } from '../src/renderer/lib/i18n.js';
import {
  TASK_PANEL_SECTION_CLASS,
  mountTaskPanel,
  staleTaskRowOf,
  type ReminderPanelRow,
  type TaskPanelActions,
  type TaskPanelRow,
  type TaskPanelView,
} from '../src/renderer/lib/ui/task-panel.js';
import { replaceTaskLine } from '../src/renderer/lib/ui/task-panel-model.js';
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
  const handle = mountTaskPanel(host as unknown as HTMLElement, { ...actions, ...overrides });
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
    assert.ok(host.querySelector('.ui-task-panel-body'), 'по умолчанию панель развёрнута');
    head.click();
    assert.deepEqual(state.saved, [['panel', true]], 'свёрнутость записана состоянием экрана');
    assert.equal(
      host.querySelector('.ui-task-panel-body'),
      null,
      'свёрнутая панель — только шапка',
    );
    assert.ok(host.querySelector('.ui-task-panel-head'), 'шапка осталась');
    // Сохранённое состояние приходит АСИНХРОННО (`ui_state`): следующая отрисовка
    // обязана применить его к уже построенной панели.
    state.map.set('panel', false);
    render(panelView([taskRow()]));
    assert.ok(host.querySelector('.ui-task-panel-body'), 'развёрнутость из состояния применена');
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

describe('панель задач: инлайн-правка строки (498f23e0)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('двойной клик открывает поле с сырой строкой источника, Escape отменяет', async () => {
    // `row.text` — снапшот БЕЗ маркера; в поле обязан попасть `body_md`.
    const { host, calls, destroy } = mount([taskRow({ text: 'задача' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
    assert.ok(field, 'поле правки открылось');
    assert.equal(field.value, '- [ ] задача', 'правится СЫРАЯ строка с маркером');
    assert.equal(calls.rawLines, 1, 'сырую строку читает экран, а не снапшот');
    field.focus();
    assert.equal(
      keymap.dispatchKeyEvent({
        key: 'Escape',
        target: field,
        preventDefault: (): void => undefined,
      } as unknown as KeyboardEvent),
      true,
      'Escape обработан диспетчером контекста правки',
    );
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'правка закрыта');
    assert.deepEqual(calls.edits, [], 'отмена не сохраняет');
    destroy();
  });

  it('Enter сохраняет СЫРУЮ строку через `editLine` и закрывает правку', async () => {
    const { host, calls, destroy } = mount([taskRow({ text: 'старый' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
    field.value = '- [x] новый';
    field.focus();
    keymap.dispatchKeyEvent({
      key: 'Enter',
      target: field,
      preventDefault: (): void => undefined,
    } as unknown as KeyboardEvent);
    await flush();
    assert.deepEqual(calls.edits, [{ key: 'c1:0', text: '- [x] новый' }]);
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'после сохранения правка закрыта');
    destroy();
  });

  it('сквозная правка: сырая строка сохраняется в body_md вместе с маркером', async () => {
    let body = '- [ ] задача [[2026-11-14]]\n- [x] вторая';
    const { host, destroy } = mount([taskRow({ text: 'задача [[2026-11-14]]' })], {
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
    const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
    assert.equal(field.value, '- [ ] задача [[2026-11-14]]');
    field.value = '- [ ] задача перенесена [[2026-11-15]]';
    field.focus();
    keymap.dispatchKeyEvent({
      key: 'Enter',
      target: field,
      preventDefault: (): void => undefined,
    } as unknown as KeyboardEvent);
    await flush();
    assert.deepEqual(
      body.split('\n'),
      ['- [ ] задача перенесена [[2026-11-15]]', '- [x] вторая'],
      'маркер задачи и соседняя строка не потеряны',
    );
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
  const handle = mountTaskPanel(host as unknown as HTMLElement, actions, { headless: true });
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
    assert.deepEqual(visible, ['пункт чек-листа', 'вложенный текст'], 'раскрытие показывает детей');
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

  it('двойной клик по строке с детьми открывает МНОГОСТРОЧНОЕ поле всего блока', async () => {
    const block = '- [ ] задача\n  - [ ] пункт\n  текст';
    const { host, calls, destroy } = mount([withChildren()], {
      loadRawBlock: async (row) => ({ start: row.lineNo, end: 2, text: block }),
    });
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    await flush();
    const field = row.querySelector('.ui-task-row-block-edit') as unknown as ShimElement;
    assert.ok(field, 'открылось поле блочной правки');
    assert.equal(field.value, block, 'в поле — строка задачи И все её вложенные строки');
    assert.equal(calls.rawLines, 0, 'блочная правка не читает одну строку: блок читает экран');
    destroy();
  });

  it('Enter в блочном поле — перевод строки, сохраняет Ctrl+Enter; диапазон — до последнего ребёнка', async () => {
    const saved: Array<{ start: number; end: number; text: string }> = [];
    const { host, destroy } = mount([withChildren()], {
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
    const field = row.querySelector('.ui-task-row-block-edit') as unknown as ShimElement;
    field.value = '- [ ] задача\n  - [x] пункт\n  текст';
    field.focus();
    assert.equal(
      keymap.dispatchKeyEvent({
        key: 'Enter',
        target: field,
        preventDefault: (): void => undefined,
      } as unknown as KeyboardEvent),
      false,
      'Enter без модификатора — перевод строки, а не сохранение',
    );
    assert.deepEqual(saved, [], 'перевод строки не пишет источник');
    keymap.dispatchKeyEvent({
      key: 'Enter',
      ctrlKey: true,
      target: field,
      preventDefault: (): void => undefined,
    } as unknown as KeyboardEvent);
    await flush();
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
});
