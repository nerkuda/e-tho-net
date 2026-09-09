/**
 * Unit tests for the fix of bug bcdb3dc6: «Ссылки на мысли из других
 * мыслесетей открываются в новой вкладке» — a cross-network wiki-link
 * always opened a NEW tab, even when the target network was already open in
 * one.
 *
 * Covered:
 *  - `findTabForNetwork` — the pure "which tab to reuse" rule (last match,
 *    else none);
 *  - `openWikiIdTarget` — wiring: an existing tab of the target network is
 *    activated (`etn.tabs.activate`) before `openNetwork` runs; no matching
 *    tab means no activate call (a new tab is left to `openNetwork` itself).
 *
 * `openNetwork` (app.ts) is far too heavy to run end-to-end under Node (a
 * dozen `ui.getState` round-trips, pins, types, tab-list bookkeeping…).
 * The mocked `networks.open` below throws immediately — its very first
 * await — so `openNetwork` fails right away and the failure is caught by
 * `openWikiIdTarget`'s try/catch (a "sети недоступна" notice, expected and
 * harmless here). What we actually assert on is the CALL ORDER captured in
 * `etnCalls`, which is fully determined before that throw: whether
 * `tabs.activate` fired for the right tab, and which network `openNetwork`
 * was asked to open.
 *
 * Runs under Node — `window` must be installed BEFORE the first import of
 * `lib/etn.js` (its live Proxy captures the global at module-evaluation
 * time).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TabDto } from '../src/main/ipc/contract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const etnCalls: string[] = [];

function tab(tabId: string, networkId: string, slotIdx: number): TabDto {
  return {
    tab_id: tabId,
    slot_idx: slotIdx,
    network_id: networkId,
    focus_id: null,
    view_mode: null,
    structures_state: null,
    chronicle_state: null,
    activity_state: null,
    layer_id: null,
    last_active_at: '2026-09-09T00:00:00.000Z',
  };
}

/**
 * Minimal element stub that survives the `notice()` path — `openWikiIdTarget`
 * calls it when the mocked `openNetwork` fails (same shim as
 * `copy-hotkey.test.ts`).
 */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style = { setProperty: () => undefined, removeProperty: () => undefined };
  textContent = '';
  isConnected = true;
  classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      this.children.push(typeof node === 'string' ? new ShimElement('#text', undefined, node) : node);
    }
  }
  remove(): void {
    /* no-op */
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

(globalThis as any).HTMLElement = class {};
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  body: new ShimElement('body'),
  documentElement: { style: {} },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  querySelector: () => null,
};

(globalThis as { window?: unknown }).window = {
  innerWidth: 1200,
  setTimeout,
  clearTimeout,
  etn: {
    networks: {
      open: async (networkId: string): Promise<never> => {
        etnCalls.push(`networks.open:${networkId}`);
        throw new Error('stop here — see file header');
      },
    },
    tabs: {
      activate: async (tabId: string): Promise<null> => {
        etnCalls.push(`tabs.activate:${tabId}`);
        return null;
      },
    },
    thoughts: {
      get: async (): Promise<never> => {
        throw new Error('unreachable — openNetwork already failed');
      },
    },
  },
};

const { findTabForNetwork } = await import('../src/renderer/screens/tabs/tab-state.js');
const { openWikiIdTarget } = await import('../src/renderer/editor/wiki-link.js');
const { store } = await import('../src/renderer/state.js');

describe('findTabForNetwork (bcdb3dc6, чистое правило)', () => {
  const tabs = [tab('t1', 'n1', 0), tab('t2', 'n2', 1), tab('t3', 'n1', 2)];

  it('находит единственный таб сети', () => {
    assert.equal(findTabForNetwork(tabs, 'n2')?.tab_id, 't2');
  });

  it('несколько табов одной сети — берёт последний', () => {
    assert.equal(findTabForNetwork(tabs, 'n1')?.tab_id, 't3');
  });

  it('сети нет ни в одном табе — null', () => {
    assert.equal(findTabForNetwork(tabs, 'n-absent'), null);
  });

  it('пустой список табов — null', () => {
    assert.equal(findTabForNetwork([], 'n1'), null);
  });
});

describe('openWikiIdTarget (bcdb3dc6, wiring)', () => {
  it('целевая сеть уже открыта — активирует существующий таб, а не создаёт новый', async () => {
    store.update({
      networkId: 'current-net',
      tabs: [tab('t-other', 'current-net', 0), tab('t-target', 'target-net', 1)],
    });
    etnCalls.length = 0;

    await openWikiIdTarget('target-net', 'thought-1');

    // `tabs.activate` для найденного таба идёт ДО `networks.open` внутри
    // `openNetwork` — именно этот порядок и означает «переиспользовали
    // существующий таб», а не «всегда открыли новый».
    assert.deepEqual(etnCalls, ['tabs.activate:t-target', 'networks.open:target-net']);
  });

  it('целевая сеть нигде не открыта — новый таб, activate не вызывается', async () => {
    store.update({
      networkId: 'current-net',
      tabs: [tab('t-other', 'current-net', 0)],
    });
    etnCalls.length = 0;

    await openWikiIdTarget('brand-new-net', 'thought-1');

    assert.deepEqual(etnCalls, ['networks.open:brand-new-net']);
  });

  it('несколько табов целевой сети — активирует последний', async () => {
    store.update({
      networkId: 'current-net',
      tabs: [
        tab('t-other', 'current-net', 0),
        tab('t-target-1', 'target-net', 1),
        tab('t-target-2', 'target-net', 2),
      ],
    });
    etnCalls.length = 0;

    await openWikiIdTarget('target-net', 'thought-1');

    assert.deepEqual(etnCalls, ['tabs.activate:t-target-2', 'networks.open:target-net']);
  });
});
