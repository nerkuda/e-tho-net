/**
 * Regression test for the editor-shaking-on-WS-event bug (ETN error
 * 206e33a1 «Бессмысленное обновление редактора при получении внешних
 * событий»).
 *
 * The chain of symptoms that produced the bug:
 *
 *  1. A `comment.*` event for ANY thought in the network arrived at the
 *     renderer via the realtime bridge.
 *  2. `applyRealtimeToUi` (realtime-ui.ts) called `scheduleRefresh()` for
 *     every comment event, even though comments are sub-objects that never
 *     change the focus response (parents/children/siblings/edges).
 *  3. `scheduleRefresh()` arms a 200 ms debounce → `refreshFocus()` → store
 *     update with the freshly-fetched focus response.
 *  4. The editor's `store.subscribe` callback fired on every store update;
 *     its signature guard could no-op most of the time, but the rebuild
 *     path was reachable (link events, focus refresh with new edges) — and
 *     even when it no-op'd, the CodeMirror field's caret could shift from
 *     sibling layout work.
 *
 * The fix has two parts:
 *
 *  a) `realtime-ui.ts` stops calling `scheduleRefresh()` for `comment.*`
 *     events. The editor's own realtime hook (`wireCommentRealtime` in
 *     comments.ts) handles foreign comment changes for the open entity
 *     in place — patching the comment view via `setMarkdownField` rather
 *     than rebuilding the editor. The canvas indicator cache is invalidated
 *     separately so the 📝 badge stays in sync.
 *
 *  b) The editor's `store.subscribe` callback now short-circuits when the
 *     open entity (id + version) is unchanged. Even if some future event
 *     slips a store update past the realtime handler, the editor DOM is
 *     left alone.
 *
 * These tests pin the (a) half — the focus-refresh trigger that was the
 * primary offender. The (b) half is exercised end-to-end by the renderer
 * store subscription wiring and is covered indirectly by every editor test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, Comment, Thought } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Captures every store notification triggered after the journal is armed. */
const storeNotifications: string[] = [];

function resetState(): void {
  storeNotifications.length = 0;
}

/** `window` shim with `etn.ui.setState` and the realtime mock. */
function shimWindow(): void {
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.etn = {
    thoughts: {
      focus: async () => {
        throw new Error('focus not expected in this test');
      },
    },
    ui: { setState: async () => undefined },
  };
}

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

function makePermanent(commentId: string, ownerId: string, bodyMd: string): Comment {
  return {
    id: commentId,
    owner_type: 'thought',
    owner_id: ownerId,
    targets: [{ owner_type: 'thought', owner_id: ownerId }],
    kind: 'permanent',
    title: null,
    body_md: bodyMd,
    body_html: `<p>${bodyMd}</p>`,
    valid_from: '2024-01-01T00:00:00.000Z',
    valid_to: null,
    version: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    created_by: 'u1',
    updated_by: 'u1',
  };
}

/**
 * Sends an arbitrary realtime event through `applyRealtimeToUi` and flushes
 * the 200 ms `scheduleRefresh` debounce. After it resolves, any `store.update`
 * that the event caused will have landed — if NONE has, the event was
 * handled without a focus refresh (the fix).
 */
async function deliverEvent(evt: AnyRealtimeEvent): Promise<void> {
  const { applyRealtimeToUi } = await import('../src/renderer/realtime-ui.js');
  applyRealtimeToUi(evt);
  await new Promise<void>((r) => setTimeout(r, 250));
}

/**
 * Sets up the store with a focused thought and arms a subscription that
 * journals every subsequent `store.update`. Returns the journal for
 * assertion.
 */
async function armStoreJournal(): Promise<void> {
  resetState();
  shimWindow();
  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    editorTarget: null,
    focus: {
      focused: makeThought(),
      parents: [],
      children: [],
      siblings: [],
      edges: [],
      sorts: {
        parents: { sort: 'created', order: 'asc' },
        children: { sort: 'created', order: 'asc' },
        siblings: { sort: 'created', order: 'asc' },
      },
    },
  } as any);
  // The setup `store.update` fires its own subscriber once — drop those
  // entries; we only want notifications triggered by the event under test.
  storeNotifications.length = 0;
  store.subscribe(() => {
    storeNotifications.push('store.update');
  });
}

describe('realtime events — focus must NOT refresh for comment.* (206e33a1)', () => {
  it('comment.updated для любой мысли не вызывает refresh фокуса', async () => {
    await armStoreJournal();

    await deliverEvent({
      type: 'comment.updated',
      seq: 1,
      ts: '2024-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      audience: 'network',
      network_id: 'n1',
      layer_id: 'base',
      data: { id: 'c1', changes: { body_md: 'новый текст' }, version: 2 },
      meta: { version: 1 },
    });

    assert.equal(
      storeNotifications.length,
      0,
      `comment.updated не должен вызывать store.update; получено ${storeNotifications.length} обновлений`,
    );
  });

  it('comment.created для мысли в neighbourhood не вызывает refresh фокуса', async () => {
    await armStoreJournal();

    await deliverEvent({
      type: 'comment.created',
      seq: 1,
      ts: '2024-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      audience: 'network',
      network_id: 'n1',
      layer_id: 'base',
      data: { comment: makePermanent('c1', 't1', 'сосед') },
      meta: { version: 1 },
    });

    assert.equal(
      storeNotifications.length,
      0,
      `comment.created не должен вызывать store.update; получено ${storeNotifications.length} обновлений`,
    );
  });

  it('comment.deleted не вызывает refresh фокуса', async () => {
    await armStoreJournal();

    await deliverEvent({
      type: 'comment.deleted',
      seq: 1,
      ts: '2024-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      audience: 'network',
      network_id: 'n1',
      layer_id: 'base',
      data: { owner_type: 'thought', owner_id: 't-other', id: 'c1' },
      meta: { version: 1 },
    });

    assert.equal(
      storeNotifications.length,
      0,
      `comment.deleted не должен вызывать store.update; получено ${storeNotifications.length} обновлений`,
    );
  });

  it('attachment.updated тоже не вызывает refresh фокуса', async () => {
    await armStoreJournal();

    await deliverEvent({
      type: 'attachment.updated',
      seq: 1,
      ts: '2024-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      audience: 'network',
      network_id: 'n1',
      layer_id: 'base',
      data: {
        id: 'a1',
        changes: { title: 'renamed.png' },
      },
      meta: { version: 1 },
    });

    assert.equal(
      storeNotifications.length,
      0,
      `attachment.updated не должен вызывать store.update; получено ${storeNotifications.length} обновлений`,
    );
  });
});
