/**
 * Вкладка «Основное» редактора мысли: две зоны и сплиттер между ними (0.16.1,
 * элемент `6083ab57`, план тестирования `7e12f589`, пункты 3.6/3.7).
 *
 * Собирается НАСТОЯЩИЙ `mountEditor` на DOM-шиме (как
 * `renderer-editor-entity-switch.test.ts`): вкладка «Основное» мысли несёт две
 * сворачиваемые группы — постоянный комментарий и зону «Задачи» (`main.tasks`),
 * между ними вертикальный сплиттер. Проверяется ПОЛИТИКА РАСКЛАДКИ:
 *  • обе зоны раскрыты → сплиттер виден, к каждой зоне применён её сохранённый
 *    кламп (`main.comment` / `main.main.tasks` из `editor_list_heights`);
 *  • одна зона свёрнута → сплиттер скрыт, единственная раскрытая занимает
 *    вкладку (клампы сняты, значение при этом не теряется);
 *  • свёрнутость зоны пишется в `editor_collapsed_groups` (через store, дебаунс
 *    `etn.ui.setState`) и восстанавливается при следующем монтировании;
 *  • пустая зона «Задачи» прячется сама (`etn:zone-visibility`) → сплиттера нет.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, TaskDTO, Thought, ThoughtType } from '@etn/shared';

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
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = ShimCustomEvent;
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
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: { style: docElementStyle },
    body,
    head: new ShimElement('head'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    getSelection: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

/** Мысль-владелец вкладки «Основное». */
function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    description: null,
    synonyms: [],
    active: true,
    marked_for_deletion: false,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  } as Thought;
}

function makeType(id: string, overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Строка проекции задачи (зона «Задачи» вкладки «Основное»). */
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
  } as TaskDTO;
}

/** Журнал записей настроек редактора (`etn.ui.setState`). */
const uiStateWrites: Array<{ key: string; value: string }> = [];

/** Подставная сеть: комментарий пуст, задачи — управляемая фикстура. */
function installEtn(tasks: TaskDTO[]): void {
  const api = {
    ui: {
      getState: async (_networkId: string, key: string) => {
        if (key === 'editor_active_tab') return 'main';
        return null;
      },
      setState: async (_networkId: string, key: string, value: string) => {
        uiStateWrites.push({ key, value });
      },
    },
    comments: { list: async () => [], create: async () => undefined },
    attachments: { list: async () => [] },
    thoughts: { get: async () => makeThought({ id: 't1' }), resolve: async () => [] },
    properties: { get: async () => [] },
    types: { listTypeProperties: async () => [] },
    tasks: {
      list: async () => ({
        items: [...tasks],
        cursor: null,
        max_revision: 2,
      }),
      patch: async () => ({ results: [], revisions: [] }),
    },
    reminders: { list: async () => ({ reminders: [], from: null, to: null }) },
    links: { get: async () => null },
    publications: { get: async () => null },
    history: { rotate: async () => undefined },
  };
  (globalThis as any).etn = api;
  ((globalThis as any).window as Record<string, any>)['etn'] = api;
}

interface Harness {
  host: ShimElement;
  /** Корень `.main-tab` (раскладка зон вкладки «Основное»). */
  main: ShimElement;
  /** Группы зон в порядке вкладки: комментарий, задачи. */
  groups: ShimElement[];
  /** Вертикальный сплиттер между зонами. */
  splitter: ShimElement;
  settle(): Promise<void>;
  destroy(): void;
}

interface SetupOptions {
  /** Сохранённая высота зоны комментария (`editor_list_heights`). */
  commentHeight?: number;
  /** Сохранённая свёрнутость групп (`editor_collapsed_groups`). */
  collapsedGroups?: Record<string, boolean>;
}

const NET = 'n1';

/** Дождаться асинхронных цепочек редактора (рендер, сборка вкладки, задачи). */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Смонтировать редактор с мыслью и вкладкой «Основное» (две зоны). */
async function setup(tasks: TaskDTO[], options: SetupOptions = {}): Promise<Harness> {
  shimDom();
  installEtn(tasks);
  uiStateWrites.length = 0;

  const { store } = await import('../src/renderer/state.js');
  const { mountEditor } = await import('../src/renderer/editor/editor.js');
  const { initListClamps } = await import('../src/renderer/editor/list-heights.js');
  const { resetEventRouter } = await import('../src/renderer/lib/live/event-router.js');
  resetEventRouter();

  const thought = makeThought({ id: 't1', title: 'T1' });
  store.update({
    networkId: NET,
    focus: makeFocus(thought),
    thoughtTypes: [makeType('root', { is_root: true })],
    editorTarget: { kind: 'thought', id: 't1', thought },
    collapsedGroups: options.collapsedGroups ?? {},
    showInactive: true,
  } as any);

  // Высоты — модульная карта; каждый тест начинает с чистого листа.
  initListClamps(
    options.commentHeight === undefined ? {} : { 'main.comment': options.commentHeight },
  );

  const host = new ShimElement('div');
  mountEditor(host as unknown as HTMLElement);
  await flush();

  const scrollBox = host.children[1] as unknown as ShimElement;
  const main = scrollBox.querySelector('.main-tab') as unknown as ShimElement | null;
  assert.ok(main, 'вкладка «Основное» мысли собрана двумя зонами (`.main-tab`)');
  const children = main.children as unknown as ShimElement[];
  const groups = children.filter((node) => node.classList.contains('group'));
  const splitter = children.find((node) => node.classList.contains('row-splitter'));
  assert.ok(splitter, 'между зонами есть вертикальный сплиттер');
  assert.equal(groups.length, 2, 'две зоны: комментарий и «Задачи»');

  return {
    host,
    main,
    groups,
    splitter: splitter!,
    settle: flush,
    destroy(): void {
      host.replaceChildren();
    },
  };
}

/** Тело группы зоны (`:scope > .group-body`). */
function bodyOf(group: ShimElement): ShimElement | null {
  return group.querySelector(':scope > .group-body') as unknown as ShimElement | null;
}

describe('вкладка «Основное»: две зоны и сплиттер (элемент 6083ab57)', () => {
  it('обе зоны раскрыты: сплиттер виден, к зонам применены сохранённые клампы', async () => {
    const h = await setup([taskRow()], { commentHeight: 280 });
    try {
      assert.equal(h.splitter.hidden, false, 'сплиттер виден при двух раскрытых зонах');

      const commentBody = bodyOf(h.groups[0]!)!;
      assert.equal(
        commentBody.style.height,
        '280px',
        'к телу комментария применён сохранённый кламп `main.comment`',
      );
      assert.equal(h.groups[0]!.style.flexGrow, '0', 'зона с клампом не растягивается по остатку');

      // Второй зоне кламп не задан — она живёт на CSS-растяжении, но остаётся
      // раскрытой (тело построено, шапка с кареткой на месте).
      assert.ok(h.groups[1]!.querySelector('.group-title') !== null, 'у второй зоны есть шапка');
      assert.equal(
        h.groups[1]!.querySelector('.group-caret')!.classList.contains('collapsed'),
        false,
        'зона «Задачи» раскрыта по умолчанию',
      );
      assert.equal(h.groups[1]!.style.flexGrow, '', 'вторая зона без клампа растягивается');
    } finally {
      h.destroy();
    }
  });

  it('одна зона свёрнута: сплиттер скрыт, вторая занимает вкладку', async () => {
    const h = await setup([taskRow()], { commentHeight: 280 });
    try {
      const { setGroupExpanded } = await import('../src/renderer/editor/group.js');
      assert.equal(
        setGroupExpanded(h.groups[0] as unknown as HTMLElement, false),
        true,
        'комментарий свёрнут',
      );

      assert.equal(h.splitter.hidden, true, 'при свёрнутой зоне сплиттера нет');
      assert.equal(bodyOf(h.groups[0]!), null, 'тело свёрнутой зоны снято');
      assert.equal(
        h.groups[0]!.style.flexGrow,
        '',
        'кламп снят с раскладки, хотя сохранённое значение осталось',
      );
      const { getListClamp } = await import('../src/renderer/editor/list-heights.js');
      assert.equal(getListClamp('main.comment'), 280, 'сохранённая высота не потеряна');

      // Обратное раскрытие возвращает сплиттер и кламп.
      setGroupExpanded(h.groups[0] as unknown as HTMLElement, true);
      assert.equal(h.splitter.hidden, false, 'сплиттер вернулся');
      assert.equal(bodyOf(h.groups[0]!)!.style.height, '280px', 'кламп применён снова');
    } finally {
      h.destroy();
    }
  });

  it('свёрнутость зоны пишется в `editor_collapsed_groups` и восстанавливается', async () => {
    const h = await setup([taskRow()]);
    try {
      const { store } = await import('../src/renderer/state.js');
      // Клик по шапке зоны — пользовательский персист (программное раскрытие
      // `setGroupExpanded` предпочтение не переписывает).
      const header = h.groups[1]!.querySelector('.group-header') as unknown as ShimElement;
      header.emit('click', {
        target: header,
        currentTarget: header,
        preventDefault: (): void => undefined,
        stopPropagation: (): void => undefined,
      });
      assert.equal(
        store.state.collapsedGroups['main.tasks'],
        true,
        'store помнит свёрнутость зоны',
      );
      assert.equal(h.splitter.hidden, true, 'свёрнутая зона прячет сплиттер');

      // Дебаунс персиста — 300 мс; ждём окно и читаем запись настройки.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const saved = uiStateWrites.find((write) => write.key === 'editor_collapsed_groups');
      assert.ok(saved, 'свёрнутость ушла в `editor_collapsed_groups`');
      assert.deepEqual(
        JSON.parse(saved!.value),
        { 'main.tasks': true },
        'в настройке ровно карта свёрнутости групп',
      );
    } finally {
      h.destroy();
    }
  });

  it('сохранённая свёрнутость восстанавливается при монтировании: сплиттера нет', async () => {
    const h = await setup([taskRow()], { collapsedGroups: { permanent: true } });
    try {
      assert.equal(h.splitter.hidden, true, 'одна из зон свёрнута уже на сборке');
      assert.equal(bodyOf(h.groups[0]!), null, 'свёрнутая зона без тела');
      assert.ok(bodyOf(h.groups[1]!) !== null, 'вторая зона раскрыта и занимает вкладку');
    } finally {
      h.destroy();
    }
  });

  it('пустая зона «Задачи» прячется: сплиттера нет, комментарий занимает вкладку', async () => {
    const h = await setup([]);
    try {
      assert.equal(
        h.groups[1]!.hidden,
        true,
        'зону без строк панель скрыла событием etn:zone-visibility',
      );
      assert.equal(h.splitter.hidden, true, 'скрытая зона не имеет сплиттера');
    } finally {
      h.destroy();
    }
  });
});
