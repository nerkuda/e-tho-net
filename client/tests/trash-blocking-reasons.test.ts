/**
 * Unit tests for the layer-aware blocking reasons of the delete dialogs
 * (bug 0.5.4: the dialog blamed «использование в свойствах» for any block,
 * including a thought added in the current layer). Pure logic — no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { trashInternals } from '../src/renderer/trash.js';

const { blockingReasons } = trashInternals;

describe('blockingReasons of the delete dialog (0.5.4)', () => {
  it('empty arms — no reasons, deletion allowed', () => {
    assert.deepEqual(blockingReasons('мысль', { properties: 0, layers: [] }), []);
  });

  it('property usage produces the properties reason', () => {
    const reasons = blockingReasons('мысль', { properties: 3, layers: [] });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /используется в свойствах других мыслей/);
  });

  it('a base entry means «существует в основе» — marking only in a layer', () => {
    const reasons = blockingReasons('мысль', {
      properties: 0,
      layers: [{ id: BASE_LAYER_ID, title: 'Основа' }],
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /существует в основе — в слое её можно только пометить/);
  });

  it('holding layers are listed by title, the base entry is not counted among them', () => {
    const reasons = blockingReasons('мысль', {
      properties: 0,
      layers: [
        { id: BASE_LAYER_ID, title: 'Основа' },
        { id: 'l1', title: 'Черновик' },
        { id: 'l2', title: 'Правки' },
      ],
    });
    assert.equal(reasons.length, 2);
    assert.match(reasons[1]!, /изменена в слоях: «Черновик», «Правки»/);
  });

  it('link noun and no property arm — layers only', () => {
    const reasons = blockingReasons('связь', {
      layers: [{ id: 'l1', title: 'Черновик' }],
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^связь изменена в слоях: «Черновик»$/);
  });
});
