/**
 * Контракт lib/link-ops (ошибка 6dcd6db7, 0.8.1): жёстовые потоки холста и
 * диалоги добавления строят рёбра пакетными операциями `POST /thoughts/batch`
 * — `POST/DELETE /links` сняты. Здесь фиксируются точные payload'ы каждой
 * обёртки (op/ids/args) и поведение `throwOnFailures`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { ensureLink, unlinkParents, unlinkChildren, setOnlyParents, throwOnFailures } =
  await import('../src/renderer/lib/link-ops.js');

/** Фальшивый `window.etn` с записью batch-вызовов. */
function fakeBatch(): { calls: any[]; api: any } {
  const calls: any[] = [];
  const api = {
    thoughts: {
      batch: async (networkId: string, input: unknown) => {
        calls.push({ networkId, input });
        return { affected: 1, failures: [] };
      },
    },
  };
  (globalThis as any).etn = api;
  return { calls, api };
}

describe('lib/link-ops — пакетные payload' + 'ы рёбер (6dcd6db7)', () => {
  it('ensureLink creates source→target via link_parents on the target', async () => {
    const { calls } = fakeBatch();
    try {
      await ensureLink('net1', 'src', 'dst', 'lt-1');
      await ensureLink('net1', 'src', 'dst'); // без типа — null
    } finally {
      delete (globalThis as any).etn;
    }
    assert.deepEqual(calls, [
      { networkId: 'net1', input: { ids: ['dst'], op: 'link_parents', args: { parent_ids: ['src'], link_type_id: 'lt-1' } } },
      { networkId: 'net1', input: { ids: ['dst'], op: 'link_parents', args: { parent_ids: ['src'], link_type_id: null } } },
    ]);
  });

  it('unlinkParents / unlinkChildren target the right direction', async () => {
    const { calls } = fakeBatch();
    try {
      await unlinkParents('net1', 'id', ['p1', 'p2']);
      await unlinkChildren('net1', 'id', ['c1']);
    } finally {
      delete (globalThis as any).etn;
    }
    assert.deepEqual(calls, [
      { networkId: 'net1', input: { ids: ['id'], op: 'unlink_parents', args: { parent_ids: ['p1', 'p2'] } } },
      { networkId: 'net1', input: { ids: ['id'], op: 'unlink_children', args: { child_ids: ['c1'] } } },
    ]);
  });

  it('setOnlyParents carries the link type for the missing link', async () => {
    const { calls } = fakeBatch();
    try {
      await setOnlyParents('net1', 'id', ['p1'], 'lt-2');
    } finally {
      delete (globalThis as any).etn;
    }
    assert.deepEqual(calls, [
      { networkId: 'net1', input: { ids: ['id'], op: 'set_only_parents', args: { parent_ids: ['p1'], link_type_id: 'lt-2' } } },
    ]);
  });

  it('throwOnFailures passes on success and throws the first failure message', () => {
    assert.doesNotThrow(() => throwOnFailures({ affected: 1, failures: [] }));
    assert.throws(
      () =>
        throwOnFailures({
          affected: 0,
          failures: [{ id: 'x', code: 'VALIDATION_ERROR', message: 'нет мысли' }],
        }),
      /нет мысли/,
    );
  });
});
