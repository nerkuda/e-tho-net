/**
 * Regression test for «Назначить иконкой мысли» not repainting the UI
 * (bug fixes/045).
 *
 * The attachments-tab command used to patch only `store.focus.focused` and
 * drop the canvas ref cache. When the edited thought was NOT the focused one
 * (opened in the editor via a canvas click / the structures / chronicle
 * view) nothing repainted at all: the editor header kept the stale entity,
 * the zone cloud kept the stale cached ref, the pinned bar / history bar and
 * the structures results were never refreshed — until the user switched the
 * focus to another thought and back.
 *
 * The reflection logic now lives in `reflectThoughtUpdate` (editor.ts) and is
 * shared by `saveThought` and the icon command; these tests pin its per-view
 * contracts. Runs under Node with a minimal `window` shim — no DOM needed:
 * nothing is mounted, so `store.update` has no subscribers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtRef } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `window` shim: `scheduleRefresh` arms `window.setTimeout`; its callback
 *  refetches the focus through the (stubbed) API and must not crash. */
function shimDom(): void {
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.etn = { thoughts: { focus: async () => null } };
}

function makeThought(id: string, overrides: Partial<Thought> = {}): Thought {
  return {
    id,
    title: id,
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
    ...overrides,
  };
}

function makeFocus(focused: Thought, children: string[] = []): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: children.map((id) => ({
      id,
      title: id,
      type_id: null,
      icon: null,
      active: true,
      link_id: `link-${id}`,
      link_type_id: null,
      link_active: true,
      has_incoming: false,
      has_outgoing: true,
      manual_position: null,
    })),
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

function makeRef(id: string): ThoughtRef {
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
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

describe('reflectThoughtUpdate — «Назначить иконкой мысли» repaint (fixes/045)', () => {
  it('replaces the focused thought so the focus cloud and the editor repaint', async () => {
    shimDom();
    const { reflectThoughtUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({ focus: makeFocus(makeThought('f')), editorTarget: null });
    const updated = makeThought('f', {
      icon: 'data:image/png;base64,AAA',
      icon_kind: 'image',
      version: 2,
    });

    reflectThoughtUpdate(updated);

    assert.equal(
      store.state.focus?.focused,
      updated,
      'the focus passenger must become the updated entity (same reference)',
    );
    assert.equal(store.state.focus?.focused.icon, 'data:image/png;base64,AAA');
  });

  it('refreshes the picked editor target (canvas click) — the editor header re-renders', async () => {
    shimDom();
    const { reflectThoughtUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    // Focus stays on another thought; the editor was opened on 't1' by a
    // canvas click — the full entity rides inside the target.
    store.update({
      focus: makeFocus(makeThought('f')),
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought('t1') },
    });
    const updated = makeThought('t1', {
      icon: 'data:image/png;base64,AAA',
      icon_kind: 'image',
      icon_attachment_id: 'att-1',
      version: 2,
    });

    reflectThoughtUpdate(updated);

    const target = store.state.editorTarget;
    assert.ok(target !== null && target.kind === 'thought');
    assert.equal(target.thought, updated, 'the target passenger must carry the new entity');
    assert.equal(store.state.structuresActiveThought, updated);
    assert.equal(store.state.structuresActiveThoughtId, 't1');
    // The focused thought is NOT 't1' — the focus must stay untouched.
    assert.equal(store.state.focus?.focused.id, 'f');
  });

  it('refreshes the structures/chronicle passenger when the target has no payload', async () => {
    shimDom();
    const { reflectThoughtUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({
      focus: makeFocus(makeThought('f')),
      editorTarget: { kind: 'thought', id: 't1' },
      structuresActiveThought: makeThought('t1'),
    });
    const updated = makeThought('t1', { icon: '💥', version: 2 });

    reflectThoughtUpdate(updated);

    const target = store.state.editorTarget;
    assert.ok(target !== null && target.kind === 'thought');
    assert.equal(target.thought, undefined, 'a payload-less target must stay payload-less');
    assert.equal(store.state.structuresActiveThought, updated);
  });

  it('drops the cached canvas ref of a focus neighbour so its cloud re-resolves', async () => {
    shimDom();
    const { reflectThoughtUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { canvasInternals } = await import('../src/renderer/canvas/canvas.js');

    // 't1' is a child zone cloud of the current focus with a cached ref.
    store.update({ focus: makeFocus(makeThought('f'), ['t1']) });
    canvasInternals.refCache.set('t1', makeRef('t1'));
    const updated = makeThought('t1', { icon: '💥', version: 2 });

    reflectThoughtUpdate(updated);

    assert.equal(
      canvasInternals.refCache.has('t1'),
      false,
      'the stale ref must be evicted before the scheduled focus refresh re-resolves it',
    );
  });

  it('leaves a thought that is neither focused nor a neighbour untouched in the store', async () => {
    shimDom();
    const { reflectThoughtUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    const focusBefore = makeFocus(makeThought('f'));
    store.update({ focus: focusBefore, editorTarget: null });

    reflectThoughtUpdate(makeThought('elsewhere', { icon: '💥', version: 2 }));

    assert.equal(store.state.focus, focusBefore, 'an unrelated thought must not touch the focus');
  });
});
