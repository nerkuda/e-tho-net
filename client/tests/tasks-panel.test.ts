/**
 * Компонента панели «Задачи и напоминания» `lib/ui/task-panel.ts` (0.16.1,
 * задача 64f7976a; элементы f76ed829/15f8ea2f/498f23e0).
 *
 * Проверяется поведение, которое нельзя выразить чистой моделью:
 *  • секции и строки строятся по снимку, unknown-узлы переживают повторный
 *    render (keyed-сверка);
 *  • чекбокс — одиночный клик, без режима правки; серая строка неактивна;
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
}

/** Строка панели (view-модель) с адресом проекции. */
function taskRow(overrides: Partial<TaskPanelRow> = {}): TaskPanelRow {
  return {
    key: 'c1:0',
    commentId: 'c1',
    lineNo: 0,
    text: 'задача',
    done: false,
    stale: false,
    subtask: false,
    periodFrom: null,
    due: '2026-11-14',
    subjectThoughts: [],
    subjectId: null,
    day: '2026-11-14',
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
    assert.equal(counters?.textContent, t('tasks.counters', [2, 0]));
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

  it('серая строка неактивна и не открывает правку', () => {
    const { host, destroy } = mount([taskRow({ stale: true })]);
    const row = rowsOf(host)[0]!;
    assert.ok(row.classList.contains('is-stale'));
    assert.equal(
      (row.querySelector('.ui-task-row-check') as unknown as ShimElement).disabled,
      true,
    );
    const text = row.querySelector('.ui-task-row-text') as unknown as ShimElement;
    text.emit('dblclick', {});
    assert.equal(row.querySelector('.ui-task-row-edit'), null);
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

  it('headActions: «Обновить» и «⋮» отдаются наружу и работают', () => {
    let menuCalls = 0;
    const { calls, headActions, destroy } = mountHeadless(flatView([taskRow()], []), {
      headMenu: () => {
        menuCalls += 1;
        return [];
      },
    });
    assert.equal(headActions.length, 2, 'кнопки шапки: «Обновить» и «⋮»');
    headActions[0]!.click();
    assert.equal(calls.refresh, 1);
    (headActions[1] as unknown as ShimElement).emit('click', {
      target: headActions[1],
      currentTarget: headActions[1],
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
