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
  type TaskPanelActions,
  type TaskPanelRow,
  type TaskPanelView,
} from '../src/renderer/lib/ui/task-panel.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Поднять минимальные глобалы DOM: без них фасады `el`/`div` не построят узлы. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    // Навигация списка (`createListNav`) вешает глобальные слушатели на
    // документ; в тесте они не срабатывают, но обязаны существовать.
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
}

/** Наблюдения вызовов действий панели за один прогон. */
interface Calls {
  refresh: number;
  undo: number;
  showDone: boolean[];
  toggles: Array<{ key: string; done: boolean }>;
  edits: Array<{ key: string; text: string }>;
  rowCommands: string[];
  bulk: string[];
  reminderActions: string[];
  days: string[];
}

/** Строка панели (view-модель) с адресом проекции. */
function taskRow(overrides: Partial<TaskPanelRow> = {}): TaskPanelRow {
  return {
    key: 'c1:0',
    commentId: 'c1',
    lineNo: 0,
    text: '- [ ] задача',
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
function mount(rows: TaskPanelRow[] = [taskRow()]): {
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
    days: [],
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
    editLine: async (row, text) => {
      calls.edits.push({ key: row.key, text });
      return true;
    },
    rowCommand: (row, command) => {
      calls.rowCommands.push(`${row.key}:${command}`);
    },
    bulk: (_filter, command) => {
      calls.bulk.push(command);
    },
    reminderAction: (row, action) => {
      calls.reminderActions.push(`${row.key}:${action}`);
    },
    openDay: (day) => {
      calls.days.push(day);
    },
    renderText: (node, row) => {
      node.textContent = row.text;
    },
  };
  const handle = mountTaskPanel(host as unknown as HTMLElement, actions);
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

  it('двойной клик открывает поле с сырым markdown, Escape отменяет', () => {
    const { host, calls, destroy } = mount([taskRow({ text: '- [ ] задача' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
    assert.ok(field, 'поле правки открылось');
    assert.equal(field.value, '- [ ] задача', 'правится СЫРОЙ markdown строки');
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

  it('Enter сохраняет текст через `editLine` и закрывает правку', async () => {
    const { host, calls, destroy } = mount([taskRow({ text: 'старый' })]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
    field.value = '- [ ] новый';
    field.focus();
    keymap.dispatchKeyEvent({
      key: 'Enter',
      target: field,
      preventDefault: (): void => undefined,
    } as unknown as KeyboardEvent);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls.edits, [{ key: 'c1:0', text: '- [ ] новый' }]);
    assert.equal(row.querySelector('.ui-task-row-edit'), null, 'после сохранения правка закрыта');
    destroy();
  });

  it('строка, открытая в правке, переживает повторный render панели', () => {
    const { host, render, destroy } = mount([taskRow()]);
    const row = rowsOf(host)[0]!;
    (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
    assert.ok(row.querySelector('.ui-task-row-edit'));
    render(panelView([taskRow({ stale: true })], { stale: true }));
    assert.ok(row.querySelector('.ui-task-row-edit'), 'правка не сброшена перерисовкой списка');
    destroy();
  });
});
