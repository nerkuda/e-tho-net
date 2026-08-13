/**
 * Unit tests for the realtime applier (task G8) and the IPC handler factory
 * (task G7). Pure TS — no Electron runtime required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, Thought, Link } from '@etn/shared';

import {
  RealtimeState,
  applyRealtimeEvent,
  type ApplierHooks,
} from '../src/main/realtime/applier.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';

/** Build a minimal thought record for cache assertions. */
function thought(id: string, title: string, version = 1): Thought {
  return {
    id,
    title,
    title_norm: title.toLowerCase(),
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    active: true,
    is_protected: false,
    is_root: false,
    fg_color: null,
    bg_color: null,
    font_bold: false,
    font_italic: false,
    font_underline: false,
    font_strike: false,
    version,
    created_at: '2026-08-13T00:00:00.000Z',
    created_by: 'u1',
    updated_at: '2026-08-13T00:00:00.000Z',
    updated_by: 'u1',
  };
}

function link(id: string, source: string, target: string): Link {
  return {
    id,
    source_id: source,
    target_id: target,
    type_id: null,
    active: true,
    version: 1,
    created_at: '2026-08-13T00:00:00.000Z',
    created_by: 'u1',
    updated_at: '2026-08-13T00:00:00.000Z',
    updated_by: 'u1',
  };
}

/** Base event envelope factory. */
function envelope(type: string, data: unknown, actorClientId = 'other-client'): AnyRealtimeEvent {
  return {
    type,
    seq: 1,
    ts: '2026-08-13T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: actorClientId },
    network_id: 'net-1',
    audience: 'network',
    data,
  } as AnyRealtimeEvent;
}

function makeHooks(overrides: Partial<ApplierHooks> = {}): ApplierHooks {
  return {
    getClientId: () => 'my-client',
    getCurrentUserId: () => 'u1',
    removeFromFocusHistoryEverywhere: () => {},
    getCurrentFocusId: () => null,
    ...overrides,
  };
}

describe('Realtime applier (G8)', () => {
  it('suppresses own-client echo', () => {
    const state = new RealtimeState();
    const result = applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('thought.created', { thought: thought('t1', 'T') }, 'my-client'),
    );
    assert.equal(result.applied, false);
    assert.equal(state.getThought('t1'), null);
  });

  it('applies thought.created into the cache', () => {
    const state = new RealtimeState();
    const result = applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('thought.created', { thought: thought('t1', 'T') }),
    );
    assert.equal(result.applied, true);
    assert.equal(state.getThought('t1')?.title, 'T');
  });

  it('ignores stale thought.updated versions', () => {
    const state = new RealtimeState();
    state.setThought(thought('t1', 'Old', 5));
    const result = applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('thought.updated', { id: 't1', changes: { title: 'New' }, version: 3 }),
    );
    assert.equal(result.applied, false);
    assert.equal(state.getThought('t1')?.title, 'Old');
  });

  it('merges newer thought.updated versions', () => {
    const state = new RealtimeState();
    state.setThought(thought('t1', 'Old', 5));
    applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('thought.updated', { id: 't1', changes: { title: 'New' }, version: 6 }),
    );
    assert.equal(state.getThought('t1')?.title, 'New');
    assert.equal(state.getThought('t1')?.version, 6);
  });

  it('reports focus-lost when the deleted thought was focused', () => {
    const state = new RealtimeState();
    state.setThought(thought('t1', 'Focused'));
    let historyCleanups = 0;
    const result = applyRealtimeEvent(
      state,
      makeHooks({
        getCurrentFocusId: (nid) => (nid === 'net-1' ? 't1' : null),
        removeFromFocusHistoryEverywhere: () => {
          historyCleanups++;
        },
      }),
      envelope('thought.deleted', { id: 't1' }),
    );
    assert.equal(result.effect, 'focus-lost');
    assert.equal(historyCleanups, 1);
    assert.equal(state.getThought('t1'), null);
  });

  it('reports network-lost on self member.removed', () => {
    const state = new RealtimeState();
    const result = applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('member.removed', { user_id: 'u1' }),
    );
    assert.equal(result.effect, 'network-lost');
  });

  it('tracks links through create/update/delete', () => {
    const state = new RealtimeState();
    applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('link.created', { link: link('l1', 'a', 'b') }),
    );
    assert.equal(state.getLink('l1')?.source_id, 'a');
    applyRealtimeEvent(
      state,
      makeHooks(),
      envelope('link.updated', { id: 'l1', changes: { active: false }, version: 2 }),
    );
    assert.equal(state.getLink('l1')?.active, false);
    applyRealtimeEvent(state, makeHooks(), envelope('link.deleted', { id: 'l1' }));
    assert.equal(state.getLink('l1'), null);
  });
});

describe('IPC handler factory (G7)', () => {
  it('routes thoughts.create args to the REST client', async () => {
    let captured: unknown = null;
    const fakeRest = {
      createThought: async (_nid: string, input: unknown) => {
        captured = input;
        return { id: 't1' };
      },
    };
    const deps = {
      getRest: () => fakeRest as never,
    } as unknown as HandlerDeps;

    const handlers = createHandlers(deps);
    const handler = handlers.get('thoughts.create');
    assert.ok(handler);
    const result = await handler(['net-1', { title: 'Hello' }]);
    assert.deepEqual(captured, { title: 'Hello' });
    assert.deepEqual(result, { id: 't1' });
  });

  it('throws a clear error when called before connect', async () => {
    const deps = { getRest: () => null } as unknown as HandlerDeps;
    const handlers = createHandlers(deps);
    await assert.rejects(() => handlers.get('thoughts.get')!(['net-1', 't1']), /Not connected/);
  });

  it('unknown method is rejected by the registry (handler map miss)', () => {
    const deps = { getRest: () => null } as unknown as HandlerDeps;
    const handlers = createHandlers(deps);
    assert.equal(handlers.has('does.not.exist'), false);
  });
});
