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
 *    владельца без pending-записи, которой у него не существует;
 *  • **ID-ссылка строки** (`[[#uuid]]`) получает подпись имени по готовому DOM
 *    и остаётся кликабельной (Д1 репроверки 7677fe06).
 *
 * Сеть подменена: `window.etn.tasks.list` отдаёт управляемую фикстуру, остальные
 * методы — заглушки. DOM — общий шим `./dom-shim.js`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { EditorView } from '@codemirror/view';

import type { TaskDTO } from '@etn/shared';

import { markdownFieldValue } from '../src/renderer/editor/markdown-field.js';
import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

/** Текст поля правки (CM6): компонента держит его у себя, а не в `value`. */
function fieldText(field: HTMLElement): string {
  return markdownFieldValue(field);
}

/**
 * Заменить текст поля правки — так же, как печатает пользователь: транзакцией
 * CM6 (иначе снапшот поля остался бы прежним).
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
  /** Входы `PATCH /tasks` (команды строк и массовые). */
  patches: Array<Record<string, unknown>>;
  /** Запросы `GET /tasks` (в том числе точечные по `comment_id`). */
  queries: Array<Record<string, unknown>>;
  settle(): Promise<void>;
  destroy(): void;
}

/** Дополнительные данные сети: строки записи для точечного перечитывания. */
interface SetupExtra {
  /** `GET /tasks?comment_id=` — снапшот записи после правки (ошибка 45480290). */
  commentRows?: Record<string, TaskDTO[]>;
  /** Вложенные не-задачные строки (`include_nested`): пункты чек-листа и текст. */
  nested?: Array<Record<string, unknown>>;
  /** Вложенные строки записи для точечного перечитывания (снапшот после правки). */
  commentNested?: Array<Record<string, unknown>>;
  /** Тексты комментариев-источников (`comments.get`) — сырой `body_md`. */
  commentBodies?: Record<string, string>;
  /**
   * Хук «сервер опубликовал событие ДО ответа на запись»: ревизия возвращается
   * из ответа, а `comment.updated` приходит по WebSocket раньше (замечание 3
   * вердикта `e984a2db`).
   */
  beforeResponse?: (commentId: string, version: number) => void;
}

/** Установить DOM-глобалы до импорта модулей рендерера. */
function shimDom(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const doc: Record<string, any> = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    // CodeMirror монтирует стили в `document.head` (`StyleSet.mount`).
    head: new ShimElement('head'),
    body,
    adoptedStyleSheets: [],
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    // CM6 (правка строки компонентой, пункт 1) спрашивает выделение, фокус и диапазон.
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
  // CM6 читает `ownerDocument.defaultView` и `getSelection` у шим-элементов.
  (ShimElement.prototype as any).ownerDocument = doc;
  (ShimElement.prototype as any).getSelection = () => null;
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
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  // Связка «документ ↔ окно» и кадры: CM6 читает `defaultView` и планирует замеры.
  doc.defaultView = win;
  win.document = doc;
  win.getSelection = () => null;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = (): void => undefined;
}

/**
 * Поднять окружение и смонтировать зону `main.tasks` настоящим `groupSection`.
 * Модули грузятся ДИНАМИЧЕСКИ: `lib/etn.ts` читает `window` при каждом доступе,
 * шим обязан стоять до первого монтирования.
 */
async function setup(initial: TaskDTO[], extra: SetupExtra = {}): Promise<Harness> {
  shimDom();
  const tasks = [...initial];
  const patches: Array<Record<string, unknown>> = [];
  const queries: Array<Record<string, unknown>> = [];
  /** Версии комментариев и их тексты (подставной PATCH и правка `body_md`). */
  const versions = new Map<string, number>();
  const bodies = new Map<string, string>();

  const api = {
    ui: {
      getState: async (): Promise<null> => null,
      setState: async (): Promise<void> => undefined,
    },
    tasks: {
      list: async (_networkId: string, query: Record<string, unknown> = {}) => {
        queries.push(query);
        const commentId = query['comment_id'];
        const items =
          typeof commentId === 'string' ? (extra.commentRows?.[commentId] ?? []) : [...tasks];
        // Как у сервера: вложенные строки отдаются той странице, чьи задачи в
        // неё попали (пункт F ТЗ 2026-11-17).
        const nestedSource =
          typeof commentId === 'string'
            ? (extra.commentNested ?? extra.nested ?? [])
            : (extra.nested ?? []);
        const nested = nestedSource.filter((line) =>
          items.some((item) => {
            const parent = line['parent'] as Record<string, unknown>;
            return item.comment_id === parent['comment_id'] && item.line_no === parent['line_no'];
          }),
        );
        return {
          items,
          cursor: null,
          max_revision: 2,
          ...(query['include_nested'] === true ? { nested } : {}),
        };
      },
      patch: async (_networkId: string, input: Record<string, unknown>) => {
        patches.push(input);
        const ops = (input['ops'] ?? []) as Array<Record<string, unknown>>;
        const revisions = ops.map((op) => {
          const id = String(op['comment_id']);
          const version = (versions.get(id) ?? 1) + 1;
          versions.set(id, version);
          return { id, version };
        });
        for (const revision of revisions) {
          extra.beforeResponse?.(revision.id, revision.version);
        }
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
    reminders: { list: async () => ({ reminders: [], from: null, to: null }) },
    thoughts: { get: async (_networkId: string, id: string) => ({ id, title: `Мысль ${id}` }) },
    links: {
      get: async (_networkId: string, id: string) => ({ id, source_id: id, target_id: id }),
    },
    publications: { get: async (_networkId: string, id: string) => ({ id, title: id }) },
    comments: {
      get: async (_networkId: string, id: string) => ({
        id,
        body_md: bodies.get(id) ?? extra.commentBodies?.[id] ?? '- [ ] задача',
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
        extra.beforeResponse?.(id, version);
        return { id, body_md: bodies.get(id), version };
      },
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
  const { resetEventRouter } = await import('../src/renderer/lib/live/event-router.js');
  resetEventRouter();

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
    patches,
    queries,
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
      const refresh = h.headActions.find((node) =>
        (node as unknown as ShimElement).classList.contains('ui-task-panel-refresh'),
      );
      assert.ok(refresh, 'кнопка «Обновить» в шапке зоны');
      (refresh as unknown as ShimElement).click();
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

describe('зона «Задачи» редактора: точечная правка и даты строк (d318a647/45480290/3f9ea2ee/3cef7466)', () => {
  beforeEach(() => shimDom());

  /** Узел строки по адресу проекции. */
  function rowOf(host: ShimElement, key: string): ShimElement {
    const row = rowsOf(host).find((node) => node.getAttribute('data-row-key') === key);
    assert.ok(row, `строка ${key} в зоне «Задачи»`);
    return row as ShimElement;
  }

  /** Открыть меню «⋮» строки. */
  function openRowMenu(row: ShimElement): void {
    const button = row.querySelector('.ui-task-row-menu') as unknown as ShimElement;
    button.emit('click', {
      target: button,
      currentTarget: button,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
  }

  it('чекбокс не серит строку: команда не трогает снапшот текста, повторный клик идёт с новой ревизией', async () => {
    const h = await setup([
      taskRow({ line_no: 0, text: 'первая' }),
      taskRow({ line_no: 1, text: 'вторая' }),
    ]);
    try {
      const click = (checked: boolean): void => {
        const check = rowOf(h.group, 'c1:0').querySelector(
          '.ui-task-row-check',
        ) as unknown as ShimElement;
        check.checked = checked;
        check.emit('change');
      };
      // Узлы строки и её содержимого ДО клика: точечное обновление чекбокса
      // (пункт 4 пачки 3) не пересобирает строку, полная перерисовка — заменяет
      // `.ui-task-row-text` и дёргает панель.
      const rowNode = rowOf(h.group, 'c1:0');
      const textNode = rowNode.querySelector('.ui-task-row-text');
      click(true);
      await h.settle();
      assert.equal(rowOf(h.group, 'c1:0'), rowNode, 'узел строки сохранён');
      assert.equal(
        rowNode.querySelector('.ui-task-row-text'),
        textNode,
        'содержимое строки не пересобрано: чекбокс патчится точечно',
      );
      assert.equal(
        rowOf(h.group, 'c1:0').classList.contains('is-stale'),
        false,
        'своя команда строку серой не делает (вердикт e984a2db)',
      );
      assert.equal(
        rowOf(h.group, 'c1:1').classList.contains('is-stale'),
        false,
        'соседняя строка той же записи тоже свежая',
      );
      assert.ok(rowOf(h.group, 'c1:0').classList.contains('is-done'), 'галочка показала отметку');
      const refresh = h.group.querySelector('.ui-task-panel-refresh') as unknown as ShimElement;
      assert.equal(
        refresh.classList.contains('is-stale'),
        true,
        'отметка зажигает «Обновить» (пункт 4): списки пересобираются только по кнопке',
      );
      click(false);
      await h.settle();
      assert.equal(
        rowOf(h.group, 'c1:0').classList.contains('is-done'),
        false,
        'повторный клик снял отметку',
      );
      const ops = h.patches.map((input) => (input['ops'] as Array<Record<string, unknown>>)[0]!);
      assert.deepEqual(
        ops.map((op) => op['done']),
        [true, false],
      );
      assert.deepEqual(
        ops.map((op) => op['expected_revision']),
        [1, 2],
        'вторая команда идёт с ревизией, поднятой первой',
      );
    } finally {
      h.destroy();
    }
  });

  it('«Сделать бессрочной» уходит операцией undate (только строка постоянного комментария)', async () => {
    const h = await setup([taskRow({ kind: 'permanent' })]);
    try {
      openRowMenu(rowOf(h.group, 'c1:0'));
      const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
      const item = body
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.undateRow')));
      assert.ok(item, 'пункт «Сделать бессрочной» в меню строки');
      item!.click();
      await h.settle();
      const op = (h.patches[0]!['ops'] as Array<Record<string, unknown>>)[0]!;
      assert.equal(op['action'], 'undate');
    } finally {
      h.destroy();
    }
  });

  it('у строки хроно-записи «Сделать бессрочной» нет: период вернёт пере-парс', async () => {
    const h = await setup([taskRow({ kind: 'chronological' })]);
    try {
      openRowMenu(rowOf(h.group, 'c1:0'));
      const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
      const item = body
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.undateRow')));
      assert.equal(item, undefined, 'команды в меню нет (уточнение 2026-11-16)');
    } finally {
      h.destroy();
    }
  });

  it('«Перенести на дату» бессрочной строки задаёт срок операцией set_due', async () => {
    const h = await setup([
      taskRow({ line_no: 0, text: 'без срока', due: null, period_from: null, period_to: null }),
    ]);
    try {
      openRowMenu(rowOf(h.group, 'c1:0'));
      const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
      const move = body
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.moveRow')));
      assert.ok(move, 'пункт «Перенести на…» в меню строки');
      move!.emit('mouseenter');
      const dateItem = body
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.moveDate')));
      assert.ok(dateItem, 'пункт «на дату» в подменю');
      dateItem!.click();
      await h.settle();
      // Диалог даты: день выбирается и подтверждается кликом (как в «Дневнике»).
      const day = (globalThis as unknown as { document: { body: ShimElement } }).document.body
        .querySelectorAll('.cal-day')
        .find((node) => String(node.getAttribute('title') ?? node.title) === '2026-11-20');
      assert.ok(day, 'день 2026-11-20 есть в диалоге даты');
      day!.emit('click', { detail: 1 });
      day!.emit('click', { detail: 2 });
      await h.settle();
      const op = (h.patches[0]!['ops'] as Array<Record<string, unknown>>)[0]!;
      assert.equal(op['action'], 'set_due');
      assert.equal(op['date'], '2026-11-20');
    } finally {
      h.destroy();
    }
  });

  it('инлайн-правка перечитывает строку зоны: новый текст без серости', async () => {
    keymap.keymapInternals.reset();
    const h = await setup([taskRow({ text: 'старая' })], {
      commentRows: {
        c1: [
          taskRow({
            text: 'новая',
            revision: 2,
            parsed_revision: 2,
            subject_thoughts: ['t1'],
          }),
        ],
      },
    });
    try {
      const row = rowOf(h.group, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      const field = row.querySelector('.ui-task-row-edit') as unknown as ShimElement;
      assert.ok(field, 'поле правки открылось (компонента комментария)');
      typeIntoField(field as unknown as HTMLElement, '- [ ] новая');
      pressCommit(field as unknown as HTMLElement);
      await h.settle();
      assert.ok(
        h.queries.some((query) => query['comment_id'] === 'c1'),
        'строка перечитана точечно по адресу записи',
      );
      assert.equal(
        rowOf(h.group, 'c1:0').classList.contains('is-stale'),
        false,
        'снапшот строки свежий',
      );
      assert.ok(
        String(
          (rowOf(h.group, 'c1:0').querySelector('.ui-task-row-text') as unknown as ShimElement)
            .innerHTML,
        ).includes('новая'),
        'зона показывает новый текст строки',
      );
    } finally {
      h.destroy();
    }
  });
});

describe('зона «Задачи» редактора: ID-ссылка строки (Д1 репроверки 7677fe06)', () => {
  beforeEach(() => shimDom());

  it('строка с [[#uuid]] получает подпись имени и остаётся кликабельной', async () => {
    const thoughtId = '44444444-4444-4444-8444-444444444444';
    const api = {
      thoughts: {
        resolve: async (_networkId: string, ids: string[]) =>
          ids.map((id) => ({ id, title: `Мысль ${id}`, active: true })),
      },
    };
    (globalThis as any).etn = api;
    ((globalThis as any).window as Record<string, unknown>)['etn'] = api;

    // DOM-шим не разбирает `innerHTML` на узлы: узел со спаном подставляем сами —
    // проверяется то, что резолв идёт по DOM строки, а не по строке HTML
    // (резолвер сниппета не видит `<span data-wiki-id>` вовсе).
    const span = new ShimElement('span');
    span.setAttribute('class', 'wiki-link');
    span.setAttribute('data-wiki-id', thoughtId);
    const node = {
      innerHTML: '',
      querySelectorAll: (selector: string) => (selector.includes('data-wiki-id') ? [span] : []),
    };

    const { renderEditorTaskRowText } = await import('../src/renderer/editor/tasks-panel.js');
    renderEditorTaskRowText(
      node as unknown as HTMLElement,
      `[[#${thoughtId}]] задача [[2026-11-14]]`,
      'n1',
    );
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.match(
      String(node.innerHTML),
      /wiki-link-date/,
      'markdown отрендерен в узел (date-чип на месте)',
    );
    assert.equal(span.textContent, `Мысль ${thoughtId}`, 'подпись ID-ссылки — имя мысли');
    assert.ok(
      span.classList.contains('wiki-link-resolved'),
      'ссылка помечена разрешённой (стиль кликабельности)',
    );
    assert.equal(
      span.getAttribute('data-wiki-id'),
      thoughtId,
      'data-wiki-id сохранён — делегированный клик работает',
    );
  });
});

// ---------------------------------------------------------------------------
// Микродоработка по вердикту e984a2db (задача 7446eb25): своя правка — не повод
// для серости и «Обновить», undo массовых команд есть и в карточке мысли.
// ---------------------------------------------------------------------------

/** Событие слоя в сети теста (`n1`) — как его доставляет WebSocket. */
function routedEvent(
  type: 'comment.updated',
  data: Record<string, unknown>,
  seq: number,
): Parameters<
  (typeof import('../src/renderer/lib/live/event-router.js'))['routeRealtimeEvent']
>[0] {
  return { type, network_id: 'n1', seq, data } as never;
}

describe('зона «Задачи» редактора: СВОЯ правка не серит строку (вердикт e984a2db)', () => {
  beforeEach(() => shimDom());

  /** Строка зоны по адресу проекции. */
  function rowOf(host: ShimElement, key: string): ShimElement {
    const row = rowsOf(host).find((node) => node.getAttribute('data-row-key') === key);
    assert.ok(row, `строка ${key} в зоне «Задачи»`);
    return row as ShimElement;
  }

  /** Кнопка «Обновить» зоны (маркер устаревания). */
  function refreshBtn(host: ShimElement): ShimElement {
    const button = host.querySelector('.ui-task-panel-refresh') as unknown as ShimElement | null;
    assert.ok(button, 'кнопка «Обновить» в шапке зоны');
    return button;
  }

  it('отметка пункта чек-листа: эхо раньше ответа не серит строку и не зажигает «Обновить»', async () => {
    const { routeRealtimeEvent } = await import('../src/renderer/lib/live/event-router.js');
    let seq = 1;
    /** Пункт чек-листа в загруженном снапшоте и в проекции после правки. */
    const child = (done: boolean): Record<string, unknown> => ({
      comment_id: 'c1',
      line_no: 1,
      parent: { comment_id: 'c1', line_no: 0 },
      text: 'пункт',
      depth: 1,
      checkbox: true,
      done,
    });
    const h = await setup([taskRow({ subject_thoughts: ['t1'] })], {
      nested: [child(false)],
      // Проекция сервера уже видит отметку: перечитывание обязано её подхватить.
      commentNested: [child(true)],
      commentRows: {
        c1: [taskRow({ subject_thoughts: ['t1'], revision: 2, parsed_revision: 2 })],
      },
      commentBodies: { c1: '- [ ] задача\n  - [ ] пункт' },
      // Сервер публикует событие ДО ответа на запись: эхо приходит без токена.
      beforeResponse: (id, version) => {
        routeRealtimeEvent(routedEvent('comment.updated', { id, version, changes: {} }, seq++));
      },
    });
    try {
      const row = rowOf(h.group, 'c1:0');
      (row.querySelector('.ui-task-row-caret') as unknown as ShimElement).click();
      await h.settle();
      const block = rowOf(h.group, 'c1:0').querySelector(
        '.ui-task-row-children',
      ) as unknown as ShimElement;
      assert.ok(block, 'подчинённый блок раскрыт');
      // Шим не разбирает `innerHTML`: контрол вставляем в блок вручную, путь
      // записи тот же (делегированный `change` блока, line-based адрес).
      const check = new ShimElement('input');
      check.type = 'checkbox';
      check.checked = true;
      block.append(check);
      block.emit('change', { target: check });
      await h.settle();

      assert.equal(
        rowOf(h.group, 'c1:0').classList.contains('is-stale'),
        false,
        'строка своей операции серой не становится',
      );
      assert.equal(
        refreshBtn(h.group).classList.contains('is-stale'),
        false,
        'эхо своей правки не зажигает «Обновить»',
      );
      const panelRoot = h.group.querySelector('.ui-task-panel') as unknown as ShimElement | null;
      assert.ok(panelRoot, 'корень панели в зоне');
      assert.equal(
        (panelRoot as unknown as { dataset: Record<string, string> }).dataset['stale'],
        '0',
        'панель не помечена устаревшей',
      );
      const blockAfter = rowOf(h.group, 'c1:0').querySelector(
        '.ui-task-row-children',
      ) as unknown as ShimElement;
      assert.match(
        String(blockAfter.innerHTML),
        /task-list-item-checkbox[^>]*checked/,
        'перечитывание подхватило отметку источника (блок перерисован из тела)',
      );
    } finally {
      h.destroy();
    }
  });

  it('сохранение блока: строка свежая, блочная правка открывается повторно без «Обновить»', async () => {
    keymap.keymapInternals.reset();
    const { routeRealtimeEvent } = await import('../src/renderer/lib/live/event-router.js');
    let seq = 1;
    const h = await setup([taskRow({ subject_thoughts: ['t1'] })], {
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
      commentBodies: { c1: '- [ ] задача\n  - [ ] пункт' },
      commentRows: {
        c1: [
          taskRow({
            subject_thoughts: ['t1'],
            text: 'задача правленая',
            revision: 2,
            parsed_revision: 2,
          }),
        ],
      },
      beforeResponse: (id, version) => {
        routeRealtimeEvent(routedEvent('comment.updated', { id, version, changes: {} }, seq++));
      },
    });
    try {
      const row = rowOf(h.group, 'c1:0');
      (row.querySelector('.ui-task-row-text') as unknown as ShimElement).emit('dblclick', {});
      await h.settle();
      let field = row.querySelector('.ui-task-row-block-edit') as unknown as ShimElement;
      assert.ok(field, 'блочная правка открылась');
      assert.equal(
        fieldText(field as unknown as HTMLElement),
        '- [ ] задача\n  - [ ] пункт',
        'в поле — блок источника',
      );
      typeIntoField(field as unknown as HTMLElement, '- [ ] задача правленая\n  - [ ] пункт');
      const commit = pressCommit(field as unknown as HTMLElement);
      assert.equal(commit.prevented, true, 'Ctrl+Enter перехвачен компонентой правки');
      await h.settle();

      assert.equal(
        rowOf(h.group, 'c1:0').classList.contains('is-stale'),
        false,
        'после сохранения блока строка не серая',
      );
      assert.equal(
        refreshBtn(h.group).classList.contains('is-stale'),
        false,
        'эхо своего сохранения не зажигает «Обновить»',
      );
      assert.ok(
        String(
          (rowOf(h.group, 'c1:0').querySelector('.ui-task-row-text') as unknown as ShimElement)
            .innerHTML,
        ).includes('задача правленая'),
        'перечитывание показало новый текст блока сразу',
      );

      // Повторная блочная правка: ранний выход по `row.stale` не срабатывает.
      (rowOf(h.group, 'c1:0').querySelector('.ui-task-row-text') as unknown as ShimElement).emit(
        'dblclick',
        {},
      );
      await h.settle();
      field = rowOf(h.group, 'c1:0').querySelector(
        '.ui-task-row-block-edit',
      ) as unknown as ShimElement;
      assert.ok(field, 'блочная правка открылась повторно без «Обновить»');
    } finally {
      h.destroy();
    }
  });

  it('массовая команда: «Отменить» появляется в шапке зоны и возвращает прежний текст', async () => {
    const body = '- [ ] задача [[2026-11-14]]';
    const h = await setup([taskRow({ subject_thoughts: ['t1'] })], {
      commentBodies: { c1: body },
    });
    try {
      const undo = h.headActions.find((node) =>
        (node as unknown as ShimElement).classList.contains('ui-task-panel-undo'),
      ) as unknown as ShimElement | undefined;
      assert.ok(undo, 'кнопка «Отменить» отдана в шапку зоны');
      assert.equal(undo.hidden, true, 'до команды «Отменить» скрыта');

      // Меню «⋮» шапки зоны: команда по всем задачам мысли.
      const menuBtn = h.headActions.find((node) =>
        (node as unknown as ShimElement).classList.contains('ui-task-group-menu'),
      ) as unknown as ShimElement | undefined;
      assert.ok(menuBtn, 'кнопка «⋮» шапки зоны');
      menuBtn.emit('click', {
        target: menuBtn,
        currentTarget: menuBtn,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      const bodyNode = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
      const item = bodyNode
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.cancelAllThought')));
      assert.ok(item, 'пункт «Отменить все невыполненные по мысли»');
      item.click();
      await h.settle();
      // Диалог подтверждения: основная кнопка.
      const confirm = bodyNode
        .querySelectorAll('.ui-btn')
        .find((node) => node.flatText().trim() === t('actions.confirm'));
      assert.ok(confirm, 'кнопка подтверждения в диалоге');
      confirm.emit('click', {
        target: confirm,
        currentTarget: confirm,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      await h.settle();

      assert.equal(undo.hidden, false, 'после массовой команды «Отменить» видна');
      undo.emit('click', { target: undo, currentTarget: undo });
      await h.settle();
      assert.equal(
        h.queries.filter((query) => query['thought_id'] === 't1').length >= 2,
        true,
        'после отмены панель перечитана',
      );
      assert.equal(undo.hidden, true, 'после отмены кнопка снова скрыта');
    } finally {
      h.destroy();
    }
  });
});

describe('зона «Задачи» редактора: «Отменить» после массового снятия (вердикт 7448ac21)', () => {
  beforeEach(() => shimDom());

  it('пустая после команды зона остаётся видимой, «Отменить» кликабельна и возвращает строки', async () => {
    // Блокер: массовое снятие задач опустошает выборку (`rowCount === 0`), и
    // группа `main.tasks` скрывалась вместе с шапкой — «Отменить» в headActions
    // становилась недоступной (undo.hidden=false при group.hidden=true).
    const body = '- [ ] задача [[2026-11-14]]';
    const row = taskRow({ subject_thoughts: ['t1'] });
    const h = await setup([row], { commentBodies: { c1: body } });
    try {
      const undo = h.headActions.find((node) =>
        (node as unknown as ShimElement).classList.contains('ui-task-panel-undo'),
      ) as unknown as ShimElement | undefined;
      assert.ok(undo, 'кнопка «Отменить» отдана в шапку зоны');
      const menuBtn = h.headActions.find((node) =>
        (node as unknown as ShimElement).classList.contains('ui-task-group-menu'),
      ) as unknown as ShimElement | undefined;
      assert.ok(menuBtn, 'кнопка «⋮» шапки зоны');
      menuBtn.emit('click', {
        target: menuBtn,
        currentTarget: menuBtn,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      const bodyNode = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
      const item = bodyNode
        .querySelectorAll('.menu-item')
        .find((node) => node.flatText().includes(t('tasks.cancelAllThought')));
      assert.ok(item, 'пункт «Отменить все невыполненные по мысли»');
      item.click();
      await h.settle();
      // План команды уже посчитан; сервер после снятия задач отдаёт пустую
      // выборку — панель остаётся без строк, но с доступной отменой.
      h.tasks.length = 0;
      const confirm = bodyNode
        .querySelectorAll('.ui-btn')
        .find((node) => node.flatText().trim() === t('actions.confirm'));
      assert.ok(confirm, 'кнопка подтверждения в диалоге');
      confirm.emit('click', {
        target: confirm,
        currentTarget: confirm,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      await h.settle();

      assert.equal(rowsOf(h.group).length, 0, 'строк после снятия задач нет');
      assert.equal(undo.hidden, false, '«Отменить» доступна');
      assert.equal(h.group.hidden, false, 'зона с шапкой не скрыта — кнопку можно нажать');

      // Отмена: сервер вернул строки, клик по кнопке перечитывает панель.
      h.tasks.push(row);
      const queriesBefore = h.queries.length;
      undo.emit('click', { target: undo, currentTarget: undo });
      await h.settle();
      assert.ok(h.queries.length > queriesBefore, 'клик по «Отменить» перечитал панель');
      assert.equal(rowsOf(h.group).length, 1, 'строки вернулись в зону');
      assert.equal(h.group.hidden, false, 'зона со строками видима');
      assert.equal(undo.hidden, true, 'после отмены кнопка снова скрыта');
    } finally {
      h.destroy();
    }
  });
});
