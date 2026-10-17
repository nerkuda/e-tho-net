/**
 * Regression test for bug 63967c21 («Ctrl+±/0 меняют масштаб холста из видов,
 * где холст скрыт»).
 *
 * The global canvas-zoom bindings (`canvas.zoomIn`/`canvas.zoomOut`/
 * `canvas.zoomReset`, `app.ts:globalKeyBindings`) used to be gated by
 * `screen === 'workspace'` only, so the shortcuts changed — and persisted — the
 * map zoom while the canvas was invisible: in the «Структуры»/«Дневник»/
 * «События»/«Публикации» views (`screens/workspace.ts` hides `canvasHost` for
 * every non-map view) and under the two opaque full-cover overlays
 * (`.workspace-placeholder` for an inaccessible tab, `.workspace-picker` for the
 * network picker). Same class as bug 00275531: a global command acting on
 * another view's state.
 *
 * Contract under test: the zoom bindings fire only while the canvas is really
 * visible — `screen === 'workspace'` AND `activeView === 'map'` AND no overlay
 * covers it. The test drives the REAL bindings through the REAL dispatcher
 * (`lib/keymap.ts`, ADR b420b08c), so dropping the guard turns it red.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal `document`/`window` shims. Must run BEFORE the first dynamic import:
 * `lib/etn.ts` captures the `window` object at import time.
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
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

/** Минимальное событие клавиатуры (форма — как в `keymap.test.ts`). */
interface FakeKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: null;
  preventDefault(): void;
}

function keyEvent(init: Partial<FakeKeyEvent>): KeyboardEvent {
  const event: FakeKeyEvent = {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    target: null,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event as unknown as KeyboardEvent;
}

/** Сочетания масштаба холста ровно в том виде, в каком их нажимает клавиатура. */
const ZOOM_CHORDS: Array<{ name: string; event: KeyboardEvent }> = [
  { name: 'Ctrl+=', event: keyEvent({ key: '=', code: 'Equal', ctrlKey: true }) },
  { name: 'Ctrl+-', event: keyEvent({ key: '-', code: 'Minus', ctrlKey: true }) },
  { name: 'Ctrl+0', event: keyEvent({ key: '0', code: 'Digit0', ctrlKey: true }) },
];

/** Регистрирует глобальный контекст приложения (как `initKeyboard`) и отдаёт
 *  реальный диспетчер — команды проверяются через него, а не вызовом `run`. */
async function installAppKeymap() {
  const { keymapInternals, defineKeyContext, dispatchKeyEvent, GLOBAL_CONTEXT_ID } = await import(
    '../src/renderer/lib/keymap.js'
  );
  keymapInternals.reset();
  const { appInternals } = await import('../src/renderer/app.js');
  defineKeyContext({ id: GLOBAL_CONTEXT_ID, bindings: appInternals.globalKeyBindings() });
  const { store } = await import('../src/renderer/state.js');
  return { appInternals, store, dispatch: dispatchKeyEvent };
}

/** Базовое состояние: рабочий стол, карта, масштаб 100 %, перекрытий нет. */
function baseState(): Record<string, unknown> {
  return {
    screen: 'workspace',
    activeView: 'map',
    canvasZoom: 1,
    networkId: null,
    pickerOpen: false,
    activeTabId: null,
    inaccessibleTabIds: new Set<string>(),
  };
}

describe('масштаб холста срабатывает только при видимом холсте (bug 63967c21)', () => {
  beforeEach(async () => {
    shimDom();
    await installAppKeymap();
  });

  it('canvasVisible: холст виден только на «Карте» рабочего стола без перекрытий', async () => {
    const { appInternals, store } = await installAppKeymap();
    for (const view of ['structures', 'chronicle', 'activity', 'publications'] as const) {
      store.update({ ...baseState(), activeView: view } as any);
      assert.equal(appInternals.canvasVisible(), false, `вид ${view}: холст скрыт`);
    }

    store.update({ ...baseState(), screen: 'networks' } as any);
    assert.equal(appInternals.canvasVisible(), false, 'экран списка сетей: холст скрыт');

    store.update({ ...baseState(), pickerOpen: true } as any);
    assert.equal(appInternals.canvasVisible(), false, 'панель выбора сети накрывает холст');

    store.update({ ...baseState(), activeTabId: 't1', inaccessibleTabIds: new Set(['t1']) } as any);
    assert.equal(appInternals.canvasVisible(), false, 'заглушка «Нет доступа к сети» накрывает холст');

    store.update(baseState() as any);
    assert.equal(appInternals.canvasVisible(), true, 'карта без перекрытий: холст виден');
  });

  it('на других видах и под перекрытиями Ctrl+±/0 не меняют масштаб карты', async () => {
    const { store, dispatch } = await installAppKeymap();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['«Структуры»', { activeView: 'structures' }],
      ['«Дневник»', { activeView: 'chronicle' }],
      ['«События»', { activeView: 'activity' }],
      ['«Публикации»', { activeView: 'publications' }],
      ['список сетей', { screen: 'networks' }],
      ['панель выбора сети', { pickerOpen: true }],
      ['заглушка «Нет доступа»', { activeTabId: 't1', inaccessibleTabIds: new Set(['t1']) }],
    ];

    for (const [name, patch] of cases) {
      for (const { name: chord, event } of ZOOM_CHORDS) {
        store.update({ ...baseState(), ...patch } as any);
        assert.equal(dispatch(event), false, `${name}: ${chord} не перехватывается`);
        assert.equal(store.state.canvasZoom, 1, `${name}: ${chord} не меняет масштаб`);
      }
    }
  });

  it('на видимой карте Ctrl+= масштабирует, Ctrl+0 сбрасывает', async () => {
    const { store, dispatch } = await installAppKeymap();

    store.update(baseState() as any);
    assert.equal(dispatch(keyEvent({ key: '=', code: 'Equal', ctrlKey: true })), true);
    assert.ok(store.state.canvasZoom > 1, `масштаб вырос: ${store.state.canvasZoom}`);

    assert.equal(dispatch(keyEvent({ key: '0', code: 'Digit0', ctrlKey: true })), true);
    assert.equal(store.state.canvasZoom, 1, 'Ctrl+0 сбрасывает масштаб');

    store.update({ ...baseState(), canvasZoom: 1 } as any);
    assert.equal(dispatch(keyEvent({ key: '-', code: 'Minus', ctrlKey: true })), true);
    assert.ok(store.state.canvasZoom < 1, `масштаб уменьшился: ${store.state.canvasZoom}`);
  });
});
