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
 *      `render()`).
 *
 * Тест монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим: холст с одним родителем в
 * верхней зоне (одно облачко на проход) и управляемой высотой облачка.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, before, describe, it } from 'node:test';

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

/** Сколько раз код прочитал `offsetHeight` (одно чтение = одно облачко за проход). */
let heightReads = 0;
/**
 * Поведение высоты облачка:
 *  - `stable` — всегда 20 px (расклад сходится за один проход);
 *  - `oscillate` — 137/111 px по очереди на КАЖДОЕ чтение: высота строки
 *    меняется в каждом проходе, расклад не сходится (живой сценарий ошибки
 *    dc723634);
 *  - `stack-overflow` — бросает `RangeError`, как переполнение стека;
 *  - `boom` — бросает обычную ошибку (проверка лимита повторов).
 */
let heightMode: 'stable' | 'oscillate' | 'stack-overflow' | 'boom' = 'stable';

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
    const expected = { dir: 'parents', passes: canvas.ZONE_MEASURE_PASS_LIMIT };
    for (const mark of marks) {
      assert.deepEqual(mark.data, expected, 'метка называет зону и число проходов');
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
});
