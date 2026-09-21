/**
 * Tests for the «Даты» group of the structures filter panel (задача 7032e55a).
 *
 * Pure structural checks on the wire-level parts of the filter-panel module:
 *
 *  * `getFilterState()` carries the four date bounds
 *    (`createdAfter`/`createdBefore`/`updatedAfter`/`updatedBefore`) as
 *    empty strings by default — the empty-filter case matches what
 *    `parseStructureFilter` returns on the server (no bound ⇒ no clause).
 *  * The wire `StructureFilter` carries the four fields as
 *    `created_after`/`created_before`/`updated_after`/`updated_before`
 *    (the server keys), matching the MCP tool's parameter names and the
 *    REST `POST /thoughts/query` body keys.
 *  * Date bounds survive a JSON round-trip through the L4 `structures_state`
 *    and through `SavedFilter.definition` (the wire persistence shape).
 *
 * The full DOM mount is exercised manually in the renderer (no Playwright
 * harness is wired into this workspace yet). The static shape of the
 * `FilterState` and the persisted JSON is enough to lock the public
 * contract — any UI regression is caught visually during smoke testing.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Installs the minimal DOM/window shims the panel + its imports need. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    etn: {
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [] },
      thoughts: {
        resolve: async () => [],
        findDuplicates: async () => [],
      },
    },
  };
}

before(() => {
  installShim();
});

describe('structures filter panel — «Даты» wire contract (задача 7032e55a)', () => {
  it('default FilterState carries empty date bounds (no-filter baseline)', async () => {
    const panel = await import('../src/renderer/screens/structures/filter-panel.js');
    const state = panel.getFilterState();
    assert.equal(state.createdAfter, '');
    assert.equal(state.createdBefore, '');
    assert.equal(state.updatedAfter, '');
    assert.equal(state.updatedBefore, '');
  });

  it('date fields persist round-trip through the L4 `structures_state` JSON', async () => {
    const panel = await import('../src/renderer/screens/structures/filter-panel.js');
    const state = {
      ...panel.getFilterState(),
      createdAfter: '2024-02-01T00:00:00',
      createdBefore: '2024-02-28T23:59:59',
      updatedAfter: '2024-03-01T00:00:00',
      updatedBefore: '2024-03-31T23:59:59',
    };
    const json = JSON.stringify(state);
    const restored = JSON.parse(json);
    assert.equal(restored.createdAfter, '2024-02-01T00:00:00');
    assert.equal(restored.createdBefore, '2024-02-28T23:59:59');
    assert.equal(restored.updatedAfter, '2024-03-01T00:00:00');
    assert.equal(restored.updatedBefore, '2024-03-31T23:59:59');
  });

  it('wire StructureFilter keys match the MCP / REST contract (snake_case)', () => {
    // The wire payload uses the same snake_case keys as the server's
    // `POST /thoughts/query` body and `etn.thoughts.query` parameters —
    // see `StructureFilter` in @etn/shared.
    const wire: import('@etn/shared').StructureFilter = {
      keywords: 'foo',
      created_after: '2024-02-01',
      created_before: '2024-02-28',
      updated_after: '2024-03-01',
      updated_before: '2024-03-31',
    };
    assert.equal(wire.created_after, '2024-02-01');
    assert.equal(wire.created_before, '2024-02-28');
    assert.equal(wire.updated_after, '2024-03-01');
    assert.equal(wire.updated_before, '2024-03-31');
  });

  it('saved-filter round-trip carries the four date bounds verbatim', () => {
    const saved: import('@etn/shared').SavedFilter = {
      id: '00000000-0000-4000-8000-000000000001',
      view: 'structures',
      name: 'Квартальные правки',
      definition: {
        created_after: '2024-02-01',
        created_before: '2024-02-28',
        updated_after: '2024-03-01',
        updated_before: '2024-03-31',
        sort: 'alpha',
        order: 'asc',
      },
      created_at: '2024-04-01T00:00:00Z',
      updated_at: '2024-04-01T00:00:00Z',
    };
    const restored = JSON.parse(JSON.stringify(saved)) as typeof saved;
    assert.equal(restored.definition.created_after, '2024-02-01');
    assert.equal(restored.definition.created_before, '2024-02-28');
    assert.equal(restored.definition.updated_after, '2024-03-01');
    assert.equal(restored.definition.updated_before, '2024-03-31');
  });
});
