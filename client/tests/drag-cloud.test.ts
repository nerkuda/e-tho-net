/**
 * Unit tests for the pure link-search helpers of the canvas drag module
 * (client/src/renderer/canvas/drag-cloud.ts). The DOM-driven drag/hit logic is
 * covered by manual/E2E checks; these tests pin down the directed-link lookup
 * that `linkToThought`/`moveFocusDirection` rely on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Link, ThoughtLinksGrouped, ThoughtRef } from '@etn/shared';

import { findDirectedLink, flattenLinks } from '../src/renderer/canvas/drag-cloud.js';

function link(id: string, sourceId: string, targetId: string, typeId: string | null = null): Link {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type_id: typeId,
    color: null,
    style: null,
    width: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

function ref(id: string): ThoughtRef {
  return {
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
  };
}

const grouped: ThoughtLinksGrouped = {
  by_type: [
    {
      type_id: 't1',
      type_name: 'related',
      items: [
        { link: link('l1', 'A', 'B', 't1'), target_thought: ref('B') },
        { link: link('l2', 'C', 'A', 't1'), target_thought: ref('A') },
      ],
    },
  ],
  untyped_parents: [{ link: link('l3', 'D', 'A') }],
  untyped_children: [{ link: link('l4', 'A', 'E') }],
};

describe('flattenLinks', () => {
  it('collects links from by_type, untyped_parents and untyped_children', () => {
    const ids = flattenLinks(grouped).map((l) => l.id);
    assert.deepEqual(ids.sort(), ['l1', 'l2', 'l3', 'l4']);
  });

  it('dedupes by id when the same link appears in several groups', () => {
    const dup: ThoughtLinksGrouped = {
      by_type: [],
      untyped_parents: [{ link: link('lx', 'A', 'B') }],
      untyped_children: [{ link: link('lx', 'A', 'B') }],
    };
    assert.equal(flattenLinks(dup).length, 1);
  });
});

describe('findDirectedLink', () => {
  it('finds an existing directed link A→B', () => {
    assert.equal(findDirectedLink(grouped, 'A', 'B')?.id, 'l1');
  });

  it('distinguishes direction: B→A is a different (absent) link than A→B', () => {
    assert.equal(findDirectedLink(grouped, 'B', 'A'), undefined);
  });

  it('finds links regardless of type_id (typed and untyped)', () => {
    assert.equal(findDirectedLink(grouped, 'D', 'A')?.id, 'l3');
    assert.equal(findDirectedLink(grouped, 'A', 'E')?.id, 'l4');
  });

  it('returns undefined for a non-existent pair', () => {
    assert.equal(findDirectedLink(grouped, 'X', 'Y'), undefined);
  });
});
