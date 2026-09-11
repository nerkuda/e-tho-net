/**
 * Regression test for ETN error dc4e0c07 «Переключение слоя не сбрасывает
 * открытый редактор мысли: сырая ошибка not found вместо корректного
 * состояния».
 *
 * The scenario: a thought that exists only in a non-base layer is open in
 * the editor; the user switches the tab to a layer where that thought does
 * not exist (e.g. the base). The server correctly returns 404 from
 * `thoughts.focus` for the now-missing id — but the renderer used to swallow
 * that 404 silently, leaving `store.state.focus` pointing at the stale row.
 * The editor then kept rendering the cached entity from the previous layer
 * while every property fetch 404'd with a raw server string visible in the
 * UI.
 *
 * The fix lives in `lib/layer-resync.ts` (the canvas-free helper module that
 * the layer switch in `app.ts` delegates to). These tests pin the helper
 * layer directly: focus refresh that 404s → fallback to HOME; focus refresh
 * that succeeds → focus is left alone. The DOM side of the editor (the
 * render-signature update that also forces a rebuild on layer switch) is
 * covered by the existing renderer tests — exercising it requires a full
 * DOM mount.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought } from '@etn/shared';

interface EtnCalls {
  focus: { nid: string; id: string }[];
  structuresQuery: { nid: string }[];
  thoughtsGet: { nid: string; id: string }[];
}

let calls: EtnCalls;

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
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
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFocusResponse(focusedId: string): FocusResponse {
  const t = makeThought({ id: focusedId });
  return {
    focused: t,
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/**
 * Decides which `thoughts.focus` calls fail. Identifiers in `notFound` 404;
 * everything else resolves via `resolveFocus`.
 */
function installFakeApi(opts: {
  resolveFocus: (id: string) => FocusResponse;
  notFound?: Set<string>;
  rootThoughtId: string;
}): void {
  calls = { focus: [], structuresQuery: [], thoughtsGet: [] };
  const notFound = opts.notFound ?? new Set<string>();
  const api: any = {
    thoughts: {
      focus: async (nid: string, id: string) => {
        calls.focus.push({ nid, id });
        if (notFound.has(id)) {
          // The real server sends `Error: thought <id> not found` for this
          // case — preserve the message so `refreshFocusOrNull` rejects the
          // same way it would in production.
          throw new Error(`thought ${id} not found`);
        }
        return opts.resolveFocus(id);
      },
      get: async (nid: string, id: string) => {
        calls.thoughtsGet.push({ nid, id });
        return makeThought({ id, title: `T:${id}` });
      },
      setFocusOrder: async () => undefined,
    },
    structures: {
      query: async (nid: string) => {
        calls.structuresQuery.push({ nid });
        // `findRootThought` reads the first row as the root.
        return {
          items: [makeThought({ id: opts.rootThoughtId, is_root: true })],
          total: 1,
        };
      },
    },
  };
  (globalThis as any).etn = api;
}

async function importResync(): Promise<{
  refreshFocusOrNull: (nid: string) => Promise<FocusResponse | null>;
  resetFocusToHome: (nid: string) => Promise<FocusResponse | null>;
}> {
  // The module reads `globalThis.etn` lazily, so it sees the fake installed
  // above once we import it dynamically.
  const mod = await import('../src/renderer/lib/layer-resync.js');
  return mod as any;
}

async function importStore(): Promise<{ update: (p: any) => void; state: any }> {
  const mod = await import('../src/renderer/state.js');
  return mod.store as any;
}

describe('layer-resync helpers (dc4e0c07)', () => {
  it('refreshFocusOrNull возвращает null, если мысль отсутствует в текущем слое', async () => {
    installFakeApi({
      resolveFocus: (id) => makeFocusResponse(id),
      notFound: new Set(['layer-only-thought']),
      rootThoughtId: 'home-id',
    });
    const { refreshFocusOrNull } = await importResync();
    const store = await importStore();
    store.update({
      networkId: 'n1',
      focus: makeFocusResponse('layer-only-thought'),
    });

    const result = await refreshFocusOrNull('n1');

    assert.equal(result, null, 'должен вернуть null при 404 на thoughts.focus');
    // The store's focus must NOT have been overwritten by a failing call.
    assert.equal(store.state.focus?.focused.id, 'layer-only-thought');
  });

  it('refreshFocusOrNull сохраняет фокус и обновляет store при успехе', async () => {
    installFakeApi({
      resolveFocus: (id) => makeFocusResponse(id),
      rootThoughtId: 'home-id',
    });
    const { refreshFocusOrNull } = await importResync();
    const store = await importStore();
    store.update({
      networkId: 'n1',
      focus: makeFocusResponse('old-focus'),
    });

    const result = await refreshFocusOrNull('n1');

    assert.notEqual(result, null);
    assert.equal(store.state.focus?.focused.id, 'old-focus');
  });

  it('resetFocusToHome возвращает фокус HOME при успехе', async () => {
    const rootId = '00000000-0000-4000-8000-000000000001';
    installFakeApi({
      resolveFocus: (id) => makeFocusResponse(id),
      rootThoughtId: rootId,
    });
    const { resetFocusToHome } = await importResync();
    const store = await importStore();
    store.update({
      networkId: 'n1',
      focus: makeFocusResponse('layer-only-thought'),
    });

    const result = await resetFocusToHome('n1');

    assert.notEqual(result, null);
    assert.equal(store.state.focus?.focused.id, rootId);
    // The catalogue query fired exactly once (findRootThought → HOME).
    assert.equal(calls.structuresQuery.length, 1);
    assert.ok(calls.focus.some((c) => c.id === rootId));
  });

  it('resetFocusToHome возвращает null и не трогает store, если HOME недоступен', async () => {
    installFakeApi({
      resolveFocus: (id) => makeFocusResponse(id),
      rootThoughtId: '00000000-0000-4000-8000-000000000001',
    });
    // Override structures.query to make HOME unreachable.
    const api: any = (globalThis as any).etn;
    api.structures.query = async () => {
      throw new Error('catalogue unreachable');
    };
    const { resetFocusToHome } = await importResync();
    const store = await importStore();
    store.update({
      networkId: 'n1',
      focus: makeFocusResponse('layer-only-thought'),
    });

    const result = await resetFocusToHome('n1');

    assert.equal(result, null);
    // Previous focus preserved — better than wiping the workspace.
    assert.equal(store.state.focus?.focused.id, 'layer-only-thought');
  });
});
