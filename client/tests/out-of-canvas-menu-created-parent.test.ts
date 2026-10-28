/**
 * Сторож ошибки d19c57b7: поведенческие кейсы меню мысли ВНЕ холста проверяют
 * НЕ факт запроса родителя, а ФАКТИЧЕСКОГО родителя созданной мысли.
 *
 * Причина появления. Верификатор круга 2 `ffc173c9` (`72bebd3c`) доказал
 * мутациями, что старые кейсы (`cloud-context-menu.test.ts`,
 * `out-of-canvas-sibling-parent.test.ts`) видят только вызов
 * `thoughts.neighbors(M, parents)`, но не значение, попавшее в меню:
 *  - «резолвить родителя M, но передать в меню родителя фокуса T» — 9/9
 *    зелёных;
 *  - «перенести сверку сети до `await resolveSiblingParent`» — 9/9 зелёных.
 * Поэтому здесь каждая команда «Добавить → налево (родственник)» доводится до
 * `etn.thoughts.create` и проверяется `create_link.target_thought_id` —
 * родитель КЛИКНУТОЙ мысли, а не мысли в фокусе карты. Места: вкладка
 * «Упоминания» (`editor/links-tab.ts`), панель закреплённых
 * (`screens/pinned-bar.ts`), строка соседа в Ctrl-hover попапе холста
 * (`canvas/canvas.ts:2600`, единственный путь меню вне холста в холсте) и
 * панель выделения (`selection/selection.ts` — десятое место, блокер
 * верификатора к 245a1992: строка панели открывала меню обходным входом без
 * родителя и создавала мысль под родителем фокуса).
 *
 * Дополнительно: смена сети ПОКА `resolveSiblingParent` в полёте. Сверка сети
 * живёт в фасаде ПОСЛЕ `await`; поздний ответ прежней сети не должен открыть
 * меню и не подставить чужого родителя. Проверяется на самом фасаде и на
 * вызывающем (панель закреплённых).
 *
 * Мутации, краснящие файл:
 *  - `showOutOfCanvasThoughtMenu` резолвит родителя по `store.state.focus`
 *    (родитель фокуса вместо кликнутой мысли) — все кейсы создания;
 *  - сверка `store.state.networkId !== networkId` перенесена до `await` —
 *    все кейсы гонки;
 *  - возврат обходного входа `showSelectionThoughtContextMenu` без родителя
 *    (панель выделения зовёт его, а не фасад) — кейсы панели выделения и
 *    сторож `guard-out-of-canvas-menu.test.ts`;
 *  - возврат локальной копии цепочки в модуль-потребитель — сторож
 *    `guard-out-of-canvas-menu.test.ts` (не ослаблен этим файлом).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type AnyRec = Record<string, any>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
/** Мысль в фокусе карты — ребёнок P1. */
const FOCUS_ID = '00000000-0000-4000-8000-0000000000f1';
const FOCUS_PARENT = '00000000-0000-4000-8000-0000000000f2';
/** Кликнутая мысль (чип/упоминание/строка соседа) — ребёнок P2. */
const CLICKED_ID = '00000000-0000-4000-8000-0000000000c1';
const CLICKED_PARENT = '00000000-0000-4000-8000-0000000000c2';
/** Для холста: P1 — родитель фокуса, GP — его родитель (строка попапа),
 *  GGP — родитель GP (фактический якорь «налево» для строки GP). */
const GRAND_ID = '00000000-0000-4000-8000-0000000000d1';
const GREAT_ID = '00000000-0000-4000-8000-0000000000e1';

const TITLES: Record<string, string> = {
  [FOCUS_ID]: 'Фокус',
  [FOCUS_PARENT]: 'Родитель Фокуса',
  [CLICKED_ID]: 'Меншн',
  [CLICKED_PARENT]: 'Родитель Меншна',
  [GRAND_ID]: 'Бабушка',
  [GREAT_ID]: 'Прабабушка',
};

/** Родитель мысли в фейковом сервере (кто под кем создан). */
const PARENTS: Record<string, string> = {
  [FOCUS_ID]: FOCUS_PARENT,
  [CLICKED_ID]: CLICKED_PARENT,
  [FOCUS_PARENT]: GRAND_ID,
  [GRAND_ID]: GREAT_ID,
};

interface Calls {
  neighbors: Array<{ networkId: string; id: string; dir: string }>;
  creates: Array<{ networkId: string; input: AnyRec }>;
}

const calls: Calls = { neighbors: [], creates: [] };

/** Удержание ответа `neighbors` для гонки со сменой сети. */
let holdNeighbors: Promise<void> | null = null;
let releaseNeighbors: (() => void) | null = null;
/** Что вернуть `neighbors` в сети B (родитель «чужой» сети). */
let parentsInB: string[] = [];

/** Слушатели документа: движку Ctrl-hover нужен настоящий `mousemove`. */
const documentListeners = new Map<string, Set<(event: AnyRec) => void>>();
const windowListeners = new Map<string, Set<(event: AnyRec) => void>>();

function addListener(
  map: Map<string, Set<(event: AnyRec) => void>>,
  type: string,
  handler: (event: AnyRec) => void,
): void {
  const set = map.get(type) ?? new Set();
  set.add(handler);
  map.set(type, set);
}

function removeListener(
  map: Map<string, Set<(event: AnyRec) => void>>,
  type: string,
  handler: (event: AnyRec) => void,
): void {
  map.get(type)?.delete(handler);
}

function dispatchDocument(type: string, event: AnyRec): void {
  event.type ??= type;
  for (const handler of [...(documentListeners.get(type) ?? [])]) handler(event);
}

/** Полная мысль для шапки редактора и `thoughts.get`. */
function fullThought(id: string, title: string): AnyRec {
  return {
    id,
    title,
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
    created_by: 'u1',
    updated_by: 'u1',
    meta: { views: [] },
  };
}

function thoughtRef(id: string): AnyRec {
  const thought = fullThought(id, TITLES[id] ?? id);
  delete thought['meta'];
  return thought;
}

function neighbor(id: string): AnyRec {
  return {
    id,
    title: TITLES[id] ?? id,
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
    link_id: `link-${id}`,
    link_type_id: null,
    link_active: true,
    link_marked_for_deletion: false,
    has_incoming: true,
    has_outgoing: false,
    manual_position: 0,
  };
}

/** Закреплённые текущего кейса (порядок — как на сервере). */
let pinnedIds: string[] = [];

const bridge: AnyRec = {
  ui: {
    getState: async () => 'links',
    setState: async () => undefined,
  },
  networks: {
    list: async () => [{ id: NET_A }, { id: NET_B }],
  },
  propertyRegistry: {
    list: async () => [],
  },
  tabs: {
    list: async () => [],
    updateState: async () => undefined,
  },
  pins: {
    list: async () => pinnedIds.map((thoughtId) => ({ thought_id: thoughtId, position: 0 })),
    set: async (_networkId: string, ids: string[]) => {
      pinnedIds = [...ids];
      return ids.map((thoughtId, position) => ({ thought_id: thoughtId, position }));
    },
  },
  thoughts: {
    get: async (_networkId: string, id: string) => fullThought(id, TITLES[id] ?? id),
    resolve: async (_networkId: string, ids: string[]) => ids.map(thoughtRef),
    neighbors: async (networkId: string, id: string, dir: string) => {
      calls.neighbors.push({ networkId, id, dir });
      if (holdNeighbors !== null) await holdNeighbors;
      if (networkId === NET_B) return parentsInB.map(neighbor);
      const parentId = PARENTS[id];
      return parentId === undefined ? [] : [neighbor(parentId)];
    },
    neighborsPage: async () => ({ total: 0, items: [] }),
    create: async (networkId: string, input: AnyRec) => {
      calls.creates.push({ networkId, input });
      return { id: 'created-thought' };
    },
    mentions: async () => [
      {
        owner_type: 'thought',
        owner_id: CLICKED_ID,
        title: TITLES[CLICKED_ID],
        comment_id: 'comment-1',
        snippet: 'Упоминание Меншна в тексте.',
        active: true,
      },
    ],
    backlinks: async () => [],
    findDuplicates: async () => [],
    findDuplicatesAcrossNetworks: async () => ({ hits: [], networks: { networks: [] } }),
    deletionCheck: async (_networkId: string, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          { blocked: false, blocking: { layers: [] }, orphaned_children: 0 },
        ]),
      ),
  },
  links: {
    deletionCheck: async () => ({}),
    get: async () => ({ id: 'link', marked_for_deletion: false }),
  },
  comments: {
    list: async () => [],
  },
  attachments: {
    list: async () => [],
  },
  properties: {
    get: async () => [],
  },
  admin: {
    listUsers: async () => [],
  },
  publications: {
    usage: async () => ({ total: 0, rows: [] }),
  },
  structures: {
    edges: async () => [],
  },
  thoughtTypeViews: {
    list: async () => ({ data: [], meta: { effective: [] } }),
    run: async () => ({
      data: [],
      meta: {
        total: 0,
        limit: 50,
        offset: 0,
        directions: {},
        view: { id: 'v', name: 'v', type_id: null },
        unresolved: [],
      },
    }),
  },
  realtime: {
    onStatusChange: () => undefined,
    onStale: () => undefined,
    onNetworkLost: () => undefined,
    onLayerControl: () => undefined,
    onEvent: () => undefined,
    notifyOnline: () => undefined,
  },
};

function shimDom(): void {
  documentListeners.clear();
  windowListeners.clear();
  (globalThis as AnyRec).HTMLElement = ShimElement;
  (globalThis as AnyRec).Element = ShimElement;
  // Лупа Ctrl-наведения проверяет узлы через `instanceof`; в шиме картинок
  // нет — пустые классы не совпадут ни с одним элементом.
  (globalThis as AnyRec).HTMLImageElement = class {};
  (globalThis as AnyRec).SVGImageElement = class {};
  (globalThis as AnyRec).ResizeObserver = class {
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
  (globalThis as AnyRec).requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  (globalThis as AnyRec).cancelAnimationFrame = () => undefined;
  (globalThis as AnyRec).getComputedStyle = () => ({
    getPropertyValue: () => '',
    paddingLeft: '0px',
    paddingRight: '0px',
  });
  const documentShim = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: {
      style: { setProperty: () => undefined, removeProperty: () => undefined },
      getPropertyValue: () => '',
    },
    addEventListener: (type: string, handler: (event: AnyRec) => void) =>
      addListener(documentListeners, type, handler),
    removeEventListener: (type: string, handler: (event: AnyRec) => void) =>
      removeListener(documentListeners, type, handler),
    dispatchEvent: (event: AnyRec): boolean => {
      dispatchDocument(event.type, event);
      return true;
    },
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
    elementFromPoint: () => null,
  };
  (globalThis as AnyRec).document = documentShim;

  const win = ((globalThis as AnyRec).window ?? ((globalThis as AnyRec).window = {})) as AnyRec;
  Object.assign(win, {
    innerWidth: 1400,
    innerHeight: 900,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (globalThis as AnyRec).requestAnimationFrame,
    cancelAnimationFrame: () => undefined,
    getComputedStyle: (globalThis as AnyRec).getComputedStyle,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    addEventListener: (type: string, handler: (event: AnyRec) => void) =>
      addListener(windowListeners, type, handler),
    removeEventListener: (type: string, handler: (event: AnyRec) => void) =>
      removeListener(windowListeners, type, handler),
    dispatchEvent: (event: AnyRec): boolean => {
      event.type ??= '';
      for (const handler of [...(windowListeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    etn: bridge,
  });
  (globalThis as AnyRec).etn = bridge;
  (globalThis as AnyRec).localStorage = win.localStorage;
}

/** Атрибутный `closest` для шима (см. ниже) — вынесен, чтобы не алиасить `this`. */
function closestByAttribute(start: ShimElement, selector: string): ShimElement | null {
  const inner = selector.slice(1, -1);
  const variants = (name: string): string[] => {
    if (!name.startsWith('data-')) return [name];
    const short = name.slice(5);
    const camel = short.replace(/-([a-z])/g, (_m: string, char: string) => char.toUpperCase());
    return [name, camel, short];
  };
  const eq = inner.indexOf('=');
  if (eq >= 0) {
    const key = inner.slice(0, eq);
    const value = inner.slice(eq + 1).replace(/"/g, '');
    let current: ShimElement | null = start;
    while (current !== null) {
      if (variants(key).some((variant) => current!.dataset[variant] === value)) return current;
      current = current.parent;
    }
    return null;
  }
  let current: ShimElement | null = start;
  while (current !== null) {
    if (variants(inner).some((variant) => variant in current!.dataset)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * `ShimElement.closest` понимает только класс/тег; движку Ctrl-hover нужен
 * атрибутный `closest('[data-hp-kind]')` (так продукт ищет триггер). Расширяем
 * ТОЛЬКО в этом тесте, не трогая общий шим.
 */
const baseClosest = ShimElement.prototype.closest;
ShimElement.prototype.closest = function closest(selector: string): ShimElement | null {
  if (selector.startsWith('[') && selector.endsWith(']')) {
    return closestByAttribute(this, selector);
  }
  return baseClosest.call(this, selector);
};

shimDom();

const stateMod = await import('../src/renderer/state.js');
const editorMod = await import('../src/renderer/editor/editor.js');
const pinnedMod = await import('../src/renderer/screens/pinned-bar.js');
const canvasMod = await import('../src/renderer/canvas/canvas.js');
const hoverMod = await import('../src/renderer/lib/hover-preview.js');
const contextMenuMod = await import('../src/renderer/canvas/context-menu.js');
const selectionMod = await import('../src/renderer/selection/selection.js');
const liveMod = await import('../src/renderer/lib/live/index.js');

/** Дождаться асинхронных чтений/продолжений экранов, попапов и диалога. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/** Смонтированное состояние между кейсами снимается первым делом. */
let teardown: (() => void) | null = null;

afterEach(() => {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  calls.neighbors = [];
  calls.creates = [];
  holdNeighbors = null;
  releaseNeighbors = null;
  parentsInB = [];
  pinnedIds = [];
  stateMod.store.update({ networkId: null, focus: null, editorTarget: null, selection: [] } as any);
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  body.body.replaceChildren();
});

/** Общее состояние стора: сеть A, фокус T (ребёнок P1). */
function installStore(pins: string[] = []): void {
  pinnedIds = [...pins];
  stateMod.store.update({
    profileId: 'profile-1',
    networkId: NET_A,
    network: { id: NET_A },
    activeTabId: 'tab-A',
    tabs: [{ tab_id: 'tab-A', network_id: NET_A }],
    activeView: 'map',
    screen: 'workspace',
    editorTarget: null,
    selection: [],
    focus: {
      focused: { id: FOCUS_ID, title: TITLES[FOCUS_ID] },
      parents: [neighbor(FOCUS_PARENT)],
      children: [],
      siblings: [],
      edges: [],
      sorts: {
        parents: { sort: 'alpha', order: 'asc' },
        children: { sort: 'alpha', order: 'asc' },
        siblings: { sort: 'alpha', order: 'asc' },
      },
    },
    showInactive: false,
    showTrash: true,
    rtStatusByNetwork: { [NET_A]: 'connected' },
    collapsedGroups: {},
    canvasZoom: 1,
    cloudWidth: 180,
    cloudGap: 16,
    layerOverrides: { thought_ids: [], link_ids: [] },
  } as any);
}

/** Все строки меню, открытого над документом (меню порталится в `body`). */
function menuRows(): ShimElement[] {
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  return body.body.findAll('menu-item');
}

/** Строка меню по началу подписи. */
function rowByLabel(prefix: string): ShimElement | undefined {
  return menuRows().find((row) => (row.textContent ?? '').trim().startsWith(prefix));
}

/** Клик «Добавить → налево (родственник)» в открытом меню. */
function clickAddSibling(): void {
  const add = rowByLabel('Добавить');
  assert.ok(add !== undefined, 'в меню есть подменю «Добавить»');
  add.emit('mouseenter');
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  const sub = body.body.findAll('menu-sub')[0];
  assert.ok(sub !== undefined, 'подменю «Добавить» построено');
  const sibling = sub
    .findAll('menu-item')
    .find((row) => (row.textContent ?? '').includes('налево'));
  assert.ok(sibling !== undefined, 'в подменю есть «налево (родственник)»');
  assert.equal(sibling.classList.contains('menu-item-disabled'), false, '«налево» активна');
  sibling.click();
}

/** Заголовок открытого диалога «Добавить» (`null` — диалог не открыт). */
function dialogTitle(): string | null {
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  const backdrop = body.body.children.find((node) => node.className === 'dialog-backdrop');
  return backdrop?.children[0]?.querySelector('.dialog-title')?.textContent ?? null;
}

/** Закрыть открытый диалог «Добавить» отменой — уборка после неудачной проверки. */
async function cancelOpenDialog(): Promise<void> {
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  const backdrop = body.body.children.find((node) => node.className === 'dialog-backdrop');
  const box = backdrop?.children[0];
  const footer = box?.children.find((c) => c.className.split(/\s+/).includes('dialog-footer'));
  footer?.children
    .find(
      (c) =>
        c.className.split(/\s+/).includes('ui-btn') &&
        !c.className.split(/\s+/).includes('ui-btn--primary'),
    )
    ?.click();
  await flush();
}

/**
 * Подтвердить диалог «Добавить» вводом имени: создаёт новую мысль. Заголовок
 * диалога обязан называть фактического родителя-якоря, а не мысль в фокусе
 * карты (ошибка 89964a9b).
 */
async function confirmCreate(title: string, expectedAnchor: string): Promise<void> {
  await flush();
  const body = (globalThis as AnyRec).document as { body: ShimElement };
  const backdrop = body.body.children.find((node) => node.className === 'dialog-backdrop');
  assert.ok(backdrop !== undefined, 'диалог «Добавить» открылся');
  const shownTitle = dialogTitle() ?? '';
  const namesAnchor = shownTitle.includes(`вниз к «${expectedAnchor}»`);
  const namesFocus = shownTitle.includes(TITLES[FOCUS_ID]!);
  if (!namesAnchor || namesFocus) {
    await cancelOpenDialog();
    assert.ok(
      namesAnchor,
      `заголовок диалога называет фактического родителя «${expectedAnchor}»: ${shownTitle}`,
    );
    assert.ok(!namesFocus, `заголовок диалога не называет мысль в фокусе: ${shownTitle}`);
  }
  const box = backdrop.children[0];
  assert.ok(box !== undefined, 'тело диалога построено');
  const input = box.querySelector('textarea');
  assert.ok(input !== null, 'поле имени в диалоге есть');
  input!.value = title;
  input!.emit('input', {});
  const primary = box.querySelector('.ui-btn--primary');
  assert.ok(primary !== null, 'кнопка подтверждения в диалоге есть');
  primary!.click();
  await flush();
}

/** Родитель, под которым создана новая мысль (`create_link.target_thought_id`). */
function createdParent(): string | null {
  assert.equal(calls.creates.length, 1, 'мысль создана ровно один раз');
  return calls.creates[0]!.input?.create_link?.target_thought_id ?? null;
}

/** Собственное событие правого клика с координатами элемента. */
function contextMenuEvent(): MouseEvent {
  return {
    clientX: 40,
    clientY: 60,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as MouseEvent;
}

/** Смонтировать редактор на вкладке «Упоминания» (группа «Упоминания в текстах»). */
async function mountLinksTab(): Promise<ShimElement> {
  installStore();
  const host = new ShimElement('div', 'editor');
  stateMod.store.update({
    editorTarget: { kind: 'thought', id: FOCUS_ID, thought: fullThought(FOCUS_ID, TITLES[FOCUS_ID]!) },
    collapsedGroups: { 'links.text-mentions': false },
  } as any);
  editorMod.mountEditor(host as unknown as HTMLElement);
  // У редактора нет teardown: его store-подписка живёт до перемонтирования и
  // иначе дёргает `render()` на каждом обновлении стора в следующих кейсах.
  // Отключаем хост от документа — подписка гвардится `host.isConnected`.
  teardown = () => {
    host.connectedRoot = false;
  };
  await flush();
  const cloud = host
    .findAll('prop-ref-cloud')
    .find((element) => element.dataset['id'] === CLICKED_ID);
  assert.ok(cloud !== undefined, 'облачко-упоминание M отрисовано на вкладке «Упоминания»');
  return cloud!;
}

/** Смонтировать панель закреплённых с чипами T и M. */
async function mountPinnedBar(): Promise<ShimElement> {
  installStore([FOCUS_ID, CLICKED_ID]);
  liveMod.setQueryData(liveMod.queryKeys.pins(), [FOCUS_ID, CLICKED_ID]);
  const host = new ShimElement('div', 'pinned-bar');
  teardown = pinnedMod.mountPinnedBar(host as unknown as HTMLElement);
  await flush();
  const chip = host
    .findAll('pinned-chip')
    .find((element) => element.dataset['id'] === CLICKED_ID);
  assert.ok(chip !== undefined, 'чип закреплённой мысли M отрисован');
  return chip!;
}

/**
 * Смонтировать панель выделения с одной строкой M (фокус карты — T, как в
 * воспроизведении верификатора: Ctrl+клик по M не меняет фокус).
 */
async function mountSelectionPanel(): Promise<ShimElement> {
  installStore();
  const host = new ShimElement('div', 'selection-panel');
  teardown = selectionMod.mountSelection(host as unknown as HTMLElement);
  selectionMod.toggleSelection([CLICKED_ID]);
  await flush();
  const row = host
    .findAll('selection-item')
    .find((element) => element.dataset['id'] === CLICKED_ID);
  assert.ok(row !== undefined, 'строка панели выделения M отрисована');
  return row!;
}

describe('меню вне холста: «налево» создаёт под родителем кликнутой мысли (d19c57b7)', () => {
  it('вкладка «Упоминания»: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    const cloud = await mountLinksTab();
    cloud.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Сосед Упоминаний', TITLES[CLICKED_PARENT]!);
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('панель закреплённых: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    const chip = await mountPinnedBar();
    chip.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Сосед Закреплённых', TITLES[CLICKED_PARENT]!);
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('панель выделения: строка M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    const row = await mountSelectionPanel();
    row.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    // Команда выделения у строки панели скрыта — запись уже выделена (§5.1).
    assert.equal(rowByLabel('Добавить к выделению'), undefined, 'нет команды «Добавить к выделению»');
    assert.equal(rowByLabel('Убрать из выделенных'), undefined, 'нет команды «Убрать из выделенных»');
    clickAddSibling();
    await confirmCreate('Сосед Выделения', TITLES[CLICKED_PARENT]!);
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('холст, строка соседа в Ctrl-hover попапе: клик по GP (родитель P1)', async () => {
    installStore();
    hoverMod.initHoverPreview();
    const host = new ShimElement('section', 'canvas-host');
    Object.defineProperty(ShimElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(ShimElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 34,
    });
    teardown = canvasMod.mountCanvas(host as unknown as HTMLElement);
    await flush();

    const parentCloud = host
      .findAll('cloud')
      .find((element) => element.dataset['id'] === FOCUS_PARENT);
    assert.ok(parentCloud !== undefined, 'облачко родителя фокуса P1 отрисовано на холсте');
    const topEllipse = parentCloud!.querySelector(':scope > .ellipse-top');
    assert.ok(topEllipse !== null, 'у облачка P1 есть верхний эллипс (входящие связи)');
    assert.equal(
      topEllipse!.dataset['hpKind'],
      'neighbors',
      'верхний эллипс P1 — триггер Ctrl-hover списка родителей',
    );

    // Ctrl+hover: движок слушает `mousemove` документа, открытие — по таймеру.
    dispatchDocument('mousemove', {
      clientX: 40,
      clientY: 40,
      ctrlKey: true,
      target: topEllipse,
    });
    await new Promise((resolve) => setTimeout(resolve, hoverMod.hoverPreviewInternals.CTRL_PREVIEW_OPEN_DELAY_MS + 50));
    await flush();

    const body = (globalThis as AnyRec).document as { body: ShimElement };
    const row = body.body
      .findAll('link-group-item')
      .find((element) => element.dataset['id'] === GRAND_ID);
    assert.ok(row !== undefined, 'строка соседа GP построена в попапе');
    row!.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [
        { networkId: NET_A, id: FOCUS_PARENT, dir: 'parents' },
        { networkId: NET_A, id: GRAND_ID, dir: 'parents' },
      ],
      'родитель запрошен у САМОЙ строки GP, а не у мысли в фокусе',
    );
    clickAddSibling();
    await confirmCreate('Сосед Холста', TITLES[GREAT_ID]!);
    assert.equal(createdParent(), GREAT_ID, 'сосед создан под GGP, а не под родителем фокуса');
  });
});

describe('фасад меню вне холста: смена сети во время resolveSiblingParent (d19c57b7)', () => {
  it('фасад: поздний ответ прежней сети не открывает меню и не подставляет чужого родителя', async () => {
    installStore();
    parentsInB = [GRAND_ID];
    holdNeighbors = new Promise<void>((resolve) => {
      releaseNeighbors = resolve;
    });
    const pending = contextMenuMod.showOutOfCanvasThoughtMenu({ event: contextMenuEvent() }, {
      id: CLICKED_ID,
      title: TITLES[CLICKED_ID]!,
      dir: 'siblings',
    });
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'резолв родителя начался в сети A',
    );
    stateMod.store.update({ networkId: NET_B } as any);
    releaseNeighbors?.();
    await pending;
    await flush();
    assert.equal(menuRows().length, 0, 'поздний ответ прежней сети не открыл меню');
    assert.equal(
      calls.neighbors.filter((call) => call.networkId === NET_B).length,
      0,
      'в чужой сети ничего не запрашивалось',
    );
  });

  it('вызывающий (панель закреплённых): поздний ответ прежней сети не открывает меню', async () => {
    const chip = await mountPinnedBar();
    parentsInB = [GRAND_ID];
    holdNeighbors = new Promise<void>((resolve) => {
      releaseNeighbors = resolve;
    });
    chip.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'резолв родителя начался в сети A',
    );
    stateMod.store.update({ networkId: NET_B } as any);
    releaseNeighbors?.();
    await flush();
    assert.equal(menuRows().length, 0, 'поздний ответ прежней сети не открыл меню');
    assert.equal(calls.creates.length, 0, 'ничего не создано');
  });

  it('вызывающий (панель выделения): поздний ответ прежней сети не открывает меню', async () => {
    const row = await mountSelectionPanel();
    parentsInB = [GRAND_ID];
    holdNeighbors = new Promise<void>((resolve) => {
      releaseNeighbors = resolve;
    });
    row.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID, dir: 'parents' }],
      'резолв родителя начался в сети A',
    );
    stateMod.store.update({ networkId: NET_B } as any);
    releaseNeighbors?.();
    await flush();
    assert.equal(menuRows().length, 0, 'поздний ответ прежней сети не открыл меню');
    assert.equal(calls.creates.length, 0, 'ничего не создано');
  });
});
