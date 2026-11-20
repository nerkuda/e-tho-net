/**
 * Сквозная цепочка «правка задачи → шина событий → две панели» (0.16.1, план
 * тестирования `7e12f589`, пункт 3.5: «при изменении задач в другом диалоге
 * список задач в редакторе мысли обновляется»).
 *
 * Смонтированы ДВЕ настоящие панели одной компоненты `lib/ui/task-list.ts`:
 *  • зона «Задачи» карточки мысли — автоперечитывание на `comment.updated`
 *    (`autoRefreshOnCommentChange`), без серости и без маркера;
 *  • панель «Дневника» (источник «период») — чужое изменение зажигает её
 *    штатный маркер «Обновить», строки остаются до ручного перечитывания.
 *
 * Событие идёт штатным путём: `PATCH /tasks` возвращает ответ, а сервер
 * публикует `comment.updated` ДО него — тест воспроизводит этот порядок и
 * пропускает событие через роутер слоя данных (`routeRealtimeEvent`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { TaskDTO } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/** Минимальный `CustomEvent`: шиму нужен `type`/`bubbles`, продукту — `detail`. */
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

/** Установить DOM-глобалы до импорта модулей рендерера. */
function shimDom(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    head: new ShimElement('head'),
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    getSelection: () => null,
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {
      /* раскладки в шиме нет */
    }
    unobserve(): void {
      /* раскладки в шиме нет */
    }
    disconnect(): void {
      /* раскладки в шиме нет */
    }
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/** Строка проекции задачи (постоянный комментарий мысли `t1`). */
function taskRow(overrides: Partial<TaskDTO> = {}): TaskDTO {
  return {
    comment_id: 'c1',
    line_no: 0,
    text: 'задача',
    period_from: null,
    period_to: null,
    due: '2026-11-14',
    auto_period: false,
    done: false,
    subject_thoughts: [],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: 1,
    parsed_revision: 1,
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'permanent',
    ...overrides,
  } as TaskDTO;
}

const NET = 'n1';
const PERIOD = { from: '2026-11-14', to: '2026-11-20' };

interface Harness {
  /** Строки в зоне «Задачи» редактора мысли. */
  zoneRows(): ShimElement[];
  /** Кнопки шапки зоны «Задачи» (`headless`). */
  zoneHeadActions(): ShimElement[];
  /** Строки панели «Дневника». */
  panelRows(): ShimElement[];
  /** Контрол «Обновить» панели «Дневника». */
  panelRefresh(): ShimElement;
  /** Сколько раз зона перечитала строки мысли (автоперечитывание). */
  zoneReads(): number;
  patches: Array<Record<string, unknown>>;
  settle(): Promise<void>;
  /** Дождаться окна автоперечитывания зоны (дебаунс 150 мс) и продолжений. */
  settleAutoRefresh(): Promise<void>;
  destroy(): void;
}

/** Дождаться асинхронных цепочек загрузки панелей. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Поднять две панели на одной шине событий. `row` — общая фикстура: правка
 * зоны меняет её, и перечитывание отдаёт уже новое состояние.
 */
async function setup(row: TaskDTO): Promise<Harness> {
  shimDom();
  const rows = [row];
  const patches: Array<Record<string, unknown>> = [];
  /** Чтения строк мысли зоной (доказывают автоперечитывание). */
  let zoneReads = 0;

  const api = {
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    tasks: {
      list: async (_networkId: string, query: Record<string, unknown> = {}) => {
        const thoughtId = query['thought_id'];
        if (typeof thoughtId === 'string') {
          zoneReads += 1;
          return { items: [...rows], cursor: null, max_revision: 2 };
        }
        const scope = query['scope'];
        const items =
          scope === 'done'
            ? rows.filter((item) => item.done)
            : scope === 'overdue' || scope === 'undated'
              ? []
              : rows.filter((item) => !item.done);
        return { items, cursor: null, max_revision: 2, total: items.length };
      },
      patch: async (_networkId: string, input: Record<string, unknown>) => {
        patches.push(input);
        const ops = (input['ops'] ?? []) as Array<Record<string, unknown>>;
        // Сервер публикует событие ДО ответа — воспроизводим порядок.
        for (const op of ops) {
          const lineNo = Number(op['line_no']);
          const index = rows.findIndex(
            (item) => item.comment_id === op['comment_id'] && item.line_no === lineNo,
          );
          // Сервер отдаёт НОВЫЕ строки, а не мутирует уже загруженные: снапшоты
          // панелей остаются прежними, пока каждая не перечитает список.
          if (index >= 0 && op['action'] === 'toggle') {
            rows[index] = { ...rows[index]!, done: op['done'] === true };
          }
          const { routeRealtimeEvent } = await import('../src/renderer/lib/live/event-router.js');
          routeRealtimeEvent(
            commentUpdatedEvent(seqFor(String(op['comment_id'])), String(op['comment_id'])),
          );
        }
        return {
          results: ops.map((op) => ({
            comment_id: op['comment_id'],
            line_no: op['line_no'],
            ok: true,
          })),
          revisions: ops.map((op) => ({ id: String(op['comment_id']), version: 2 })),
        };
      },
    },
    reminders: { list: async () => ({ reminders: [], from: null, to: null }) },
    thoughts: { get: async (_networkId: string, id: string) => ({ id, title: `Мысль ${id}` }) },
    publications: { get: async (_networkId: string, id: string) => ({ id, title: id }) },
  };
  (globalThis as any).etn = api;
  ((globalThis as any).window as Record<string, any>)['etn'] = api;

  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET, showInactive: true } as any);
  const { resetEventRouter } = await import('../src/renderer/lib/live/event-router.js');
  resetEventRouter();

  const { mountTaskList } = await import('../src/renderer/lib/ui/task-list.js');

  // Зона «Задачи» редактора мысли: автоперечитывание, без своей шапки.
  const zoneHost = new ShimElement('div');
  const zone = mountTaskList(zoneHost as unknown as HTMLElement, {
    source: { kind: 'thought', ownerId: 't1' },
    view: {
      headless: true,
      doneSection: 'collapsed',
      inactiveRows: 'filter',
      rowSubjectClouds: false,
      autoRefreshOnCommentChange: true,
      renderText: (node, item) => {
        node.textContent = item.text;
      },
    },
  });

  // Панель «Дневника»: источник «период», штатный маркер «Обновить».
  const panelHost = new ShimElement('div');
  const panel = mountTaskList(panelHost as unknown as HTMLElement, {
    source: { kind: 'period', getPeriod: () => ({ ...PERIOD }) },
    view: {
      reminders: false,
      doneSection: 'toggle',
      renderText: (node, item) => {
        node.textContent = item.text;
      },
    },
  });

  await flush();

  return {
    zoneRows: () => zoneHost.querySelectorAll('[data-row-key]') as unknown as ShimElement[],
    zoneHeadActions: () => zone.headActions() as unknown as ShimElement[],
    panelRows: () => panelHost.querySelectorAll('[data-row-key]') as unknown as ShimElement[],
    panelRefresh: () => panelHost.querySelector('.ui-task-panel-refresh') as unknown as ShimElement,
    zoneReads: () => zoneReads,
    patches,
    settle: flush,
    async settleAutoRefresh(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 220));
      await flush();
    },
    destroy(): void {
      zone.destroy();
      panel.destroy();
    },
  };
}

/** Номер события `comment.updated` по комментарию (дедуп роутера по seq). */
const seqs = new Map<string, number>();
function seqFor(commentId: string): number {
  const next = (seqs.get(commentId) ?? 0) + 1;
  seqs.set(commentId, next);
  return next;
}

/** `comment.updated` постоянного комментария мысли: правка `body_md`. */
function commentUpdatedEvent(seq: number, commentId: string): any {
  return {
    type: 'comment.updated',
    seq,
    ts: '2026-11-20T09:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data: {
      id: commentId,
      kind: 'permanent',
      version: 2,
      changes: { body_md: '- [x] задача' },
      owner_type: 'thought',
      owner_id: 't1',
    },
    layer_id: '00000000-0000-0000-0000-000000000000',
  };
}

beforeEach(() => {
  seqs.clear();
});

describe('цепочка «зона редактора ↔ панель Дневника» (план 7e12f589, 3.5)', () => {
  it('отметка в зоне: один PATCH, зона обновилась сама, панель зажгла «Обновить»', async () => {
    const h = await setup(taskRow());
    try {
      assert.equal(h.zoneRows().length, 1, 'зона показывает строку задачи');
      assert.equal(h.panelRows().length, 1, 'панель «Дневника» показывает ту же строку');
      assert.equal(
        h.panelRefresh().classList.contains('is-stale'),
        false,
        'до события маркер «Обновить» погашен',
      );

      const check = h.zoneRows()[0]!.querySelector('.ui-task-row-check') as unknown as ShimElement;
      check.checked = true;
      check.emit('change', { target: check });
      await h.settle();

      assert.equal(h.patches.length, 1, 'ровно ОДИН PATCH: эхо события второй не порождает');
      const op = (h.patches[0]!['ops'] as Array<Record<string, unknown>>)[0]!;
      assert.equal(op['comment_id'], 'c1');
      assert.equal(op['action'], 'toggle');
      assert.equal(op['done'], true);

      // Своя правка зоны: строка остаётся на месте (отметка видна), серости и
      // маркера нет — панель не перечитывается ради собственного эха.
      const readsBefore = h.zoneReads();
      await h.settleAutoRefresh();
      assert.equal(h.zoneReads(), readsBefore, 'своё эхо не гонит зону в перечитывание');
      assert.equal(h.zoneRows().length, 1, 'строка на месте: порядок держится (пункт 2)');
      assert.equal(
        h.zoneRows()[0]!.classList.contains('is-done'),
        true,
        'строка зоны показывает новое состояние (выполнена)',
      );
      assert.equal(
        (h.zoneRows()[0]!.querySelector('.ui-task-row-check') as unknown as ShimElement).checked,
        true,
        'чекбокс зоны показывает отметку источника',
      );
      assert.equal(
        h.zoneRows().some((node) => node.classList.contains('is-stale')),
        false,
        'ни одна строка зоны не серая: автоперечитывание вместо маркера',
      );
      const zoneRefresh = h
        .zoneHeadActions()
        .find((node) => node.classList.contains('ui-task-panel-refresh'));
      assert.ok(zoneRefresh, 'в шапке зоны есть «Обновить»');
      // Своя отметка меняет состав списков (строка уходит в «Выполненные»),
      // поэтому маркер зоны зажигается штатно (`markerAdvanced`): пересобирает
      // списки человек кнопкой, а строки при этом не сереют.
      assert.equal(
        zoneRefresh!.classList.contains('is-stale'),
        true,
        'своя правка зоны зажигает её маркер (списки пересобираются по кнопке)',
      );

      // Панель «Дневника» — чужое изменение: маркер, без своего PATCH.
      assert.equal(
        h.panelRefresh().classList.contains('is-stale'),
        true,
        'панель «Дневника» зажгла штатный маркер «Обновить»',
      );
      assert.equal(
        h.panelRows()[0]!.classList.contains('is-stale'),
        true,
        'строка панели «Дневника» серая до ручного перечитывания',
      );
      assert.equal(h.patches.length, 1, 'панель «Дневника» сама ничего не записывала');
    } finally {
      h.destroy();
    }
  });

  it('отметка в панели «Дневника»: зона редактора перечитывает список сама', async () => {
    const h = await setup(taskRow());
    try {
      const check = h.panelRows()[0]!.querySelector('.ui-task-row-check') as unknown as ShimElement;
      const readsBefore = h.zoneReads();
      check.checked = true;
      check.emit('change', { target: check });
      await h.settle();

      assert.equal(h.patches.length, 1, 'ровно один PATCH панели «Дневника»');

      // Чужое для зоны событие: автоперечитывание по дебаунсу (пункт 4
      // уточнения 2026-11-19) — новая строка приходит с сервера.
      await h.settleAutoRefresh();
      assert.ok(h.zoneReads() > readsBefore, 'зона перечитала строки по чужому событию');
      const doneSection = h.zoneRows().length;
      assert.equal(
        doneSection,
        0,
        'выполненная строка ушла в свёрнутую секцию «Выполненные», а не осталась активной',
      );
      assert.equal(
        h.panelRefresh().classList.contains('is-stale'),
        true,
        'своя правка панели «Дневника» тоже зажигает её маркер (списки пересобираются по кнопке)',
      );
    } finally {
      h.destroy();
    }
  });
});
