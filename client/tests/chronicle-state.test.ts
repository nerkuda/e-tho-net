/**
 * Unit tests for the chronicle view's pure state helpers (L20): the filter
 * criteria serialization and the persisted L4-state parser. Pure Node, no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FILTER,
  fromDefinition,
  parseChronicleState,
  toDefinition,
  type ChronicleFilterState,
} from '../src/renderer/screens/chronicle/state.js';

describe('toDefinition / fromDefinition', () => {
  it('round-trips a full filter', () => {
    const state: ChronicleFilterState = {
      keywords: 'счет* -вод*',
      thoughtIds: ['a', 'b'],
      includeSubtree: true,
      typeIds: ['t1'],
      linkTypeIds: ['l1'],
      linkScope: 'sources',
      dateFrom: '2024-01-01',
      dateTo: '2024-12-31',
      order: 'desc',
    };
    const definition = toDefinition(state);
    assert.equal(definition.keywords, 'счет* -вод*');
    assert.deepEqual(definition.thought_ids, ['a', 'b']);
    assert.equal(definition.include_subtree, true);
    assert.deepEqual(definition.type_ids, ['t1']);
    assert.deepEqual(definition.link_type_ids, ['l1']);
    assert.equal(definition.link_scope, 'sources');
    assert.equal(definition.date_from, '2024-01-01');
    assert.equal(definition.date_to, '2024-12-31');
    assert.equal(definition.order, 'desc');
    assert.deepEqual(fromDefinition(definition), state);
  });

  it('omits empty criteria and defaults to asc/both', () => {
    const definition = toDefinition(DEFAULT_FILTER);
    assert.equal(definition.keywords, undefined);
    assert.equal(definition.thought_ids, undefined);
    assert.equal(definition.include_subtree, undefined);
    assert.equal(definition.link_scope, 'both');
    assert.equal(definition.order, 'asc');
    const back = fromDefinition(definition);
    assert.deepEqual(back, DEFAULT_FILTER);
  });

  it('parses partial definitions with safe defaults', () => {
    assert.deepEqual(fromDefinition({}), DEFAULT_FILTER);
    assert.deepEqual(fromDefinition({ order: 'desc', link_scope: 'targets' }), {
      ...DEFAULT_FILTER,
      order: 'desc',
      linkScope: 'targets',
    });
  });
});

describe('parseChronicleState', () => {
  it('parses a full persisted state', () => {
    const parsed = parseChronicleState(
      JSON.stringify({
        filter: { keywords: 'x', order: 'desc' },
        offset: 150,
        savedFilterId: 'f1',
      }),
    );
    assert.equal(parsed.filter.keywords, 'x');
    assert.equal(parsed.filter.order, 'desc');
    assert.equal(parsed.offset, 150);
    assert.equal(parsed.savedFilterId, 'f1');
  });

  it('falls back to empty on garbage or missing fields', () => {
    const garbage = parseChronicleState('not-json{');
    assert.equal(garbage.offset, 0);
    assert.equal(garbage.savedFilterId, null);
    assert.equal(garbage.filter.order, 'asc');

    const partial = parseChronicleState(JSON.stringify({ offset: -5 }));
    assert.equal(partial.offset, 0, 'negative offsets clamp to zero');

    const float = parseChronicleState(JSON.stringify({ offset: 7.9 }));
    assert.equal(float.offset, 7, 'offsets are floored');
  });
});
