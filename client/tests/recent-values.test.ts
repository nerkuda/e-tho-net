/**
 * Unit tests for the recent-values store of property editors
 * (client/src/renderer/editor/recent-values.ts).
 *
 * Covers the pure history helpers (add / dedup-lift / cap at 10 — the
 * acceptance criteria of the «Помощь с заполнением значений свойств» task)
 * and the localStorage roundtrip (key = network id + property id). The
 * dropdown mechanics (focus/typing/↑↓/Enter/Escape/blur) moved to the shared
 * suggestions dropdown and are covered by suggest-dropdown.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The simplest Storage stand-in (a Map with the two methods used). */
class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let recentModule: any = null;
async function loadRecent(): Promise<any> {
  if (recentModule === null) {
    recentModule = await import('../src/renderer/editor/recent-values.js');
  }
  return recentModule;
}

describe('recent-values history helpers (pure)', () => {
  it('recentValuesStorageKey includes the network id and the property id', async () => {
    const { recentValuesStorageKey } = await loadRecent();
    assert.equal(recentValuesStorageKey('net-1', 'p-2'), 'props.recent.net-1.p-2');
  });

  it('parseRecentValues: null/invalid JSON/non-array → [], strings only, capped at 10', async () => {
    const { parseRecentValues } = await loadRecent();
    assert.deepEqual(parseRecentValues(null), []);
    assert.deepEqual(parseRecentValues('not json'), []);
    assert.deepEqual(parseRecentValues('{"a":1}'), []);
    assert.deepEqual(parseRecentValues('["a",1,null,"","b"]'), ['a', 'b']);
    const eleven = JSON.stringify(Array.from({ length: 12 }, (_, i) => `v${i}`));
    const parsed = parseRecentValues(eleven);
    assert.equal(parsed.length, 10, 'history never exceeds 10 entries');
    assert.deepEqual(parsed, ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });

  it('mergeRecentValue: new value first, repeat lifts without duplicates', async () => {
    const { mergeRecentValue } = await loadRecent();
    assert.deepEqual(mergeRecentValue(['b', 'c'], 'a'), ['a', 'b', 'c']);
    assert.deepEqual(mergeRecentValue(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    assert.deepEqual(mergeRecentValue(['a'], 'a'), ['a']);
    // The value is trimmed; whitespace-only leaves the history unchanged.
    assert.deepEqual(mergeRecentValue(['a'], '  b  '), ['b', 'a']);
    assert.deepEqual(mergeRecentValue(['a'], '   '), ['a']);
    // The previous array is never mutated.
    const prev = ['a', 'b'];
    mergeRecentValue(prev, 'c');
    assert.deepEqual(prev, ['a', 'b']);
  });

  it('mergeRecentValue: caps at 10, the oldest entry drops out', async () => {
    const { mergeRecentValue, RECENT_VALUES_MAX } = await loadRecent();
    assert.equal(RECENT_VALUES_MAX, 10);
    let history: string[] = [];
    for (let i = 1; i <= 11; i += 1) history = mergeRecentValue(history, `v${i}`);
    assert.equal(history.length, 10);
    assert.equal(history[0], 'v11', 'the newest value is first');
    assert.ok(!history.includes('v1'), 'the oldest of 11 entries drops out');
  });
});

describe('recent-values localStorage roundtrip', () => {
  it('recordRecentValue/loadRecentValues: roundtrip, isolated per network and property', async () => {
    const { recordRecentValue, loadRecentValues } = await loadRecent();
    const previous = (globalThis as any).localStorage;
    (globalThis as any).localStorage = new ShimStorage();
    try {
      recordRecentValue('net-1', 'p-1', 'Москва');
      recordRecentValue('net-1', 'p-1', 'СПб');
      // A repeat lifts to the top without duplicates.
      recordRecentValue('net-1', 'p-1', 'Москва');
      assert.deepEqual(loadRecentValues('net-1', 'p-1'), ['Москва', 'СПб']);
      // Other properties / other networks have their own history.
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), []);
      assert.deepEqual(loadRecentValues('net-2', 'p-1'), []);
      recordRecentValue('net-1', 'p-2', 'Казань');
      assert.deepEqual(loadRecentValues('net-1', 'p-1'), ['Москва', 'СПб']);
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), ['Казань']);
      // Whitespace-only values are never recorded.
      recordRecentValue('net-1', 'p-2', '   ');
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), ['Казань']);
    } finally {
      (globalThis as any).localStorage = previous;
    }
  });
});
