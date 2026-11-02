/**
 * Регресс ошибки 1ae1f9b8: скрытый экран не держит подписки индикаторов.
 *
 * До фикса клиентского 46bda0e8 «подписка = видимость» соблюдалась только
 * внутри экрана: набор «Структур» объявлялся в `renderTree`, а снимался лишь
 * в teardown `mountStructures` (`activeView !== 'structures'` — ранний
 * `return`, перерисовки и снятия нет). Холст по `activeView` не гейтился
 * вовсе. Следствие: после ухода с вида подписки скрытого экрана оставались
 * живыми, и волна `indicatorsAll` (ресинк после смены слоя,
 * `comment.updated`/`attachment.updated`) перечитывала его строки — лишние
 * comments.list+attachments.list на каждую отрисованную строку.
 *
 * Контракт под тестом:
 *  1. ушли со «Структур» на карту — подписки дерева сняты, волна индикаторов
 *     не читает ни одной строки скрытого дерева;
 *  2. вернулись на «Структуры» — видимый набор строк объявлен заново (волна
 *     снова читает ровно строки дерева);
 *  3. холст, скрытый на «Структурах», подписок тоже не держит; возврат на
 *     карту объявляет его набор заново;
 *  4. семантика «подписка = видимость» не сломана: набор объявляется из
 *     отрисованных строк/облачков, а не из истории.
 *
 * Экраны монтируются ЦЕЛИКОМ на общем DOM-шиме (`./dom-shim.js`): проверяется
 * настоящее поведение подписки store и общего владельца подписок
 * `lib/cloud-indicators.ts`, а не вызов внутренней функции.
 *
 * Мутации, краснящие кейсы:
 *   - убрать снятие набора «Структур» при уходе с вида — кейсы 1 и 2;
 *   - убрать гейт видимости холста — кейс 3.
 *
 * Тест входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import type { FocusNeighbor, FocusResponse, Thought, ThoughtRef } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type CloudIndicatorsModule = typeof import('../src/renderer/lib/cloud-indicators.js');
type LiveModule = typeof import('../src/renderer/lib/live/index.js');
type StateModule = typeof import('../src/renderer/state.js');
type StructuresModule = typeof import('../src/renderer/screens/structures/structures.js');
type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');

const NETWORK_ID = '00000000-0000-4000-8000-0000000001e1';
const TYPE_ID = '00000000-0000-4000-8000-0000000001e2';
const FOCUS_ID = '00000000-0000-4000-8000-0000000001e3';
const CHILD_ID = '00000000-0000-4000-8000-0000000001e4';
/** Строки дерева «Структур»: три результата отбора, без раскрытий. */
const TREE_IDS = [
  '00000000-0000-4000-8000-0000000001e5',
  '00000000-0000-4000-8000-0000000001e6',
  '00000000-0000-4000-8000-0000000001e7',
];

let indicators: CloudIndicatorsModule;
let live: LiveModule;
let store: StateModule['store'];
let structures: StructuresModule;
let canvas: CanvasModule;

/** id мыслей, по которым ушёл запрос comments.list / attachments.list. */
let commentCalls: string[] = [];
let attachmentCalls: string[] = [];

let mountedStructures: (() => void) | null = null;
let mountedCanvas: (() => void) | null = null;

function thought(id: string, title: string): Thought {
  return {
    id,
    title,
    type_id: TYPE_ID,
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
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

/** Карточка-ссылка мысли для строк запроса (ThoughtRef — подмножество Thought). */
function thoughtRef(id: string, title: string): ThoughtRef {
  return thought(id, title);
}

function neighbor(id: string): FocusNeighbor {
  return {
    id,
    title: `Сосед ${id}`,
    type_id: TYPE_ID,
    icon: null,
    active: true,
    link_id: `link-${id}`,
    link_type_id: null,
    link_active: true,
    link_marked_for_deletion: false,
    has_incoming: false,
    has_outgoing: false,
    manual_position: 0,
  };
}

/** Фокус карты: фокусная мысль и один потомок — два видимых облачка. */
function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Фокус'),
    parents: [],
    children: [neighbor(CHILD_ID)],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'manual', order: 'asc' },
      children: { sort: 'manual', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

/** Мост preload: минимум для монтирования обоих экранов и счётчиков облачков. */
function installBridge(): void {
  commentCalls = [];
  attachmentCalls = [];
  const api = {
    ui: { getState: async () => null, setState: async () => undefined },
    tabs: { updateState: async () => undefined, list: async () => [] },
    propertyRegistry: { list: async () => [] },
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    thoughts: {
      get: async (id: string) => ({ ...thoughtRef(id, `Мысль ${id}`), meta: { views: [] } }),
      resolve: async (_n: string, ids: string[]) => ids.map((id) => thoughtRef(id, `Мысль ${id}`)),
      findDuplicates: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
      focus: async () => focusResponse(),
    },
    history: { list: async () => [] },
    structures: {
      query: async () => ({
        items: TREE_IDS.map((id) => thoughtRef(id, `Строка ${id}`)),
        total: TREE_IDS.length,
        directions: {},
        next_cursor: null,
      }),
      edges: async () => [],
      hierarchy: async () => ({ neighbors: [], has_more: false }),
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
          view: { id: 'v', name: 'v', type_id: TYPE_ID },
          unresolved: [],
        },
      }),
    },
    comments: {
      list: async (_networkId: string, _ownerType: string, id: string) => {
        commentCalls.push(id);
        return [{ kind: 'permanent' }, { kind: 'chronological' }];
      },
    },
    attachments: {
      list: async (_networkId: string, _ownerType: string, id: string) => {
        attachmentCalls.push(id);
        return [];
      },
    },
  };
  (globalThis as any).etn = api;
  (globalThis as any).window.etn = api;
}

function installGlobals(): void {
  (globalThis as any).HTMLElement = ShimElement;
  // Зоны холста виртуализированы: у шима нет `clientWidth`/`offsetHeight`, и
  // без них раскладка сетки делит на NaN или не сходится по высоте строк
  // (`Math.max(estimate, undefined)` → NaN, `renderZoneContent` зацикливается) —
  // в canvas-тестах ровно эти два поля так же задаются прототипом.
  Object.defineProperty(ShimElement.prototype, 'clientWidth', {
    get: () => 1000,
    configurable: true,
  });
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
    get: () => 34,
    configurable: true,
  });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: { style: {}, classList: new ShimElement('html').classList },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [] as ShimElement[],
    activeElement: null,
    getSelection: () => null,
    elementFromPoint: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  win.cancelAnimationFrame = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as any).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as any).localStorage = win.localStorage;
  // Токены длительностей фокуса/проявления расклада — как в canvas-тестах:
  // без них фокус-хореография читает NaN и расклад повторяет пересборку.
  const animTokens: Record<string, string> = {
    '--anim-focus-flight': '400ms',
    '--anim-focus-settle': '260ms',
    '--anim-focus-fade': '300ms',
    '--anim-focus-ease': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    '--anim-network-reveal': '300ms',
  };
  (globalThis as any).getComputedStyle = (el: {
    style?: { getPropertyValue?: (n: string) => string };
  }) => ({
    getPropertyValue: (name: string): string =>
      name in animTokens ? animTokens[name]! : (el?.style?.getPropertyValue?.(name) ?? ''),
  });
  win.getComputedStyle = (globalThis as any).getComputedStyle;
  // Web Animations API: переход фокуса анимирует облачка через `el.animate`;
  // без метода рендер падает на середине пересборки (шим его не несёт).
  (ShimElement.prototype as any).animate = () => ({ cancel: () => undefined });
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
}

/** Дождаться микротасок, таймеров и продолжений промисов экранов. */
async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

before(async () => {
  installGlobals();
  installBridge();
  store = (await import('../src/renderer/state.js')).store;
  live = await import('../src/renderer/lib/live/index.js');
  indicators = await import('../src/renderer/lib/cloud-indicators.js');
  structures = await import('../src/renderer/screens/structures/structures.js');
  canvas = await import('../src/renderer/canvas/canvas.js');
});

beforeEach(() => {
  mountedStructures?.();
  mountedStructures = null;
  mountedCanvas?.();
  mountedCanvas = null;
  store.update({ networkId: null } as any);
  indicators.resetCloudIndicatorSubscriptions();
  indicators.cloudIndicatorInternals.resetConcurrencyMetric();
  live.resetQueryRegistry();
  installBridge();
  store.update({
    networkId: NETWORK_ID,
    screen: 'workspace',
    activeView: 'map',
    activeTabId: null,
    tabs: [],
    focus: null,
    rtStatusByNetwork: { [NETWORK_ID]: 'connected' },
    thoughtTypes: [],
    linkTypes: [],
    selection: [],
    layerOverrides: { thought_ids: [], link_ids: [] },
    canvasZoom: 1,
    cloudWidth: 180,
    cloudGap: 16,
  } as any);
});

afterEach(() => {
  mountedStructures?.();
  mountedStructures = null;
  mountedCanvas?.();
  mountedCanvas = null;
});

const subscriberCount = (): number => indicators.cloudIndicatorInternals.subscriberCount();
const subscribedIds = (): string[] => indicators.cloudIndicatorInternals.subscribedIds();

describe('скрытый экран не держит подписки индикаторов (ошибка 1ae1f9b8)', () => {
  it('«Структуры» → карта: подписки дерева сняты, волна не читает строки дерева', async () => {
    store.update({ activeView: 'structures' } as any);
    const host = new ShimElement('div');
    mountedStructures = structures.mountStructures(host as unknown as HTMLElement);
    await flush();

    assert.equal(host.querySelectorAll('.st-row').length, TREE_IDS.length, 'дерево отрисовало строки');
    assert.deepEqual(subscribedIds(), [...TREE_IDS].sort(), 'на «Структурах» дерево подписано на свои строки');

    // Уход с вида: холст в этом кейсе не смонтирован — проверяется только дерево.
    store.update({ activeView: 'map' } as any);
    await flush();

    assert.equal(subscriberCount(), 0, 'скрытое дерево подписок не держит');

    commentCalls = [];
    attachmentCalls = [];
    live.invalidateQueries(live.queryKeys.indicatorsAll(), live.LOCAL_CAUSE);
    await flush();

    assert.deepEqual(commentCalls, [], 'волна после смены слоя не читает строки скрытого дерева');
    assert.deepEqual(attachmentCalls, [], 'волна не читает вложения строк скрытого дерева');
  });

  it('возврат на «Структуры»: набор строк объявлен заново', async () => {
    store.update({ activeView: 'structures' } as any);
    const host = new ShimElement('div');
    mountedStructures = structures.mountStructures(host as unknown as HTMLElement);
    await flush();

    store.update({ activeView: 'map' } as any);
    await flush();
    assert.equal(subscriberCount(), 0, 'скрытое дерево подписок не держит');

    store.update({ activeView: 'structures' } as any);
    await flush();
    assert.deepEqual(subscribedIds(), [...TREE_IDS].sort(), 'видимый набор объявлен заново');

    // Ресинк слоя на показанном дереве снова читает ровно его строки.
    commentCalls = [];
    attachmentCalls = [];
    live.invalidateQueries(live.queryKeys.indicatorsAll(), live.LOCAL_CAUSE);
    await flush();
    assert.deepEqual([...commentCalls].sort(), [...TREE_IDS].sort(), 'волна читает строки дерева');
    assert.deepEqual([...attachmentCalls].sort(), [...TREE_IDS].sort());
  });

  it('холст, скрытый на «Структурах», подписок не держит; на карте — держит', async () => {
    const host = new ShimElement('section', 'canvas-host');
    mountedCanvas = canvas.mountCanvas(host as unknown as HTMLElement);
    await flush();
    store.update({ focus: focusResponse() } as any);
    await flush();

    assert.deepEqual(
      subscribedIds(),
      [FOCUS_ID, CHILD_ID].sort(),
      'на карте подписаны фокус и видимый сосед',
    );

    store.update({ activeView: 'structures' } as any);
    await flush();
    assert.equal(subscriberCount(), 0, 'скрытый холст подписок не держит');

    store.update({ activeView: 'map' } as any);
    await flush();
    assert.deepEqual(
      subscribedIds(),
      [FOCUS_ID, CHILD_ID].sort(),
      'возврат на карту объявляет набор заново',
    );

    // Облачка не теряют данные: повторная подписка применяет кэш слоя сразу,
    // волна не нужна (значения 📝/📅/📎 остаются у пересозданных облачков).
    commentCalls = [];
    attachmentCalls = [];
    live.invalidateQueries(live.queryKeys.indicatorsAll(), live.LOCAL_CAUSE);
    await flush();
    assert.deepEqual([...commentCalls].sort(), [FOCUS_ID, CHILD_ID].sort());
  });
});
