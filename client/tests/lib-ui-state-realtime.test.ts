/**
 * Интеграция реактивной основы списков с realtime-каналом (задача 60fcc702,
 * требование 628d33ee, компонент ebe5e19f).
 *
 * Ключевой сценарий требования: realtime-событие сети обновляет данные списка
 * БЕЗ ручного `invalidate`-хука вызывающего. Проверяется на мосте производных
 * эффектов `applyDerivedRealtime` (G6 техпроекта 269016e2 — прежний
 * `applyRealtimeToUi` снесён) под DOM-шимом: подписчик селектора на срез store
 * срабатывает от события, потому что производный эффект фан-аутит его через
 * `store.update` (а не зовёт точечную инвалидацию, которую вызывающий обязан
 * помнить). jsdom не нужен — среда та же, что у прочих realtime-тестов рендерера.
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

describe('realtime → селектор: список обновляется сам (60fcc702)', () => {
  it('pinned-thoughts.updated и show_inactive доходят до подписчиков селекторов', async () => {
    shimDom();
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined, getState: async () => null },
      types: { listThoughtTypes: async () => [], listLinkTypes: async () => [] },
      thoughts: { focus: async () => null },
    };
    const { store } = await import('../src/renderer/state.js');
    const { applyDerivedRealtime } = await import('../src/renderer/realtime-effects.js');
    const { select } = await import('../src/renderer/lib/ui/state.js');

    store.update({ networkId: 'n1', pins: [], showInactive: false } as any);

    const pinCalls: string[][] = [];
    const inactiveCalls: boolean[] = [];
    const offPins = select(
      (s) => s.pins,
      (pins) => pinCalls.push([...pins]),
    );
    const offInactive = select(
      (s) => s.showInactive,
      (value) => inactiveCalls.push(value),
    );

    try {
      assert.deepEqual(pinCalls, [[]], 'подписка сразу отдаёт текущий список');
      assert.deepEqual(inactiveCalls, [false]);

      // Событие другой сети игнорируется целиком (граница сети).
      applyDerivedRealtime(
        foreignEvent('pinned-thoughts.updated', 'n2', { ordered_ids: ['x'] }) as any,
      );
      assert.deepEqual(pinCalls, [[]], 'чужую сеть селектор не видит');

      // Своя сеть: список пинов обновлён другим клиентом — без invalidate
      // вызывающего подписчик селектора получает новые данные.
      applyDerivedRealtime(
        foreignEvent('pinned-thoughts.updated', 'n1', { ordered_ids: ['a', 'b'] }) as any,
      );
      assert.deepEqual(pinCalls, [[], ['a', 'b']], 'список обновился от realtime-события');

      // Повтор того же значения в другом контейнере — молчание (структурное
      // сравнение среза).
      applyDerivedRealtime(
        foreignEvent('pinned-thoughts.updated', 'n1', { ordered_ids: ['a', 'b'] }) as any,
      );
      assert.equal(pinCalls.length, 2);

      // Ветка user-preference: show_inactive обновляет store напрямую.
      applyDerivedRealtime(
        foreignEvent('user-preference.updated', 'n1', { key: 'show_inactive', value: true }) as any,
      );
      assert.deepEqual(inactiveCalls, [false, true], 'булев срез пришёл от события');
    } finally {
      offPins();
      offInactive();
    }
  });
});
