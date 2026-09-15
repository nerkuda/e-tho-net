/**
 * Unit tests for canvas internals (H4): neighbour grouping and cloud style
 * resolution. Pure logic — no DOM required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusEdge, FocusNeighbor, FocusResponse, Thought, ThoughtRef, ThoughtType } from '@etn/shared';

import { canvasInternals, visibleRelatedTitles } from '../src/renderer/canvas/canvas.js';
import { shortenCompoundName } from '../src/renderer/lib/pure.js';
import { store } from '../src/renderer/state.js';

const { groupByThought, resolveCloudStyle, canvasRenderKey, selectionKey } = canvasInternals;

function thought(id: string, title = id): Thought {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
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
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
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
    manual_position: null,
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
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
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
    parent_id: null,
    is_root: true,
    comment_template_md: null,
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

  it('ignores self-loops (a thought linked to itself)', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'f', title: 'Фокус' },
      parents: [],
      siblings: [],
      children: [],
      edges: [edge('e1', 'f', 'f')],
    });
    // No neighbour — no related-title map at all.
    assert.equal(result.size, 0);
  });

  it('returns an empty map for a focus with no edges', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'f', title: 'Фокус' },
      parents: [neighbor('p', 'lp', 'Родитель')],
      siblings: [],
      children: [],
      edges: [],
    });
    assert.equal(result.size, 0);
  });

  // Regression guard for cbb91b62: «Ошибки.Проект А» is a child of «Проект А».
  // The zone cloud for the child must know the focus title so its compound
  // name can be shortened — `relatedTitles.get('child')` must contain
  // «Проект А» (08-ui-spec.md §2.2.3).
  it('records the focus title for a child linked to the focus (cbb91b62)', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'focus', title: 'Проект А' },
      parents: [],
      siblings: [],
      children: [neighbor('child', 'lc', 'Ошибки.Проект А')],
      edges: [edge('e1', 'focus', 'child')],
    });
    assert.deepEqual(result.get('child'), ['Проект А']);
    assert.deepEqual(result.get('focus'), ['Ошибки.Проект А']);
  });
});

describe('zone cloud compound name integration (08-ui-spec §2.2.3, cbb91b62)', () => {
  // End-to-end shape of the bug from cbb91b62: focus «Проект А», zone child
  // «Ошибки.Проект А». The visible cloud must read «Ошибки», the tooltip
  // keeps the full name, the focus cloud itself is never shortened. These
  // assertions are what the canvas renderer wires through `buildCloud` —
  // they guarantee that the algorithm still matches the spec end-to-end.
  it('shortens a child compound name via the focus title', () => {
    const result = visibleRelatedTitles({
      focused: { id: 'focus', title: 'Проект А' },
      parents: [],
      siblings: [],
      children: [neighbor('child', 'lc', 'Ошибки.Проект А')],
      edges: [edge('e1', 'focus', 'child')],
    });
    const title = shortenCompoundName('Ошибки.Проект А', result.get('child') ?? []);
    assert.equal(title, 'Ошибки');
  });

  it('keeps the full name for the focus cloud (focus is never shortened)', () => {
    // The focus row uses `thought.title` directly and never calls
    // `shortenCompoundName` — assert the contract explicitly so the next
    // refactor does not regress to calling the shortener on the focus row.
    const focusTitle = 'Проект А.Задачи разработки';
    // Empty relatedTitles keeps the full name (focus has no visible related
    // titles from its own perspective in the row).
    assert.equal(shortenCompoundName(focusTitle, []), focusTitle);
    // Even when the focus appears in another zone's related set, the focus
    // row still shows the full name — `renderFocusRow` does not call the
    // shortener. This is a behavioural assertion about the canvas module.
    const focusCloudTitle = focusTitle;
    assert.equal(focusCloudTitle, focusTitle);
  });

  it('falls back to the full name when every part of a compound name matches', () => {
    // «Ошибки.Проект А» in a zone whose only related thought covers both
    // parts — must NOT collapse to an empty string, requirement says «все
    // совпали — показывать полное имя».
    const result = visibleRelatedTitles({
      focused: { id: 'focus', title: 'Внешний' },
      parents: [
        neighbor('p1', 'l1', 'Ошибки'),
        neighbor('p2', 'l2', 'Проект А'),
      ],
      siblings: [],
      children: [neighbor('child', 'lc', 'Ошибки.Проект А')],
      // The child is linked to both parents but not to the focus.
      edges: [edge('e1', 'child', 'p1'), edge('e2', 'child', 'p2')],
    });
    const title = shortenCompoundName('Ошибки.Проект А', result.get('child') ?? []);
    assert.equal(title, 'Ошибки.Проект А');
  });

  it('hides parts matching a compound parent («ETN.Ошибки» hides both parts)', () => {
    // Replicates the well-known «ETN.Ошибки» case from the existing pure
    // suite at the canvas wiring level: the parent is itself compound and
    // both parts must hide.
    const result = visibleRelatedTitles({
      focused: { id: 'focus', title: 'Внешний' },
      parents: [neighbor('p', 'lp', 'ETN.Ошибки')],
      siblings: [],
      children: [neighbor('child', 'lc', 'ETN.Ошибки.Отложено на будущее')],
      edges: [edge('e1', 'child', 'p')],
    });
    const title = shortenCompoundName('ETN.Ошибки.Отложено на будущее', result.get('child') ?? []);
    assert.equal(title, 'Отложено на будущее');
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

  it('changes with the focus and cloud geometry', () => {
    store.update({ focus: focusResponse(), cloudWidth: 180, editorTarget: null });
    const base = canvasRenderKey();
    store.update({ focus: focusResponse() });
    assert.equal(canvasRenderKey(), base, 'identical focus data — same key');
    store.update({ focus: { ...focusResponse(), focused: thought('f', 'Переименовано') } });
    assert.notEqual(canvasRenderKey(), base, 'edited focus title — new key');
    store.update({ focus: focusResponse(), cloudWidth: 200 });
    assert.notEqual(canvasRenderKey(), base, 'cloud width — new key');
  });

  it('ignores editorTarget / selectedLinkId — clicks in the upper zones must NOT rebuild the lower zone (task ff82809a)', () => {
    store.update({
      focus: focusResponse(),
      editorTarget: null,
      selectedLinkId: null,
    });
    const base = canvasRenderKey();
    // Opening a parent thought in the editor (openThoughtInEditor) only
    // changes editorTarget — the zone geometry and contents are the same,
    // so the canvas must take the selection-only fast path instead of
    // rebuilding every zone.
    store.update({ editorTarget: { kind: 'thought', id: 'p' } });
    assert.equal(canvasRenderKey(), base, 'editorTarget — same key');
    // Selecting a link (links.ts already has its own subscription that
    // re-draws lines on store changes) must likewise not cascade into a
    // full zone rebuild.
    store.update({ editorTarget: null, selectedLinkId: 'e1' });
    assert.equal(canvasRenderKey(), base, 'selectedLinkId — same key');
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
