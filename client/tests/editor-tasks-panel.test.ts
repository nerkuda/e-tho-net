/**
 * Зона `main.tasks` вкладки «Основное» редактора мысли (0.16.1, задача 710b68aa;
 * элемент `f3893859`) — экранная обвязка `editor/tasks-panel.ts` под DOM-шимом.
 *
 * Что проверяется ЗДЕСЬ, а не в тестах компоненты и модели (там — готовые снимки
 * и чистые правила):
 *  • **счётчики в шапке зоны** — блокер приёмки: группа `main.tasks` обязана
 *    иметь бейдж, а тело панели — обновлять его событием `etn:set-count`
 *    (сборка секции + настоящий `groupSection` редактора);
 *  • **адрес «Открыть источник»** — замечание приёмки: хроно-строка открывает
 *    запись «Дневника» (pending ставится), постоянный комментарий — карточку
 *    владельца без pending-записи, которой у него не существует.
 *
 * Сеть подменена: `window.etn.tasks.list` отдаёт управляемую фикстуру, остальные
 * методы — заглушки. DOM — общий шим `./dom-shim.js`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { TaskDTO } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/** Минимальный `CustomEvent`: шим не несёт глобального конструктора. */
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

/** Строка проекции с полями, нужными панели и адресу источника. */
function taskRow(overrides: Partial<TaskDTO> = {}): TaskDTO {
  return {
    comment_id: 'c1',
    line_no: 0,
    text: 'задача',
    period_from: null,
    period_to: null,
    due: '2026-11-14',
    done: false,
    subject_thoughts: [],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: 1,
    parsed_revision: 1,
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'chronological',
    ...overrides,
  };
}

/** Общее состояние теста: подставная сеть, фикстура и смонтированная зона. */
interface Harness {
  group: ShimElement;
  /** Текущая выдача `GET /tasks` (меняется между «Обновить»). */
  tasks: TaskDTO[];
  /** Кнопки шапки зоны из `GroupSpec.actions`. */
  headActions: HTMLElement[];
  settle(): Promise<void>;
  destroy(): void;
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
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/**
 * Поднять окружение и смонтировать зону `main.tasks` настоящим `groupSection`.
 * Модули грузятся ДИНАМИЧЕСКИ: `lib/etn.ts` читает `window` при каждом доступе,
 * шим обязан стоять до первого монтирования.
 */
async function setup(initial: TaskDTO[]): Promise<Harness> {
  shimDom();
  const tasks = [...initial];

  const api = {
    ui: {
      getState: async (): Promise<null> => null,
      setState: async (): Promise<void> => undefined,
    },
    tasks: {
      list: async () => ({ items: [...tasks], cursor: null, max_revision: 1 }),
      patch: async () => ({ results: [], revision: 2 }),
    },
    reminders: { list: async () => ({ reminders: [], from: null, to: null }) },
    thoughts: { get: async (_networkId: string, id: string) => ({ id, title: `Мысль ${id}` }) },
    links: {
      get: async (_networkId: string, id: string) => ({ id, source_id: id, target_id: id }),
    },
    publications: { get: async (_networkId: string, id: string) => ({ id, title: id }) },
    comments: {
      get: async () => ({ id: 'c1', body_md: '- [ ] задача', version: 1 }),
      update: async () => undefined,
      list: async () => [],
    },
    history: { rotate: async () => undefined },
  };
  (globalThis as any).etn = api;
  ((globalThis as any).window as Record<string, unknown>)['etn'] = api;

  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    profileId: null,
    editorTarget: null,
    selectedLinkId: null,
    showInactive: true,
  } as any);

  const { createEditorTasksSection } = await import('../src/renderer/editor/tasks-panel.js');
  const { groupSection } = await import('../src/renderer/editor/group.js');

  const lifecycle = { onDispose: (): void => undefined, onShow: (): void => undefined };
  const ctx = {
    ownerType: 'thought',
    ownerId: 't1',
    thought: null,
    link: null,
  } as any;
  const spec = createEditorTasksSection(ctx, lifecycle);
  assert.ok(spec !== null, 'у мысли зона «Задачи» есть');
  const group = groupSection(spec) as unknown as ShimElement;

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();

  return {
    group,
    tasks,
    headActions: spec.actions ?? [],
    settle,
    destroy(): void {
      // Тело панели снимает подписки по dispose; у группы своего teardown нет.
      group.remove();
    },
  };
}

/** Строки задач внутри зоны (по адресу проекции). */
const rowsOf = (host: ShimElement): ShimElement[] =>
  host.querySelectorAll('[data-row-key]') as unknown as ShimElement[];

const { t } = await import('../src/renderer/lib/i18n.js');

describe('зона «Задачи» редактора: счётчики шапки (блокер приёмки 710b68aa)', () => {
  beforeEach(() => shimDom());

  it('бейдж счётчиков есть в шапке и обновляется после «Обновить»', async () => {
    const h = await setup([taskRow()]);
    try {
      const badge = h.group.querySelector('.ui-badge') as unknown as ShimElement | null;
      assert.ok(badge, 'бейдж счётчиков в шапке зоны «Задачи» (требование f3893859)');
      assert.equal(
        badge.textContent,
        t('tasks.counters', [1, 0]),
        'после загрузки бейдж показывает открытые/выполненные',
      );

      // «Обновить»: в сети появились ещё одна открытая и одна выполненная строка.
      h.tasks.length = 0;
      h.tasks.push(
        taskRow(),
        taskRow({ comment_id: 'c2', line_no: 0, text: 'вторая' }),
        taskRow({ comment_id: 'c3', line_no: 0, text: 'выполненная', done: true }),
      );
      h.headActions[0]!.click();
      await h.settle();

      assert.equal(
        badge.textContent,
        t('tasks.counters', [2, 1]),
        'бейдж обновился событием etn:set-count после перечитывания',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('зона «Задачи» редактора: адрес «Открыть источник» (замечание 710b68aa)', () => {
  beforeEach(() => shimDom());

  it('постоянный комментарий открывает владельца без pending-записи, хроно — запись', async () => {
    const h = await setup([
      taskRow({ comment_id: 'c-chrono', line_no: 0, text: 'из записи', kind: 'chronological' }),
      taskRow({ comment_id: 'c-perm', line_no: 0, text: 'из постоянного', kind: 'permanent' }),
    ]);
    const { takePendingRecord } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    try {
      const rows = rowsOf(h.group);
      assert.equal(rows.length, 2, 'обе строки показаны');

      // Вторая строка — постоянный комментарий: записи «Дневника» у него нет.
      (rows[1]!.querySelector('.ui-task-row-date') as unknown as ShimElement).click();
      await h.settle();
      assert.equal(
        takePendingRecord('t1'),
        null,
        'pending-запись не ставится: у постоянного комментария нет записи',
      );
      assert.equal(store.state.editorTarget?.kind, 'thought', 'открыта карточка владельца');
      assert.equal((store.state.editorTarget as any)?.id, 't1');

      // Первая строка — хроно-запись: выбирается её строка в «Дневнике».
      (rows[0]!.querySelector('.ui-task-row-date') as unknown as ShimElement).click();
      await h.settle();
      assert.deepEqual(takePendingRecord('t1'), {
        commentId: 'c-chrono',
        thoughtId: 't1',
      });
    } finally {
      h.destroy();
    }
  });
});
