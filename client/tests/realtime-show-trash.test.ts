/**
 * Realtime-путь настройки «Показывать содержимое корзины» (задача 77923b49,
 * 0.8.2): событие `user-preference.updated` с ключом `show_trash` от ДРУГОГО
 * клиента обязано дойти до store и перечитать карту — иначе второй клиент
 * пользователя продолжит показывать помеченных на удаление, пока не
 * перезапустится.
 *
 * Путь (G2): окрестность фокуса гасит роутер слоя (`focusAll`), активная
 * подписка перечитывает её; `store.update({ showTrash })` и легаси-обновление
 * «Структур» — рядом. Проверяется реальный конвейер `routeRealtimeEvent` +
 * `applyRealtimeToUi` под DOM-шимом: значение флага, перезапрос фокуса и игнор
 * чужих ключей/чужих сетей.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function shimDom(): void {
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

/** Окрестность фокуса — минимум, который разбирает `zoneStateFromFocus`. */
function makeFocusResponse(): unknown {
  const ref = (id: string): unknown => ({
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: false,
    font_italic: false,
    font_underline: false,
    font_strike: false,
  });
  return {
    focused: ref('t1'),
    parents: [ref('p1')],
    children: [ref('c1')],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Realtime-событие чужого клиента (собственное эхо отсекает G8-applier). */
function foreignEvent(
  type: string,
  networkId: string,
  data: unknown,
  seq = 1,
): Record<string, unknown> {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    audience: 'user',
    network_id: networkId,
    layer_id: 'base',
    data,
    meta: { version: 1 },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

/** REFRESH_DEBOUNCE_MS + запас (app.ts). */
const REFRESH_SLACK_MS = 320;

describe('realtime show_trash: настройка другого клиента доходит до карты (77923b49)', () => {
  it('user-preference.updated show_trash переключает store и перечитывает фокус; чужой ключ — нет', async () => {
    shimDom();
    let focusFetches = 0;
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined, getState: async () => null },
      types: { listThoughtTypes: async () => [], listLinkTypes: async () => [] },
      thoughts: {
        focus: async () => {
          focusFetches++;
          return makeFocusResponse();
        },
      },
    };
    const { store } = await import('../src/renderer/state.js');
    const { applyRealtimeToUi } = await import('../src/renderer/realtime-ui.js');
    const { activateFocusQuery, deactivateFocusQuery } =
      await import('../src/renderer/lib/layer-resync.js');
    const { resetQueryRegistry } = await import('../src/renderer/lib/live/query-registry.js');
    const { resetEventRouter, routeRealtimeEvent } =
      await import('../src/renderer/lib/live/event-router.js');

    resetQueryRegistry();
    resetEventRouter();
    store.update({
      networkId: 'n1',
      activeView: 'map',
      activeTabId: 'tab1',
      focus: makeFocusResponse() as any,
      showTrash: true,
    } as any);
    // Слой данных (G2): окрестность подписана — перезапрос запускает роутер.
    activateFocusQuery('n1', 't1');
    await wait(100);
    const baseline = focusFetches;

    /** Реальный конвейер: роутер слоя, затем легаси-применение. */
    const deliver = (evt: Record<string, unknown>): void => {
      routeRealtimeEvent(evt as any, { networkId: 'n1' });
      applyRealtimeToUi(evt as any);
    };

    // Чужая сеть — событие соседней вкладки общий store не трогает.
    deliver(foreignEvent('user-preference.updated', 'n2', { key: 'show_trash', value: false }, 1));
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true, 'событие чужой сети настройку не меняет');
    assert.equal(focusFetches, baseline, 'событие чужой сети фокус не перечитывает');

    // Чужой ключ в своей сети — не наша настройка (роутер не гасит focus).
    deliver(foreignEvent('user-preference.updated', 'n1', { key: 'cloud_width', value: 200 }, 2));
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true);
    assert.equal(focusFetches, baseline, 'чужой ключ preference фокус не перечитывает');

    // Своя сеть: другой клиент выключил корзину — store и карта следуют.
    deliver(foreignEvent('user-preference.updated', 'n1', { key: 'show_trash', value: false }, 3));
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, false, 'настройка пришла от другого клиента');
    assert.equal(focusFetches, baseline + 1, 'карта перечитала окрестность фокуса через слой');

    // Обратное включение — тем же путём.
    deliver(foreignEvent('user-preference.updated', 'n1', { key: 'show_trash', value: true }, 4));
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true);
    assert.equal(focusFetches, baseline + 2);
    deactivateFocusQuery();
    resetQueryRegistry();
    resetEventRouter();
  });
});
