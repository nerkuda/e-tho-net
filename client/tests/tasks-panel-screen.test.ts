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
import { afterEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

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
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: { style: {} },
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
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

  const calls: Calls = { list: [], patch: [], records: 0, days: [], resolved: [], state: [] };
  const tasks = fixture.tasks ?? [];
  const doneTasks = fixture.doneTasks ?? [];
  const overdueTasks = fixture.overdueTasks ?? [];
  const undatedTasks = fixture.undatedTasks ?? [];
  /** Версии комментариев-источников и их тексты (подставной PATCH/update). */
  const versions = new Map<string, number>();
  const bodies = new Map<string, string>();
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
          return {
            items: fixture.commentRows?.[commentId] ?? [],
            cursor: null,
            max_revision: 2,
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
        body_md: bodies.get(id) ?? '- [ ] задача',
        version: versions.get(id) ?? 1,
      }),
      update: async (
        _networkId: string,
        id: string,
        input: { body_md?: string },
      ): Promise<Record<string, unknown>> => {
        const version = (versions.get(id) ?? 1) + 1;
        versions.set(id, version);
        if (input.body_md !== undefined) bodies.set(id, input.body_md);
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
  const handle = mountTasksPanel(host as unknown as HTMLElement, {
    getPeriod: () => PERIOD,
    openDay: (day) => calls.days.push(day),
    onRecordsChanged: () => {
      calls.records += 1;
    },
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

describe('панель задач: подгруппы напоминаний по видам субъектов (блокер 64f7976a)', () => {
  it('мысль и публикация показывают названия, не GUID', async () => {
    const thoughtId = '11111111-1111-4111-8111-111111111111';
    const publicationId = '22222222-2222-4222-8222-222222222222';
    const h = await setup({
      reminders: [
        // Оба вхождения в разных секциях («сегодня» и «период»), чтобы в каждой
        // секции была РОВНО одна строка: порог 1 элемент — группировка по мыслям.
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
      const titles = group.findAll('ui-task-subgroup-title').map((node) => node.flatText().trim());
      assert.deepEqual(titles, [`Мысль ${thoughtId}`, `Публикация ${publicationId}`]);
      assert.ok(
        !titles.some((title) => /^[0-9a-f-]{36}$/.test(title)),
        'в заголовках подгрупп нет GUID',
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

  it('чекбокс красит ТОЛЬКО свою строку, соседняя остаётся рабочей', async () => {
    const h = await setup({
      tasks: [taskRow({ line_no: 0, text: 'первая' }), taskRow({ line_no: 1, text: 'вторая' })],
    });
    try {
      clickCheck(h, 'c1:0', true);
      await h.settle();
      assert.equal(rowOf(h, 'c1:0').classList.contains('is-stale'), true, 'правленая строка серая');
      assert.equal(
        rowOf(h, 'c1:1').classList.contains('is-stale'),
        false,
        'соседняя строка той же записи остаётся свежей',
      );
      assert.ok(rowOf(h, 'c1:0').classList.contains('is-done'), 'галочка показала новое состояние');
      assert.equal(
        (rowOf(h, 'c1:1').querySelector('.ui-task-row-check') as unknown as ShimElement).disabled,
        false,
        'соседняя строка рабочая',
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
      assert.ok(field, 'поле правки открылось');
      field.value = '- [ ] новая';
      field.focus();
      keymap.dispatchKeyEvent({
        key: 'Enter',
        target: field,
        preventDefault: (): void => undefined,
      } as unknown as KeyboardEvent);
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
