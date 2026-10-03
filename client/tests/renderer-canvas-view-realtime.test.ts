/**
 * Регресс-тест ошибки 4fca95c9 «Карта мыслей не всегда обновляется после внешних
 * изменений».
 *
 * Сценарий пользователя: на карте в фокусе мысль-версия, у её типа есть отбор по
 * умолчанию («Актуальные работы»), поэтому нижняя зона холста — результат
 * `thought-type-views.run`, а не «Потомки». Агент в другой сессии создаёт работу,
 * привязывая её к версии свойством-связью «запланировано в версию»
 * (`config.show_on_map=false`). Ребро отфильтровано из окрестности фокуса, ответ
 * `focus()` не меняется, ключ перерисовки холста (`canvasRenderKey`) не меняется,
 * `render()` не запускается — и отбор не переисполняется, пока пользователь вручную
 * не переключит отбор/фокус.
 *
 * Тест монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим, держит `focus()` неизменным
 * (окрестность статична — как в жизни с отфильтрованной связью) и проверяет, что
 * внешнее `thought.created`/`link.created` перерисовывает нижнюю зону: отбор
 * переисполнен, счётчик рендеров вырос, новая строка появилась в зоне.
 *
 * Без фикса `requestCanvasRepaint`/`invalidateViewResultForRealtime` тест краснеет:
 * ни одного нового `render()`, `run()` не вызван, строка отсутствует.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type { FocusResponse, Thought } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');
type RealtimeEffectsModule = typeof import('../src/renderer/realtime-effects.js');
type EventRouterModule = typeof import('../src/renderer/lib/live/event-router.js');

let canvas: CanvasModule;
let realtimeEffects: RealtimeEffectsModule;
let eventRouter: EventRouterModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';
const WORK_ID = '00000000-0000-4000-8000-000000000200';

/** Последний смонтированный хост — `document.querySelector('.canvas-host')`. */
let currentHost: ShimElement | null = null;

/** Строки результата активного отбора — тест подменяет их «из другой сессии». */
let viewRows: Array<Record<string, unknown>> = [];
/** Сколько раз исполнялся отбор (счётчик `thought-type-views.run`). */
let viewRunCount = 0;

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
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

/** Окрестность фокуса НЕ меняется: связь работы с версией отфильтрована. */
function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Версия 0.10.3'),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

function metaViewRow(id: string, name: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    name,
    name_key: id,
    description: null,
    defined_on: TYPE_ID,
    inherited: false,
    is_default: isDefault,
  };
}

/** Определение активного отбора — тест подменяет его (в т.ч. на keywords). */
let viewDefinition = JSON.stringify({ criteria: [] });

function fullView(id: string, name: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    thought_type_id: TYPE_ID,
    name,
    name_key: id,
    description: null,
    definition: viewDefinition,
    position: 0,
    is_default: isDefault,
    version: 1,
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
  };
}

/** Realtime-событие от чужого клиента (собственное эхо отсекает G8-applier). */
function foreignEvent(type: string, data: unknown): Record<string, unknown> {
  return {
    type,
    seq: 1,
    ts: '2026-09-30T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    audience: 'network',
    network_id: NETWORK_ID,
    layer_id: 'base',
    data,
    meta: { version: 1 },
  };
}

// ---------------------------------------------------------------------------
// Fake `etn` + DOM/global harness
// ---------------------------------------------------------------------------

function installFakeApi(): unknown {
  return {
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    thoughts: {
      // Ответ фокуса НЕ меняется — окрестность статична (связь отфильтрована).
      focus: async () => focusResponse(),
      get: async () => ({
        meta: { views: [metaViewRow('v1', 'Актуальные работы', true)] },
      }),
      resolve: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
    },
    thoughtTypeViews: {
      list: async () => ({
        data: [fullView('v1', 'Актуальные работы', true)],
        meta: { effective: [] },
      }),
      run: async () => {
        viewRunCount++;
        return {
          data: viewRows.map((r) => ({ ...r })),
          meta: {
            total: viewRows.length,
            limit: 50,
            offset: 0,
            directions: {},
            view: { id: 'v1', name: 'Актуальные работы', type_id: TYPE_ID },
            unresolved: [],
          },
        };
      },
    },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { edges: async () => [] },
  };
}

function installEtn(): void {
  const api = installFakeApi();
  (globalThis as any).etn = api;
  const w = (globalThis as any).window as { etn?: unknown } | undefined;
  if (w !== undefined) w.etn = api;
}

function installGlobals(): void {
  // DOM-шим не задаёт `offsetHeight` — без него `Math.max(estimate, undefined)`
  // даёт NaN, и виртуализация нижней зоны уходит в бесконечную рекурсию
  // (`renderZoneContent` перезамеряет высоты). Прототипный геттер покрывает и
  // облачка, создаваемые уже во время отрисовки.
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
    get: () => 20,
    configurable: true,
  });
  // `findZoneCloud` использует `CSS.escape` — в среде теста его нет.
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
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    requestAnimationFrame: raf,
    setTimeout: (cb: (...a: unknown[]) => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
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

/**
 * DOM-шим не знает геометрии: у зон `clientWidth`/`clientHeight` нулевые
 * (clientWidth вообще `undefined`), и виртуализация нижней зоны получает NaN.
 * Проставляем числа всему смонтированному поддереву — иначе непустая зона
 * отбора падает `RangeError: Invalid array length`.
 */
function sizeDom(el: ShimElement): void {
  const sized = el as unknown as { clientWidth: number; clientHeight: number; scrollHeight: number };
  sized.clientWidth = 800;
  sized.clientHeight = 600;
  sized.scrollHeight = 2000;
  for (const child of el.children) sizeDom(child);
}

function renderCount(): number {
  return canvas.canvasInternals.renderCount();
}

/** Монтирует холст, ставит фокус на версию и ждёт, пока отбор исполнится. */
async function mountWithView(): Promise<() => void> {
  const host = makeHost();
  const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
  sizeDom(host);
  store.update({ networkId: NETWORK_ID, focus: focusResponse() });
  await settle();
  return dispose;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
  realtimeEffects = await import('../src/renderer/realtime-effects.js');
  eventRouter = await import('../src/renderer/lib/live/event-router.js');
});

beforeEach(async () => {
  installEtn();
  // Дедуп роутера по seq — состояние процесса: сбрасываем между тестами,
  // иначе второе событие с тем же seq будет отброшено как опоздавшее.
  eventRouter.resetEventRouter();
  viewRows = [{ id: 'existing', title: 'Старая работа', type_id: TYPE_ID, active: true, marked_for_deletion: false }];
  viewDefinition = JSON.stringify({ criteria: [] });
  viewRunCount = 0;
  store.update({ networkId: NETWORK_ID, focus: null, canvasZoom: 1, cloudWidth: 180 });
  // Сброс удержанного полосой фокуса: `dispose()` не зовёт `renderStrip(null)`,
  // и следующий тест с тем же FOCUS_ID считался бы «фокус не менялся» — кэш
  // определения отбора (в т.ч. признак `keywords`) не перечитывался бы.
  const strip = await import('../src/renderer/canvas/focus-filter-strip.js');
  await strip.renderStrip(null);
});

describe('realtime-обновление нижней зоны в режиме отбора (ошибка 4fca95c9)', () => {
  it('внешнее thought.created работы, видимой только строкой отбора, перерисовывает холст', async () => {
    const dispose = await mountWithView();
    // Базово отбор исполнен хотя бы раз при отрисовке фокуса.
    assert.ok(viewRunCount >= 1, 'отбор по умолчанию должен исполниться при отрисовке');
    const beforeRun = viewRunCount;
    const beforeRender = renderCount();

    // Другая сессия создала работу: она попадает в результат отбора...
    viewRows.push({ id: WORK_ID, title: 'Новая задача', type_id: TYPE_ID, active: true, marked_for_deletion: false });
    // ...окрестность фокуса при этом не меняется (ребро отфильтровано).
    // G2: реальный конвейер — роутер слоя гасит `focus`-ключи, подписка холста
    // на инвалидации перерисовывает нижнюю зону (ошибка 4fca95c9); мост производных
    // эффектов `applyDerivedRealtime` идёт следом (realtime.ts).
    const evt = foreignEvent('thought.created', { thought: thought(WORK_ID, 'Новая задача') }) as any;
    eventRouter.routeRealtimeEvent(evt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(evt);
    await settle();

    assert.ok(
      viewRunCount > beforeRun,
      `внешнее thought.created обязано переисполнить отбор; вызовов было ${viewRunCount - beforeRun}`,
    );
    assert.ok(
      renderCount() > beforeRender,
      `внешнее thought.created обязано перерисовать холст; рендеров было ${renderCount() - beforeRender}`,
    );
    assert.ok(
      canvas.getZoneEntries('children').some((e) => e.id === WORK_ID),
      'новая строка отбора обязана появиться в нижней зоне без смены отбора/фокуса',
    );
    dispose();
  });

  it('внешнее link.created (ребро скрытого на карте типа) тоже перерисовывает нижнюю зону', async () => {
    const dispose = await mountWithView();
    const beforeRun = viewRunCount;
    const beforeRender = renderCount();

    viewRows.push({ id: WORK_ID, title: 'Новая задача', type_id: TYPE_ID, active: true, marked_for_deletion: false });
    // Ребро работы→версия: тип связи `show_on_map=false`, поэтому focus() не меняется.
    const evt = foreignEvent('link.created', {
      link: { id: 'l-work', source_id: WORK_ID, target_id: FOCUS_ID, type_id: null, active: true, version: 1 },
    }) as any;
    eventRouter.routeRealtimeEvent(evt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(evt);
    await settle();

    assert.ok(viewRunCount > beforeRun, 'link.created обязан переисполнить активный отбор');
    assert.ok(renderCount() > beforeRender, 'link.created обязан перерисовать холст в режиме отбора');
    assert.ok(
      canvas.getZoneEntries('children').some((e) => e.id === WORK_ID),
      'новая строка отбора появилась после внешнего link.created',
    );
    dispose();
  });

  it('вход в отбор и видимая строка переисполняют отбор; невидимая правка без полей-признаков — нет', async () => {
    const dispose = await mountWithView();
    assert.ok(viewRunCount >= 1, 'отбор по умолчанию исполнился');

    // 1) Мысль ВНЕ окрестности и ВНЕ результата отбора, правка без полей,
    //    влияющих на состав отбора (заголовок, но отбор не использует keywords):
    //    views.run НЕ переисполняется.
    const invisibleId = '00000000-0000-4000-8000-000000000999';
    const beforeRun = viewRunCount;
    const invisibleEvt = {
      ...foreignEvent('thought.updated', {
        id: invisibleId,
        changes: { title: 'Невидимая правка' },
        version: 2,
      }),
      seq: 2,
    } as any;
    eventRouter.routeRealtimeEvent(invisibleEvt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(invisibleEvt);
    await settle();
    assert.equal(viewRunCount, beforeRun, 'правка без полей-признаков отбор не переисполняет');

    // 2) «Вход» в отбор (блокер G3): смена типа/актуальности у НЕвидимой мысли
    //    может ввести её в отбор — views.run обязан переисполниться, даже если
    //    старое видимое множество не содержит записи.
    const afterInvisible = viewRunCount;
    const entryEvt = {
      ...foreignEvent('thought.updated', {
        id: invisibleId,
        changes: { type_id: TYPE_ID, active: true },
        version: 3,
      }),
      seq: 3,
    } as any;
    eventRouter.routeRealtimeEvent(entryEvt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(entryEvt);
    await settle();
    assert.ok(
      viewRunCount > afterInvisible,
      'смена типа/актуальности переисполняет отбор (мысль могла войти)',
    );

    // 3) Мысль, УЖЕ видимая строкой отбора: её строка могла измениться — отбор
    //    обязан переисполниться (направление «выход»/обновление строки).
    const visibleId = 'existing';
    const beforeVisible = viewRunCount;
    const visibleEvt = {
      ...foreignEvent('thought.updated', {
        id: visibleId,
        changes: { title: 'Видимая правка' },
        version: 2,
      }),
      seq: 4,
    } as any;
    eventRouter.routeRealtimeEvent(visibleEvt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(visibleEvt);
    await settle();
    assert.ok(viewRunCount > beforeVisible, 'правка видимой строки отбора переисполняет отбор');
    dispose();
  });

  it('keywords-положительный: заголовок невидимой мысли при keywords-отборе переисполняет отбор, оформление — нет', async () => {
    // Активный отбор использует критерий `keywords` — заголовок/синонимы
    // входят в состав отбора. Мысль ВНЕ видимого результата: её новое имя
    // может ВВЕСТИ её в отбор (симметрично «входу» при смене типа).
    viewDefinition = JSON.stringify({ criteria: [], keywords: 'работа' });
    const dispose = await mountWithView();
    assert.ok(viewRunCount >= 1, 'keywords-отбор исполнился при отрисовке');
    const strip = await import('../src/renderer/canvas/focus-filter-strip.js');
    // Переисполняем активный отбор — полоса читает определение и запоминает
    // признак `keywords` (как при показе результата в UI).
    await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.equal(strip.activeViewUsesKeywords(), true, 'keywords-отбор распознан полосой');
    const invisibleId = '00000000-0000-4000-8000-000000000998';

    const beforeTitle = viewRunCount;
    const titleEvt = {
      ...foreignEvent('thought.updated', {
        id: invisibleId,
        changes: { title: 'Работа новая' },
        version: 2,
      }),
      seq: 10,
    } as any;
    eventRouter.routeRealtimeEvent(titleEvt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(titleEvt);
    await settle();
    assert.ok(
      viewRunCount > beforeTitle,
      'правка заголовка при keywords-отборе переисполняет отбор',
    );

    const afterTitle = viewRunCount;
    const decoEvt = {
      ...foreignEvent('thought.updated', {
        id: invisibleId,
        changes: { bg_color: '#ffffff' },
        version: 3,
      }),
      seq: 11,
    } as any;
    eventRouter.routeRealtimeEvent(decoEvt, { networkId: NETWORK_ID });
    realtimeEffects.applyDerivedRealtime(decoEvt);
    await settle();
    assert.equal(afterTitle, viewRunCount, 'оформление keywords-отбор не переисполняет');
    dispose();
  });
});
