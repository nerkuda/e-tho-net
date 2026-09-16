/**
 * Unit tests for the canvas link-type filter helpers (задача «Фильтр типов
 * связей на карте мыслей», 0.8.1):
 * `computeDefaultCanvasLinkFilter` and `parseStoredCanvasLinkFilter`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '../src/types/thought-type.js';
import {
  computeDefaultCanvasLinkFilter,
  parseStoredCanvasLinkFilter,
} from '../src/types/link.js';

/** Minimal registry row carrying just the fields the helpers read. */
function prop(
  id: string,
  overrides: {
    value_type?: NetworkProperty['value_type'];
    config?: NetworkProperty['config'];
  } = {},
): NetworkProperty {
  return {
    id,
    name: id,
    value_type: overrides.value_type ?? 'text',
    config: overrides.config ?? null,
    description: null,
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
  };
}

describe('computeDefaultCanvasLinkFilter', () => {
  it('always includes structural links, even with no show_on_map flags', () => {
    const out = computeDefaultCanvasLinkFilter([
      prop('p1', { value_type: 'link', config: { link_type_id: 'lt-1' } }),
    ]);
    assert.deepEqual(out, { include_structural: true });
  });

  it('collects the link_type_id of every link property with show_on_map=true', () => {
    const out = computeDefaultCanvasLinkFilter([
      prop('p1', { value_type: 'link', config: { link_type_id: 'lt-1', show_on_map: true } }),
      prop('p2', { value_type: 'link', config: { link_type_id: 'lt-2', show_on_map: true } }),
      prop('p3', { value_type: 'link', config: { link_type_id: 'lt-3', show_on_map: false } }),
      prop('p4', { value_type: 'text' }),
    ]);
    assert.deepEqual(out, { include_structural: true, type_ids: ['lt-1', 'lt-2'] });
  });

  it('ignores structural link properties (no link_type_id) when collecting types', () => {
    const out = computeDefaultCanvasLinkFilter([
      prop('p1', { value_type: 'link', config: { structural: true, show_on_map: true } }),
      prop('p2', { value_type: 'link', config: { link_type_id: 'lt-1', show_on_map: true } }),
    ]);
    assert.deepEqual(out, { include_structural: true, type_ids: ['lt-1'] });
  });
});

describe('parseStoredCanvasLinkFilter', () => {
  it('null/undefined → null (live default)', () => {
    assert.equal(parseStoredCanvasLinkFilter(null), null);
    assert.equal(parseStoredCanvasLinkFilter(undefined), null);
  });

  it('a well-formed object round-trips', () => {
    assert.deepEqual(parseStoredCanvasLinkFilter({ type_ids: ['a'], include_structural: true }), {
      type_ids: ['a'],
      include_structural: true,
    });
  });

  it('a garbled value → null (fall back to default)', () => {
    assert.equal(parseStoredCanvasLinkFilter('nonsense'), null);
    assert.equal(parseStoredCanvasLinkFilter({}), null);
    assert.equal(parseStoredCanvasLinkFilter({ type_ids: 42 }), null);
  });
});
