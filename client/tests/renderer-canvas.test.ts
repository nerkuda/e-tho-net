/**
 * Unit tests for canvas internals (H4): neighbour grouping and cloud style
 * resolution. Pure logic — no DOM required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusEdge, FocusNeighbor, Thought, ThoughtRef, ThoughtType } from '@etn/shared';

import { canvasInternals, visibleRelatedTitles } from '../src/renderer/canvas/canvas.js';
import { store } from '../src/renderer/state.js';

const { groupByThought, resolveCloudStyle, canvasRenderKey, selectionKey } = canvasInternals;

function thought(id: string, title = id): Thought {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    active: true,
    is_protected: false,
    is_root: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function focusResponse(): FocusResponse {
  return {
    focused: thought('f'),
    parents: [neighbor('p', 'lp')],
    siblings: [],
    children: [],
    edges: [],
    sorts: { parents: 'created', children: 'created' },
  };
}

function neighbor(id: string, linkId: string, title = id): FocusNeighbor {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    active: true,
    link_id: linkId,
    link_type_id: null,
    link_active: true,
    has_incoming: false,
    has_outgoing: false,
  };
}

function edge(id: string, source_id: string, target_id: string): FocusEdge {
  return { id, source_id, target_id, type_id: null, color: null, style: null, width: null };
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
    // null = "inherit from the type" (02-data-model.md §3.1.1).
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

function type(overrides: Partial<ThoughtType>): ThoughtType {
  return {
    id: 'type1',
    name: 'Тип',
    icon: null,
    icon_kind: 'emoji',
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

  it('a manual false overrides a true type default', () => {
    // The null-coalesce model (unlike the old OR) lets a thought explicitly
    // turn OFF a font flag the type enables (02-data-model.md §3.1.1).
    store.update({ thoughtTypes: [type({ font_bold: true })] });
    const style = resolveCloudStyle(ref({ type_id: 'type1', font_bold: false }));
    assert.equal(style.bold, false);
    store.update({ thoughtTypes: [] });
  });
});

describe('visibleRelatedTitles (08-ui-spec §2.2.3)', () => {
  it('maps focus↔neighbour edges to the endpoint titles', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'f', title: 'Проект А' },
      parents: [neighbor('p', 'lp', 'Родитель')],
      siblings: [],
      children: [neighbor('c', 'lc', 'Задачи разработки')],
      edges: [edge('e1', 'f', 'c'), edge('e2', 'p', 'f')],
    });
    assert.deepEqual(result.get('f'), ['Задачи разработки', 'Родитель']);
    assert.deepEqual(result.get('c'), ['Проект А']);
    assert.deepEqual(result.get('p'), ['Проект А']);
  });

  it('includes neighbour↔neighbour edges', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'f', title: 'Фокус' },
      parents: [neighbor('p1', 'l1', 'Проект А'), neighbor('p2', 'l2', 'Задачи разработки')],
      siblings: [],
      children: [],
      edges: [edge('e1', 'p1', 'p2')],
    });
    assert.deepEqual(result.get('p1'), ['Задачи разработки']);
    assert.deepEqual(result.get('p2'), ['Проект А']);
    assert.equal(result.get('f'), undefined);
  });

  it('ignores edges whose endpoints are not among the displayed thoughts', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'f', title: 'Фокус' },
      parents: [],
      siblings: [],
      children: [neighbor('c', 'lc', 'Дитя')],
      edges: [edge('e1', 'f', 'c'), edge('e2', 'c', 'gone')],
    });
    assert.deepEqual(result.get('f'), ['Дитя']);
    assert.deepEqual(result.get('c'), ['Фокус']);
  });
});

describe('canvasRenderKey / selectionKey (2e418bc3)', () => {
  it('ignores the selection list — selection-only changes repaint in place', () => {
    store.update({ selection: [], focus: null });
    const base = canvasRenderKey();
    // The selection must never be part of the canvas content signature.
    store.update({ selection: ['a', 'b'] });
    assert.equal(canvasRenderKey(), base);
    assert.equal(selectionKey(), 'a\u0000b');
  });

  it('changes with the focus, cloud geometry and editor target', () => {
    store.update({ focus: focusResponse(), cloudWidth: 180, editorTarget: null });
    const base = canvasRenderKey();
    store.update({ focus: focusResponse() });
    assert.equal(canvasRenderKey(), base, 'identical focus data — same key');
    store.update({ focus: { ...focusResponse(), focused: thought('f', 'Переименовано') } });
    assert.notEqual(canvasRenderKey(), base, 'edited focus title — new key');
    store.update({ focus: focusResponse(), cloudWidth: 200 });
    assert.notEqual(canvasRenderKey(), base, 'cloud width — new key');
    store.update({ focus: focusResponse(), editorTarget: { kind: 'thought', id: 'f' } });
    assert.notEqual(canvasRenderKey(), base, 'editor target — new key');
  });

  it('changes with the layer overrides — the badge repaints after a mutation (71d7e27a)', () => {
    store.update({
      focus: focusResponse(),
      layerOverrides: { thought_ids: [], link_ids: [] },
    });
    const base = canvasRenderKey();
    // A post-mutation override refresh (08-ui-spec §2.2) must produce a new
    // key: without it the subscriber took the selection-only fast path and
    // the layer badge only appeared after the next focus/layer change.
    store.update({ layerOverrides: { thought_ids: ['f'], link_ids: [] } });
    assert.notEqual(canvasRenderKey(), base, 'override list — new key');
  });
});
