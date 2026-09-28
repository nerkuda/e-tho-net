/**
 * Regression test for task 90b2256e «Инкрементальная смена сущности в
 * редакторе»: opening ANOTHER thought of the same kind must reuse the editor
 * skeleton (tab bar, its buttons, pane host) and rebuild only the header and
 * the tab CONTENT; the loading→loaded transition must build the skeleton
 * exactly once; a focused header field must get its focus back.
 *
 * Runs the REAL `mountEditor` under Node with a DOM shim (mirrors
 * `renderer-type-change-panes.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shimDom(): void {
  // `instanceof HTMLElement` guards the focus logic — make the shim element the
  // HTMLElement so a focused field is actually recognised (product code).
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
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
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: docElementStyle },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Minimal but complete `window.etn` mock (async chains must not reject). */
function installEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    ui: { getState: async () => 'main', setState: async () => undefined },
    comments: { list: async () => [], create: async () => undefined },
    attachments: { list: async () => [] },
    thoughts: { get: async () => ({}) },
    properties: { get: async () => [] },
    types: { listTypeProperties: async () => [] },
  };
}

/** One in-type text property definition, shared by the «Свойства» fixtures. */
const TEXT_PROPERTY = {
  id: 'p1',
  property_id: 'p1',
  owner_type: 'thought_type',
  owner_id: 'ta',
  key: 'Заметка',
  value_type: 'text',
  config: null,
  required: false,
  position: 0,
};

/** Adds one in-type text property so the «Свойства» table actually attaches. */
function installTypeProperty(): void {
  const win = (globalThis as any).window as Record<string, any>;
  win.etn.types = { listTypeProperties: async () => [TEXT_PROPERTY] };
}

/** One stored text value row for the `TEXT_PROPERTY` definition. */
function propertyValueRow(value: string): unknown {
  return {
    property_id: 'p1',
    property_name: 'Заметка',
    value_type: 'text',
    value,
    outside_type: false,
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
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

/** Waits for the editor's own async chains (render, tab pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('инкрементальная смена сущности в редакторе (90b2256e)', () => {
  it('смена мысли того же вида сохраняет каркас и обновляет шапку', async () => {
    shimDom();
    installEtn();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const scrollBox = host.children[1]!;
    const tabBar = scrollBox.querySelector('.editor-tabs')!;
    const firstTab = tabBar.querySelectorAll('.editor-tab')[0]!;
    assert.equal(scrollBox.querySelector('.editor-title-input')!.value, 'A');
    const skeletons = editorInternals.skeletonBuildCount();

    // Open ANOTHER thought of the same kind.
    store.update({
      focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })),
    } as any);
    await flush();

    assert.equal(host.children[1], scrollBox, 'scrollBox переиспользован');
    assert.equal(scrollBox.querySelector('.editor-tabs'), tabBar, 'полоса вкладок — тот же узел');
    assert.equal(
      tabBar.querySelectorAll('.editor-tab')[0],
      firstTab,
      'кнопки вкладок — те же узлы (каркас не пересобран)',
    );
    assert.equal(
      scrollBox.querySelector('.editor-title-input')!.value,
      'B',
      'шапка обновлена на новую мысль',
    );
    assert.equal(
      editorInternals.skeletonBuildCount(),
      skeletons,
      'смена сущности не собирает каркас повторно',
    );
  });

  it('loading→loaded строит каркас ровно один раз', async () => {
    shimDom();
    installEtn();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: null,
      structuresActiveThought: null,
      editorTarget: { kind: 'thought', id: 't9' },
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    const before = editorInternals.skeletonBuildCount();
    mountEditor(host as any);
    await flush();

    assert.equal(
      editorInternals.skeletonBuildCount(),
      before + 1,
      'загрузочный каркас собран один раз',
    );
    const scrollBox = host.children[1]!;
    const tabBar = scrollBox.querySelector('.editor-tabs')!;
    assert.ok(scrollBox.querySelector('.editor-icon-loading') !== null, 'в шапке прелоадер');

    // The entity arrives.
    const loaded = makeThought({ id: 't9', title: 'T9', type_id: 'ta' });
    store.update({
      editorTarget: { kind: 'thought', id: 't9', thought: loaded },
      structuresActiveThought: loaded,
    } as any);
    await flush();

    assert.equal(
      editorInternals.skeletonBuildCount(),
      before + 1,
      'приход сущности НЕ пересобирает каркас',
    );
    assert.equal(scrollBox.querySelector('.editor-tabs'), tabBar, 'полоса вкладок сохранена');
    assert.equal(
      scrollBox.querySelector('.editor-icon-loading'),
      null,
      'прелоадер заменён реальной шапкой',
    );
    assert.equal(scrollBox.querySelector('.editor-title-input')!.value, 'T9');
  });

  it('фокус поля заголовка сохраняется на переиспользованном поле', async () => {
    shimDom();
    installEtn();
    const { mountEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const scrollBox = host.children[1]!;
    const titleA = scrollBox.querySelector('.editor-title-input')!;
    (globalThis as any).document.activeElement = titleA;

    store.update({
      focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })),
    } as any);
    await flush();

    const titleB = scrollBox.querySelector('.editor-title-input')!;
    assert.equal(titleB, titleA, 'поле заголовка переиспользовано — тот же узел');
    assert.equal(titleB.value, 'B', 'значение обновлено на новую мысль');
    assert.equal(titleB.focused, true, 'фокус остался на поле заголовка');
  });

  it('смена мысли того же типа переиспользует поля шапки и построенные панели', async () => {
    shimDom();
    installEtn();
    installTypeProperty();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    // Build the «Свойства» pane so its keyed table is observable.
    editorInternals.activateTab('properties');
    await flush();

    const scrollBox = host.children[1]!;
    const paneHost = scrollBox.querySelector('.tab-pane-root')!;
    const titleA = scrollBox.querySelector('.editor-title-input')!;
    const synA = scrollBox.querySelector('.synonyms-input')!;
    const paneA = paneHost.children[0]!;
    const tableA = scrollBox.querySelector('.prop-table');
    assert.ok(tableA !== null, 'таблица «Свойства» построена');

    store.update({
      focus: makeFocus(
        makeThought({ id: 't2', title: 'B', type_id: 'ta', synonyms: ['синоним'] }),
      ),
    } as any);
    await flush();

    assert.equal(scrollBox.querySelector('.editor-title-input'), titleA, 'поле заголовка — тот же узел');
    assert.equal(scrollBox.querySelector('.synonyms-input'), synA, 'поле синонимов — тот же узел');
    assert.equal(titleA.value, 'B', 'заголовок обновлён на новую мысль');
    assert.equal(synA.value, 'синоним', 'синонимы обновлены на новой мысли');
    assert.equal(paneHost.children[0], paneA, 'панель вкладки переиспользована — тот же узел');
    assert.equal(
      scrollBox.querySelector('.prop-table'),
      tableA,
      'таблица «Свойства» не пересобрана — живы строки по ключам',
    );
  });

  it('скрытая вкладка сохраняет узел при смене мысли и перечитывается лениво', async () => {
    shimDom();
    installEtn();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const scrollBox = host.children[1]!;
    const paneHost = scrollBox.querySelector('.tab-pane-root')!;

    // Make sure «Комментарий» is built and shown first (the active tab is
    // module-level and may leak from a previous test in this file).
    editorInternals.activateTab('main');
    await flush();
    const mainPane = paneHost.children[0]!;

    // Hide «Комментарий» behind «Свойства» so it becomes a cached hidden pane.
    editorInternals.activateTab('properties');
    await flush();

    // Another thought of the same type: «Свойства» is retargeted (hook), the
    // hidden «Комментарий» is only marked stale — its node stays cached.
    store.update({ focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })) } as any);
    await flush();

    editorInternals.activateTab('main');
    await flush();
    assert.equal(
      paneHost.children[0],
      mainPane,
      'скрытая вкладка перечитана в своём узле — identity сохранена',
    );
    assert.equal(scrollBox.querySelector('.editor-title-input')!.value, 'B');
  });

  it('устаревший загрузчик счётчика не перезаписывает счётчик новой мысли', async () => {
    shimDom();
    installEtn();
    const { mountEditor, registerTabCount } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    // Controllable loader for the counted «Дневник» tab: each entity's count is
    // resolved manually so we can let the PREVIOUS entity's promise settle last.
    const resolvers = new Map<string, (n: number) => void>();
    registerTabCount(
      'chrono',
      (ctx) =>
        new Promise<number | undefined>((resolve) => {
          resolvers.set(ctx.ownerId, (n) => resolve(n));
        }),
    );

    const scrollBox = host.children[1]!;
    const tabBar = scrollBox.querySelector('.editor-tabs')!;
    const badge = tabBar.querySelectorAll('.editor-tab')[4]!.querySelector('.editor-tab-count')!;

    // t1 → t2 → t3 (same type): t2's and t3's loaders are both in flight.
    store.update({ focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })) } as any);
    await flush();
    store.update({ focus: makeFocus(makeThought({ id: 't3', title: 'C', type_id: 'ta' })) } as any);
    await flush();
    assert.ok(resolvers.has('t2') && resolvers.has('t3'), 'загрузчики обеих мыслей запущены');

    // The CURRENT entity (t3) settles first, then the stale t2 loader.
    resolvers.get('t3')!(3);
    await flush();
    assert.equal(badge.textContent, '(3)', 'счётчик актуальной мысли записан');
    resolvers.get('t2')!(2);
    await flush();
    assert.equal(badge.textContent, '(3)', 'устаревший загрузчик не перезаписал счётчик');
  });

  it('устаревший ответ «Свойства» не перезаписывает значения новой мысли', async () => {
    shimDom();
    installEtn();
    // Controllable `properties.get`: each owner's response is settled manually,
    // so the PREVIOUS owner's response can arrive AFTER the new one.
    const pending = new Map<string, (values: unknown[]) => void>();
    const win = (globalThis as any).window as Record<string, any>;
    win.etn.types = { listTypeProperties: async () => [TEXT_PROPERTY] };
    win.etn.properties = {
      get: (_networkId: string, _ownerType: string, ownerId: string) =>
        new Promise((resolve) => pending.set(ownerId, resolve)),
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();
    editorInternals.activateTab('properties');
    await flush();

    const valueRow = (v: string): unknown => propertyValueRow(v);
    assert.ok(pending.has('t1'), 'загрузка свойств t1 стартовала');

    // Switch to another thought of the same type while t1 is still in flight.
    store.update({ focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })) } as any);
    await flush();
    assert.ok(pending.has('t2'), 'загрузка свойств t2 стартовала');

    // The CURRENT owner (t2) settles first…
    pending.get('t2')!([valueRow('VALUE_B')]);
    await flush();
    const scrollBox = host.children[1]!;
    assert.equal(
      scrollBox.querySelector('.prop-editor')!.value,
      'VALUE_B',
      'значение текущей мысли показано',
    );

    // …then the stale t1 response arrives and must be dropped.
    pending.get('t1')!([valueRow('VALUE_A')]);
    await flush();
    assert.equal(
      scrollBox.querySelector('.prop-editor')!.value,
      'VALUE_B',
      'устаревший ответ t1 отброшен — значение новой мысли не перезаписано',
    );
  });

  it('скрытая вкладка «Свойства» перечитывается при смене мысли и пишет в новую', async () => {
    shimDom();
    installEtn();
    const getCalls: string[] = [];
    const setCalls: Array<{ ownerId: string; value: unknown }> = [];
    const win = (globalThis as any).window as Record<string, any>;
    win.etn.types = { listTypeProperties: async () => [TEXT_PROPERTY] };
    win.etn.properties = {
      get: async (_networkId: string, _ownerType: string, ownerId: string) => {
        getCalls.push(ownerId);
        const rows: unknown[] = [propertyValueRow(ownerId === 't1' ? 'VALUE_A' : 'VALUE_B')];
        // Only t2 has an outside-type value — the group's «Свойства вне типа»
        // badge must follow the owner on retarget (круг 3).
        if (ownerId === 't2') {
          rows.push({
            property_id: 'po1',
            property_name: 'Вне типа',
            value_type: 'text',
            value: 'X',
            outside_type: true,
          });
        }
        return rows;
      },
      set: async (
        _networkId: string,
        _ownerType: string,
        ownerId: string,
        _key: string,
        value: unknown,
      ) => {
        setCalls.push({ ownerId, value });
      },
      remove: async () => undefined,
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    // Build «Свойства» for t1, then hide it behind «Комментарий».
    editorInternals.activateTab('properties');
    await flush();
    const scrollBox = host.children[1]!;
    assert.equal(scrollBox.querySelector('.prop-editor')!.value, 'VALUE_A');
    editorInternals.activateTab('main');
    await flush();

    // Switch to another thought of the same type while «Свойства» is hidden.
    const before = getCalls.length;
    store.update({ focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })) } as any);
    await flush();
    assert.ok(
      getCalls.slice(before).includes('t2'),
      'скрытая вкладка «Свойства» перечитала значения новой мысли',
    );

    // Returning to the tab shows the CURRENT owner's value…
    editorInternals.activateTab('properties');
    await flush();
    assert.equal(
      scrollBox.querySelector('.prop-editor')!.value,
      'VALUE_B',
      'показано значение текущей мысли, а не прежней',
    );
    // The «Свойства вне типа» badge belongs to the reused group header and must
    // follow the new owner too (t2 has one outside-type value).
    const outsideTitle = scrollBox.findAll(
      (n) => n.className.includes('group-title') && n.textContent === 'Свойства вне типа',
    )[0]!;
    assert.equal(
      outsideTitle.parent!.querySelector('.ui-badge')!.textContent,
      '(1)',
      'счётчик «Свойства вне типа» соответствует текущей мысли',
    );

    // …and an edit writes to the CURRENT owner, not the previous one.
    const input = scrollBox.querySelector('.prop-editor')!;
    input.value = 'NEW_VALUE';
    input.blur();
    await flush();
    assert.equal(setCalls.length > 0, true, 'правка сохранена');
    assert.equal(setCalls.at(-1)!.ownerId, 't2', 'правка ушла в текущую мысль');
    assert.equal(setCalls.at(-1)!.value, 'NEW_VALUE');
  });
});
