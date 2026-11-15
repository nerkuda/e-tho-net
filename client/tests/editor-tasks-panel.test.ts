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

import type { TaskDTO } from '@etn/shared';

import * as keymap from '../src/renderer/lib/keymap.js';
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
        if (typeof commentId === 'string') {
          return { items: extra.commentRows?.[commentId] ?? [], cursor: null, max_revision: 2 };
        }
        return { items: [...tasks], cursor: null, max_revision: 1 };
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

  it('чекбокс красит только свою строку, повторный клик идёт с новой ревизией', async () => {
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
      click(true);
      await h.settle();
      assert.equal(rowOf(h.group, 'c1:0').classList.contains('is-stale'), true);
      assert.equal(
        rowOf(h.group, 'c1:1').classList.contains('is-stale'),
        false,
        'соседняя строка той же записи остаётся свежей',
      );
      click(false);
      await h.settle();
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

  it('«Сделать бессрочной» уходит операцией undate', async () => {
    const h = await setup([taskRow()]);
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
