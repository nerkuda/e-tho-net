/**
 * Unit tests for the «События» view's pure state helpers (задача f27809d0):
 * the L4-state parser. Pure Node, no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FILTER,
  ENTITY_TYPE_OPTIONS,
  parseActivityState,
  type ActivityFilterState,
} from '../src/renderer/screens/activity/state.js';

describe('parseActivityState', () => {
  it('returns defaults for empty input', () => {
    const parsed = parseActivityState('');
    assert.deepEqual(parsed.filter, { ...DEFAULT_FILTER });
    assert.equal(parsed.offset, 0);
  });

  it('returns defaults for malformed JSON', () => {
    const parsed = parseActivityState('not-json');
    assert.deepEqual(parsed.filter, { ...DEFAULT_FILTER });
    assert.equal(parsed.offset, 0);
  });

  it('parses a populated filter', () => {
    const json = JSON.stringify({
      filter: {
        fromMs: '2024-06-01',
        toMs: '2024-06-30',
        userId: 'user-123',
        entityTypes: ['thought', 'link'],
        actions: ['created', 'updated'],
      },
      offset: 50,
    });
    const parsed = parseActivityState(json);
    assert.equal(parsed.filter.fromMs, '2024-06-01');
    assert.equal(parsed.filter.toMs, '2024-06-30');
    assert.equal(parsed.filter.userId, 'user-123');
    assert.deepEqual(parsed.filter.entityTypes, ['thought', 'link']);
    assert.deepEqual(parsed.filter.actions, ['created', 'updated']);
    assert.equal(parsed.offset, 50);
  });

  it('drops unknown entity types and unknown actions', () => {
    const json = JSON.stringify({
      filter: {
        entityTypes: ['thought', 'mystery-type'],
        actions: ['created', 'something-else'],
      },
    });
    const parsed = parseActivityState(json);
    assert.deepEqual(parsed.filter.entityTypes, ['thought']);
    assert.deepEqual(parsed.filter.actions, ['created']);
  });

  it('clamps negative offset to zero', () => {
    const json = JSON.stringify({ filter: {}, offset: -5 });
    const parsed = parseActivityState(json);
    assert.equal(parsed.offset, 0);
  });

  it('rounds a fractional offset to the nearest integer floor', () => {
    const json = JSON.stringify({ filter: {}, offset: 12.9 });
    const parsed = parseActivityState(json);
    assert.equal(parsed.offset, 12);
  });

  it('exposes the same entity-type options the UI ships', () => {
    // Sanity check: the wire vocabulary must stay in lock-step with the
    // server (`ActivityEntityType`). Any drift here would silently filter
    // out every event for the changed kind.
    const types = ENTITY_TYPE_OPTIONS.map((o) => o.value).sort();
    assert.deepEqual(
      types,
      [
        'attachment',
        'comment',
        'layer',
        'link',
        'link_type',
        'property',
        'thought',
        'thought_type',
      ],
    );
  });

  it('parses a partial filter with safe defaults', () => {
    const json = JSON.stringify({ filter: { userId: 'u-1' } });
    const parsed = parseActivityState(json);
    const expected: ActivityFilterState = {
      keywords: '',
      fromMs: '',
      toMs: '',
      userOp: 'eq',
      userId: 'u-1',
      userIds: [],
      entityTypes: [],
      actions: [],
    };
    assert.deepEqual(parsed.filter, expected);
  });
});
