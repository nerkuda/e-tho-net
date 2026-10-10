/**
 * Realtime-пути владений общих вложений (0.12.1, задача f77382ba, сущность
 * 109be255, требование 0502e045).
 *
 * Проверяется:
 *  1) роутер слоя: `attachment.created` с агрегатом `owners[]` гасит списки и
 *     счётчики-индикаторы ВСЕХ владельцев; новые события
 *     `attachment.owner.added` / `attachment.owner.removed` адресуют список и
 *     индикаторы владельца из нагрузки;
 *  2) производный гейт (`realtime-effects`): владелец события, входящий в
 *     показанную окрестность, освежает её; чужой владелец — нет.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Фабрика realtime-события (seq растёт — иначе роутер отбросит как опоздавшее). */
function realtimeEvent(
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
    network_id: networkId,
    audience: 'network',
    layer_id: '00000000-0000-4000-8000-000000000001',
    data,
  };
}

describe('роутер слоя: события владений вложения (109be255)', () => {
  it('attachment.created гасит списки/индикаторы ВСЕХ владельцев из owners[]', async () => {
    const {
      registerQuery,
      resetQueryRegistry,
      resetEventRouter,
      routeRealtimeEvent,
      queryKeys,
    } = await import('../src/renderer/lib/live/index.js');

    resetQueryRegistry();
    resetEventRouter();
    registerQuery(queryKeys.attachments('thought', 't1'), null);
    registerQuery(queryKeys.attachments('thought', 't2'), null);
    registerQuery(queryKeys.indicators('t2'), null);

    const result = routeRealtimeEvent(
      realtimeEvent(
        'attachment.created',
        'n1',
        {
          attachment: {
            id: 'a1',
            owner_type: 'thought',
            owner_id: 't1',
            owners: [
              { owner_type: 'thought', owner_id: 't1' },
              { owner_type: 'thought', owner_id: 't2' },
            ],
          },
        },
        1,
      ) as any,
    );
    assert.ok(
      result.invalidated.includes(queryKeys.attachments('thought', 't1')),
      'первичный владелец',
    );
    assert.ok(
      result.invalidated.includes(queryKeys.attachments('thought', 't2')),
      'второй владелец из агрегата',
    );
    assert.ok(result.invalidated.includes(queryKeys.indicators('t2')), 'индикаторы владельца');
  });

  it('owner.added/removed гасят список и индикаторы владельца (0502e045)', async () => {
    const {
      registerQuery,
      resetQueryRegistry,
      resetEventRouter,
      routeRealtimeEvent,
      queryKeys,
    } = await import('../src/renderer/lib/live/index.js');

    resetQueryRegistry();
    resetEventRouter();
    registerQuery(queryKeys.attachments('thought', 't1'), null);
    registerQuery(queryKeys.indicators('t1'), null);
    const added = routeRealtimeEvent(
      realtimeEvent(
        'attachment.owner.added',
        'n1',
        { attachment_id: 'a1', owner_type: 'thought', owner_id: 't1' },
        1,
      ) as any,
    );
    assert.ok(added.invalidated.includes(queryKeys.attachments('thought', 't1')));
    assert.ok(added.invalidated.includes(queryKeys.indicators('t1')));

    resetEventRouter();
    registerQuery(queryKeys.attachments('publication', 'p1'), null);
    registerQuery(queryKeys.indicators('p1'), null);
    const removed = routeRealtimeEvent(
      realtimeEvent(
        'attachment.owner.removed',
        'n1',
        { attachment_id: 'a1', owner_type: 'publication', owner_id: 'p1' },
        1,
      ) as any,
    );
    assert.ok(removed.invalidated.includes(queryKeys.attachments('publication', 'p1')));
    assert.ok(removed.invalidated.includes(queryKeys.indicators('p1')));
  });
});

// ---------------------------------------------------------------------------
// Производный гейт: владелец события в показанной окрестности
// ---------------------------------------------------------------------------

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
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

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

/** REFRESH_DEBOUNCE_MS (app.ts) + запас. */
const REFRESH_SLACK_MS = 300;

describe('гейт realtime-effects: владения вложения (f77382ba)', () => {
  it('владелец в окрестности освежает её, чужой владелец — нет', async () => {
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
    const { applyDerivedRealtime } = await import('../src/renderer/realtime-effects.js');
    const { resetQueryRegistry } = await import('../src/renderer/lib/live/query-registry.js');
    const { resetEventRouter, routeRealtimeEvent } = await import(
      '../src/renderer/lib/live/event-router.js'
    );

    resetQueryRegistry();
    resetEventRouter();
    store.update({
      networkId: 'n1',
      activeView: 'map',
      activeTabId: 'tab1',
      focus: makeFocusResponse() as any,
    } as any);
    await wait(50);
    const baseline = focusFetches;

    const deliver = (evt: Record<string, unknown>): void => {
      routeRealtimeEvent(evt as any, { networkId: 'n1' });
      applyDerivedRealtime(evt as any);
    };

    // Владелец вне окрестности — окрестность не перечитывается.
    deliver(
      realtimeEvent(
        'attachment.owner.added',
        'n1',
        { attachment_id: 'a1', owner_type: 'thought', owner_id: 't9' },
        1,
      ),
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(focusFetches, baseline, 'чужой владелец окрестность не перечитывает');

    // Владелец — сам фокус: производный гейт освежает окрестность.
    deliver(
      realtimeEvent(
        'attachment.owner.added',
        'n1',
        { attachment_id: 'a1', owner_type: 'thought', owner_id: 't1' },
        2,
      ),
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(focusFetches, baseline + 1, 'владелец-фокус освежает окрестность');

    // Локальный сосед (p1) из owners[] снимка created — тоже освежает.
    deliver(
      realtimeEvent(
        'attachment.created',
        'n1',
        {
          attachment: {
            id: 'a2',
            owner_type: 'thought',
            owner_id: 't9',
            owners: [
              { owner_type: 'thought', owner_id: 't9' },
              { owner_type: 'thought', owner_id: 'p1' },
            ],
          },
        },
        3,
      ),
    );
    await wait(REFRESH_SLACK_MS);
    assert.equal(focusFetches, baseline + 2, 'владелец-сосед из owners[] освежает окрестность');

    resetQueryRegistry();
    resetEventRouter();
  });
});
