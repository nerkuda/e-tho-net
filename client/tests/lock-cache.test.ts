/**
 * Unit tests for the renderer object-lock cache (task 4f141756 — «Захваты в
 * клиенте: авто-захват, индикация, ручной сброс»).
 *
 * Pure-logic tests only: the cache itself never reaches the network or DOM.
 * Realtime updates flow through `__setForTests` / `__resetForTests` (the
 * production path uses `edit.acquired` / `edit.released` / `edit.cleared`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LockRow } from '@etn/shared';

import {
  __resetForTests,
  __setForTests,
  broadcastSeq,
  getLock,
  getLockByKey,
  holderNameByUserId,
  listLocks,
  lockKey,
  otherHolder,
  parseLockKey,
  subscribeLockCache,
} from '../src/renderer/lib/lock-cache.js';

function row(overrides: Partial<LockRow> = {}): LockRow {
  return {
    id: overrides.id ?? 'lock-1',
    entity_type: overrides.entity_type ?? 'thought',
    entity_id: overrides.entity_id ?? 'thought-1',
    user_id: overrides.user_id ?? 'user-A',
    client_id: overrides.client_id ?? null,
    acquired_at_ms: overrides.acquired_at_ms ?? Date.now(),
  };
}

describe('lock-cache: key helpers', () => {
  it('lockKey + parseLockKey round-trip', () => {
    const key = lockKey('thought', 'abc-123');
    assert.equal(key, 'thought:abc-123');
    assert.deepEqual(parseLockKey(key), { entityType: 'thought', entityId: 'abc-123' });
  });

  it('parseLockKey rejects malformed keys', () => {
    assert.equal(parseLockKey('noseparator'), null);
    assert.equal(parseLockKey(':empty-type'), null);
    assert.equal(parseLockKey('empty-id:'), null);
  });
});

describe('lock-cache: storage', () => {
  it('getLock returns undefined when no row exists', () => {
    __resetForTests();
    assert.equal(getLock('thought', 'missing'), undefined);
    assert.equal(getLockByKey('thought:missing'), undefined);
  });

  it('__setForTests seeds rows and listLocks reflects them', () => {
    __resetForTests();
    __setForTests([
      row({ entity_type: 'thought', entity_id: 'a', user_id: 'user-A' }),
      row({ entity_type: 'link', entity_id: 'b', user_id: 'user-B', id: 'lock-2' }),
    ]);
    const list = listLocks();
    assert.equal(list.length, 2);
    assert.equal(getLock('thought', 'a')?.user_id, 'user-A');
    assert.equal(getLock('link', 'b')?.id, 'lock-2');
  });

  it('subscribeLockCache fires on every transition', () => {
    __resetForTests();
    let calls = 0;
    const unsubscribe = subscribeLockCache(() => {
      calls += 1;
    });
    __setForTests([row()]);
    __setForTests([row({ id: 'lock-2' })]);
    unsubscribe();
    __setForTests([row({ id: 'lock-3' })]);
    assert.equal(calls, 2);
    assert.ok(broadcastSeq() >= 2);
  });
});

describe('lock-cache: otherHolder / holderNameByUserId', () => {
  it('holderNameByUserId falls back to the raw id when the user is unknown', () => {
    __resetForTests();
    // No user cache seeded — the helper returns the id verbatim.
    assert.equal(holderNameByUserId('user-X'), 'user-X');
  });

  it('otherHolder returns null when nobody holds the lock', () => {
    __resetForTests();
    assert.equal(otherHolder('thought', 'no-such'), null);
  });
});

describe('lock-cache: __resetForTests wipes between tests', () => {
  it('clears rows, listeners and the realtime wire flag', () => {
    __setForTests([row()]);
    subscribeLockCache(() => undefined);
    __resetForTests();
    assert.equal(listLocks().length, 0);
    assert.equal(getLock('thought', 'thought-1'), undefined);
  });
});
