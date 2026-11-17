/**
 * Регресс-тест ошибки dc723634 — «Фриз рендерера ~15 с при двойном клике по
 * облачку»: осцилляция высот строк зоны.
 *
 * Механика дефекта. `renderZoneContent` измеряет высоты видимых строк и
 * перезапускал СЕБЯ, пока они меняются (комментарий «heights are
 * deterministic — the re-run converges immediately»). В сети пользователя
 * высоты не сходились: измеренная высота меняет высоту `.zone-spacer`, с ней —
 * полосу прокрутки и content-box зоны, от которых зависят число колонок, окно
 * виртуализации и состав/высоты тех же строк. Самовызов уходил в
 * `RangeError: Maximum call stack size exceeded`, внешний catch повторял
 * пересборку целиком — и всё начиналось заново: многосекундный фриз.
 *
 * Гейт держит инварианты фикса:
 *   1. осциллирующие высоты (`offsetHeight` возвращает 137/111 по очереди на
 *      каждое чтение) НЕ дают переполнения стека: проходы итеративные и
 *      ограничены `ZONE_MEASURE_PASS_LIMIT`, последний построенный расклад
 *      остаётся в DOM;
 *   2. постработка прохода выполняется ОДИН раз и при любом исходе: при
 *      исчерпании лимита набор видимых мыслей зоны (подписка индикаторов)
 *      всё равно актуализируется — новые облачка подписываются, ушедшие id
 *      не залипают (замечание проверки 5c5e7b39);
 *   3. исчерпание лимита оставляет след в ФАЙЛОВОМ журнале меткой
 *      `ui.zone_measure_exhausted {dir, passes}` — `console.warn` туда не
 *      попадает, поэтому консольной строки недостаточно;
 *   4. «повтор целиком» ограничен: детерминированный `RangeError` не
 *      повторяется вовсе (повтор умножил бы фриз), а прочий сбой пересборки —
 *      не больше `REBUILD_RETRY_LIMIT` раз (`REBUILD_RETRY_LIMIT + 1` вход в
 *      `render()`);
 *   5. геометрия зоны не зависит от собственных измерений: `.zone` резервирует
 *      жёлоб полосы прокрутки (`scrollbar-gutter: stable`), а зонный
 *      `ResizeObserver` наблюдает `border-box` — переключение полосы от высоты
 *      `.zone-spacer` не меняет content-box, число колонок и окно;
 *   6. пограничная строка (высота облачка зависит от ширины зоны, ширина — от
 *      высоты содержимого) НЕ перезапускает серию раскладки из кадра в кадр:
 *      за 20 асинхронных тиков число серий и входов в `render()` остаётся
 *      единицами, а проходы измерения не пересобирают облачка (DOM строится
 *      один раз на состав окна) — иначе это и есть мерцание дефекта dc723634.
 *
 * Тест монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим: холст с одним родителем в
 * верхней зоне (одно облачко на проход) и управляемой высотой облачка.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { FocusNeighbor, FocusResponse, Thought } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');

let canvas: CanvasModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';
const PARENT_ID = '00000000-0000-4000-8000-000000000200';
const FOCUS_B_ID = '00000000-0000-4000-8000-000000000101';
const PARENT_B_ID = '00000000-0000-4000-8000-000000000201';

let currentHost: ShimElement | null = null;

/** Метки, доставленные мостом файлового журнала `window.etn.logEvent`. */
const logged: Array<{ name: string; data?: Record<string, unknown> }> = [];

// --- Модель контура «высоты → spacer → полоса → content-box → колонки» ------

/** Ширина классической вертикальной полосы прокрутки (Chromium на Windows). */
const SCROLLBAR_PX = 15;
/** Content-box зоны, когда полоса прокрутки места не занимает. */
const ZONE_BASE_WIDTH = 800;
/** Видимая высота зоны (content-box) в модели. */
const ZONE_HEIGHT = 380;
/** Отступ `.zone` (совпадает с ZONE_PADDING_PX в canvas.ts). */
const ZONE_PADDING = 12;
/** Порог «широкая зона»: 800 px без полосы против 785 px с полосой. */
const WIDE_ZONE_MIN = ZONE_BASE_WIDTH - SCROLLBAR_PX + 1;
/** Высота облачка пограничной строки: в широкой зоне (4 колонки) и в узкой (3). */
const BOUNDARY_TALL = 200;
const BOUNDARY_SHORT = 100;
/** Сколько родителей в сценарии пограничной строки (4 колонки → 2 ряда). */
const BOUNDARY_PARENTS = 7;
/** Ширина content-box последнего чтения `clientWidth` зоны (для высоты облачка). */
let zoneWidthNow = 0;

/** Сколько раз код прочитал `offsetHeight` (одно чтение = одно облачко за проход). */
let heightReads = 0;
/**
 * Поведение высоты облачка:
 *  - `stable` — всегда 20 px (расклад сходится за один проход);
 *  - `oscillate` — 137/111 px по очереди на КАЖДОЕ чтение: высота строки
 *    меняется в каждом проходе, расклад не сходится (живой сценарий ошибки
 *    dc723634);
 *  - `boundary` — высота зависит от ширины зоны (200 px в широкой, 100 px в
 *    узкой): пограничная строка, у которой высота и ширина зоны зависят друг от
 *    друга (триггер пользователя: «добавил мысль рядом — проблема исчезла»);
 *  - `stack-overflow` — бросает `RangeError`, как переполнение стека;
 *  - `boom` — бросает обычную ошибку (проверка лимита повторов).
 */
let heightMode: 'stable' | 'oscillate' | 'boundary' | 'stack-overflow' | 'boom' = 'stable';

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
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function neighbor(id: string, linkId: string, title = id): FocusNeighbor {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    active: true,
    link_id: linkId,
    link_type_id: null,
    link_active: true,
    link_marked_for_deletion: false,
    has_incoming: false,
    has_outgoing: false,
    manual_position: null,
  };
}

/** Ровно один родитель: одно облачко в зоне — одно чтение высоты за проход. */
function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Фокус'),
    parents: [neighbor(PARENT_ID, 'link-parent', 'Родитель')],
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

// ---------------------------------------------------------------------------
// Fake `etn` + DOM/global harness (как в renderer-canvas-view-loading.test.ts)
// ---------------------------------------------------------------------------

function installFakeApi(): unknown {
  return {
    // Мост файлового журнала клиента: ровно то, чем пишутся метки `ui.*`.
    logEvent: (name: string, data?: Record<string, unknown>): void => {
      logged.push({ name, data });
    },
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    thoughts: {
      focus: async () => focusResponse(),
      get: async () => ({ meta: { views: [] } }),
      resolve: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
    },
    thoughtTypeViews: {
      list: async () => ({ data: [], meta: { effective: [] } }),
      run: async () => ({
        data: [],
        meta: { total: 0, limit: 100, offset: 0, directions: {}, unresolved: [] },
      }),
    },
    thoughtCustomViews: { list: async () => ({ data: [], meta: { effective: [] } }) },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { edges: async () => [] },
    cancelRequest: () => undefined,
  };
}

function installEtn(): void {
  const api = installFakeApi();
  (globalThis as any).etn = api;
  const w = (globalThis as any).window as { etn?: unknown } | undefined;
  if (w !== undefined) w.etn = api;
}

function installGlobals(): void {
  // Управляемая высота облачка: ровно один потребитель — виртуализация зоны
  // (canvas.ts, измерение высот строк).
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
    get: () => {
      heightReads += 1;
      if (heightMode === 'stack-overflow') throw new RangeError('Maximum call stack size exceeded');
      if (heightMode === 'boom') throw new Error('boom');
      // Пограничная строка: высота облачка зависит от ширины зоны — и это
      // замыкает контур на собственные измерения (ошибка dc723634).
      if (heightMode === 'boundary') {
        return zoneWidthNow >= WIDE_ZONE_MIN ? BOUNDARY_TALL : BOUNDARY_SHORT;
      }
      // Значения заведомо не совпадают ни с оценкой невидимой строки, ни друг
      // с другом: каждый проход видит «новую» высоту — расклад не сходится.
      return heightMode === 'oscillate' ? (heightReads % 2 === 1 ? 137 : 111) : 20;
    },
    configurable: true,
  });
  (globalThis as any).CSS = { escape: (value: string) => value };
  const documentElement = new ShimElement('html');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement,
    body: new ShimElement('body'),
    querySelector: (sel: string) => (sel === '.canvas-host' ? currentHost : null),
    querySelectorAll: () => [] as ShimElement[],
    elementFromPoint: () => null,
  };
  const raf = (cb: (t: number) => void): ReturnType<typeof setTimeout> =>
    setTimeout(() => cb(Date.now()), 0);
  (globalThis as any).requestAnimationFrame = raf;
  (globalThis as any).getComputedStyle = (elx: { style: unknown }) => elx.style;
  (globalThis as any).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: (elx: { style: unknown }) => elx.style,
    matchMedia: () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    requestAnimationFrame: raf,
    setTimeout: (cb: (...a: unknown[]) => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    etn: (globalThis as any).etn,
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Управляемый ResizeObserver и модель коробки зоны
// ---------------------------------------------------------------------------

/** Одно наблюдение фейкового `ResizeObserver`. */
interface ObservedTarget {
  el: ShimElement;
  box: 'content-box' | 'border-box';
  /** Последняя доставленная коробка: уведомление — только при её смене. */
  last: { width: number; height: number } | null;
}

interface ObservationRecord {
  callback: ResizeObserverCallback;
  targets: ObservedTarget[];
}

/** Все наблюдения фейкового `ResizeObserver` в текущем тесте. */
const observations: ObservationRecord[] = [];

/**
 * Модель измеряемой коробки: `null` — брать числа шима. Зона в сценарии
 * осцилляции моделируется функцией из {@link modelBoundaryZone}.
 */
let modelledBox:
  | ((
      el: ShimElement,
      box: 'content-box' | 'border-box',
    ) => { width: number; height: number } | null)
  | null = null;

/**
 * Подменяет глобальный `ResizeObserver` управляемым. Заглушка из
 * `installGlobals` не уведомляет никогда, а гейту нужно ровно поведение
 * браузера: уведомление ПОСЛЕ раскладки и только при смене наблюдаемой коробки.
 */
function installRecordingResizeObserver(): () => void {
  const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  observations.length = 0;
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly record: ObservationRecord;
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [] };
      observations.push(this.record);
    }
    observe(el: Element, options?: { box?: 'content-box' | 'border-box' }): void {
      this.record.targets.push({
        el: el as unknown as ShimElement,
        box: options?.box ?? 'content-box',
        last: null,
      });
    }
    unobserve(el: Element): void {
      this.record.targets = this.record.targets.filter(
        (target) => (target.el as unknown as Element) !== el,
      );
    }
    disconnect(): void {
      this.record.targets = [];
    }
  };
  return () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous;
    observations.length = 0;
    modelledBox = null;
  };
}

/**
 * Доставляет наблюдателям уведомления о смене коробки — как браузер после
 * раскладки. Первое наблюдение уведомляет всегда (RO доставляет начальный
 * размер), дальше — только при изменении.
 */
function flushResizeObservers(): void {
  for (const record of observations) {
    const entries: ResizeObserverEntry[] = [];
    for (const target of record.targets) {
      const sized = target.el as unknown as { clientWidth: number; clientHeight: number };
      const size = modelledBox?.(target.el, target.box) ?? {
        width: sized.clientWidth,
        height: sized.clientHeight,
      };
      if (
        target.last !== null &&
        target.last.width === size.width &&
        target.last.height === size.height
      ) {
        continue;
      }
      target.last = size;
      entries.push({
        target: target.el,
        contentRect: { width: size.width, height: size.height },
      } as unknown as ResizeObserverEntry);
    }
    if (entries.length > 0) {
      record.callback(entries, record as unknown as ResizeObserver);
    }
  }
}

/** `settle` с доставкой уведомлений `ResizeObserver` после каждого тика. */
async function settleWithObservers(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushResizeObservers();
  }
}

/**
 * Геометрия зоны сценария: content-box зависит от собственной полосы прокрутки
 * (если жёлоб не зарезервирован), `border-box` — нет. `clientWidth` зоны читает
 * раскладка (`zoneGridOf` → число колонок), поэтому именно эта зависимость и
 * замыкала контур «высоты ↔ полоса ↔ колонки ↔ окно» (ошибка dc723634).
 */
function modelBoundaryZone(zone: ShimElement, options: { gutterStable: boolean }): void {
  const contentWidth = (): number => {
    const spacer = zone.querySelector('.zone-spacer');
    const spacerHeight = Number.parseFloat(spacer?.style.height ?? '0') || 0;
    const hasScrollbar = spacerHeight > ZONE_HEIGHT;
    const reserved = options.gutterStable || hasScrollbar ? SCROLLBAR_PX : 0;
    zoneWidthNow = ZONE_BASE_WIDTH - reserved;
    return zoneWidthNow;
  };
  Object.defineProperty(zone, 'clientWidth', { configurable: true, get: contentWidth });
  Object.defineProperty(zone, 'clientHeight', { configurable: true, get: () => ZONE_HEIGHT });
  modelledBox = (el, box) => {
    if (el !== zone) return null;
    if (box === 'border-box') {
      // Жёлоб полосы «съедает» padding-box: рамка зоны от неё не меняется.
      return { width: ZONE_BASE_WIDTH + 2 * ZONE_PADDING, height: ZONE_HEIGHT };
    }
    return { width: contentWidth(), height: ZONE_HEIGHT };
  };
}

/** Тело правила `.zone { … }` из canvas.css (сторож геометрии полосы). */
function zoneRuleBody(): string {
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const css = fs.readFileSync(
    path.join(clientRoot, 'src', 'renderer', 'styles', 'canvas.css'),
    'utf8',
  );
  const match = /(?:^|\n)\s*\.zone\s*\{([^}]*)\}/.exec(css);
  assert.ok(match !== null, 'в canvas.css не найдено правило .zone');
  return match[1] ?? '';
}

/** Идентификатор `i`-го родителя сценария пограничной строки. */
function boundaryParentId(i: number): string {
  return `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
}

/** Окрестность из `count` родителей — «многострочная» зона. */
function focusResponseWithParents(count: number): FocusResponse {
  const response = focusResponse();
  response.parents = Array.from({ length: count }, (_, i) =>
    neighbor(boundaryParentId(i), `link-parent-${i}`, `Родитель ${i + 1}`),
  );
  return response;
}

function makeHost(): ShimElement {
  const host = new ShimElement('section', 'canvas-host');
  currentHost = host;
  return host;
}

/** Шим не знает геометрии: проставляем числа, иначе виртуализация падает. */
function sizeDom(el: ShimElement): void {
  const sized = el as unknown as {
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
  };
  sized.clientWidth = 800;
  sized.clientHeight = 600;
  sized.scrollHeight = 2000;
  for (const child of el.children) sizeDom(child);
}

/** Монтирует холст и ставит фокус с одним родителем. */
async function mountWithParent(): Promise<{ host: ShimElement; dispose: () => void }> {
  const host = makeHost();
  const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
  sizeDom(host);
  store.update({ networkId: NETWORK_ID, focus: focusResponse() });
  await settle();
  return { host, dispose };
}

/**
 * Монтирует холст со сценарием пограничной строки: `BOUNDARY_PARENTS` родителей
 * и геометрия зоны, зависящая от её собственной полосы прокрутки. Резервирует
 * ли жёлоб полосы настоящий `.zone` — читаем из canvas.css, как это сделал бы
 * браузер: снятый из CSS фикс обязан вернуть цикл.
 */
async function mountBoundaryZone(): Promise<{
  host: ShimElement;
  zone: ShimElement;
  dispose: () => void;
}> {
  const gutterStable = /scrollbar-gutter\s*:\s*stable/.test(zoneRuleBody());
  const host = makeHost();
  const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
  sizeDom(host);
  const zone = host.querySelector('.zone-parents');
  assert.ok(zone !== null, 'верхняя зона смонтирована');
  modelBoundaryZone(zone!, { gutterStable });
  store.update({ networkId: NETWORK_ID, focus: focusResponseWithParents(BOUNDARY_PARENTS) });
  await settleWithObservers();
  return { host, zone: zone!, dispose };
}

interface ConsoleCapture {
  warns: string[];
  errors: string[];
  restore: () => void;
}

/** Перехват диагностики холста: предупреждение о лимите и отказы пересборки. */
function captureConsole(): ConsoleCapture {
  const warns: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]): void => {
    warns.push(String(args[0]));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(String(args[0]));
  };
  return {
    warns,
    errors,
    restore: (): void => {
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
});

beforeEach(async () => {
  installEtn();
  heightMode = 'stable';
  heightReads = 0;
  logged.length = 0;
  store.update({ networkId: NETWORK_ID, focus: null, canvasZoom: 1, cloudWidth: 180 });
  // Сброс удержанного полосой фокуса между тестами: `dispose()` не зовёт
  // `renderStrip(null)`, и следующий фокус с тем же id считался бы прежним.
  const strip = await import('../src/renderer/canvas/focus-filter-strip.js');
  await strip.renderStrip(null);
});

describe('высоты строк зоны не уводят раскладку в бесконечный повтор (ошибка dc723634)', () => {
  it('осциллирующие высоты ограничены лимитом проходов и не дают RangeError', async () => {
    const { host, dispose } = await mountWithParent();
    await settle();

    const zone = host.querySelector('.zone-parents');
    assert.ok(zone !== null, 'верхняя зона смонтирована');
    assert.ok(zone!.querySelector('.cloud') !== null, 'облачко родителя построено');

    heightMode = 'oscillate';
    heightReads = 0;
    logged.length = 0;
    const rendersBefore = canvas.canvasInternals.renderCount();
    const capture = captureConsole();
    try {
      canvas.requestCanvasRepaint();
      await settle();
    } finally {
      capture.restore();
    }

    const reads = heightReads;
    const clouds = Math.max(1, zone!.querySelectorAll('.cloud').length);
    // Входов в render() могло быть больше одного (коалессинг триггеров), но
    // каждый вход обязан уложиться в лимит проходов по одному чтению на
    // облачко — иначе исправление не работает.
    const renders = Math.max(1, canvas.canvasInternals.renderCount() - rendersBefore);
    // Жёсткий предел проходов — часть требования к фиксу. Границу задаём
    // ЛИТЕРАЛОМ, а не константой модуля: иначе гейт «зеленел» бы при любом
    // лимите, включая заведомо бесконечный.
    const HARD_PASS_CAP = 5;
    assert.ok(
      canvas.ZONE_MEASURE_PASS_LIMIT <= HARD_PASS_CAP,
      `лимит проходов обязан остаться жёстким: ${canvas.ZONE_MEASURE_PASS_LIMIT} > ${HARD_PASS_CAP}`,
    );
    // Эпсилон — только для субпиксельного дрожания: пиксельный порог скрыл бы
    // настоящую смену высоты строки (раскладка разошлась бы с DOM).
    assert.ok(
      canvas.ZONE_MEASURE_EPSILON_PX <= 1,
      `порог высоты обязан остаться субпиксельным: ${canvas.ZONE_MEASURE_EPSILON_PX}`,
    );
    const limit = HARD_PASS_CAP * clouds * renders;
    assert.ok(
      reads <= limit,
      `осцилляция не должна превышать лимит проходов: чтений ${reads}, предел ${limit}`,
    );
    assert.ok(
      reads > clouds,
      `осцилляция обязана потребовать повторных проходов (чтений ${reads})`,
    );
    assert.equal(
      capture.errors.length,
      0,
      `пересборка не должна падать: ${capture.errors.join(' | ')}`,
    );
    assert.ok(
      logged.some((event) => event.name === 'ui.zone_measure_exhausted'),
      'исчерпание лимита проходов обязано попадать в файловый журнал меткой ui.zone_measure_exhausted',
    );
    // Последний построенный расклад остаётся на экране (не бросаем, не чистим).
    assert.ok(zone!.querySelector('.cloud') !== null, 'облачко последнего прохода осталось в DOM');

    heightMode = 'stable';
    dispose();
  });

  it('при исчерпании лимита набор индикаторов зоны всё равно актуализируется', async () => {
    const { dispose } = await mountWithParent();
    await settle();
    assert.deepEqual(
      canvas.canvasInternals.zoneVisibleIds('parents'),
      [PARENT_ID],
      'стабильный расклад подписал индикаторы на видимого родителя',
    );

    // Другая окрестность: у нового фокуса другой родитель. Расклад не сойдётся,
    // но набор «что сейчас на экране» обязан смениться — иначе индикаторы новых
    // облачков не подпишутся, а id прежних залипнут в наборе (замечание
    // проверки 5c5e7b39: постработка стояла после раннего «нужен ещё проход»).
    heightMode = 'oscillate';
    const next = focusResponse();
    next.focused = thought(FOCUS_B_ID, 'Другой фокус');
    next.parents = [neighbor(PARENT_B_ID, 'link-parent-b', 'Другой родитель')];
    store.update({ focus: next });
    await settle();

    assert.deepEqual(
      canvas.canvasInternals.zoneVisibleIds('parents'),
      [PARENT_B_ID],
      'при исчерпании лимита набор видимых мыслей зоны обязан быть актуальным',
    );
    assert.ok(
      !canvas.canvasInternals.zoneVisibleIds('parents').includes(PARENT_ID),
      'id прежней окрестности выпадают из набора индикаторов',
    );

    heightMode = 'stable';
    dispose();
  });

  it('исчерпание лимита оставляет след в файловом журнале меткой ui.zone_measure_exhausted', async () => {
    const { host, dispose } = await mountWithParent();
    await settle();
    assert.ok(host.querySelector('.zone-parents')?.querySelector('.cloud') !== null);

    heightMode = 'oscillate';
    logged.length = 0;
    canvas.requestCanvasRepaint();
    await settle();

    const marks = logged.filter((event) => event.name === 'ui.zone_measure_exhausted');
    assert.ok(
      marks.length >= 1,
      `исчерпание лимита обязано попасть в файловый журнал: ${JSON.stringify(logged)}`,
    );
    for (const mark of marks) {
      assert.equal(mark.data?.['dir'], 'parents', 'метка называет зону');
      // Осцилляция высот возвращает раскладку в уже виденное состояние, поэтому
      // серия обрывается повтором состояния, не дожидаясь лимита проходов.
      assert.equal(mark.data?.['reason'], 'cycle', 'причина — повтор состояния прохода');
      const passes = Number(mark.data?.['passes']);
      assert.ok(
        passes >= 2 && passes <= canvas.ZONE_MEASURE_PASS_LIMIT,
        `число проходов в пределах лимита: ${passes}`,
      );
    }

    heightMode = 'stable';
    dispose();
  });

  it('RangeError в пересборке не повторяется целиком (детерминированный сбой)', async () => {
    const { host, dispose } = await mountWithParent();
    await settle();
    const parents = host.querySelector('.zone-parents');
    assert.ok(parents?.querySelector('.cloud') !== null, 'облачко родителя построено');

    heightMode = 'stack-overflow';
    const rendersBefore = canvas.canvasInternals.renderCount();
    const capture = captureConsole();
    try {
      canvas.requestCanvasRepaint();
      await settle();
    } finally {
      capture.restore();
    }

    const renders = canvas.canvasInternals.renderCount() - rendersBefore;
    assert.equal(
      renders,
      1,
      `переполнение стека детерминировано — повтор целиком лишь повторит фриз (входов: ${renders})`,
    );
    assert.ok(
      capture.errors.some((line) => line.includes('пересборка расклада прервана')),
      'отказ пересборки обязан попадать в журнал',
    );

    heightMode = 'stable';
    dispose();
  });

  it('прочий сбой пересборки повторяется не больше REBUILD_RETRY_LIMIT раз', async () => {
    const { host, dispose } = await mountWithParent();
    await settle();
    const parents = host.querySelector('.zone-parents');
    assert.ok(parents?.querySelector('.cloud') !== null, 'облачко родителя построено');

    heightMode = 'boom';
    const rendersBefore = canvas.canvasInternals.renderCount();
    const capture = captureConsole();
    try {
      canvas.requestCanvasRepaint();
      await settle(40);
    } finally {
      capture.restore();
    }

    const renders = canvas.canvasInternals.renderCount() - rendersBefore;
    assert.equal(
      renders,
      canvas.REBUILD_RETRY_LIMIT + 1,
      `первая попытка + ${canvas.REBUILD_RETRY_LIMIT} повтора (входов: ${renders})`,
    );

    // Возвращаем рабочую высоту: успешный рендер обнуляет счётчик сбоев.
    heightMode = 'stable';
    canvas.requestCanvasRepaint();
    await settle();
    dispose();
  });

  it('проходы измерения высот не пересобирают облачка (DOM строится на состав окна)', async () => {
    const { dispose } = await mountWithParent();
    await settle();

    heightMode = 'oscillate';
    const buildsBefore = canvas.canvasInternals.zoneCloudBuilds();
    const readsBefore = heightReads;
    canvas.requestCanvasRepaint();
    await settle();

    assert.ok(
      heightReads - readsBefore > 1,
      `серия обязана сделать больше одного прохода (чтений ${heightReads - readsBefore})`,
    );
    // Облачка строятся ОДИН раз на серию (первый проход), а не в каждом проходе.
    const builds = canvas.canvasInternals.zoneCloudBuilds() - buildsBefore;
    const reads = heightReads - readsBefore;
    assert.ok(builds >= 1, `первый проход серии обязан построить облачко: ${builds}`);
    assert.ok(
      builds < reads,
      `измерение высот не пересобирает облачка: пересборок ${builds}, чтений высоты ${reads}`,
    );

    heightMode = 'stable';
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Осцилляция раскладки: пограничная строка (ошибка dc723634, мерцание)
// ---------------------------------------------------------------------------

describe('осцилляция раскладки зоны: устойчивая геометрия (ошибка dc723634)', () => {
  it('ширина зоны не зависит от её собственной полосы прокрутки', async () => {
    assert.match(
      zoneRuleBody(),
      /scrollbar-gutter\s*:\s*stable/,
      '.zone обязан резервировать жёлоб полосы прокрутки: иначе content-box (и число колонок) зависит от высоты .zone-spacer',
    );

    const restoreObserver = installRecordingResizeObserver();
    try {
      const { zone, dispose } = await mountBoundaryZone();
      const zoneRecord = observations.find((record) =>
        record.targets.some((target) => target.el === zone),
      );
      assert.ok(zoneRecord !== undefined, 'зонный ResizeObserver зарегистрирован');
      const target = zoneRecord!.targets.find((item) => item.el === zone)!;
      assert.equal(
        target.box,
        'border-box',
        'зонный ResizeObserver обязан наблюдать border-box: переключение полосы прокрутки меняет только content-box',
      );
      dispose();
    } finally {
      restoreObserver();
    }
  });

  it('пограничная строка не перезапускает раскладку кадр за кадром', async () => {
    const restoreObserver = installRecordingResizeObserver();
    try {
      const { zone, dispose } = await mountBoundaryZone();
      assert.equal(
        zone.querySelectorAll('.cloud').length,
        BOUNDARY_PARENTS,
        'окно зоны построено целиком',
      );

      // Триггер пользователя: новая мысль рядом с фокусной строкой и высота
      // пограничной строки, зависящая от ширины зоны (ширина — от высоты
      // содержимого). Без размыкания контура серия раскладки перезапускается
      // на каждом кадре и облачка пересобираются — это и есть мерцание.
      heightMode = 'boundary';
      logged.length = 0;
      const rendersBefore = canvas.canvasInternals.renderEnterCount();
      const runsBefore = canvas.canvasInternals.zoneLayoutRuns();
      const buildsBefore = canvas.canvasInternals.zoneCloudBuilds();

      canvas.requestCanvasRepaint();
      await settleWithObservers(20);

      const renders = canvas.canvasInternals.renderEnterCount() - rendersBefore;
      const runs = canvas.canvasInternals.zoneLayoutRuns() - runsBefore;
      const builds = canvas.canvasInternals.zoneCloudBuilds() - buildsBefore;

      assert.ok(
        renders <= 2,
        `входов в render() за 20 тиков должно остаться единицы, а не десятки: ${renders}`,
      );
      assert.ok(
        runs <= 6,
        `серий раскладки за 20 тиков должно остаться единицы, а не десятки: ${runs}`,
      );
      // Окно строится ОДИН раз на серию: 7 облачков, а не 7 на каждый проход.
      assert.ok(
        builds > 0 && builds <= BOUNDARY_PARENTS,
        `окно строится один раз на серию: построено ${builds} при ${BOUNDARY_PARENTS} мыслях`,
      );
      assert.equal(
        zone.querySelectorAll('.cloud').length,
        BOUNDARY_PARENTS,
        'состав окна не потерялся',
      );
      assert.ok(
        !logged.some((event) => event.name === 'ui.zone_measure_exhausted'),
        `расклад обязан сойтись, а не исчерпывать лимит: ${JSON.stringify(logged)}`,
      );
      // Сошлось на узкой геометрии: 3 колонки × 3 ряда по 100 px + промежутки.
      const spacer = zone.querySelector('.zone-spacer');
      assert.equal(
        spacer?.style.height,
        `${3 * (BOUNDARY_SHORT + 12)}px`,
        'высота spacer отражает измеренные высоты трёх рядов',
      );

      heightMode = 'stable';
      dispose();
    } finally {
      restoreObserver();
    }
  });
});
