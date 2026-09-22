/**
 * Realtime-путь настройки «Показывать содержимое корзины» (задача 77923b49,
 * 0.8.2): событие `user-preference.updated` с ключом `show_trash` от ДРУГОГО
 * клиента обязано дойти до store и перечитать карту — иначе второй клиент
 * пользователя продолжит показывать помеченных на удаление, пока не
 * перезапустится.
 *
 * Путь ровно тот же, что у `show_inactive` (симметрия настроек видимости):
 * `store.update({ showTrash })` + `scheduleRefresh()` +
 * `scheduleStructuresRefresh()`. Проверяется реальный вызов
 * `applyRealtimeToUi` под DOM-шимом: значение флага, перезапрос фокуса и
 * игнор чужих ключей/чужих сетей.
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
function foreignEvent(type: string, networkId: string, data: unknown): Record<string, unknown> {
  return {
    type,
    seq: 1,
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

    store.update({
      networkId: 'n1',
      activeView: 'map',
      activeTabId: 'tab1',
      focus: makeFocusResponse() as any,
      showTrash: true,
    } as any);

    // Чужая сеть — событие соседней вкладки общий store не трогает.
    applyRealtimeToUi(
      foreignEvent('user-preference.updated', 'n2', { key: 'show_trash', value: false }) as any,
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true, 'событие чужой сети настройку не меняет');
    assert.equal(focusFetches, 0, 'событие чужой сети фокус не перечитывает');

    // Чужой ключ в своей сети — не наша настройка.
    applyRealtimeToUi(
      foreignEvent('user-preference.updated', 'n1', { key: 'cloud_width', value: 200 }) as any,
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true);
    assert.equal(focusFetches, 0, 'чужой ключ preference фокус не перечитывает');

    // Своя сеть: другой клиент выключил корзину — store и карта следуют.
    applyRealtimeToUi(
      foreignEvent('user-preference.updated', 'n1', { key: 'show_trash', value: false }) as any,
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, false, 'настройка пришла от другого клиента');
    assert.equal(focusFetches, 1, 'карта перечитала окрестность фокуса');

    // Обратное включение — тем же путём.
    applyRealtimeToUi(
      foreignEvent('user-preference.updated', 'n1', { key: 'show_trash', value: true }) as any,
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(store.state.showTrash, true);
    assert.equal(focusFetches, 2);
  });
});
