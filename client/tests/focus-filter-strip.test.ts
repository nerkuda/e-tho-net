/**
 * Unit tests for the focus filter strip (task 02ba2ae7; spec df84de22
 * «Полоса отборов под фокусом», 0.14.1 — task c2bbffab).
 *
 * Covered behaviours:
 *   * renderStrip(null) hides the strip and clears the focus bookkeeping;
 *   * единственный источник набора для рендера — `GET /thoughts/{id}/views?include_effective=true`
 *     (`thoughtCustomViews.list`): `thoughts.get` полосой не вызывается, а
 *     `thoughtTypeViews.list` — только при открытии подтверждения переноса в
 *     тип (без `include_effective`, источник истины о собственном дефолте);
 *   * the strip paints «Потомки», then the effective views in server order
 *     (types by chain → custom), then «⋯», then «+», then the link filter;
 *   * inherited type views carry `.inherited` (dimmed, no italic class), custom
 *     (out-of-type) views carry `.out-of-type` (italic) and come last;
 *   * «+» opens a two-item menu for a typed focus and the custom editor
 *     straight away for a type-less one;
 *   * clicking «Потомки» returns the mode to `{ kind: 'children' }`;
 *   * clicking a view button switches the active mode, notifies listeners and
 *     persists `{viewId, viewName, scope, definedOn}` to L4;
 *   * persisted choice wins over the default; an unknown persisted view falls
 *     back to the default (or «Потомки»); the old shape (`viewTypeId`) is
 *     tolerated and re-resolved against the effective set;
 *   * «Изменить»/«По умолчанию»/«Удалить» route custom views to
 *     `thoughtCustomViews`, type views to `thoughtTypeViews`; deletion
 *     confirmation names the owner; transfers («в отборы типа» / «из отборов
 *     типа») confirm the scope of the change and call the move operations;
 *   * в рабочем слое все правки — notice «Основы», ни один вызов записи не
 *     уходит (гейт до подтверждения);
 *   * `runActiveViewIfNeeded` caches the result, carries `meta.total`, keeps
 *     the run free of sort/order and records `scope`/`definedOn`;
 *   * realtime: `thought-type-view.*` и `thought-custom-view.*`
 *     перестраивают полосу (включая безтиповой фокус), удалённый активный →
 *     «Потомки», перенесённый (`reason:'moved'`) не сбрасывается.
 *
 * Runs the strip module against a minimal DOM shim and a fake `etn`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type { FocusResponse, Thought, ThoughtTypeView } from '@etn/shared';
import { BASE_LAYER_ID } from '@etn/shared';

import { invalidateQueries } from '../src/renderer/lib/live/index.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type StripModule = typeof import('../src/renderer/canvas/focus-filter-strip.js');
let strip: StripModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const ROOT_TYPE_ID = '00000000-0000-4000-8000-0000000000aa';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';
const OTHER_ID = '00000000-0000-4000-8000-0000000001ff';

function thought(id: string, title: string, typeId: string | null = TYPE_ID): Thought {
  return {
    id,
    title,
    type_id: typeId,
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
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function focusOf(t: Thought): FocusResponse {
  return {
    focused: t,
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'manual', order: 'asc' },
      children: { sort: 'manual', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

/**
 * Строка эффективного набора — форма `meta.effective` из
 * `GET /thoughts/{id}/views?include_effective=true` (типовые + внетиповые).
 */
function row(
  id: string,
  name: string,
  options: {
    scope?: 'type' | 'thought';
    definedOn?: string;
    inherited?: boolean;
    isDefault?: boolean;
    /**
     * Собственная пометка строки (0.14.1, дельта раунда 2). По умолчанию
     * совпадает с `isDefault`: обычные фикстуры не моделируют перекрытие
     * внетиповым дефолтом мысли. Репро x6 передаёт `isDefault:false,
     * ownDefault:true` — эффективная пометка типа занулена перекрытием.
     */
    ownDefault?: boolean;
    position?: number;
    version?: number;
    definition?: string;
  } = {},
): Record<string, unknown> {
  const scope = options.scope ?? 'type';
  return {
    id,
    name,
    name_key: name.toLowerCase(),
    description: null,
    definition: options.definition ?? JSON.stringify({ criteria: [] }),
    position: options.position ?? 0,
    is_default: options.isDefault ?? false,
    own_default: options.ownDefault ?? options.isDefault ?? false,
    version: options.version ?? 1,
    scope,
    defined_on: options.definedOn ?? TYPE_ID,
    inherited: scope === 'type' ? options.inherited === true : false,
  };
}

/** Полная карточка типового отбора (ответ create/update). */
function fullTypeView(id: string, name: string, isDefault = false): ThoughtTypeView {
  return {
    id,
    thought_type_id: TYPE_ID,
    name,
    name_key: name.toLowerCase(),
    description: null,
    definition: JSON.stringify({ criteria: [] }),
    position: 0,
    is_default: isDefault,
    version: 1,
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
  };
}

// ---------------------------------------------------------------------------
// Fake `etn`
// ---------------------------------------------------------------------------

interface FakeState {
  /** `thoughtCustomViews.list` — единственный источник набора полосы. */
  effectiveList: {
    calls: { nid: string; tid: string; opts?: unknown }[];
    effective: Record<string, unknown>[];
  };
  /** `thoughts.get` — не должен вызываться (двухшаговый fallback убран). */
  thoughtsGetCalls: { nid: string; id: string }[];
  /** `thoughtTypeViews.list` — только для собственных отборов типа при
   *  открытии подтверждения move-to-type (без `include_effective`). */
  typeOwn: {
    calls: { nid: string; tid: string; opts?: unknown }[];
    data: ThoughtTypeView[];
    error: Error | null;
  };
  propertyRegistry: { calls: number };
  customCreate: { calls: any[] };
  customUpdate: { calls: any[] };
  customRemove: { calls: any[] };
  customMoveToType: { calls: any[] };
  typeUpdate: { calls: any[] };
  typeRemove: { calls: any[] };
  typeMoveToThought: { calls: any[] };
  viewRun: { calls: { nid: string; tid: string; name: string; opts?: unknown }[]; response: any };
  uiGet: { calls: { nid: string; key: string }[]; value: string | null };
  uiSet: { calls: { nid: string; key: string; value: string }[] };
}

let state: FakeState;

function installFakeApi(): any {
  state = {
    effectiveList: { calls: [], effective: [] },
    thoughtsGetCalls: [],
    typeOwn: { calls: [], data: [], error: null },
    propertyRegistry: { calls: 0 },
    customCreate: { calls: [] },
    customUpdate: { calls: [] },
    customRemove: { calls: [] },
    customMoveToType: { calls: [] },
    typeUpdate: { calls: [] },
    typeRemove: { calls: [] },
    typeMoveToThought: { calls: [] },
    viewRun: { calls: [], response: null },
    uiGet: { calls: [], value: null },
    uiSet: { calls: [] },
  };
  return {
    thoughts: {
      get: async (nid: string, id: string) => {
        state.thoughtsGetCalls.push({ nid, id });
        throw new Error('thoughts.get не должен вызываться полосой');
      },
    },
    propertyRegistry: {
      list: async () => {
        state.propertyRegistry.calls += 1;
        return [];
      },
    },
    thoughtTypeViews: {
      list: async (nid: string, tid: string, opts?: unknown) => {
        state.typeOwn.calls.push({ nid, tid, opts });
        if (state.typeOwn.error !== null) throw state.typeOwn.error;
        return { data: state.typeOwn.data, meta: { effective: [] } };
      },
      run: async (nid: string, tid: string, name: string, opts?: unknown) => {
        state.viewRun.calls.push({ nid, tid, name, opts });
        return state.viewRun.response;
      },
      update: async (...args: any[]) => {
        state.typeUpdate.calls.push(args);
        return fullTypeView(args[2], 'X', Boolean(args[3]?.is_default));
      },
      remove: async (...args: any[]) => {
        state.typeRemove.calls.push(args);
      },
      moveToThought: async (...args: any[]) => {
        state.typeMoveToThought.calls.push(args);
        return {
          id: args[2],
          name: 'X',
          name_key: 'x',
          description: null,
          definition: '{}',
          position: 0,
          is_default: false,
          version: 1,
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
          created_by: '00000000-0000-4000-8000-000000000000',
          scope: 'thought',
          defined_on: args[3],
          inherited: false,
        };
      },
    },
    thoughtCustomViews: {
      list: async (nid: string, tid: string, opts?: unknown) => {
        state.effectiveList.calls.push({ nid, tid, opts });
        return { data: [], meta: { effective: state.effectiveList.effective } };
      },
      create: async (...args: any[]) => {
        state.customCreate.calls.push(args);
        return {
          id: 'c-new',
          thought_id: args[1],
          name: args[2]?.name ?? 'X',
          name_key: String(args[2]?.name ?? 'x').toLowerCase(),
          description: null,
          definition: args[2]?.definition ?? '{}',
          position: 0,
          is_default: Boolean(args[2]?.is_default),
          version: 1,
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
          created_by: '00000000-0000-4000-8000-000000000000',
        };
      },
      update: async (...args: any[]) => {
        state.customUpdate.calls.push(args);
        return {
          id: args[2],
          thought_id: args[1],
          name: 'X',
          name_key: 'x',
          description: null,
          definition: '{}',
          position: 0,
          is_default: Boolean(args[3]?.is_default),
          version: 2,
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
          created_by: '00000000-0000-4000-8000-000000000000',
        };
      },
      remove: async (...args: any[]) => {
        state.customRemove.calls.push(args);
      },
      moveToType: async (...args: any[]) => {
        state.customMoveToType.calls.push(args);
        return fullTypeView(args[2], 'X', false);
      },
    },
    ui: {
      getState: async (nid: string, key: string) => {
        state.uiGet.calls.push({ nid, key });
        return state.uiGet.value;
      },
      setState: async (nid: string, key: string, value: string) => {
        state.uiSet.calls.push({ nid, key, value });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  host: ShimElement;
  findButton: (label: string) => ShimElement | null;
  findViewButton: (viewId: string) => ShimElement | null;
  findPlusButton: () => ShimElement | null;
  findStrip: () => ShimElement | null;
}

function installShim(): Harness {
  const host = new ShimElement('section', 'canvas-host');
  const focusRow = new ShimElement('div', 'canvas-focus-row');
  const splitter = new ShimElement('div', 'zone-splitter-h');
  const empty = new ShimElement('div', 'canvas-empty hidden');
  const layerLabel = new ShimElement('div', 'canvas-layer-label hidden');
  host.append(focusRow, splitter, empty, layerLabel);

  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: null,
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

  return {
    host,
    findButton: (label) => {
      const all = host.querySelectorAll('.canvas-filter-strip-btn');
      return all.find((b) => b.textContent === label) ?? null;
    },
    findViewButton: (viewId) => {
      const all = host.querySelectorAll('.canvas-filter-strip-btn');
      return all.find((b) => b.dataset['viewId'] === viewId) ?? null;
    },
    findPlusButton: () => host.querySelectorAll('.canvas-filter-strip-add')[0] ?? null,
    findStrip: () => host.querySelector('.canvas-filter-strip'),
  };
}

function setNetwork(): void {
  store.update({ networkId: NETWORK_ID, focus: null });
}

/** Минимальный `window` для `notice`, `showMenuAt`, `showDialog`. */
function installWindow(): void {
  (globalThis as any).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    requestAnimationFrame: (cb: (t: number) => void) => {
      cb(0);
      return 0;
    },
    etn: (globalThis as any).etn,
  };
}

function bodyEl(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Текст всего поддерева (ShimElement не агрегирует textContent детей). */
function textOf(node: ShimElement): string {
  let out = node.textContent;
  for (const child of node.children) out += textOf(child);
  return out;
}

function noticesOnBody(): string[] {
  return bodyEl().children.map(textOf);
}

function clearBody(): void {
  const body = bodyEl();
  while (body.children.length > 0) body.children.pop();
}

/** Последнее открытое меню (`showMenuAt` кладёт `.menu` в body). */
function lastMenu(): ShimElement | undefined {
  const menus = bodyEl().children.filter((child) => child.classList.contains('menu'));
  return menus[menus.length - 1];
}

function menuLabels(menu: ShimElement): string[] {
  return menu
    .querySelectorAll('.menu-item')
    .map((rowEl) => textOf(rowEl).trim())
    .filter((text) => text !== '' && text !== '—');
}

function findMenuItemByLabel(menu: ShimElement, label: string): ShimElement | undefined {
  return menu.children.find((rowEl) => textOf(rowEl).includes(label));
}

/** Последний диалог (`showDialog` кладёт `.dialog-backdrop` в body). */
function lastDialog(): ShimElement | undefined {
  const dialogs = bodyEl().children.filter((child) => child.classList.contains('dialog-backdrop'));
  return dialogs[dialogs.length - 1];
}

function dialogText(dialog: ShimElement): string {
  return textOf(dialog);
}

/** Кнопка футера диалога по подписи. */
function dialogButton(dialog: ShimElement, label: string): ShimElement | undefined {
  return dialog
    .querySelectorAll('button')
    .find((btn) => textOf(btn).trim() === label);
}

/** Прогон микротасок/таймеров шима — для async-путей realtime/API. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

before(async () => {
  (globalThis as any).etn = installFakeApi();
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
  };
  strip = await import('../src/renderer/canvas/focus-filter-strip.js');
});

beforeEach(async () => {
  store.update({ networkId: null, focus: null, thoughtTypes: [], currentLayer: null });
  (globalThis as any).etn = installFakeApi();
  // `lib/etn.ts` читает `window.etn`, если `window` уже определён предыдущим
  // тестом, — держим оба источника на одном свежем фейке.
  if ((globalThis as any).window !== undefined) {
    (globalThis as any).window.etn = (globalThis as any).etn;
  }
  // Сброс module-level persisted/currentMode: свежий фейк ui отдаёт null.
  await strip.renderStrip(null);
  await strip.loadPersistedStrip();
});

/** Монтирует полосу и рендерит фокус с заданным эффективным набором. */
async function mountWith(
  rows: Record<string, unknown>[],
  focus = thought(FOCUS_ID, 'МЛИ-инструменты'),
): Promise<Harness> {
  const harness = installShim();
  setNetwork();
  strip.mountFilterStrip(harness.host as any);
  state.effectiveList.effective = rows;
  await strip.renderStrip(focusOf(focus));
  return harness;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('focus-filter-strip (02ba2ae7; df84de22)', () => {
  it('hides itself when renderStrip(null) is called', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    await strip.renderStrip(null);
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null, 'strip element should be mounted');
    assert.ok(stripEl!.classList.contains('hidden'), 'strip should be hidden');
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('берёт набор из единственного GET include_effective, без thoughts.get/list типа', async () => {
    await mountWith([row('v-1', 'Актуальные работы')]);
    assert.equal(state.effectiveList.calls.length, 1, 'один GET на рендер');
    assert.equal(state.effectiveList.calls[0]?.tid, FOCUS_ID);
    assert.deepEqual(state.effectiveList.calls[0]?.opts, { includeEffective: true });
    assert.equal(state.thoughtsGetCalls.length, 0, 'thoughts.get не вызывается');
    assert.equal(state.typeOwn.calls.length, 0, 'на рендере список отборов типа не нужен');
  });

  it('paints «Потомки», then views in server order, then «⋯», «+», filter', async () => {
    const harness = await mountWith([
      row('v-1', 'A-просмотр', { position: 1 }),
      row('v-2', 'Z-просмотр', { position: 2 }),
    ]);
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null && !stripEl.classList.contains('hidden'));
    const btns = (stripEl as ShimElement).querySelectorAll('.canvas-filter-strip-btn');
    assert.equal(btns.length, 6, 'Потомки + 2 views + ⋯ + + + фильтр');
    assert.equal(btns[0]!.textContent, 'Потомки');
    assert.equal(btns[1]!.textContent, 'A-просмотр');
    assert.equal(btns[2]!.textContent, 'Z-просмотр');
    assert.equal(btns[3]!.textContent, '⋯');
    assert.equal(btns[4]!.textContent, '+');
    assert.ok(btns[5]!.classList.contains('canvas-filter-strip-filter'));
  });

  it('сохраняет серверный порядок: типовые (корень → тип) → внетиповые, без пересортировки (9792d55a, 045f539a)', async () => {
    const harness = await mountWith([
      row('r0', 'Root A', { definedOn: ROOT_TYPE_ID, inherited: true, position: 0 }),
      row('r1', 'Root B', { definedOn: ROOT_TYPE_ID, inherited: true, position: 1 }),
      row('o0', 'Own A', { position: 0 }),
      row('o1', 'Own B', { position: 1 }),
      row('c0', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, position: 0 }),
    ]);
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null && !stripEl.classList.contains('hidden'));
    const btns = (stripEl as ShimElement).querySelectorAll('.canvas-filter-strip-btn');
    assert.equal(btns.length, 9, 'Потомки + 5 views + ⋯ + + + фильтр');
    assert.equal(btns[0]!.textContent, 'Потомки');
    assert.equal(btns[1]!.textContent, 'Root A');
    assert.equal(btns[2]!.textContent, 'Root B');
    assert.equal(btns[3]!.textContent, 'Own A');
    assert.equal(btns[4]!.textContent, 'Own B');
    assert.equal(btns[5]!.textContent, 'Кому одолжил', 'внетиповой — после типовых');
  });

  it('унаследованный типовой — приглушённый без курсива; внетиповой — курсив (df84de22)', async () => {
    const harness = await mountWith([
      row('t-inh', 'Наследуемый', { definedOn: ROOT_TYPE_ID, inherited: true }),
      row('t-own', 'Свой'),
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID }),
    ]);
    const inherited = harness.findViewButton('t-inh');
    const own = harness.findViewButton('t-own');
    const custom = harness.findViewButton('c-1');
    assert.ok(inherited !== null && own !== null && custom !== null);
    assert.ok(inherited!.classList.contains('inherited'), 'унаследованный — приглушение');
    assert.equal(inherited!.classList.contains('out-of-type'), false, 'унаследованный НЕ курсив');
    assert.equal(own!.classList.contains('inherited'), false);
    assert.ok(custom!.classList.contains('out-of-type'), 'внетиповой — курсив');
    assert.equal(custom!.dataset['viewScope'], 'thought');
    assert.equal(inherited!.dataset['viewScope'], 'type');
  });

  it('«+» у безтиповой мысли доступна и сразу открывает редактор внетипового отбора', async () => {
    installWindow();
    clearBody();
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.effectiveList.effective = [];
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Без типа', null)));
    const plus = harness.findPlusButton();
    assert.ok(plus !== null);
    assert.equal(plus!.disabled, false, 'кнопка «+» больше не заблокирована (0.14.1)');
    plus!.click();
    assert.equal(lastMenu(), undefined, 'безтиповая — без меню, сразу редактор');
    await settle();
    assert.equal(state.propertyRegistry.calls, 1, 'открылся редактор отбора');
  });

  it('«+» у типизированной мысли открывает меню из двух пунктов (тип / вне типа)', async () => {
    installWindow();
    clearBody();
    const harness = await mountWith([]);
    harness.findPlusButton()!.click();
    const menu = lastMenu();
    assert.ok(menu !== undefined, 'меню «+» открыто');
    assert.deepEqual(menuLabels(menu), [
      'Новый отбор типа мысли',
      'Новый отбор вне типа',
    ]);
    const item = findMenuItemByLabel(menu, 'Новый отбор вне типа');
    assert.ok(item !== undefined);
    item!.click();
    await settle();
    assert.equal(state.propertyRegistry.calls, 1);
  });

  it('activates the focus default view (or «Потомки» when none)', async () => {
    await mountWith([
      row('v-default', 'Работы версии', { isDefault: true, position: 0 }),
      row('v-extra', 'Лишний', { position: 1 }),
    ]);
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-default');

    // У другой мысли того же типа своего выбора нет и эффективного набора нет:
    // без дефолта полоса открывает «Потомки».
    state.effectiveList.effective = [];
    await strip.renderStrip(focusOf(thought(OTHER_ID, 'Другая')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('restores the persisted per-focus mode with re-resolved owner (scope/definedOn)', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      [FOCUS_ID]: { kind: 'view', viewId: 'v-2', viewName: 'Z', viewTypeId: TYPE_ID },
    });
    await strip.loadPersistedStrip();
    state.effectiveList.effective = [
      row('v-1', 'A', { position: 0 }),
      row('v-2', 'Z', { position: 1 }),
    ];
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.deepEqual(strip.getActiveMode(), {
      kind: 'view',
      viewId: 'v-2',
      viewName: 'z',
      scope: 'type',
      definedOn: TYPE_ID,
    });
  });

  it('falls back to default view when the persisted view id is unknown', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      [FOCUS_ID]: { kind: 'view', viewId: 'stale', viewName: 's', viewTypeId: TYPE_ID },
    });
    await strip.loadPersistedStrip();
    state.effectiveList.effective = [
      row('v-default', 'D', { isDefault: true, position: 0 }),
      row('v-extra', 'E', { position: 1 }),
    ];
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-default');
  });

  it('clicking «Потомки» switches the active mode back to children and notifies listeners', async () => {
    const harness = await mountWith([row('v-d', 'D', { isDefault: true, position: 0 })]);
    let received: any = 'unset';
    const off = strip.onModeChange((m) => {
      received = m;
    });
    const btn = harness.findButton('Потомки');
    assert.ok(btn !== null);
    btn!.click();
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
    assert.deepEqual(received, { kind: 'children' });
    off();
  });

  it('сохранённые «Потомки» переживают повторный рендер и смену фокуса (GUI C1)', async () => {
    const harness = await mountWith([row('v-d', 'Дефолт', { isDefault: true, position: 0 })]);
    assert.equal((strip.getActiveMode() as any).viewId, 'v-d');
    const btn = harness.findButton('Потомки');
    assert.ok(btn !== null);
    btn!.click();
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });

    // Store-нотификация/перерисовка того же фокуса: дефолтный отбор обязан
    // НЕ вернуться — иначе клик по «Потомки» отменяется следующим тиком.
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'МЛИ-инструменты')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });

    // Смена фокуса и возврат: сохранённый выбор «Потомки» переживает оба шага.
    await strip.renderStrip(focusOf(thought(OTHER_ID, 'Другая')));
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'МЛИ-инструменты')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('clicking a view button persists the choice (id, name, scope, owner) and notifies listeners', async () => {
    const harness = await mountWith([
      row('v-1', 'A', { position: 0 }),
      row('v-2', 'B', { position: 1 }),
    ]);
    let received: any = null;
    const off = strip.onModeChange((m) => {
      received = m;
    });
    const btn = harness.findViewButton('v-2');
    assert.ok(btn !== null);
    btn!.click();
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-2');
    assert.ok(received !== null && received.kind === 'view' && received.viewId === 'v-2');
    await settle();
    const setCalls = state.uiSet.calls.filter((c) => c.key === 'focus_filter_strip');
    assert.ok(setCalls.length > 0);
    const last = setCalls[setCalls.length - 1];
    assert.ok(last !== undefined);
    const payload = JSON.parse(last.value);
    assert.deepEqual(payload[FOCUS_ID], {
      kind: 'view',
      viewId: 'v-2',
      viewName: 'b',
      scope: 'type',
      definedOn: TYPE_ID,
    });
    off();
  });

  it('parsePersistedMode: tolerates garbage and recovers an empty map', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = '{ not valid json';
    await strip.loadPersistedStrip();
    state.effectiveList.effective = [];
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('parsePersistedMode: drops entries that lack required fields', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      good: { kind: 'children' },
      bad: { kind: 'view' /* missing viewId */ },
    });
    await strip.loadPersistedStrip();
    state.effectiveList.effective = [];
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.ok(['children', 'view'].includes(strip.getActiveMode().kind));
  });

  it('«Сделать по умолчанию» у внетипового идёт в маршрут мысли (thoughtCustomViews.update)', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    const harness = await mountWith([
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, version: 3 }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    const item = findMenuItemByLabel(menu, 'Сделать отбор по умолчанию');
    assert.ok(item !== undefined);
    item!.click();
    await settle();
    assert.equal(state.customUpdate.calls.length, 1);
    assert.deepEqual(state.customUpdate.calls[0].slice(0, 5), [
      NETWORK_ID,
      FOCUS_ID,
      'c-1',
      { is_default: true },
      3,
    ]);
    assert.equal(state.typeUpdate.calls.length, 0);
  });

  it('подтверждение удаления внетипового называет владельца-мысль, DELETE идёт в маршрут мысли', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    const harness = await mountWith([
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, version: 4 }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Удалить отбор')!.click();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение удаления открыто');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('Удалить отбор «Кому одолжил» мысли «МЛИ-инструменты»'),
      `текст должен называть мысль-владельца: ${text}`,
    );
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.customRemove.calls.length, 1);
    assert.deepEqual(state.customRemove.calls[0], [NETWORK_ID, FOCUS_ID, 'c-1', 4]);
    assert.equal(state.typeRemove.calls.length, 0);
  });

  it('перенос «вне типа → тип»: подтверждение про все мысли типа, вызов move-to-type', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    const harness = await mountWith([
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('его увидят все мысли этого типа'),
      `подтверждение обязано называть эффект на все мысли типа: ${text}`,
    );
    // Дефолт получателя — из источника истины (собственные отборы типа), а не
    // из эффективного набора мысли (дельта раунда 3).
    assert.equal(state.typeOwn.calls.length, 1, 'один запрос собственных отборов типа');
    assert.deepEqual(state.typeOwn.calls[0], {
      nid: NETWORK_ID,
      tid: TYPE_ID,
      opts: { includeEffective: false },
    });
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.customMoveToType.calls.length, 1);
    assert.deepEqual(state.customMoveToType.calls[0], [NETWORK_ID, FOCUS_ID, 'c-1']);
  });

  it('перенос в тип: overlay-репро w6 — собственный дефолт типа скрыт одноимённым внетиповым, элемент есть', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    // Блокер проверки раунда 2: у типа «МЛИ-инструмент» есть СВОЙ дефолт
    // «Работы типа», но у мысли есть одноимённый внетиповой «Работы типа» —
    // типовая строка исчезает из эффективного набора ЦЕЛИКОМ, `own_default`
    // скрытого дефолта недоступен. Клиент обязан спросить собственные отборы
    // типа и предупредить (третий элемент подтверждения).
    state.typeOwn.data = [fullTypeView('t-1', 'Работы типа', true)];
    const harness = await mountWith([
      row('c-overlay', 'Работы типа', { scope: 'thought', definedOn: FOCUS_ID, position: 0 }),
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, position: 1 }),
      row('c-2', 'В гараже', {
        scope: 'thought',
        definedOn: FOCUS_ID,
        isDefault: true,
        ownDefault: true,
        position: 2,
      }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('Отбор «Кому одолжил» станет общим для типа'),
      `элемент 1 — имя отбора и тип-получатель: ${text}`,
    );
    assert.ok(
      text.includes('его увидят все мысли этого типа'),
      `элемент 2 — эффект на все мысли типа: ${text}`,
    );
    assert.ok(
      text.includes(
        'У получателя уже есть отбор по умолчанию — перенесённый отбор останется без этой пометки.',
      ),
      `элемент 3 — собственный дефолт типа, скрытый из эффективного набора: ${text}`,
    );
  });

  it('перенос ДЕФОЛТНОГО отбора в тип: предупреждение и вызов с дефолтным отбором', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    // Замечание проверки: раньше тесты переносили только НЕ-дефолтный отбор,
    // поэтому фактический эффект «останется без пометки» не покрывался.
    state.typeOwn.data = [fullTypeView('t-1', 'Работы типа', true)];
    const harness = await mountWith([
      row('c-2', 'В гараже', {
        scope: 'thought',
        definedOn: FOCUS_ID,
        isDefault: true,
        ownDefault: true,
        position: 1,
      }),
    ]);
    harness.findViewButton('c-2')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('Отбор «В гараже» станет общим для типа'),
      `элемент 1 — имя дефолтного отбора: ${text}`,
    );
    assert.ok(
      text.includes('перенесённый отбор останется без этой пометки'),
      `элемент 3 — переносимый дефолт потеряет пометку: ${text}`,
    );
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.customMoveToType.calls.length, 1);
    assert.deepEqual(state.customMoveToType.calls[0], [NETWORK_ID, FOCUS_ID, 'c-2']);
  });

  it('перенос в тип: у получателя НЕТ своего дефолта — третьего элемента нет, пометка сохранится', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    // Положительный контроль: собственные отборы типа без is_default —
    // переносимый дефолт сохранит пометку, предупреждать не о чем.
    state.typeOwn.data = [fullTypeView('t-1', 'Работы типа', false)];
    const harness = await mountWith([
      row('c-2', 'В гараже', {
        scope: 'thought',
        definedOn: FOCUS_ID,
        isDefault: true,
        ownDefault: true,
        position: 1,
      }),
    ]);
    harness.findViewButton('c-2')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(
      !text.includes('останется без этой пометки'),
      `без занятого дефолта предупреждение не добавляется: ${text}`,
    );
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.customMoveToType.calls.length, 1, 'перенос не заблокирован');
  });

  it('перенос в тип: ошибка запроса собственных отборов — подтверждение без третьего элемента', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    // Деградация: недоступность подсказки не блокирует штатную операцию —
    // сервер сам снимает пометку, если дефолт получателя занят.
    state.typeOwn.error = new Error('list failed');
    const harness = await mountWith([
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение открылось несмотря на ошибку');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('его увидят все мысли этого типа'),
      `базовые элементы на месте: ${text}`,
    );
    assert.ok(
      !text.includes('останется без этой пометки'),
      `при ошибке третьего элемента нет: ${text}`,
    );
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.customMoveToType.calls.length, 1, 'перенос не заблокирован ошибкой');
    assert.equal(state.typeOwn.calls.length, 1);
  });

  it('перенос «тип → вне» унаследованного: подтверждение про типы-потомки, адрес — defined_on', async () => {
    installWindow();
    clearBody();
    store.update({
      currentLayer: { id: BASE_LAYER_ID, title: 'Основа' },
      thoughtTypes: [
        {
          id: ROOT_TYPE_ID,
          name: 'Версия',
          parent_id: null,
          is_root: true,
          icon: null,
          icon_kind: 'emoji',
          fg_color: null,
          bg_color: null,
          font_bold: null,
          font_italic: null,
          font_underline: null,
          font_strike: null,
          description: null,
          comment_template_md: null,
          version: 1,
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
          created_by: '00000000-0000-4000-8000-000000000000',
        },
      ],
    });
    const harness = await mountWith([
      row('t-inh', 'Работы версии', { definedOn: ROOT_TYPE_ID, inherited: true }),
    ]);
    harness.findViewButton('t-inh')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Исключить отбор из отборов типа')!.click();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(text.includes('у всех мыслей типа «Версия»'), `эффект на все мысли типа: ${text}`);
    assert.ok(text.includes('типов-потомков «Версия»'), `унаследованный — потомки: ${text}`);
    dialogButton(dialog, 'Подтвердить')!.click();
    await settle();
    assert.equal(state.typeMoveToThought.calls.length, 1);
    assert.deepEqual(state.typeMoveToThought.calls[0], [
      NETWORK_ID,
      ROOT_TYPE_ID,
      't-inh',
      FOCUS_ID,
    ]);
  });

  it('перенос «тип → вне»: третий элемент по собственному дефолту мысли-получателя', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    const harness = await mountWith([
      row('t-1', 'Работы типа', { isDefault: true, ownDefault: true }),
      row('c-1', 'В гараже', {
        scope: 'thought',
        definedOn: FOCUS_ID,
        isDefault: true,
        ownDefault: true,
        position: 1,
      }),
    ]);
    harness.findViewButton('t-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Исключить отбор из отборов типа')!.click();
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, 'подтверждение переноса открыто');
    const text = dialogText(dialog);
    assert.ok(
      text.includes('станет внетиповым у мысли'),
      `элемент 1 — эффект на мысль-получателя: ${text}`,
    );
    assert.ok(
      text.includes('перенесённый отбор останется без этой пометки'),
      `элемент 2 — собственный дефолт мысли-получателя: ${text}`,
    );
  });

  it('в рабочем слое перенос/удаление не уходят в API — notice «Основы»', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: '11111111-2222-3333-4444-555555555555', title: 'Черновик' } });
    const harness = await mountWith([
      row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID }),
    ]);
    harness.findViewButton('c-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Перенести отбор в отборы типа')!.click();
    await settle();
    assert.equal(lastDialog(), undefined, 'подтверждение не открывается');
    assert.equal(state.customMoveToType.calls.length, 0);
    assert.ok(
      noticesOnBody().some((text) => text.includes('Для изменения отбора переключитесь в Основу')),
      `ожидался notice про Основу: ${JSON.stringify(noticesOnBody())}`,
    );
  });

  // -------------------------------------------------------------------
  // Запуск отбора
  // -------------------------------------------------------------------

  it('runActiveViewIfNeeded: returns null when the active mode is «Потомки»', async () => {
    await mountWith([]);
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.equal(result, null);
    assert.equal(state.viewRun.calls.length, 0);
  });

  it('runActiveViewIfNeeded: runs the view, caches the result and records owner', async () => {
    await mountWith([row('c-d', 'D', { scope: 'thought', definedOn: FOCUS_ID, isDefault: true })]);
    state.viewRun.response = {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000200',
          title: 'Задача A',
          type_id: null,
          icon: null,
          icon_kind: 'emoji',
          active: true,
          marked_for_deletion: false,
        },
      ],
      meta: {
        total: 1,
        limit: 50,
        offset: 0,
        directions: {
          '00000000-0000-4000-8000-000000000200': { has_incoming: false, has_outgoing: false },
        },
        view: { id: 'c-d', name: 'D', scope: 'thought', defined_on: FOCUS_ID },
        unresolved: [],
      },
    };
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null);
    assert.equal(result!.viewId, 'c-d');
    assert.equal(result!.scope, 'thought');
    assert.equal(result!.definedOn, FOCUS_ID);
    assert.equal(result!.items.length, 1);
    assert.equal(strip.takeViewResult(), result);
    assert.equal(state.viewRun.calls.length, 1);
    assert.equal(
      state.viewRun.calls[0]?.opts,
      undefined,
      'sort/order не передаются — их читает исполнитель из определения',
    );
  });

  it('renderStrip того же фокуса не теряет закешированный результат отбора (ошибка 90811979)', async () => {
    const FRESH = '00000000-0000-4000-8000-0000000002f0';
    await mountWith([row('v-k', 'K', { isDefault: true })], thought(FRESH, 'Свежая'));
    state.viewRun.response = {
      data: [
        {
          id: '00000000-0000-4000-8000-0000000002f1',
          title: 'Мысль K',
          type_id: null,
          icon: null,
          icon_kind: 'emoji',
          active: true,
          marked_for_deletion: false,
        },
      ],
      meta: {
        total: 1,
        limit: 50,
        offset: 0,
        directions: { '00000000-0000-4000-8000-0000000002f1': { has_incoming: false, has_outgoing: false } },
        view: { id: 'v-k', name: 'K', scope: 'type', defined_on: TYPE_ID },
        unresolved: [],
      },
    };
    assert.equal(strip.getActiveMode().kind, 'view', 'включился отбор по умолчанию');
    const fresh = await strip.runActiveViewIfNeeded(FRESH);
    assert.ok(fresh !== null);
    assert.equal(strip.takeViewResult()?.focusId, FRESH);

    await strip.renderStrip(focusOf(thought(FRESH, 'Свежая')));
    assert.equal(
      strip.takeViewResult()?.focusId,
      FRESH,
      'кеш отбора переживает ре-рендер того же фокуса',
    );
  });

  it('runActiveViewIfNeeded: keeps an «empty» result distinct from an unresolved one', async () => {
    await mountWith([row('v-d', 'D', { isDefault: true })]);
    state.viewRun.response = {
      data: [],
      meta: {
        total: 0,
        limit: 50,
        offset: 0,
        directions: {},
        view: { id: 'v-d', name: 'D', scope: 'type', defined_on: TYPE_ID },
        unresolved: [{ token: '$thought.type', reason: 'no-type', message: '…' }],
      },
    };
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null);
    assert.equal(result!.empty, false);
    assert.ok(Array.isArray(result!.unresolved));
  });

  it('runActiveViewIfNeeded: AST-сортировка по свойству реестра не фильтруется полосой (ADR 23fab347)', async () => {
    const astDefinition = JSON.stringify({
      version: 1,
      filter: { op: 'and', children: [] },
      sort: [{ key: 'p-city', order: 'desc' }],
    });
    await mountWith([
      row('v-ast', 'AST', { isDefault: true, definition: astDefinition }),
    ]);
    state.viewRun.response = {
      data: [],
      meta: {
        total: 0,
        limit: 50,
        offset: 0,
        directions: {},
        view: { id: 'v-ast', name: 'AST', scope: 'type', defined_on: TYPE_ID },
        unresolved: [],
      },
    };
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null, 'AST-отбор исполняется полосой');
    assert.equal(
      state.viewRun.calls[0]?.opts,
      undefined,
      'ключ-свойство не фильтруется — определение читает исполнитель',
    );
  });

  // -------------------------------------------------------------------
  // Ошибка 4493811f: total и динамическая пагинация
  // -------------------------------------------------------------------

  function refItem(id: string): any {
    return {
      id,
      title: id,
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      active: true,
      marked_for_deletion: false,
    };
  }

  function refIds(count: number, start = 0): string[] {
    return Array.from(
      { length: count },
      (_, i) => `00000000-0000-4000-8000-${String(start + i).padStart(12, '0')}`,
    );
  }

  async function setupDefaultPage(total: number, pageIds: string[]): Promise<void> {
    await mountWith([row('v-page', 'Страница', { isDefault: true })]);
    state.viewRun.response = {
      data: pageIds.map(refItem),
      meta: {
        total,
        limit: pageIds.length,
        offset: 0,
        directions: {},
        view: { id: 'v-page', name: 'Страница', scope: 'type', defined_on: TYPE_ID },
        unresolved: [],
      },
    };
  }

  it('runActiveViewIfNeeded несёт meta.total, а не длину порции (4493811f)', async () => {
    await setupDefaultPage(316, refIds(100));
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null);
    assert.equal(result!.items.length, 100);
    assert.equal(result!.total, 316);
    assert.equal(strip.hasMoreViewResult(), true);
  });

  it('loadMoreViewResult догружает порцию с offset и исчерпывается на meta.total (4493811f)', async () => {
    await setupDefaultPage(250, refIds(100, 0));
    const first = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.equal(first!.total, 250);

    state.viewRun.response = {
      data: refIds(100, 1000).map(refItem),
      meta: {
        total: 250,
        limit: 100,
        offset: 100,
        directions: {},
        view: { id: 'v-page', name: 'Страница', scope: 'type', defined_on: TYPE_ID },
        unresolved: [],
      },
    };
    const second = await strip.loadMoreViewResult(FOCUS_ID);
    assert.ok(second !== null);
    assert.equal(second!.items.length, 200);
    const lastCall = state.viewRun.calls[state.viewRun.calls.length - 1];
    assert.deepEqual(lastCall?.opts, { limit: 100, offset: 100 });
    assert.equal(strip.hasMoreViewResult(), true);

    state.viewRun.response = {
      data: refIds(50, 2000).map(refItem),
      meta: {
        total: 250,
        limit: 50,
        offset: 200,
        directions: {},
        view: { id: 'v-page', name: 'Страница', scope: 'type', defined_on: TYPE_ID },
        unresolved: [],
      },
    };
    const third = await strip.loadMoreViewResult(FOCUS_ID);
    assert.ok(third !== null);
    assert.equal(third!.items.length, 250);
    assert.equal(third!.total, 250);
    assert.equal(strip.hasMoreViewResult(), false);
  });

  it('loadMoreViewResult — no-op в режиме «Потомки» и без результата (4493811f)', async () => {
    await mountWith([]);
    assert.equal(await strip.loadMoreViewResult(FOCUS_ID), null);
    assert.equal(strip.hasMoreViewResult(), false);
  });

  // -------------------------------------------------------------------
  // Realtime
  // -------------------------------------------------------------------

  it('realtime thought-type-view event triggers a strip rebuild (в т.ч. безтиповой фокус)', async () => {
    const harness = await mountWith([], thought(FOCUS_ID, 'Без типа', null));
    assert.equal(strip.getActiveMode().kind, 'children');
    store.update({ focus: focusOf(thought(FOCUS_ID, 'Без типа', null)) });
    state.effectiveList.effective = [
      row('v-root', 'Корневой', { definedOn: ROOT_TYPE_ID, inherited: true }),
    ];
    strip.onThoughtTypeViewRealtime({
      type: 'thought-type-view.created',
      thought_type_id: ROOT_TYPE_ID,
      view_id: 'v-root',
    });
    await settle();
    assert.ok(
      harness.findViewButton('v-root') !== null,
      'отбор корневого типа появился у безтиповой мысли',
    );
  });

  it('realtime thought-custom-view event перестраивает полосу по ключу thought-views:@<focus>', async () => {
    const harness = await mountWith([]);
    store.update({ focus: focusOf(thought(FOCUS_ID, 'МЛИ-инструменты')) });
    state.effectiveList.effective = [
      row('c-new', 'В гараже', { scope: 'thought', definedOn: FOCUS_ID }),
    ];
    invalidateQueries(`thought-views:@${FOCUS_ID}`);
    await settle();
    assert.ok(harness.findViewButton('c-new') !== null, 'внетиповой отбор появился');
  });

  it('realtime удалённый активный отбор уходит на «Потомки», а не на дефолт (df84de22)', async () => {
    await mountWith([row('v-1', 'Активный', { isDefault: true })]);
    assert.equal((strip.getActiveMode() as any).viewId, 'v-1');
    store.update({ focus: focusOf(thought(FOCUS_ID, 'МЛИ-инструменты')) });
    // Удалён активный, но у набора остался другой дефолт — правило «Потомки».
    state.effectiveList.effective = [row('v-2', 'Другой', { isDefault: true })];
    strip.onThoughtTypeViewRealtime({
      type: 'thought-type-view.deleted',
      thought_type_id: TYPE_ID,
      view_id: 'v-1',
    });
    await settle();
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('realtime перенесённый (reason:moved) активный не сбрасывается, владелец перерезолвится', async () => {
    const harness = await mountWith([
      row('v-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, isDefault: false }),
      row('v-2', 'Дефолт', { isDefault: true }),
    ]);
    harness.findViewButton('v-1')!.click();
    assert.equal((strip.getActiveMode() as any).scope, 'thought');
    store.update({ focus: focusOf(thought(FOCUS_ID, 'МЛИ-инструменты')) });
    // Перенос «вне типа → тип»: id тот же, владелец стал типом.
    state.effectiveList.effective = [
      row('v-1', 'Кому одолжил', { scope: 'type', definedOn: TYPE_ID }),
      row('v-2', 'Дефолт', { isDefault: true }),
    ];
    strip.onThoughtTypeViewRealtime({
      type: 'thought-custom-view.deleted',
      thought_id: FOCUS_ID,
      view_id: 'v-1',
      reason: 'moved',
    });
    await settle();
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-1', 'активный чип сохранён');
    assert.equal((mode as any).scope, 'type', 'владелец перерезолвлен');
    assert.equal((mode as any).definedOn, TYPE_ID);
  });

  it('realtime event is a no-op when there is no focused thought', async () => {
    await mountWith([]);
    store.update({ networkId: NETWORK_ID, focus: null });
    assert.doesNotThrow(() => {
      strip.onThoughtTypeViewRealtime({
        type: 'thought-type-view.created',
        thought_type_id: TYPE_ID,
        view_id: 'v-1',
      });
    });
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('onFocusChange is a safe no-op for unknown focus ids', () => {
    assert.doesNotThrow(() => {
      strip.onFocusChange('00000000-0000-4000-8000-00000000ffff');
    });
  });

  // -------------------------------------------------------------------
  // Меню «⋯» и гейт «Основы»
  // -------------------------------------------------------------------

  it('overflow: ⋯ dropdown surfaces hidden views, внетиповые помечены «(вне типа)»', async () => {
    installWindow();
    clearBody();
    const harness = await mountWith(
      Array.from({ length: 6 }, (_, i) => row(`v-${i}`, `Имя ${i}`, { position: i })).concat([
        row('c-1', 'Кому одолжил', { scope: 'thought', definedOn: FOCUS_ID, position: 6 }),
      ]),
    );
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null);
    const all = (stripEl as ShimElement).querySelectorAll('.canvas-filter-strip-btn');
    const overflow = all.find((b) => b.classList.contains('canvas-filter-strip-overflow'));
    assert.ok(overflow !== null);
    overflow!.click();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    assert.ok(
      menuLabels(menu).some((label) => label.includes('(вне типа)')),
      `внетиповой в «⋯» обязан быть помечен: ${JSON.stringify(menuLabels(menu))}`,
    );
  });

  it('«+» в полосе под фокусом показывает тост «Для добавления отборов…» в слое изменений', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: '11111111-2222-3333-4444-555555555555', title: 'Черновик' } });
    const harness = await mountWith([]);
    harness.findPlusButton()!.click();
    assert.equal(lastMenu(), undefined, 'меню не открывается до гейта');
    assert.ok(
      noticesOnBody().some((text) => text.includes('Для добавления отборов переключитесь в Основу')),
      `ожидался тост про Основу; фактически: ${JSON.stringify(noticesOnBody())}`,
    );
    assert.equal(state.propertyRegistry.calls, 0, 'диалог не открывается');
  });

  it('«+» в полосе под фокусом открывает диалог в Основе (контрольное поведение)', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    const harness = await mountWith([]);
    harness.findPlusButton()!.click();
    const menu = lastMenu();
    assert.ok(menu !== undefined, 'меню двух пунктов открыто');
    findMenuItemByLabel(menu, 'Новый отбор типа мысли')!.click();
    await settle();
    assert.equal(state.propertyRegistry.calls, 1);
    assert.equal(
      noticesOnBody().filter((text) => text.includes('Для добавления отборов')).length,
      0,
      'в Основе тостов про слой быть не должно',
    );
  });

  it('контекстное меню «Изменить отбор» показывает тост в слое изменений', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: '11111111-2222-3333-4444-555555555555', title: 'Черновик' } });
    const harness = await mountWith([
      row('v-1', 'A-просмотр', { position: 0, version: 3 }),
    ]);
    harness.findViewButton('v-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Изменить отбор')!.click();
    await settle();
    assert.ok(
      noticesOnBody().some((text) => text.includes('Для изменения отбора переключитесь в Основу')),
      `ожидался тост про Основу; фактически: ${JSON.stringify(noticesOnBody())}`,
    );
    assert.equal(state.propertyRegistry.calls, 0, 'диалог не открывался');
  });

  it('контекстное меню «Удалить отбор» показывает тост в слое изменений', async () => {
    installWindow();
    clearBody();
    store.update({ currentLayer: { id: '11111111-2222-3333-4444-555555555555', title: 'Черновик' } });
    const harness = await mountWith([row('v-1', 'A-просмотр', { position: 0, version: 3 })]);
    harness.findViewButton('v-1')!.dispatchContextMenu();
    const menu = lastMenu();
    assert.ok(menu !== undefined);
    findMenuItemByLabel(menu, 'Удалить отбор')!.click();
    await settle();
    assert.equal(lastDialog(), undefined, 'подтверждение не открывается');
    assert.ok(
      noticesOnBody().some((text) => text.includes('Для удаления отбора переключитесь в Основу')),
      `ожидался тост про Основу; фактически: ${JSON.stringify(noticesOnBody())}`,
    );
    assert.equal(state.typeRemove.calls.length, 0);
  });
});
