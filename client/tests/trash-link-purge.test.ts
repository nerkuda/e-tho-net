/**
 * «Удалить совсем» одной связи после 0.8.1 (ошибка 8b4b7a7e).
 *
 * `DELETE /links/{id}` снят (требование 3ea5c6af) — жёсткое удаление ребра
 * идёт через корзину: пометка «marked_for_deletion» (если не стоит) + точечный
 * `POST /trash/purge { ids: [id] }`. Здесь гоняем настоящий
 * {@link purgeLinkCompletely} из рендерера с фальшивым `window.etn` и
 * проверяем порядок вызовов — и что `links.remove` не зовётся вовсе.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

import { purgeLinkCompletely } from '../src/renderer/trash.js';

interface Call {
  method: string;
  args: unknown[];
}

/** Fake `window.etn` recording every call; `purgeCount` seeds the purge result. */
function fakeEtn(purgedCount: number): { calls: Call[]; api: any } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      if (method === 'links.get') return { version: 7 };
      if (method === 'trash.purge') return { purged: purgedCount, skipped: 0 };
      return {};
    };
  const api = {
    links: {
      get: record('links.get'),
      update: record('links.update'),
      remove: record('links.remove'),
    },
    trash: { purge: record('trash.purge') },
  };
  return { calls, api };
}

describe('purgeLinkCompletely (8b4b7a7e)', () => {
  it('unmarked link: PATCH into the trash, then a targeted purge by id', async () => {
    const { calls, api } = fakeEtn(1);
    (globalThis as any).etn = api;
    try {
      assert.equal(await purgeLinkCompletely('net1', 'link-1', false), true);
    } finally {
      delete (globalThis as any).etn;
    }
    assert.deepEqual(calls.map((c) => c.method), ['links.get', 'links.update', 'trash.purge']);
    const update = calls[1]!;
    assert.equal(update.args[0], 'net1');
    assert.equal(update.args[1], 'link-1');
    assert.deepEqual(update.args[2], { marked_for_deletion: true });
    assert.equal(update.args[3], 7, 'If-Match берётся из links.get');
    assert.deepEqual(calls[2]!.args, ['net1', ['link-1']], 'purge получает ровно один id');
  });

  it('already-marked link: no PATCH, the purge runs directly', async () => {
    const { calls, api } = fakeEtn(1);
    (globalThis as any).etn = api;
    try {
      assert.equal(await purgeLinkCompletely('net1', 'link-2', true), true);
    } finally {
      delete (globalThis as any).etn;
    }
    assert.deepEqual(calls.map((c) => c.method), ['trash.purge']);
    assert.deepEqual(calls[0]!.args, ['net1', ['link-2']]);
  });

  it('blocked row (purged 0) reports failure without links.remove', async () => {
    const { calls, api } = fakeEtn(0);
    (globalThis as any).etn = api;
    try {
      assert.equal(await purgeLinkCompletely('net1', 'link-3', true), false);
    } finally {
      delete (globalThis as any).etn;
    }
    assert.ok(
      calls.every((c) => c.method !== 'links.remove'),
      'снятый DELETE /links/{id} не должен зваться',
    );
  });
});
