/**
 * Tests for the «Снять все блокировки» command of the «Участники сети»
 * dialog (workspace-menus.ts, UI element ae74b044, bug ba1a5e40).
 *
 * Regression: a `.link-btn` in the members table used to be `disabled` when
 * the participant held no locks, but a disabled link button has no disabled
 * style — it looked clickable and silently swallowed clicks, so the user saw
 * «nothing happen». The command must always run and always report the cleared
 * count (including 0); a failed call must surface a readable error message.
 *
 * The handler is tested through its injected dependencies, without a DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearMemberLocks,
  type ClearMemberLocksDeps,
} from '../src/renderer/screens/workspace-menus.js';

interface Calls {
  confirmations: number;
  clearCalls: Array<{ networkId: string; userId: string }>;
  clearedMessages: string[];
  errorMessages: string[];
  refreshes: number;
}

/** Builds a recording dependency set around the given `clear` result. */
function makeDeps(options: {
  confirmResult?: boolean;
  clearResult?: { cleared: number };
  clearError?: Error;
}): { deps: ClearMemberLocksDeps; calls: Calls } {
  const calls: Calls = {
    confirmations: 0,
    clearCalls: [],
    clearedMessages: [],
    errorMessages: [],
    refreshes: 0,
  };
  const deps: ClearMemberLocksDeps = {
    confirm: async () => {
      calls.confirmations += 1;
      return options.confirmResult ?? true;
    },
    clear: async (networkId, userId) => {
      calls.clearCalls.push({ networkId, userId });
      if (options.clearError !== undefined) throw options.clearError;
      return options.clearResult ?? { cleared: 0 };
    },
    onCleared: (message) => {
      calls.clearedMessages.push(message);
    },
    onError: (message) => {
      calls.errorMessages.push(message);
    },
    refresh: async () => {
      calls.refreshes += 1;
    },
  };
  return { deps, calls };
}

describe('clearMemberLocks — «Снять все блокировки» (ba1a5e40)', () => {
  it('does nothing when the user declines the confirmation', async () => {
    const { deps, calls } = makeDeps({ confirmResult: false });
    await clearMemberLocks('net-1', 'u-2', 'Анна', deps);
    assert.equal(calls.confirmations, 1, 'the confirmation must be asked');
    assert.equal(calls.clearCalls.length, 0, 'no server call without confirmation');
    assert.equal(calls.clearedMessages.length, 0, 'no result message');
    assert.equal(calls.errorMessages.length, 0, 'no error message');
    assert.equal(calls.refreshes, 0, 'no refresh');
  });

  it('reports the cleared count after a successful reset', async () => {
    const { deps, calls } = makeDeps({ clearResult: { cleared: 2 } });
    await clearMemberLocks('net-1', 'u-2', 'Анна', deps);
    assert.deepEqual(calls.clearCalls, [{ networkId: 'net-1', userId: 'u-2' }]);
    assert.deepEqual(calls.clearedMessages, ['Снято блокировок: 2.']);
    assert.equal(calls.errorMessages.length, 0);
    assert.equal(calls.refreshes, 1, 'the dialog must refresh after a reset');
  });

  it('reports zero when the participant held no locks (the reported case)', async () => {
    const { deps, calls } = makeDeps({ clearResult: { cleared: 0 } });
    await clearMemberLocks('net-1', 'u-2', 'Анна', deps);
    assert.deepEqual(calls.clearedMessages, ['Снято блокировок: 0.']);
    assert.equal(calls.refreshes, 1);
  });

  it('surfaces a readable error message when the call fails', async () => {
    const { deps, calls } = makeDeps({ clearError: new Error('нет прав доступа') });
    await clearMemberLocks('net-1', 'u-2', 'Анна', deps);
    assert.equal(calls.clearedMessages.length, 0, 'no success message on failure');
    assert.deepEqual(calls.errorMessages, ['Не удалось снять блокировки: нет прав доступа']);
    assert.equal(calls.refreshes, 0, 'no refresh after a failure');
  });
});
