/**
 * Unit tests for canvas internals (H4): neighbour grouping and cloud style
 * resolution. Pure logic — no DOM required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusNeighbor, ThoughtRef, ThoughtType } from '@etn/shared';

import { canvasInternals } from '../src/renderer/canvas/canvas.js';
import { store } from '../src/renderer/state.js';

const { groupByThought, resolveCloudStyle } = canvasInternals;

function neighbor(id: string, linkId: string): FocusNeighbor {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    active: true,
    link_id: linkId,
    link_type_id: null,
    link_active: true,
  };
}

function ref(overrides: Partial<ThoughtRef> = {}): ThoughtRef {
  return {
    id: 't1',
    title: 'Мысль',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    active: true,
    fg_color: null,
    bg_color: null,
    font_bold: false,
    font_italic: false,
    font_underline: false,
    font_strike: false,
    ...overrides,
  };
}

function type(overrides: Partial<ThoughtType>): ThoughtType {
  return {
    id: 'type1',
    name: 'Тип',
    icon: null,
    fg_color: null,
    bg_color: null,
    font_bold: false,
    font_italic: false,
    font_underline: false,
    font_strike: false,
    description: null,
    version: 1,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

describe('groupByThought', () => {
  it('groups several links to the same thought into one entry', () => {
    const groups = groupByThought([neighbor('a', 'l1'), neighbor('a', 'l2'), neighbor('b', 'l3')]);
    assert.equal(groups.length, 2);
    const a = groups.find((g) => g.id === 'a');
    assert.ok(a);
    assert.equal(a.links.length, 2);
  });

  it('returns an empty list for no neighbours', () => {
    assert.deepEqual(groupByThought([]), []);
  });
});

describe('resolveCloudStyle', () => {
  it('own values win over type defaults', () => {
    store.update({
      thoughtTypes: [type({ fg_color: '#000000', bg_color: '#ffffff', font_bold: true })],
    });
    const style = resolveCloudStyle(ref({ type_id: 'type1', fg_color: '#ff0000' }));
    assert.equal(style.fg, '#ff0000');
    assert.equal(style.bg, '#ffffff');
    assert.equal(style.bold, true);
    store.update({ thoughtTypes: [] });
  });

  it('falls back to nulls without a type', () => {
    store.update({ thoughtTypes: [] });
    const style = resolveCloudStyle(ref());
    assert.equal(style.fg, null);
    assert.equal(style.bg, null);
    assert.equal(style.bold, false);
  });

  it('inherits font flags from the type', () => {
    store.update({ thoughtTypes: [type({ font_italic: true, font_strike: true })] });
    const style = resolveCloudStyle(ref({ type_id: 'type1' }));
    assert.equal(style.italic, true);
    assert.equal(style.strike, true);
    store.update({ thoughtTypes: [] });
  });
});
