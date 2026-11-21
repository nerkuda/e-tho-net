/**
 * Экранная обвязка панели «Задачи и напоминания» — `screens/chronicle/
 * tasks-panel.ts` (0.16.1, задача 64f7976a; требование e6af8b9e «массовые
 * команды», блокер и замечания репроверки 64f7976a).
 *
 * Что проверяется ЗДЕСЬ, а не в тестах компоненты/модели (они видят только
 * готовые снимки и чистые правила):
 *  • загрузка экрана идёт четырьмя запросами задач + напоминаний, а фильтр
 *    «за период» собирается из периода ленты;
 *  • массовая команда группы «за период» уходит в сеть С from/to периода —
 *    сними границы в `periodFilter`, и тест краснеет (мутация проверена);
 *  • подгруппы напоминаний показывают НАЗВАНИЯ субъектов обоих видов (мысль и
 *    публикация), а не GUID: вид берётся у строки, ключи названий у видов разные;
 *  • «Перенести… на дату», равную якорю строки («сегодня» — массово), не
 *    закрывает диалог молча, а пишет статус «Перенос не требуется»;
 *  • ID-ссылка строки (`[[#uuid]]`) красится по ГОТОВОМУ DOM: подпись — имя
 *    мысли, span остаётся `.wiki-link[data-wiki-id]` (блокер приёмки 399c25d5).
 *
 * Сеть подменена: `window.etn` — подставной REST-клиент, который записывает
 * вызовы. DOM — общий шим `./dom-shim.js`; диалоги (подтверждение, выбор даты)
 * проходят настоящий путь `lib/dialog.ts`/`date-period-dialog.ts` и
 * подтверждаются кликом по их DOM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EditorView, runScopeHandlers } from '@codemirror/view';

import * as keymap from '../src/renderer/lib/keymap.js';
import { markdownFieldValue } from '../src/renderer/editor/markdown-field.js';
import type { TasksPanelHandle } from '../src/renderer/screens/chronicle/tasks-panel.js';
import { ShimElement } from './dom-shim.js';

/** Текст поля правки (CM6): компонента держит его у себя, а не в `value`. */
function fieldText(field: HTMLElement): string {
  return markdownFieldValue(field);
}

/**
 * Заменить текст поля правки — тем же путём, что печатает пользователь:
 * транзакцией CM6 (иначе снапшот поля остался бы прежним и правка «не грязная»).
 */
function typeIntoField(field: HTMLElement, text: string): void {
  const content = field.querySelector<HTMLElement>('.cm-content');
  assert.ok(content, 'поле CM6 смонтировано');
  const view = EditorView.findFromDOM(content);
  assert.ok(view, 'вид CM6 найден по DOM');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/** Ctrl+Enter по корню поля: capture-перехват компоненты (п.1 ТЗ 2026-11-18). */
function pressCommit(field: HTMLElement): { prevented: boolean; stopped: boolean } {
  const state = { prevented: false, stopped: false };
  (field as unknown as ShimElement).emit('keydown', {
    key: 'Enter',
    ctrlKey: true,
    metaKey: false,
    preventDefault: (): void => {
      state.prevented = true;
    },
    stopPropagation: (): void => {
      state.stopped = true;
    },
  });
  return state;
}

/** Период ленты, который отдаёт экран (`deps.getPeriod`). */
const PERIOD = { from: '2026-11-10', to: '2026-11-12' };

/** Запись вызовов подставного REST-клиента. */
interface Calls {
  /** `etn.tasks.list(networkId, query)` — по вызову на секцию. */
  list: Array<Record<string, unknown>>;
  /** `etn.tasks.patch(networkId, input)` — команды строк и массовые. */
  patch: Array<Record<string, unknown>>;
  /** `deps.onRecordsChanged()` — лента обязана перечитаться после команды. */
  records: number;
  /** `deps.openDay(day)` — переход к источнику. */
  days: string[];
  /** `etn.thoughts.resolve(networkId, ids)` — запрошенные id ID-ссылок. */
  resolved: string[];
  /** `etn.ui.setState(...)` — сохранённые настройки панели (`ui_state`). */
  state: string[];
  /** `deps.onPanelCollapsed(...)` — свёрнутость панели для слайдера (пункт B). */
  collapsed: boolean[];
  /** `etn.comments.update(...)` — сырые тексты, записанные в источники. */
  commentUpdates: string[];
}

/** Данные, которые «есть в сети» у подставного клиента. */
interface Fixture {
  /** Строки проекции задач в периоде (scope=open). */
  tasks?: Array<Record<string, unknown>>;
  /** Выполненные строки периода (scope=done), по умолчанию — те же, что `tasks`. */
  doneTasks?: Array<Record<string, unknown>>;
  /** Просроченные строки (scope=overdue) — сквозная секция. */
  overdueTasks?: Array<Record<string, unknown>>;
  /** Строки без срока (scope=undated) — сквозная секция. */
  undatedTasks?: Array<Record<string, unknown>>;
  /** Напоминания владельца с уже раскрытыми вхождениями. */
  reminders?: Array<Record<string, unknown>>;
  /**
   * Строки ЗАПИСИ для точечного перечитывания (`GET /tasks?comment_id=`), по
   * адресу комментария: так проверяется обновление снапшота после инлайн-правки
   * (ошибка 45480290).
   */
  commentRows?: Record<string, Array<Record<string, unknown>>>;
  /** Сохранённые настройки панели в `ui_state` (свёрнутость, показ выполненных). */
  uiState?: string;
  /** Вложенные не-задачные строки, которые отдаёт сервер по `include_nested`. */
  nested?: Array<Record<string, unknown>>;
  /** Тексты комментариев-источников (`comments.get`) — сырой `body_md`. */
  commentBodies?: Record<string, string>;
  /** Период ленты для экрана (по умолчанию `PERIOD`); одна дата — плоские секции. */
  period?: { from: string; to: string };
}

/** Минимальная строка `TaskDTO` в периоде, открытая. */
function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment_id: 'c1',
    line_no: 0,
    text: 'задача',
    period_from: '2026-11-10',
    period_to: '2026-11-11',
    due: '2026-11-11',
    done: false,
    subject_thoughts: [],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: 1,
    parsed_revision: 1,
    kind: 'permanent',
    auto_period: false,
    ...overrides,
  };
}

/** Минимальное напоминание `Reminder` с одним вхождением. */
function reminder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    user_id: 'u1',
    subject_type: 'thought',
    subject_id: '11111111-1111-4111-8111-111111111111',
    subject_state: 'active',
    kind: 'one',
    schedule: { type: 'once' },
    anchor_at: '2026-11-10T09:00:00.000Z',
    next_at: '2026-11-10T09:00:00.000Z',
    exceptions: {},
    state: 'active',
    occurrences: [
      {
        occurrence_at: '2026-11-10T09:00:00.000Z',
        status: 'active',
        until: null,
      },
    ],
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

/** Общий рантайм одного теста: DOM-шим, подставная сеть, смонтированная панель. */
interface Harness {
  host: ShimElement;
  calls: Calls;
  /** Строка состояния клиента (`notice(..., 'info')` пишет сюда). */
  status: { textContent: string; title: string };
  /** Дождаться промисов загрузки и диалогов. */
  settle(): Promise<void>;
  /** Открыть меню «⋮» группы «Задачи периода». */
  openTasksMenu(): void;
  /** Открыть меню «⋮» строки задачи. */
  openRowMenu(): void;
  /** Пункты последнего открытого меню (по подписи). */
  menuItem(label: string): ShimElement;
  /** Открыть подменю пункта меню (наведение). */
  hover(item: ShimElement): void;
  /** Подтвердить верхний диалог его основной кнопкой. */
  confirmDialog(): void;
  /** Выбрать день в открытом диалоге даты (двойной клик — подтверждение). */
  pickDay(day: string): void;
  /** Дочерние узлы `document.body`. */
  body(): ShimElement;
  /** Дескриптор панели для экрана (высота, свёрнутость). */
  handle: TasksPanelHandle;
  /** Сменить период ленты и перечитать панель (как «Применить» в фильтре). */
  setPeriod(next: { from: string; to: string }): Promise<void>;
  destroy(): void;
}

/**
 * Поднять окружение: шим DOM, подставной `window.etn` и смонтированная панель.
 * Модули грузятся ДИНАМИЧЕСКИ: `lib/etn.ts` читает `window` при каждом доступе,
 * но шим обязан стоять до первого монтирования.
 */
async function setup(fixture: Fixture = {}): Promise<Harness> {
  const body = new ShimElement('body');
  const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const doc: Record<string, any> = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    // `documentElement`/`head` — настоящие узлы шима: CodeMirror монтирует
    // свои стили в `document.head` (`StyleSet.mount`).
    documentElement: new ShimElement('html'),
    head: new ShimElement('head'),
    body,
    adoptedStyleSheets: [],
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    // CodeMirror (правка строки компонентой) спрашивает выделение/фокус/диапазон.
    getSelection: () => null,
    hasFocus: () => false,
    createRange: () => ({
      setStart: (): void => undefined,
      setEnd: (): void => undefined,
      getClientRects: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    }),
  };
  (globalThis as any).document = doc;
  // CodeMirror читает `ownerDocument.defaultView` у шим-элементов.
  (ShimElement.prototype as any).ownerDocument = doc;
  (ShimElement.prototype as any).getSelection = () => null;
  // Наблюдатель мутаций/локальное хранилище нужны CM6; раскладка полю не нужна.
  (globalThis as any).MutationObserver = class {
    observe(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
    takeRecords(): unknown[] {
      return [];
    }
  };
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => ls.get(key) ?? null,
    setItem: (key: string, value: string) => void ls.set(key, value),
    removeItem: (key: string) => void ls.delete(key),
    clear: () => ls.clear(),
    key: (index: number) => [...ls.keys()][index] ?? null,
    get length() {
      return ls.size;
    },
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): boolean => true;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  win.addEventListener = (type: string, listener: (event: any) => void): void => {
    windowListeners.push({ type, listener });
  };
  win.removeEventListener = (type: string, listener: (event: any) => void): void => {
    const index = windowListeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener,
    );
    if (index >= 0) windowListeners.splice(index, 1);
  };
  // Связка «документ ↔ окно» и кадры: CM6 читает `defaultView` и планирует замеры.
  doc.defaultView = win;
  win.document = doc;
  win.getSelection = () => null;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = (): void => undefined;

  const calls: Calls = {
    list: [],
    patch: [],
    records: 0,
    days: [],
    resolved: [],
    state: [],
    collapsed: [],
    commentUpdates: [],
  };
  const tasks = fixture.tasks ?? [];
  const doneTasks = fixture.doneTasks ?? [];
  const overdueTasks = fixture.overdueTasks ?? [];
  const undatedTasks = fixture.undatedTasks ?? [];
  /** Версии комментариев-источников и их тексты (подставной PATCH/update). */
  const versions = new Map<string, number>();
  const bodies = new Map<string, string>();
  /**
   * Вложенные строки, попадающие в страницу `GET /tasks`: как у сервера — только
   * те, чьи родители-задачи в неё попали (пункт F ТЗ 2026-11-17). Общая для
   * срезов и для точечного перечитывания записи (`include_nested`).
   */
  const nestedOf = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    (fixture.nested ?? []).filter((line) =>
      items.some(
        (item) =>
          item['comment_id'] === (line['parent'] as Record<string, unknown>)['comment_id'] &&
          item['line_no'] === (line['parent'] as Record<string, unknown>)['line_no'],
      ),
    );
  const api = {
    ui: {
      getState: async (): Promise<string | null> => fixture.uiState ?? null,
      setState: async (_networkId: string, _key: string, value: string): Promise<void> => {
        calls.state.push(value);
      },
    },
    tasks: {
      list: async (_networkId: string, query: Record<string, unknown> = {}) => {
        calls.list.push(query);
        const commentId = query['comment_id'];
        if (typeof commentId === 'string') {
          // Точечное перечитывание записи (после инлайн-правки).
          const items = fixture.commentRows?.[commentId] ?? [];
          return {
            items,
            cursor: null,
            max_revision: 2,
            ...(query['include_nested'] === true ? { nested: nestedOf(items) } : {}),
          };
        }
        // Срезы не смешиваются: «просрочено» и «без срока» — сквозные запросы,
        // в фикстуре по умолчанию пусты, чтобы строка периода не считалась трижды.
        const scope = query['scope'];
        const items =
          scope === 'overdue'
            ? overdueTasks
            : scope === 'undated'
              ? undatedTasks
              : scope === 'done'
                ? doneTasks
                : tasks;
        return {
          items,
          cursor: null,
          max_revision: 1,
          ...(query['include_nested'] === true ? { nested: nestedOf(items) } : {}),
        };
      },
      patch: async (_networkId: string, input: Record<string, unknown>) => {
        calls.patch.push(input);
        const ops = (input['ops'] ?? []) as Array<Record<string, unknown>>;
        const revisions = ops.map((op) => {
          const id = String(op['comment_id']);
          const version = (versions.get(id) ?? 1) + 1;
          versions.set(id, version);
          return { id, version };
        });
        return {
          results: ops.map((op) => ({
            comment_id: op['comment_id'],
            line_no: op['line_no'],
            ok: true,
          })),
          revisions,
        };
      },
    },
    reminders: {
      list: async () => ({ reminders: fixture.reminders ?? [], from: null, to: null }),
    },
    thoughts: {
      get: async (_networkId: string, id: string) => ({ id, title: `Мысль ${id}` }),
      resolve: async (_networkId: string, ids: string[]) => {
        calls.resolved.push(...ids);
        return ids.map((id) => ({ id, title: `Мысль ${id}`, exists: true }));
      },
    },
    publications: {
      get: async (_networkId: string, id: string) => ({ id, title: `Публикация ${id}` }),
    },
    comments: {
      list: async () => [],
      get: async (_networkId: string, id: string) => ({
        id,
        body_md: bodies.get(id) ?? fixture.commentBodies?.[id] ?? '- [ ] задача',
        version: versions.get(id) ?? 1,
      }),
      update: async (
        _networkId: string,
        id: string,
        input: { body_md?: string },
      ): Promise<Record<string, unknown>> => {
        const version = (versions.get(id) ?? 1) + 1;
        versions.set(id, version);
        if (input.body_md !== undefined) {
          bodies.set(id, input.body_md);
          calls.commentUpdates.push(input.body_md);
        }
        return { id, body_md: bodies.get(id), version };
      },
    },
  };
  (globalThis as any).etn = api;
  win.etn = api;

  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
  const { mountStatusMessage } = await import('../src/renderer/lib/status-message.js');
  const status = { textContent: '', title: '' };
  mountStatusMessage(status);
  const { closeMenu } = await import('../src/renderer/lib/menu.js');
  const { mountTasksPanel } = await import('../src/renderer/screens/chronicle/tasks-panel.js');

  const host = new ShimElement('div');
  let period = fixture.period ?? PERIOD;
  const handle = mountTasksPanel(host as unknown as HTMLElement, {
    getPeriod: () => period,
    openDay: (day) => calls.days.push(day),
    onRecordsChanged: () => {
      calls.records += 1;
    },
    onPanelCollapsed: (collapsed) => calls.collapsed.push(collapsed),
  });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();

  const menuItem = (label: string): ShimElement => {
    const item = body
      .querySelectorAll('.menu-item')
      .find((node) => node.flatText().includes(label));
    assert.ok(item, `пункт меню «${label}» есть`);
    return item;
  };

  return {
    host,
    calls,
    status,
    settle,
    body: () => body,
    handle,
    openTasksMenu(): void {
      const group = host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
      assert.ok(group, 'группа «Задачи периода» на панели');
      const button = group.querySelector('.ui-task-group-menu') as unknown as ShimElement;
      assert.ok(button, 'кнопка «⋮» группы задач');
      button.emit('click', {
        target: button,
        currentTarget: button,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
    },
    openRowMenu(): void {
      const button = host.querySelector('.ui-task-row-menu') as unknown as ShimElement;
      assert.ok(button, 'кнопка «⋮» строки задачи');
      button.emit('click', {
        target: button,
        currentTarget: button,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
    },
    menuItem,
    hover(item: ShimElement): void {
      item.emit('mouseenter');
    },
    confirmDialog(): void {
      const confirm = body
        .querySelectorAll('.ui-btn')
        .find((node) => node.flatText().trim() === tActionConfirm);
      assert.ok(confirm, 'кнопка подтверждения в диалоге');
      confirm.emit('click', {
        target: confirm,
        currentTarget: confirm,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
    },
    pickDay(day: string): void {
      const cell = body
        .querySelectorAll('.cal-day')
        .find((node) => String(node.getAttribute('title') ?? node.title) === day);
      assert.ok(cell, `день ${day} есть в диалоге даты`);
      // Одиночный клик выбирает день, двойной — подтверждает выбор (609deba0).
      cell.emit('click', { detail: 1 });
      cell.emit('click', { detail: 2 });
    },
    async setPeriod(next: { from: string; to: string }): Promise<void> {
      period = next;
      handle.refresh();
      await settle();
    },
    destroy(): void {
      handle.destroy();
      closeMenu();
    },
  };
}

/** Подпись кнопки подтверждения из словаря (диалог строит её тем же `t()`). */
let tActionConfirm = 'OK';

afterEach(async () => {
  const { closeMenu } = await import('../src/renderer/lib/menu.js');
  closeMenu();
});

describe('панель задач: экранная загрузка и период массовых команд (e6af8b9e)', () => {
  it('загружает четыре среза задач и напоминания, фильтр периода — из ленты', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      assert.deepEqual(
        h.calls.list.map((query) => query['scope']),
        ['open', 'overdue', 'undated', 'done'],
        'четыре запроса проекции: период, просрочено, без срока, выполненные',
      );
      assert.deepEqual(
        h.calls.list.map((query) => query['include_nested']),
        [true, true, true, true],
        'вложенные строки запрашиваются вместе с задачами (пункт F ТЗ)',
      );
      assert.deepEqual(
        { from: h.calls.list[0]!['from'], to: h.calls.list[0]!['to'] },
        PERIOD,
        '«за период» адресуется периодом ленты',
      );
      assert.deepEqual(
        { from: h.calls.list[3]!['from'], to: h.calls.list[3]!['to'] },
        PERIOD,
        'выполненные — тоже в периоде ленты',
      );
    } finally {
      h.destroy();
    }
  });

  it('массовая команда «за период» уходит в сеть с from/to периода ленты', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.openTasksMenu();
      h.menuItem(tCancelAllPeriod).click();
      await h.settle();
      h.confirmDialog();
      await h.settle();
      const patches = h.calls.patch;
      assert.equal(patches.length, 1, 'команда ушла один раз');
      assert.equal(patches[0]!['action'], 'cancel-all');
      assert.deepEqual(patches[0]!['filter'], {
        scope: 'open',
        from: PERIOD.from,
        to: PERIOD.to,
        today: todayLocalOfScreen(),
      });
      assert.equal(h.calls.records, 1, 'лента перечитана после команды');
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: единый список напоминаний с названиями субъектов (пункт 6)', () => {
  it('мысль и публикация — облачка в ОДНОМ списке, без подгрупп и GUID', async () => {
    const thoughtId = '11111111-1111-4111-8111-111111111111';
    const publicationId = '22222222-2222-4222-8222-222222222222';
    const h = await setup({
      reminders: [
        reminder({
          id: 'r-thought',
          subject_type: 'thought',
          subject_id: thoughtId,
          occurrences: [{ occurrence_at: todayStartIso(), status: 'active', until: null }],
        }),
        reminder({
          id: 'r-publication',
          subject_type: 'publication',
          subject_id: publicationId,
          occurrences: [{ occurrence_at: tomorrowStartIso(), status: 'active', until: null }],
        }),
      ],
    });
    try {
      const group = h.host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
      assert.ok(group, 'группа «Напоминания периода» на панели');
      assert.equal(group.findAll('ui-task-subgroup').length, 0, 'подгрупп по видам субъектов нет');
      const titles = group
        .findAll('ui-task-row-subject')
        .map((node) => node.flatText().trim())
        .filter((title) => title !== '');
      assert.deepEqual(titles, [`Мысль ${thoughtId}`, `Публикация ${publicationId}`]);
      assert.ok(
        !titles.some((title) => /^[0-9a-f-]{36}$/.test(title)),
        'в облачках строк нет GUID',
      );
    } finally {
      h.destroy();
    }
  });
});
describe('панель задач: ID-ссылка строки красится по готовому DOM (блокер 399c25d5)', () => {
  it('пустой span data-wiki-id получает подпись мысли и остаётся кликабельным', async () => {
    const h = await setup({});
    try {
      const thoughtId = '33333333-3333-4333-8333-333333333333';
      // DOM-шим не разбирает `innerHTML` на узлы: подставляем узел сами —
      // проверяется именно то, что резолв идёт по DOM строки, а не по строке
      // HTML (резолвер сниппета не видит `<span data-wiki-id>` вовсе).
      const span = new ShimElement('span');
      span.setAttribute('class', 'wiki-link');
      span.setAttribute('data-wiki-id', thoughtId);
      const node = {
        innerHTML: '',
        querySelectorAll: (selector: string) => (selector.includes('data-wiki-id') ? [span] : []),
      };
      const { renderTaskRowText } =
        await import('../src/renderer/screens/chronicle/tasks-panel.js');
      renderTaskRowText(node as unknown as HTMLElement, `[[#${thoughtId}]] [[2026-11-11]]`, 'n1');
      await h.settle();

      assert.deepEqual(h.calls.resolved, [thoughtId], 'id ID-ссылки запрошен у сети');
      assert.equal(span.textContent, `Мысль ${thoughtId}`, 'подпись ссылки — имя мысли');
      assert.ok(
        span.classList.contains('wiki-link-resolved'),
        'ссылка помечена разрешённой (стиль кликабельности)',
      );
      assert.equal(
        span.getAttribute('data-wiki-id'),
        thoughtId,
        'data-wiki-id сохранён — делегированный клик работает',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: «Перенести… на дату» без сдвига не молчит (замечание 64f7976a)', () => {
  it('дата, равная сроку строки, показывает статус «Перенос не требуется»', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.openRowMenu();
      h.hover(h.menuItem(tMoveRow));
      h.menuItem(tMoveDate).click();
      await h.settle();
      h.pickDay('2026-11-11');
      await h.settle();
      assert.equal(h.calls.patch.length, 0, 'команда в сеть не ушла');
      assert.equal(h.status.textContent, tMoveNotNeeded, 'статус вместо молчания');
    } finally {
      h.destroy();
    }
  });

  it('«сегодня» для массового переноса тоже показывает статус', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.openTasksMenu();
      h.hover(h.menuItem(tMoveAllPeriod));
      h.menuItem(tMoveDate).click();
      await h.settle();
      h.pickDay(todayLocalOfScreen());
      await h.settle();
      assert.equal(h.calls.patch.length, 0, 'массовая команда в сеть не ушла');
      assert.equal(h.status.textContent, tMoveNotNeeded, 'статус вместо молчания');
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: точечная правка строки (ошибки d318a647/45480290)', () => {
  /** Узел строки панели по адресу проекции. */
  function rowOf(h: Harness, key: string): ShimElement {
    const row = h.host
      .querySelectorAll('.ui-task-row')
      .find((node) => node.getAttribute('data-row-key') === key);
    assert.ok(row, `строка ${key} на панели`);
    return row as ShimElement;
  }

  /** Клик по чекбоксу строки: выставить состояние и послать `change`. */
  function clickCheck(h: Harness, key: string, checked: boolean): void {
    const check = rowOf(h, key).querySelector('.ui-task-row-check') as unknown as ShimElement;
    check.checked = checked;
    check.emit('change');
  }

  it('чекбокс зажигает «Обновить» (пункт 4), но строки остаются свежими и рабочими', async () => {
    const h = await setup({
      tasks: [taskRow({ line_no: 0, text: 'первая' }), taskRow({ line_no: 1, text: 'вторая' })],
    });
    try {
      clickCheck(h, 'c1:0', true);
      await h.settle();
      assert.equal(
        rowOf(h, 'c1:0').classList.contains('is-stale'),
        false,
        'своя команда строку серой не делает (вердикт e984a2db)',
      );
      assert.equal(
        rowOf(h, 'c1:1').classList.contains('is-stale'),
        false,
        'соседняя строка той же записи тоже свежая',
      );
      assert.ok(rowOf(h, 'c1:0').classList.contains('is-done'), 'галочка показала новое состояние');
      assert.equal(
        (rowOf(h, 'c1:1').querySelector('.ui-task-row-check') as unknown as ShimElement).disabled,
        false,
        'соседняя строка рабочая',
      );
      assert.equal(
        (
          h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement
        ).classList.contains('is-stale'),
        true,
        'отметка выполнения зажигает «Обновить»: списки пересобираются только по кнопке',
      );
      // Повторный клик снимает отметку: команда работает и на серой строке.
      clickCheck(h, 'c1:0', false);
      await h.settle();
      assert.equal(
        rowOf(h, 'c1:0').classList.contains('is-done'),
        false,
        'повторный клик снял отметку',
      );
      const ops = h.calls.patch.map(
        (input) => (input['ops'] as Array<Record<string, unknown>>)[0]!,
      );
      assert.deepEqual(
        ops.map((op) => op['action']),
        ['toggle', 'toggle'],
      );
      assert.deepEqual(
        ops.map((op) => op['done']),
        [true, false],
      );
      assert.deepEqual(
        ops.map((op) => op['expected_revision']),
        [1, 2],
        'вторая команда идёт с ревизией, поднятой первой (иначе 409)',
      );
    } finally {
      h.destroy();
    }
  });

  it('«Сделать бессрочной» перечитывает запись и зажигает «Обновить» (срок изменился)', async () => {
    const h = await setup({
      tasks: [taskRow()],
      // После «Сделать бессрочной» запись перечитывается БЕЗ срока — структура
      // секций изменилась, поэтому «Обновить» зажигается (пункт 2).
      commentRows: {
        c1: [
          taskRow({
            due: null,
            period_from: null,
            period_to: null,
            revision: 2,
            parsed_revision: 2,
          }),
        ],
      },
    });
    try {
      h.openRowMenu();
      h.menuItem(tUndateRow).click();
      await h.settle();
      assert.ok(
        h.calls.list.some((query) => query['comment_id'] === 'c1'),
        'строки записи перечитаны после СВОЕЙ команды',
      );
      assert.equal(
        rowOf(h, 'c1:0').classList.contains('is-stale'),
        false,
        'своя команда строку серой не делает (вердикт e984a2db)',
      );
      assert.equal(
        (
          h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement
        ).classList.contains('is-stale'),
        true,
        'смена срока зажигает «Обновить»: секции пересобираются только по кнопке (пункт 2)',
      );
    } finally {
      h.destroy();
    }
  });

  it('инлайн-правка перечитывает строку: новый текст, без серости', async () => {
    keymap.keymapInternals.reset();
    const h = await setup({
      tasks: [taskRow({ text: 'старая' })],
      commentRows: { c1: [taskRow({ text: 'новая', revision: 2, parsed_revision: 2 })] },
    });
    try {
      const row = rowOf(h, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
      assert.ok(field, 'поле правки открылось (компонента комментария)');
      typeIntoField(field as unknown as HTMLElement, '- [ ] новая');
      pressCommit(field as unknown as HTMLElement);
      await h.settle();
      assert.ok(
        h.calls.list.some((query) => query['comment_id'] === 'c1'),
        'строка перечитана точечно по адресу записи',
      );
      assert.equal(
        rowOf(h, 'c1:0').classList.contains('is-stale'),
        false,
        'снапшот строки свежий — «Обновить» для неё не нужна',
      );
      assert.ok(
        String(
          (rowOf(h, 'c1:0').querySelector('.ui-task-row-text') as unknown as ShimElement).innerHTML,
        ).includes('новая'),
        'панель показывает новый текст строки',
      );
    } finally {
      h.destroy();
    }
  });
  it('инлайн-правка пишет СЫРУЮ строку источника, а не снапшот проекции', async () => {
    keymap.keymapInternals.reset();
    // Сырая строка отличается от снапшота: маркер списка, markdown-разметка,
    // date-ссылка и вложенная строка под задачей. Мутация «писать row.text»
    // сохранила бы снапшот и уничтожила задачу.
    const raw = '- [ ] Задача **жирным** и `кодом` [[2026-11-20]]';
    const h = await setup({
      tasks: [taskRow({ text: 'Задача **жирным** и `кодом` [[2026-11-20]]' })],
      commentBodies: { c1: `${raw}\n  - [ ] пункт` },
      commentRows: { c1: [taskRow({ text: 'Задача **жирным** — уточнение', revision: 2 })] },
    });
    try {
      const row = rowOf(h, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-edit') as unknown as HTMLElement;
      assert.ok(field, 'поле правки открылось');
      assert.equal(fieldText(field), raw, 'в поле — СЫРАЯ строка тела, а не снапшот проекции');
      typeIntoField(field, '- [ ] Задача **жирным** — уточнение');
      pressCommit(field);
      await h.settle();
      assert.deepEqual(
        h.calls.commentUpdates,
        ['- [ ] Задача **жирным** — уточнение\n  - [ ] пункт'],
        'в тело ушла отредактированная СЫРАЯ строка (маркер сохранён), вложенная строка цела',
      );
    } finally {
      h.destroy();
    }
  });
  it('поле правки получает фокус ПОСЛЕ вставки в строку (блокер 84c71c37)', async () => {
    keymap.keymapInternals.reset();
    const h = await setup({ tasks: [taskRow()] });
    const originalFocus = ShimElement.prototype.focus;
    /** Ставился ли фокус, когда поле уже стояло в строке документа. */
    const focusedInRow: boolean[] = [];
    /** Есть ли над узлом строка задачи (у оторванного узла фокус — no-op). */
    const insideTaskRow = (start: ShimElement): boolean => {
      let node: ShimElement | null = start;
      while (node !== null) {
        if (node.classList.contains('ui-task-row')) return true;
        node = node.parentNode;
      }
      return false;
    };
    ShimElement.prototype.focus = function (this: ShimElement): void {
      focusedInRow.push(insideTaskRow(this));
      originalFocus.call(this);
    };
    try {
      const row = rowOf(h, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      assert.ok(
        focusedInRow.includes(true),
        'фокус выставлен, когда поле уже в строке (в оторванном узле он — no-op)',
      );
      const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
      assert.ok(field, 'поле правки открылось');
      const content = field.querySelector('.cm-content') as unknown as ShimElement;
      assert.equal(content.focused, true, 'каретка в поле правки, а не в body');
      // Enter без клика в поле: правка живая, keymap компоненты работает сразу.
      const view = EditorView.findFromDOM(content as unknown as HTMLElement);
      assert.ok(view, 'вид CM6 найден по DOM');
      runScopeHandlers(
        view,
        {
          key: 'Enter',
          keyCode: 13,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault: (): void => undefined,
          stopPropagation: (): void => undefined,
        } as unknown as KeyboardEvent,
        'editor',
      );
      assert.equal(view.state.doc.lines, 2, 'Enter дописал строку без клика в поле');
    } finally {
      ShimElement.prototype.focus = originalFocus;
      h.destroy();
    }
  });

  it('Ctrl+Enter со сменой срока: строка на месте, «Обновить» зажжена, порядок — по кнопке', async () => {
    keymap.keymapInternals.reset();
    /** Поздняя строка: по ней видно, что порядок пересобирается по сроку. */
    const lateRow = taskRow({
      comment_id: 'c2',
      text: 'поздняя',
      period_from: '2026-11-20',
      period_to: '2026-11-20',
      due: '2026-11-20',
    });
    const fixture = {
      tasks: [taskRow({ text: 'первая' }), lateRow],
      commentBodies: { c1: '- [ ] первая [[2026-11-18]]', c2: '- [ ] поздняя [[2026-11-20]]' },
      commentRows: {
        // После правки источник отдаёт НОВЫЙ срок: порядок по сроку изменился бы.
        c1: [
          taskRow({
            text: 'первая',
            period_from: '2099-01-01',
            period_to: '2099-01-01',
            due: '2099-01-01',
            revision: 2,
            parsed_revision: 2,
          }),
        ],
      },
    };
    const h = await setup(fixture);
    try {
      const order = (): Array<string | null> =>
        h.host.querySelectorAll('.ui-task-row').map((node) => node.getAttribute('data-row-key'));
      assert.deepEqual(order(), ['c1:0', 'c2:0'], 'исходный порядок — по сроку строки');

      const row = rowOf(h, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
      assert.ok(field, 'поле правки открылось');
      typeIntoField(field as unknown as HTMLElement, '- [ ] первая [[2099-01-01]]');
      pressCommit(field as unknown as HTMLElement);
      await h.settle();

      assert.deepEqual(
        order(),
        ['c1:0', 'c2:0'],
        'строка НЕ прыгает после Ctrl+Enter: порядок пересобирается только по «Обновить»',
      );
      const refresh = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.ok(refresh, 'кнопка «Обновить» на панели');
      assert.ok(
        refresh.classList.contains('is-stale'),
        'смена срока зажгла «Обновить» (пункт 2): маркер не «своя правка прощается»',
      );

      // Пользователь нажал «Обновить»: лента отдаёт запись с новым сроком.
      fixture.tasks.splice(
        0,
        fixture.tasks.length,
        taskRow({
          text: 'первая',
          period_from: '2099-01-01',
          period_to: '2099-01-01',
          due: '2099-01-01',
        }),
        lateRow,
      );
      refresh.emit('click', {
        target: refresh,
        currentTarget: refresh,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      await h.settle();
      assert.deepEqual(order(), ['c2:0', 'c1:0'], 'по кнопке порядок пересобран по новому сроку');
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: даты бессрочных строк (ошибки 3f9ea2ee/3cef7466/f517d83a)', () => {
  /** Строка без срока: ни периода, ни срока. */
  function undatedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return taskRow({
      comment_id: 'c9',
      line_no: 0,
      text: 'без срока',
      period_from: null,
      period_to: null,
      due: null,
      ...overrides,
    });
  }

  it('«Перенести на дату» бессрочной строки уходит операцией set_due', async () => {
    const h = await setup({ undatedTasks: [undatedRow()] });
    try {
      h.openRowMenu();
      h.hover(h.menuItem(tMoveRow));
      h.menuItem(tMoveDate).click();
      await h.settle();
      h.pickDay('2026-11-20');
      await h.settle();
      assert.equal(h.calls.patch.length, 1, 'команда ушла один раз');
      const op = (h.calls.patch[0]!['ops'] as Array<Record<string, unknown>>)[0]!;
      assert.deepEqual(op, {
        comment_id: 'c9',
        line_no: 0,
        action: 'set_due',
        date: '2026-11-20',
        expected_revision: 1,
      });
    } finally {
      h.destroy();
    }
  });

  it('«Сделать бессрочной» уходит операцией undate', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.openRowMenu();
      h.menuItem(tUndateRow).click();
      await h.settle();
      const op = (h.calls.patch[0]!['ops'] as Array<Record<string, unknown>>)[0]!;
      assert.equal(op['action'], 'undate');
      assert.equal(op['date'], undefined, 'сдвига у команды нет');
    } finally {
      h.destroy();
    }
  });

  it('массовая «Сделать бессрочными за период» уходит командой undate-all', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.openTasksMenu();
      h.menuItem(tUndateAllPeriod).click();
      await h.settle();
      h.confirmDialog();
      await h.settle();
      assert.equal(h.calls.patch.length, 1, 'команда ушла один раз');
      assert.equal(h.calls.patch[0]!['action'], 'undate-all');
      assert.deepEqual(h.calls.patch[0]!['filter'], {
        scope: 'open',
        from: PERIOD.from,
        to: PERIOD.to,
        today: todayLocalOfScreen(),
      });
      assert.equal(h.calls.records, 1, 'лента перечитана после команды');
    } finally {
      h.destroy();
    }
  });

  it('секция «Без срока» плоская: вложенной группы «Без даты» нет, счётчик в шапке', async () => {
    const h = await setup({ undatedTasks: [undatedRow()] });
    try {
      const section = h.host
        .querySelectorAll('.ui-task-section')
        .find((node) => node.getAttribute('data-section') === 'undated') as ShimElement;
      assert.ok(section, 'секция «Без срока» на панели');
      assert.equal(
        section.querySelector('.ui-task-subgroup'),
        null,
        'вложенной группы «Без даты» нет (ошибка f517d83a)',
      );
      assert.equal(
        section.querySelector('.ui-task-section-count')?.textContent,
        '(1)',
        'счётчик строк — в шапке секции',
      );
      assert.equal(
        h.host.querySelectorAll('[data-row-key]').length,
        1,
        'строка без срока показана',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: свёрнутость блоков в ui_state (ошибка d0801eea)', () => {
  it('сохранённая свёрнутость группы восстанавливается при открытии панели', async () => {
    // Настройки читаются АСИНХРОННО, уже после монтирования панели: сохранённая
    // карта обязана примениться к построенным узлам, иначе группа открывалась бы
    // развёрнутой до перезапуска клиента.
    const h = await setup({
      tasks: [taskRow()],
      uiState: JSON.stringify({ showDone: false, collapsed: { 'group:tasks': true } }),
    });
    try {
      const group = h.host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
      assert.equal(
        group.querySelector('.ui-task-group-sections'),
        null,
        'группа свёрнута по сохранённой настройке',
      );
      assert.equal(
        group.querySelector('.ui-task-group-counters')?.textContent,
        t('tasks.counters', [1, 0]),
        'счётчик группы виден и в свёрнутом виде',
      );
    } finally {
      h.destroy();
    }
  });

  it('сворачивание группы записывается настройкой панели и переживает перечитывание', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const group = h.host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
      (group.querySelector('.ui-task-group-head') as unknown as ShimElement).click();
      await h.settle();
      assert.equal(h.calls.state.length, 1, 'настройка сохранена в ui_state');
      const saved = JSON.parse(h.calls.state[0]!) as {
        showDone: boolean;
        collapsed: Record<string, boolean>;
      };
      assert.deepEqual(
        saved.collapsed,
        { 'group:tasks': true },
        'ключ блока — в карте свёрнутости',
      );
      assert.equal(
        group.querySelector('.ui-task-group-sections'),
        null,
        'тело свёрнутой группы снято с экрана',
      );
      assert.equal(
        group.querySelector('.ui-task-group-counters')?.textContent,
        t('tasks.counters', [1, 0]),
        'счётчик группы виден и в свёрнутом виде',
      );
      // «Обновить» не раскрывает группу: свёрнутость — состояние экрана, а не
      // пересобранного списка.
      (h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement).click();
      await h.settle();
      assert.equal(
        (h.host.querySelector('.ui-task-group-tasks') as unknown as ShimElement).querySelector(
          '.ui-task-group-sections',
        ),
        null,
        'после перечитывания группа осталась свёрнутой',
      );
    } finally {
      h.destroy();
    }
  });
});

/** Подписи и «сегодня» берутся из тех же модулей, что и у экрана. */
const { t } = await import('../src/renderer/lib/i18n.js');
const { todayLocal } = await import('../src/renderer/screens/chronicle/diary.js');

const tCancelAllPeriod = t('tasks.cancelAllPeriod');
const tMoveRow = t('tasks.moveRow');
const tMoveAllPeriod = t('tasks.moveAllPeriod');
const tMoveDate = t('tasks.moveDate');
const tMoveNotNeeded = t('tasks.moveNotNeeded');
const tUndateRow = t('tasks.undateRow');
const tUndateAllPeriod = t('tasks.undateAllPeriod');
tActionConfirm = t('actions.confirm');

/** «Сегодня» экрана (локальные сутки клиента). */
function todayLocalOfScreen(): string {
  return todayLocal();
}

/** Начало сегодняшних суток (UTC-инстанс) — вхождение в секции «Сегодня». */
function todayStartIso(): string {
  return new Date(`${todayLocal()}T09:00:00`).toISOString();
}

/** Момент следующего дня — вхождение в секции «Период». */
function tomorrowStartIso(): string {
  const date = new Date(`${todayLocal()}T09:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

/** Локальный день со сдвигом от сегодняшнего (`YYYY-MM-DD`). */
function localDayShifted(days: number): string {
  const date = new Date(`${todayLocal()}T09:00:00`);
  date.setDate(date.getDate() + days);
  return todayLocal(date);
}

/** Вчерашние сутки — вхождение в сквозную секцию «Просрочено». */
function yesterdayLocalOfScreen(): string {
  return localDayShifted(-1);
}

/** Завтрашние сутки — второй день периода для проверки формы секций. */
function tomorrowLocalOfScreen(): string {
  return localDayShifted(1);
}

// ---------------------------------------------------------------------------
// 0.16.1, замечания пользователя 2026-11-17 (задача 01998381): пункты B, C, D, F.
// ---------------------------------------------------------------------------

describe('панель задач: подчинённый блок рендерится как комментарий (пачка 7)', () => {
  it('сервер отдаёт строки записи, панель читает срез тела и рисует его единым рендерером', async () => {
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт чек-листа',
          depth: 1,
          checkbox: true,
        },
      ],
      commentBodies: {
        c1: [
          '- [ ] задача',
          '  - [ ] пункт чек-листа',
          '  - обычная строка',
          '    - глубже',
          '  ```',
          '  - [ ] это код',
          '  ```',
        ].join('\n'),
      },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      assert.ok(row, 'строка задачи в панели');
      assert.equal(
        h.host.findAll('ui-task-row-children').length,
        0,
        'по умолчанию подчинённый блок свёрнут',
      );
      const caret = row.querySelector('.ui-task-row-caret') as unknown as ShimElement;
      assert.ok(caret, 'у строки с блоком есть каретка');
      caret.click();
      await h.settle();

      const block = row.querySelector('.ui-task-row-children') as unknown as ShimElement;
      assert.ok(block, 'блок раскрыт');
      assert.ok(
        block.classList.contains('comment-view'),
        'блок — просмотр комментария (те же стили)',
      );
      assert.ok(
        block.classList.contains('md-collapse-host'),
        'сворачивание пунктов — штатным механизмом просмотра (`decorateCommentView`)',
      );
      const html = String(block.innerHTML);
      assert.match(html, /<ul class="contains-task-list">/, 'вложенный список построен рендерером');
      assert.match(html, /class="task-list-item-checkbox"/, 'чекбоксы эталонные');
      assert.match(html, /<pre><code[ >]/, 'код внутри подчинённых строк остался кодом');
      assert.doesNotMatch(html, /ui-task-child-row/, 'плоских «•»-строк больше нет');
    } finally {
      h.destroy();
    }
  });

  it('подзадача с датой видна и строкой-топ, и внутри блока родителя', async () => {
    const h = await setup({
      tasks: [
        taskRow(),
        taskRow({
          key: 'c1:1',
          line_no: 1,
          text: 'подзадача',
          due: '2026-11-20',
          subtask: true,
          parent_task: { comment_id: 'c1', line_no: 0 },
        }),
      ],
      commentBodies: {
        c1: '- [ ] задача\n  - [ ] подзадача [[2026-11-20]]',
      },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
      await h.settle();
      const block = row.querySelector('.ui-task-row-children') as unknown as ShimElement;
      assert.match(
        String(block.innerHTML),
        /подзадача \[\[2026-11-20\]\]|wiki-link-date/,
        'датированная подзадача показана внутри блока родителя',
      );
      assert.ok(
        h.host.querySelector('[data-row-key="c1:1"]'),
        'и остаётся самостоятельной строкой-топ панели',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: одна дата — напоминания плоским списком (пункты C и D)', () => {
  it('секции напоминаний без подгрупп, каждая строка — облачко мысли', async () => {
    const day = '2026-11-12';
    const h = await setup({
      period: { from: day, to: day },
      reminders: [
        reminder({
          id: 'r-a',
          subject_id: '11111111-1111-4111-8111-111111111111',
          occurrences: [{ occurrence_at: `${day}T09:00:00`, status: 'active', until: null }],
        }),
        reminder({
          id: 'r-b',
          subject_id: '22222222-2222-4222-8222-222222222222',
          occurrences: [{ occurrence_at: `${day}T18:00:00`, status: 'active', until: null }],
        }),
      ],
    });
    try {
      const group = h.host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
      assert.ok(group, 'группа напоминаний на панели');
      assert.equal(group.findAll('ui-task-subgroup').length, 0, 'подгрупп по датам/мыслям нет');
      assert.deepEqual(
        group
          .findAll('prc-title')
          .map((node) => node.flatText().trim())
          .sort(),
        [
          'Мысль 11111111-1111-4111-8111-111111111111',
          'Мысль 22222222-2222-4222-8222-222222222222',
        ].sort(),
        'каждая строка — облачко своей мысли',
      );
    } finally {
      h.destroy();
    }
  });

  it('просроченное вхождение помечается классом is-overdue (красный)', async () => {
    const overdueMoment = new Date(`${todayLocal()}T09:00:00`);
    overdueMoment.setDate(overdueMoment.getDate() - 1);
    const h = await setup({
      reminders: [
        reminder({
          occurrences: [
            { occurrence_at: overdueMoment.toISOString(), status: 'active', until: null },
          ],
        }),
      ],
    });
    try {
      const overdue = h.host
        .findAll('ui-reminder-row')
        .filter((node) => node.className.includes('is-overdue'));
      assert.equal(overdue.length, 1, 'просроченная строка помечена для красной даты');
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: высота панели в ui_state (пункт B ТЗ 2026-11-17)', () => {
  it('сохранённая высота применяется переменной панели', async () => {
    const h = await setup({ tasks: [taskRow()], uiState: JSON.stringify({ height: 300 }) });
    try {
      const root = h.host.querySelector('.ui-task-panel') as unknown as ShimElement;
      assert.equal(
        root.style.getPropertyValue('--task-panel-height'),
        '300px',
        'высота из ui_state выставлена на панель',
      );
      assert.equal(h.handle.panelHeight(), 300, 'дескриптор отдаёт высоту экрану');
    } finally {
      h.destroy();
    }
  });

  it('новая высота слайдера пишется в ui_state', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      h.handle.setPanelHeight(420);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const saved = h.calls.state.map((raw) => JSON.parse(raw) as { height?: number });
      assert.equal(saved[saved.length - 1]?.height, 420, 'высота записана в настройку панели');
      const root = h.host.querySelector('.ui-task-panel') as unknown as ShimElement;
      assert.equal(root.style.getPropertyValue('--task-panel-height'), '420px');
    } finally {
      h.destroy();
    }
  });

  it('свёрнутая панель сообщает экрану — слайдер прячется', async () => {
    const h = await setup({
      tasks: [taskRow()],
      uiState: JSON.stringify({ collapsed: { panel: true } }),
    });
    try {
      assert.deepEqual(h.calls.collapsed, [true], 'стартовая свёрнутость сообщена экрану');
      assert.equal(h.handle.panelCollapsed(), true);
    } finally {
      h.destroy();
    }
  });

  it('сохранённая высота ниже минимума поднимается до нижней границы', async () => {
    // Нижняя граница — часть контракта слайдера (пункт B ТЗ 2026-11-17):
    // панель ниже 120px нечитаема. Число в ожидании задано явно: тест обязан
    // краснеть, если границу в коде сдвинут (мутационная проба TASKS_PANEL_H_MIN).
    const h = await setup({ tasks: [taskRow()], uiState: JSON.stringify({ height: 50 }) });
    try {
      const root = h.host.querySelector('.ui-task-panel') as unknown as ShimElement;
      assert.equal(
        root.style.getPropertyValue('--task-panel-height'),
        '120px',
        'высота из настроек ограничена снизу',
      );
      assert.equal(h.handle.panelHeight(), 120);
    } finally {
      h.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Доработка по вердикту проверки 2026-11-17 (блокер): форма секций.
// ---------------------------------------------------------------------------

describe('панель задач: единая форма списков при любом периоде (пункт 6 ТЗ 2026-11-18)', () => {
  it('напоминания — ОДИН список без подгрупп и после смены периода', async () => {
    const today = todayLocal();
    const tomorrow = tomorrowLocalOfScreen();
    const yesterday = yesterdayLocalOfScreen();
    const h = await setup({
      period: { from: today, to: today },
      reminders: [
        reminder({
          id: 'r-yesterday',
          occurrences: [{ occurrence_at: `${yesterday}T09:00:00`, status: 'active', until: null }],
        }),
        reminder({
          id: 'r-today',
          occurrences: [{ occurrence_at: `${today}T09:00:00`, status: 'active', until: null }],
        }),
        reminder({
          id: 'r-tomorrow',
          occurrences: [{ occurrence_at: `${tomorrow}T09:00:00`, status: 'active', until: null }],
        }),
      ],
    });
    try {
      const group = h.host.querySelector('.ui-task-group-reminders') as unknown as ShimElement;
      assert.ok(group, 'группа напоминаний на панели');
      assert.equal(group.findAll('ui-task-subgroup').length, 0, 'подгрупп нет при одной дате');
      assert.equal(group.querySelectorAll('.ui-reminder-row').length, 3, 'в списке все вхождения');

      await h.setPeriod({ from: today, to: tomorrow });

      assert.equal(
        group.findAll('ui-task-subgroup').length,
        0,
        'подгрупп нет и при расширенном периоде: форма списка одна',
      );
      assert.equal(
        group.querySelectorAll('.ui-reminder-row').length,
        3,
        'список остался сплошным, вхождения не потеряны',
      );
    } finally {
      h.destroy();
    }
  });

  it('задачи — «Без срока» и «Срочные» без подгрупп при любом периоде', async () => {
    const today = todayLocal();
    const undated = taskRow({
      comment_id: 'c-undated',
      line_no: 0,
      text: 'без срока',
      period_from: null,
      period_to: null,
      due: null,
    });
    const dated = taskRow({ comment_id: 'c-dated', line_no: 0, text: 'срочная' });
    const h = await setup({
      period: { from: today, to: today },
      tasks: [dated],
      undatedTasks: [undated],
    });
    try {
      const tasksGroup = h.host.querySelector('.ui-task-group-tasks') as unknown as ShimElement;
      assert.ok(tasksGroup, 'группа задач на панели');
      assert.equal(
        tasksGroup.findAll('ui-task-subgroup').length,
        0,
        'подгрупп по датам/мыслям больше нет (пороги 6762adb0 отменены)',
      );
      const titles = tasksGroup
        .findAll('ui-task-section-title')
        .map((node) => node.flatText().trim());
      assert.deepEqual(
        titles,
        [t('tasks.sectionUndated'), t('tasks.sectionUrgent')],
        'ровно две сплошные секции: «Без срока», затем «Срочные»',
      );
      // Форма секций — штатная сворачиваемая секция дизайн-системы (0.16.1,
      // пачка 6, пункт 1), а не flat-вариант «Выполненных задач»: шапка с
      // кареткой и счётчиком, свёрнутость — общий персист панели.
      assert.equal(
        tasksGroup.findAll('ui-task-section-head').length,
        2,
        'у каждой секции шапка дизайн-системы',
      );
      const sectionRoots = tasksGroup.querySelectorAll('[data-section]');
      assert.deepEqual(
        sectionRoots.map((section) => section.classList.contains('ui-task-flat')),
        [false, false],
        'flat-формы списка у этих секций нет',
      );

      await h.setPeriod({ from: today, to: tomorrowLocalOfScreen() });

      assert.equal(
        tasksGroup.findAll('ui-task-subgroup').length,
        0,
        'смена периода форму секций не меняет',
      );
      assert.deepEqual(
        tasksGroup.findAll('ui-task-section-title').map((node) => node.flatText().trim()),
        [t('tasks.sectionUndated'), t('tasks.sectionUrgent')],
        'те же две секции и после смены периода',
      );
    } finally {
      h.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// 0.16.1, замечания пользователя 2026-11-18 (задача 7446eb25): пункты 2, 3, 4.
// ---------------------------------------------------------------------------

/** Событие слоя для проверки маркера «Обновить» (сеть теста — `n1`). */
function realtimeEvent(
  type: 'comment.updated' | 'comment.created' | 'comment.deleted' | 'reminders.changed',
  data: Record<string, unknown>,
  seq: number,
): Parameters<
  (typeof import('../src/renderer/lib/live/event-router.js'))['routeRealtimeEvent']
>[0] {
  return { type, network_id: 'n1', seq, data } as never;
}

describe('панель задач: маркер «Обновить» по любому изменению сети (замечание 2 ТЗ 2026-11-18)', () => {
  it('эхо СВОЕЙ правки не красит запись и не зажигает «Обновить»', async () => {
    // Две строки ОДНОЙ записи: правка одной не должна сереть соседнюю.
    const h = await setup({
      tasks: [taskRow(), taskRow({ line_no: 1, text: 'вторая', due: '2026-11-12' })],
    });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();

      const first = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      const second = h.host.querySelector('[data-row-key="c1:1"]') as unknown as ShimElement;
      const check = first.querySelector('.ui-task-row-check') as unknown as ShimElement;
      check.checked = true;
      check.emit('change', { target: check });
      await h.settle();
      assert.equal(
        first.classList.contains('is-stale'),
        false,
        'своя команда строку серой не делает (вердикт e984a2db)',
      );
      assert.equal(second.classList.contains('is-stale'), false, 'соседняя строка записи не серая');

      // Эхо своей операции: ревизия 2 — токен `c1:2` из ответа `PATCH`.
      routeRealtimeEvent(
        realtimeEvent('comment.updated', { id: 'c1', version: 2, changes: {} }, 1),
      );
      await h.settle();
      assert.equal(
        first.classList.contains('is-stale'),
        false,
        'эхо СВОЕЙ правки не серит свою строку',
      );
      assert.equal(
        second.classList.contains('is-stale'),
        false,
        'эхо СВОЕЙ правки не превращается во внешнее изменение записи',
      );
    } finally {
      h.destroy();
    }
  });

  it('чужая правка НЕзагруженной записи всё равно поднимает маркер «Обновить»', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();
      const refreshBtn = (): ShimElement =>
        h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(
        refreshBtn().classList.contains('is-stale'),
        false,
        'до событий маркер не горит',
      );

      routeRealtimeEvent(
        realtimeEvent('comment.updated', { id: 'c-unknown', version: 1, changes: {} }, 1),
      );
      await h.settle();
      assert.equal(
        refreshBtn().classList.contains('is-stale'),
        true,
        'правка записи, которой панель НЕ загружала, тоже требует пересборки состава',
      );
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      assert.equal(
        row.classList.contains('is-stale'),
        false,
        'загруженная строка чужой записи серой не становится',
      );
    } finally {
      h.destroy();
    }
  });

  it('чужая правка загруженной записи поднимает маркер и красит запись целиком', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();

      routeRealtimeEvent(
        realtimeEvent('comment.updated', { id: 'c1', version: 9, changes: {} }, 1),
      );
      await h.settle();
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      assert.equal(row.classList.contains('is-stale'), true, 'строка изменённой записи серая');
      const refreshBtn = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(refreshBtn.classList.contains('is-stale'), true, 'маркер «Обновить» горит');
    } finally {
      h.destroy();
    }
  });

  // -------------------------------------------------------------------------
  // 0.16.1, пачка 3, пункт 5: нерелевантные события панель НЕ перерисовывают.
  // -------------------------------------------------------------------------

  it('правка постоянного комментария без задач не дёргает панель «Дневника»', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();
      const refreshBtn = (): ShimElement =>
        h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      const text = row.querySelector('.ui-task-row-text') as unknown as ShimElement;
      assert.equal(
        refreshBtn().classList.contains('is-stale'),
        false,
        'до события маркер не горит',
      );

      routeRealtimeEvent(
        realtimeEvent(
          'comment.updated',
          {
            id: 'c-perm',
            version: 1,
            kind: 'permanent',
            changes: { body_md: 'обычный текст комментария мысли' },
          },
          1,
        ),
      );
      await h.settle();
      assert.equal(
        refreshBtn().classList.contains('is-stale'),
        false,
        'постоянный комментарий вне панели маркер не зажигает',
      );
      assert.equal(h.host.querySelector('[data-row-key="c1:0"]'), row, 'узел строки не пересоздан');
      assert.equal(
        row.querySelector('.ui-task-row-text'),
        text,
        'содержимое строки не перерисовывалось',
      );
    } finally {
      h.destroy();
    }
  });

  it('постоянный комментарий, где ПОЯВИЛАСЬ строка задачи, релевантен', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();
      routeRealtimeEvent(
        realtimeEvent(
          'comment.updated',
          {
            id: 'c-perm-new',
            version: 1,
            kind: 'permanent',
            changes: { body_md: '- [ ] новая задача без дат' },
          },
          1,
        ),
      );
      await h.settle();
      const refreshBtn = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(
        refreshBtn.classList.contains('is-stale'),
        true,
        'состав секции «Без срока» мог измениться — «Обновить» зажжён',
      );
    } finally {
      h.destroy();
    }
  });

  it('правка НЕ-текстовых полей записи панель не трогает', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();
      routeRealtimeEvent(
        realtimeEvent(
          'comment.updated',
          { id: 'c1', version: 9, kind: 'chronological', changes: { title: 'новый заголовок' } },
          1,
        ),
      );
      await h.settle();
      const refreshBtn = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(refreshBtn.classList.contains('is-stale'), false, 'строки задач не изменились');
    } finally {
      h.destroy();
    }
  });

  it('удаление и создание постоянного комментария без задач панель не трогают', async () => {
    const h = await setup({ tasks: [taskRow()] });
    try {
      const { resetEventRouter, routeRealtimeEvent } =
        await import('../src/renderer/lib/live/event-router.js');
      resetEventRouter();
      routeRealtimeEvent(realtimeEvent('comment.deleted', { id: 'c-unknown' }, 1));
      routeRealtimeEvent(
        realtimeEvent(
          'comment.created',
          { comment: { id: 'p1', kind: 'permanent', body_md: 'просто текст' } },
          2,
        ),
      );
      await h.settle();
      const refreshBtn = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(
        refreshBtn.classList.contains('is-stale'),
        false,
        'состав загруженных строк не изменился',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: пункт чек-листа правит источник (замечание 4 ТЗ 2026-11-18)', () => {
  it('клик по чекбоксу пункта ставит `[x]` правкой `body_md` (серверного toggle у пункта нет)', async () => {
    const body = '- [ ] задача\n  - [ ] пункт';
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
      ],
      commentBodies: { c1: body },
      commentRows: { c1: [taskRow({ revision: 2 })] },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
      await h.settle();
      const block = row.querySelector('.ui-task-row-children') as unknown as ShimElement;
      assert.ok(block, 'блок раскрыт');
      // Шим не разбирает `innerHTML`, поэтому контрол вставляем в блок вручную:
      // делегированный `change` на блоке адресует строку по разбору блока —
      // этот же путь работает и с контролами настоящего рендерера.
      const check = new ShimElement('input');
      check.type = 'checkbox';
      check.checked = true;
      block.append(check);
      block.emit('change', { target: check });
      await h.settle();

      assert.deepEqual(
        h.calls.commentUpdates,
        ['- [ ] задача\n  - [x] пункт'],
        'отметка ставится правкой текста источника, а не `PATCH /tasks`',
      );
      assert.deepEqual(h.calls.patch, [], 'команд задач по пункту чек-листа не было');
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: своя правка бессрочной строки не теряет строки (вердикт 7448ac21)', () => {
  /** Бессрочная строка постоянного комментария (нет ни периода, ни срока). */
  function undatedPermanentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return taskRow({ period_from: null, period_to: null, due: null, ...overrides });
  }

  it('отметка пункта в строке «Без срока» оставляет строки записи в панели', async () => {
    // Воспроизведение блокера: постоянный комментарий с блоком и соседней
    // строкой; обе — бессрочные (секция «Без срока»). Своя правка перечитывает
    // запись точечно и раньше прогоняла undated-строки через периодный фильтр —
    // они исчезали из панели (rowTexts → пусто при stale=0).
    const blockRow = undatedPermanentRow({ line_no: 0, text: 'блок-П 7446EB25' });
    const singleRow = undatedPermanentRow({ line_no: 2, text: 'одиночная-П 7446EB25' });
    const h = await setup({
      undatedTasks: [blockRow, singleRow],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
      ],
      commentBodies: { c1: '- [ ] блок-П 7446EB25\n  - [ ] пункт\n- [ ] одиночная-П 7446EB25' },
      commentRows: {
        c1: [
          { ...blockRow, revision: 2, parsed_revision: 2 },
          { ...singleRow, revision: 2, parsed_revision: 2 },
        ],
      },
    });
    try {
      // Текст строки экран рисует markdown-рендером в `innerHTML` — шим его в
      // `flatText()` не переносит, поэтому читаем разметку строки.
      const rowText = (key: string): string => {
        const node = h.host.querySelector(`[data-row-key="${key}"]`);
        assert.ok(node, `строка ${key} на панели`);
        const text = node.querySelector('.ui-task-row-text') as unknown as ShimElement;
        return String(text.innerHTML);
      };
      assert.ok(
        rowText('c1:0').includes('блок-П 7446EB25'),
        'до правки бессрочная строка-блок на панели',
      );
      assert.ok(
        rowText('c1:2').includes('одиночная-П 7446EB25'),
        'до правки соседняя бессрочная строка на панели',
      );

      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
      await h.settle();
      const block = row.querySelector('.ui-task-row-children') as unknown as ShimElement;
      assert.ok(block, 'блок раскрыт');
      const check = new ShimElement('input');
      check.type = 'checkbox';
      check.checked = true;
      block.append(check);
      block.emit('change', { target: check });
      await h.settle();

      assert.ok(
        h.calls.list.some((query) => query['comment_id'] === 'c1'),
        'своя правка перечитала строки записи точечно',
      );
      assert.ok(
        rowText('c1:0').includes('блок-П 7446EB25'),
        'после отметки пункта строка-блок осталась в панели',
      );
      assert.ok(
        rowText('c1:2').includes('одиночная-П 7446EB25'),
        'после отметки пункта соседняя строка осталась в панели',
      );
      const refresh = h.host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(
        refresh.classList.contains('is-stale'),
        false,
        'перечитывание своей правки не зажигает «Обновить»',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('панель задач: блочная правка компонентой комментария (замечание 3 ТЗ 2026-11-18)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('двойной клик по строке с детьми правит ВЕСЬ блок источника одним сохранением', async () => {
    const body = '- [ ] задача\n  - [ ] пункт\n  текст\n- [ ] соседняя';
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
        {
          comment_id: 'c1',
          line_no: 2,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'текст',
          depth: 1,
          checkbox: false,
          done: false,
        },
      ],
      commentBodies: { c1: body },
      commentRows: { c1: [taskRow({ revision: 2 })] },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-block-edit') as unknown as HTMLElement;
      assert.ok(field, 'блочное поле открылось');
      // ОБА класса реального поля (блокер 84c71c37): строка через пробел в одном
      // `classList.add` бросала InvalidCharacterError и правка не открывалась.
      assert.ok(field.classList.contains('ui-task-row-edit'), 'общий класс строки задачи');
      assert.ok(
        field.classList.contains('ui-task-row-block-edit'),
        'класс блочной правки — оба токена на месте',
      );
      assert.equal(
        fieldText(field),
        '- [ ] задача\n  - [ ] пункт\n  текст',
        'в поле — строка задачи и обе вложенные строки (диапазон до последнего ребёнка)',
      );
      typeIntoField(field, '- [ ] задача\n  - [x] пункт\n  текст');
      const commit = pressCommit(field);
      assert.equal(commit.prevented, true, 'Ctrl+Enter перехвачен компонентой правки');
      await h.settle();

      assert.deepEqual(
        h.calls.commentUpdates,
        ['- [ ] задача\n  - [x] пункт\n  текст\n- [ ] соседняя'],
        'заменён ровно блок строки-задачи; соседняя строка не тронута',
      );
      assert.equal(
        row.querySelector('.ui-task-row-block-edit'),
        null,
        'поле закрылось после сохранения',
      );
    } finally {
      h.destroy();
    }
  });

  it('блочная правка сохраняет произвольный текст БЕЗ маркера — задача снимается (DoD 5)', async () => {
    const body = '- [ ] задача\n  - [ ] пункт\n  текст\n- [ ] соседняя';
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
        {
          comment_id: 'c1',
          line_no: 2,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'текст',
          depth: 1,
          checkbox: false,
          done: false,
        },
      ],
      commentBodies: { c1: body },
      commentRows: { c1: [] },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-block-edit') as unknown as HTMLElement;
      assert.ok(field, 'блочное поле открылось');
      typeIntoField(field, 'Просто заметка без списка');
      pressCommit(field);
      await h.settle();
      assert.deepEqual(
        h.calls.commentUpdates,
        ['Просто заметка без списка\n- [ ] соседняя'],
        'текст без маркера записан вместо блока дословно; соседняя задача цела',
      );
    } finally {
      h.destroy();
    }
  });

  it('блочная правка: смешанный блок (задача → обычный текст) пишется дословно', async () => {
    const body = '- [ ] задача\n  - [ ] пункт\n- [ ] соседняя';
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
      ],
      commentBodies: { c1: body },
      commentRows: { c1: [taskRow({ revision: 2 })] },
    });
    try {
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-block-edit') as unknown as HTMLElement;
      assert.ok(field, 'блочное поле открылось');
      typeIntoField(field, '- [ ] задача\nобычный текст вместо пункта');
      pressCommit(field);
      await h.settle();
      assert.deepEqual(
        h.calls.commentUpdates,
        ['- [ ] задача\nобычный текст вместо пункта\n- [ ] соседняя'],
        'смешанный блок записан дословно, ничего не отвергнуто',
      );
    } finally {
      h.destroy();
    }
  });

  it('Ctrl+Enter блока сохраняет правку, а не применяет отбор «Дневника» (вердикт 7448ac21)', async () => {
    const body = '- [ ] задача\n  - [ ] пункт\n- [ ] соседняя';
    const h = await setup({
      tasks: [taskRow()],
      nested: [
        {
          comment_id: 'c1',
          line_no: 1,
          parent: { comment_id: 'c1', line_no: 0 },
          text: 'пункт',
          depth: 1,
          checkbox: true,
          done: false,
        },
      ],
      commentBodies: { c1: body },
      commentRows: { c1: [taskRow({ revision: 2 })] },
    });
    try {
      const { wireChronicleApplyShortcut } =
        await import('../src/renderer/screens/chronicle/filter-panel.js');
      let applies = 0;
      wireChronicleApplyShortcut(h.host as unknown as HTMLElement, () => {
        applies += 1;
      });
      const row = h.host.querySelector('[data-row-key="c1:0"]') as unknown as ShimElement;
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-block-edit') as unknown as HTMLElement;
      assert.ok(field, 'блочное поле открылось');
      typeIntoField(field, '- [ ] задача\n  - [x] пункт');
      // Порядок реального DOM: фокус поля, затем focusin вида (контекст отбора
      // ложится выше). Компонента гасит жест в capture-фазе.
      h.host.emit('focusin', {});
      const commit = pressCommit(field);
      assert.equal(commit.prevented, true, 'жест погашен компонентой');
      assert.equal(commit.stopped, true, 'событие не всплывает до диспетчера');
      const handled = keymap.dispatchKeyEvent({
        ctrlKey: true,
        key: 'Enter',
        target: field,
        defaultPrevented: true,
      } as unknown as KeyboardEvent);
      await h.settle();

      assert.equal(applies, 0, 'Ctrl+Enter не ушёл в «применить отбор»');
      assert.equal(handled, false, 'после preventDefault диспетчер молчит');
      assert.deepEqual(
        h.calls.commentUpdates,
        ['- [ ] задача\n  - [x] пункт\n- [ ] соседняя'],
        'блок сохранён правкой body_md',
      );
      assert.equal(
        row.querySelector('.ui-task-row-block-edit'),
        null,
        'поле закрылось после сохранения',
      );
    } finally {
      h.destroy();
    }
  });
});
