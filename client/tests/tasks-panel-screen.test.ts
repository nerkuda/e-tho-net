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
}

/** Данные, которые «есть в сети» у подставного клиента. */
interface Fixture {
  /** Строки проекции задач (одна и та же выдача на все запросы задач). */
  tasks?: Array<Record<string, unknown>>;
  /** Напоминания владельца с уже раскрытыми вхождениями. */
  reminders?: Array<Record<string, unknown>>;
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

  const calls: Calls = { list: [], patch: [], records: 0, days: [], resolved: [] };
  const tasks = fixture.tasks ?? [];
  const api = {
    ui: {
      getState: async (): Promise<null> => null,
      setState: async (): Promise<void> => undefined,
    },
    tasks: {
      list: async (_networkId: string, query: Record<string, unknown> = {}) => {
        calls.list.push(query);
        // Срезы не смешиваются: «просрочено» и «без срока» — сквозные запросы,
        // в фикстуре они пусты, чтобы строка периода не считалась трижды.
        const scope = query['scope'];
        const items = scope === 'open' || scope === 'done' ? tasks : [];
        return {
          items,
          cursor: null,
          max_revision: 1,
        };
      },
      patch: async (_networkId: string, input: Record<string, unknown>) => {
        calls.patch.push(input);
        return { results: [], revision: 2 };
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
      get: async () => ({ id: 'c1', body_md: '- [ ] задача', version: 1 }),
      update: async () => undefined,
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

/** Подписи и «сегодня» берутся из тех же модулей, что и у экрана. */
const { t } = await import('../src/renderer/lib/i18n.js');
const { todayLocal } = await import('../src/renderer/screens/chronicle/diary.js');

const tCancelAllPeriod = t('tasks.cancelAllPeriod');
const tMoveRow = t('tasks.moveRow');
const tMoveAllPeriod = t('tasks.moveAllPeriod');
const tMoveDate = t('tasks.moveDate');
const tMoveNotNeeded = t('tasks.moveNotNeeded');
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
