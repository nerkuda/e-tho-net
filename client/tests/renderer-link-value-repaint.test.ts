/**
 * Regression test for ETN error f0b959dd «Карта не обновляется при изменении
 * значений свойств-связей в редакторе».
 *
 * Симптом: мысль в фокусе, открыт редактор; в свойстве «Родители» (структурная
 * связь) добавлена новая мысль и сохранена — на карте ничего не изменилось
 * (ожидалось: новая мысль в секторе родителей и обновлённый список
 * родственников). Касается значений свойств-связей вообще (структурные
 * «Родители»/«Потомки», типизированные связи, «Свойства вне типа»).
 *
 * Причина — та же, что у серии прецедентов 0.8.2: сервер на запись значения
 * публикует `property-value.set`/`deleted` (создание/удаление РЕБРА), но своё
 * realtime-эхо собственного клиента до рендерера не доходит (G8 applier,
 * main/realtime/applier.ts отбрасывает событие по `actor.client_id`), а
 * локальный путь после ответа `etn.properties.set` окрестность фокуса не
 * перечитывал.
 *
 * Здесь проверяется:
 *  1) реальный путь ЧУЖОГО события через `applyRealtimeToUi` под DOM-шимом:
 *     `property-value.set` и `link.created` из активной сети перечитывают
 *     окрестность фокуса (холст), событие чужой сети — игнорируется;
 *  2) чистый гейт локального производителя `inFocusNeighbourhood`: фокус и его
 *     соседи видимы, невидимая мысль/ребро — нет (чужая мысль — игнор);
 *  3) проводка: запись значения свойства-связи в редакторе («Свойства типа» и
 *     «Свойства вне типа») зовёт общий пересчёт окрестности под этим гейтом.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Thought } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим и данные
// ---------------------------------------------------------------------------

class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  hidden = false;
  readOnly = false;
  disabled = false;
  isConnected = true;
  innerHTML = '';
  tabIndex = -1;
  role = '';
  parent: ShimElement | null = null;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [...nodes];
  }
  remove(): void {
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  setAttribute(): void {}
  getAttribute(): string | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  closest(): ShimElement | null {
    return null;
  }
  focus(): void {}
  blur(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = class {
    detail: unknown;
    constructor(_type: string, init?: { detail?: unknown }) {
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
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
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

function makeThought(id: string): Thought {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as Thought;
}

/** Окрестность фокуса: t1 в фокусе, p1/c1/s1 — соседи, e1 — ребро. */
function makeFocusResponse(): unknown {
  return {
    focused: makeThought('t1'),
    parents: [makeThought('p1')],
    children: [makeThought('c1')],
    siblings: [makeThought('s1')],
    edges: [
      {
        id: 'e1',
        source_id: 't1',
        target_id: 'c1',
        type_id: null,
        color: null,
        style: null,
        width: null,
      },
    ],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Realtime-событие от чужого клиента (собственное эхо отсекает G8-applier). */
function foreignEvent(type: string, networkId: string, data: unknown): Record<string, unknown> {
  return {
    type,
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    audience: 'network',
    network_id: networkId,
    layer_id: 'base',
    data,
    meta: { version: 1 },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// ---------------------------------------------------------------------------
// Realtime-путь: чужое изменение значения свойства-связи доходит до карты
// ---------------------------------------------------------------------------

describe('realtime-значение свойства-связи перечитывает окрестность фокуса (f0b959dd)', () => {
  it('property-value.set и link.created из активной сети перечитывают фокус; чужая сеть — игнор', async () => {
    shimDom();
    /** Перезапросы фокуса — так виден `scheduleNeighbourhoodRepaint` (холст). */
    let focusFetches = 0;
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined },
      types: {
        listThoughtTypes: async () => [],
        listLinkTypes: async () => [],
      },
      thoughts: {
        focus: async () => {
          focusFetches++;
          return makeFocusResponse();
        },
      },
    };
    const { store } = await import('../src/renderer/state.js');
    const { applyRealtimeToUi } = await import('../src/renderer/realtime-ui.js');

    store.update({
      networkId: 'n1',
      activeView: 'map',
      activeTabId: 'tab1',
      focus: makeFocusResponse(),
    } as any);

    // Чужая сеть: событие соседней вкладки общий store активной не трогает.
    applyRealtimeToUi(
      foreignEvent('property-value.set', 'n2', {
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'p1',
        value: ['x'],
      }) as any,
    );
    await wait(260);
    assert.equal(focusFetches, 0, 'событие чужой сети окрестность не перечитывает');

    // Своя сеть, чужой клиент: запись значения свойства-связи (сервер создал
    // ребро) — карта перечитывает окрестность фокуса.
    applyRealtimeToUi(
      foreignEvent('property-value.set', 'n1', {
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'p1',
        value: ['x'],
      }) as any,
    );
    await wait(260);
    assert.equal(
      focusFetches,
      1,
      'чужое `property-value.set` перечитывает фокус (путь жив, эталон для локального)',
    );

    // Типизированная связь, созданная другим клиентом, — тот же путь.
    applyRealtimeToUi(
      foreignEvent('link.created', 'n1', {
        link: {
          id: 'l9',
          source_id: 't1',
          target_id: 'c1',
          type_id: null,
          active: true,
          version: 1,
        },
      }) as any,
    );
    await wait(260);
    assert.equal(focusFetches, 2, 'чужой `link.created` перечитывает фокус');
  });
});

// ---------------------------------------------------------------------------
// Локальный путь: гейт видимости владельца значения
// ---------------------------------------------------------------------------

describe('гейт локальной записи значения свойства-связи (f0b959dd)', () => {
  it('фокус и соседи видимы, невидимая мысль/ребро — нет; без фокуса — пусто', async () => {
    shimDom();
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined },
      thoughts: { focus: async () => makeFocusResponse() },
    };
    const { store } = await import('../src/renderer/state.js');
    const { inFocusNeighbourhood } = await import('../src/renderer/realtime-ui.js');

    store.update({ networkId: 'n1', focus: makeFocusResponse() } as any);
    // Мысль-владелец: фокус и его соседи — видимы.
    assert.equal(inFocusNeighbourhood('thought', 't1'), true, 'фокус виден');
    assert.equal(inFocusNeighbourhood('thought', 'p1'), true, 'родитель виден');
    assert.equal(inFocusNeighbourhood('thought', 'c1'), true, 'потомок виден');
    assert.equal(inFocusNeighbourhood('thought', 's1'), true, 'родственник виден');
    // Чужая мысль (редактор открыт на мысли вне карты) — правка карту не меняет.
    assert.equal(inFocusNeighbourhood('thought', 'z9'), false, 'невидимая мысль — игнор');
    // Связь-владелец: видно только ребро текущей окрестности.
    assert.equal(inFocusNeighbourhood('link', 'e1'), true, 'ребро окрестности видно');
    assert.equal(inFocusNeighbourhood('link', 'l9'), false, 'чужое ребро — игнор');

    // Фокуса нет — пересчитывать нечего.
    store.update({ focus: null } as any);
    assert.equal(inFocusNeighbourhood('thought', 't1'), false, 'без фокуса — игнор');

    // Локальный производитель фокус-мысли: гейт пропускает → пересчёт
    // планируется и реально перечитывает фокус (холст/секторы/линии).
    store.update({ focus: makeFocusResponse() } as any);
    let focusFetches = 0;
    (globalThis as any).window.etn.thoughts.focus = async () => {
      focusFetches++;
      return makeFocusResponse();
    };
    const { scheduleNeighbourhoodRepaint } = await import('../src/renderer/realtime-ui.js');
    if (inFocusNeighbourhood('thought', 't1')) scheduleNeighbourhoodRepaint();
    await wait(260);
    assert.equal(focusFetches, 1, 'запись значения свойства-связи фокус-мысли перечитывает окрестность');
  });
});

// ---------------------------------------------------------------------------
// Проводка: локальные производители редактора «Свойства»
// ---------------------------------------------------------------------------

describe('проводка пересчёта окрестности из редактора свойств (f0b959dd)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('помощник пересчёта делегирует общий набор окрестности', () => {
    const realtimeUi = read('realtime-ui.ts');
    // Набор «холст + Структуры + Хроника» задан один раз, в
    // `scheduleNeighbourhoodRepaint`; ветки link.*/property-value.* зовут его.
    assert.ok(
      /export function scheduleNeighbourhoodRepaint\(\): void \{[\s\S]{0,120}?scheduleRefresh\(\);[\s\S]{0,80}?scheduleStructuresRefresh\(\);[\s\S]{0,80}?scheduleChronicleRefresh\(\);/.test(
        realtimeUi,
      ),
      'scheduleNeighbourhoodRepaint пересчитывает холст, «Структуры» и «Хронику»',
    );
    assert.ok(
      /case 'property-value\.set':[\s\S]{0,200}?scheduleNeighbourhoodRepaint\(\);/.test(realtimeUi),
      'realtime-ветка значения свойства зовёт общий пересчёт окрестности',
    );
  });

  it('запись значения свойства-связи зовёт пересчёт под гейтом видимости', () => {
    const properties = read('editor/properties.ts');

    // Импорт общего набора и гейта из realtime-ui (локальный путь — тот же
    // набор, что у чужого realtime-события).
    assert.ok(
      /import \{ inFocusNeighbourhood, scheduleNeighbourhoodRepaint \} from '\.\.\/realtime-ui\.js';/.test(
        properties,
      ),
      'редактор свойств берёт набор и гейт из realtime-ui',
    );
    // Сам помощник: пересчёт только для видимого владельца.
    assert.ok(
      /function repaintAfterLinkValueWrite\(ownerType: 'thought' \| 'link', ownerId: string\): void \{\s*if \(inFocusNeighbourhood\(ownerType, ownerId\)\) scheduleNeighbourhoodRepaint\(\);/.test(
        properties,
      ),
      'пересчёт окрестности выполняется только для владельца, видимого на карте',
    );
    // Типовое свойство-связь («Родители»/«Потомки» и типизированные): вызов
    // стоит после успешной записи и только для вида «связь».
    assert.ok(
      /await etn\.properties\.(set|remove)\([\s\S]{0,600}?if \(definition\.value_type === 'link'\) \{\s*repaintAfterLinkValueWrite\(ownerType, ownerId\);\s*\}/.test(
        properties,
      ),
      'типовое свойство-связь пересчитывает окрестность после записи',
    );
    // Внетиповое свойство-связь: и запись значения, и очистка «×».
    const outsideCalls = properties.match(/repaintAfterLinkValueWrite\(ownerType, ownerId\);/g) ?? [];
    assert.ok(
      outsideCalls.length >= 3,
      'все три локальных производителя (типовое, внетиповое, очистка внетипового) пересчитывают окрестность',
    );
  });
});
