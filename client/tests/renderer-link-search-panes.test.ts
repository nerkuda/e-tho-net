/**
 * Регрессия ошибки 0a49c206 «Поиск в полях свойств-связей перестаёт работать
 * после редактирования комментария».
 *
 * Симптом (пользователь, 2026-09-21): в редакторе мысли на вкладке «Свойства»
 * живой поиск в поле свойства-связи («Потомки» и любое другое) работает; после
 * перехода на «Комментарий», правки текста и возврата на «Свойства» набор текста
 * выпадашку не открывает. Переоткрытие другой мысли чинит.
 *
 * Причина: `wireSuggest` (lib/suggest-dropdown.ts) вешает оконные
 * capture-слушатели `mousedown`/`keydown` и в каждом из них при
 * `!input.isConnected` вызывает `dispose()` — снимает ВСЕ слушатели, включая
 * слушатели самого поля. Панель вкладки редактора кэшируется (`builtPanes`) и
 * при показе другой вкладки отключается от DOM (`paneHostEl.replaceChildren`),
 * но НЕ уничтожается: возврат на «Свойства» подключает тот же узел обратно.
 * Первое же оконное событие после отключения (клик/нажатие клавиши в
 * «Комментарии») убивало живой поиск навсегда — до переоткрытия мысли, которое
 * строит вкладку заново. Тот же класс, что 05bd8809 (слушатель самоотпирался
 * по `!root.isConnected` на отключённой вкладке).
 *
 * Проверяется реальный путь под DOM-шимом (как в
 * `renderer-attachments-panes.test.ts`): смонтировать редактор, показать вкладку
 * «Свойства» с полем-связью, убедиться, что ввод открывает выпадашку; уйти на
 * «Комментарий» (панель отключается от DOM, «правим комментарий» — шлём оконные
 * события), вернуться и убедиться, что ввод снова открывает выпадашку на том же
 * (кэшированном) поле.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Document-level listeners, keyed by event type. */
const documentListeners = new Map<string, Set<(event: any) => void>>();
/** Window-level listeners (capture-слушатели выпадашки живут здесь). */
const windowListeners = new Map<string, Set<(event: any) => void>>();

function dispatchWindow(type: string, event: any = {}): void {
  event.type ??= type;
  for (const handler of [...(windowListeners.get(type) ?? [])]) handler(event);
}

const body = new ShimElement('body');
body.connectedRoot = true;

/**
 * Элемент с настоящей дисциплиной подключения: `isConnected` считается по
 * цепочке родителей до корня с флагом `connectedRoot`. Для этого теста корни по
 * умолчанию отключены от документа — подключённые тест помечает сам
 * (`connectedRoot = true` на host и на `document.body`).
 */
function detached(tag: string, className?: string, text?: string): ShimElement {
  const element = new ShimElement(tag, className, text);
  element.connectedRoot = false;
  return element;
}

function shimDom(): void {
  documentListeners.clear();
  windowListeners.clear();
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  (globalThis as any).document = {
    createElement: (tag: string) => detached(tag),
    createElementNS: (_ns: string, tag: string) => detached(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    addEventListener: (type: string, handler: (event: any) => void) => {
      const set = documentListeners.get(type) ?? new Set();
      set.add(handler);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      documentListeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: any): boolean => {
      for (const handler of [...(documentListeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    querySelector: () => null,
    activeElement: null,
    body,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.dispatchEvent = () => undefined;
  win.addEventListener = (type: string, handler: (event: any) => void) => {
    const set = windowListeners.get(type) ?? new Set();
    set.add(handler);
    windowListeners.set(type, set);
  };
  win.removeEventListener = (type: string, handler: (event: any) => void) => {
    windowListeners.get(type)?.delete(handler);
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: 'ta',
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
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

/** Определение свойства-связи в наборе типа владельца. */
const linkDefinition = {
  id: 'tp-1',
  property_id: 'lk-prop',
  owner_type: 'thought_type' as const,
  owner_id: 'ta',
  key: 'Потомки',
  value_type: 'link' as const,
  config: { link_type_id: 'lt-1' },
  required: false,
  position: 0,
  description: null,
  inherited: false,
  defined_on: 'ta',
  defined_on_name: 'ta',
  default_value: null,
  overridden_here: false,
  description_overridden: false,
  side: null,
  allowed_opposite_type_ids: [],
};

function thoughtRef(id: string) {
  return {
    id,
    title: `Мысль ${id}`,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

/** Все элементы с данным классом внутри `root` (обход в глубину). */
function findByClass(root: ShimElement, className: string): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(/\s+/).includes(className)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Открытые списки-подсказчики, отрисованные в `document.body`. */
function bodyLists(): ShimElement[] {
  return body.children.filter((c) => c.className.split(/\s+/).includes('type-combo-list'));
}

/** Ждёт собственные асинхронные цепочки редактора (render, сборка вкладок). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Открывает выпадашку живого поиска: фокус поля + ввод символа. */
async function openSearch(input: ShimElement): Promise<void> {
  input.focus();
  input.value = 'Мысль';
  input.dispatch('input');
  await flush();
}

describe('живой поиск в поле-связи переживает уход на «Комментарий» (0a49c206)', () => {
  it('после возврата на «Свойства» ввод снова открывает выпадашку', async () => {
    shimDom();
    const thought = makeThought();
    (globalThis as any).window.etn = {
      ui: { getState: async () => 'properties', setState: async () => undefined },
      types: {
        listTypeProperties: async () => [linkDefinition],
      },
      properties: {
        get: async () => [],
        set: async () => undefined,
        remove: async () => undefined,
      },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: {
        get: async () => thought,
        focus: async () => null,
        findDuplicates: async () => [{ ...thoughtRef('c1'), title: 'Мысль-цель' }],
        resolve: async (_n: string, ids: string[]) => ids.map((id) => thoughtRef(id)),
        update: async () => thought,
      },
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: () => undefined,
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: null,
      editorTarget: { kind: 'thought', id: 't1', thought },
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    host.connectedRoot = true;
    mountEditor(host as any);
    await flush();

    // Предусловие: показана вкладка «Свойства», в поле-связи есть живой поиск.
    assert.equal(
      editorInternals.paneBuildCount('properties'),
      1,
      '«Свойства» построены при монтировании',
    );
    const inputs = findByClass(host, 'link-value-add');
    assert.equal(inputs.length, 1, 'в таблице свойств есть поле живого поиска свойства-связи');
    const input = inputs[0]!;

    // 1. Исходное состояние: ввод открывает выпадашку.
    await openSearch(input);
    assert.ok(bodyLists().length > 0, 'до ухода с вкладки ввод открывает выпадашку');

    // 2. Уходим на «Комментарий» — панель «Свойства» отключается от DOM, но
    //    остаётся в кэше вкладок (тот же узел вернётся обратно). «Правим
    //    комментарий»: первое же оконное событие после отключения.
    input.blur();
    editorInternals.activateTab('main');
    await flush();
    assert.equal(input.isConnected, false, 'панель «Свойства» отключена от DOM');
    dispatchWindow('mousedown', { target: null });
    dispatchWindow('keydown', {
      key: 'a',
      repeat: false,
      stopImmediatePropagation: () => undefined,
      preventDefault: () => undefined,
    });

    // 3. Возврат на «Свойства»: тот же кэшированный узел подключается обратно,
    //    «Комментарий» не пересобирался (CodeMirror цел).
    editorInternals.activateTab('properties');
    await flush();
    assert.equal(input.isConnected, true, 'та же панель «Свойства» подключена обратно из кэша');
    assert.equal(
      editorInternals.paneBuildCount('properties'),
      1,
      'вкладка не пересобиралась — кэш сохранён',
    );

    // 4. Главная проверка: ввод снова открывает выпадашку.
    await openSearch(input);
    assert.ok(
      bodyLists().length > 0,
      'после возврата на «Свойства» ввод снова открывает выпадашку (без переоткрытия мысли)',
    );
  });
});

/**
 * Контракт самого `wireSuggest`: поле, временно выпавшее из документа,
 * сохраняет слушатели, а оконные слушатели (защита от утечки) возвращаются
 * повторным фокусом. Ошибка 0a49c206: прежнее `dispose()` по
 * `!input.isConnected` снимало и слушатели поля — у возвращённой из кэша панели
 * живой поиск не воскресал.
 */
describe('wireSuggest: отключение поля снимает только оконные слушатели', () => {
  it('фокус возвращает оконные слушатели, слушатели поля переживают отключение', async () => {
    shimDom();
    const { wireSuggest } = await import('../src/renderer/lib/suggest-dropdown.js');
    const host = new ShimElement('div');
    host.connectedRoot = true;
    const input = detached('input');
    host.append(input);

    const handle = wireSuggest(input as any, {
      sources: [{ when: 'typed', load: () => [{ value: 'x', label: 'X' }] }],
      onPick: () => undefined,
    });
    const winDownCount = (): number => windowListeners.get('mousedown')?.size ?? 0;
    assert.equal(winDownCount(), 1, 'при подключении оконный слушатель поставлен');

    // Панель вкладки отключена от DOM.
    host.replaceChildren();
    assert.equal(input.isConnected, false, 'поле отключено от документа');
    dispatchWindow('keydown', { key: 'a', repeat: false });
    assert.equal(winDownCount(), 0, 'оконный слушатель снят (защита от утечки)');
    assert.ok(
      (input.listeners['focus']?.length ?? 0) > 0,
      'слушатели самого поля сохранены — их вернуть некому',
    );

    // Панель подключена обратно, пользователь фокусирует поле.
    host.append(input);
    input.focus();
    assert.equal(winDownCount(), 1, 'фокус вернул оконный слушатель');

    handle.dispose();
    assert.equal(winDownCount(), 0, 'явный dispose снимает всё');
  });
});
