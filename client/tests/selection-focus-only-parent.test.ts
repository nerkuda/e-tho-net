/**
 * «Сделать единственным родителем» после 0.8.1 (ошибка 6dcd6db7):
 * `POST/DELETE /links` сняты — поток строится на живых операциях. Здесь
 * проверяется переноса типа {@link retypeFocusLinks}: PATCH получает только
 * существующая связь фокус→мысль с чужим типом; свои связи, чужие источники и
 * корректный тип не трогаются; ошибка PATCH считается по мыслям.
 *
 * Сама пересборка родителей (`set_only_parents`) — серверная пакетная
 * операция, покрытая routes-thoughts.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { retypeFocusLinks } = await import('../src/renderer/selection/selection.js');

interface Call {
  method: string;
  args: unknown[];
}

/** grouped-фикстура `GET /thoughts/{id}/links?group=type`. */
function grouped(links: Array<{ id: string; source_id: string; target_id: string; type_id: string | null; version: number }>): unknown {
  const untyped = links.filter((l) => l.type_id === null);
  return {
    by_type: links
      .filter((l) => l.type_id !== null)
      .map((l) => ({ items: [{ link: l }] })),
    untyped_parents: untyped.map((l) => ({ link: l })),
    untyped_children: [],
  };
}

/** Фальшивый `window.etn` c записью вызовов; `failOn` валид вызов update. */
function fakeEtn(linksByThought: Map<string, ReturnType<typeof grouped>>, failUpdateFor: Set<string>): { calls: Call[]; api: any } {
  const calls: Call[] = [];
  const api = {
    links: {
      listByThought: async (_n: string, id: string) => {
        calls.push({ method: 'links.listByThought', args: [_n, id] });
        return linksByThought.get(id) ?? grouped([]);
      },
      update: async (n: string, id: string, input: unknown, version: number) => {
        calls.push({ method: 'links.update', args: [n, id, input, version] });
        if (failUpdateFor.has(id)) throw new Error('boom');
        return {};
      },
      remove: async (...args: unknown[]) => {
        calls.push({ method: 'links.remove', args });
        throw new Error('снятый endpoint не должен зваться');
      },
      create: async (...args: unknown[]) => {
        calls.push({ method: 'links.create', args });
        throw new Error('снятый endpoint не должен зваться');
      },
    },
  };
  return { calls, api };
}

function install(api: any): void {
  (globalThis as any).etn = api;
}

describe('retypeFocusLinks (6dcd6db7: единственный родитель без links.create/remove)', () => {
  it('PATCHes only the focus link whose type differs; others untouched', async () => {
    const links = grouped([
      { id: 'l-keep-typed', source_id: 'focus', target_id: 't1', type_id: 'lt-old', version: 3 },
      { id: 'l-keep-ok', source_id: 'focus', target_id: 't1', type_id: 'lt-new', version: 1 },
      { id: 'l-other-src', source_id: 'x', target_id: 't1', type_id: 'lt-old', version: 1 },
      { id: 'l-outgoing', source_id: 't1', target_id: 'y', type_id: 'lt-old', version: 1 },
    ]);
    const { calls, api } = fakeEtn(new Map([['t1', links]]), new Set());
    install(api);
    try {
      assert.equal(await retypeFocusLinks('net1', 'focus', ['t1'], 'lt-new'), 0);
    } finally {
      delete (globalThis as any).etn;
    }
    const updates = calls.filter((c) => c.method === 'links.update');
    assert.deepEqual(
      updates.map((c) => [c.args[1], c.args[2], c.args[3]]),
      [['l-keep-typed', { type_id: 'lt-new' }, 3]],
      'PATCH только чужой-типной связи фокуса, с её версией',
    );
    assert.ok(calls.every((c) => c.method === 'links.update' || c.method === 'links.listByThought'));
  });

  it('null type («без типа») retypes a typed link to untyped', async () => {
    const links = grouped([
      { id: 'l-1', source_id: 'focus', target_id: 't1', type_id: 'lt-old', version: 2 },
    ]);
    const { calls, api } = fakeEtn(new Map([['t1', links]]), new Set());
    install(api);
    try {
      assert.equal(await retypeFocusLinks('net1', 'focus', ['t1'], null), 0);
    } finally {
      delete (globalThis as any).etn;
    }
    const updates = calls.filter((c) => c.method === 'links.update');
    assert.deepEqual(updates.map((c) => c.args[2]), [{ type_id: null }]);
  });

  it('counts a thought as failed when its PATCH throws; the rest proceed', async () => {
    const t1 = grouped([{ id: 'l-1', source_id: 'focus', target_id: 't1', type_id: 'a', version: 1 }]);
    const t2 = grouped([{ id: 'l-2', source_id: 'focus', target_id: 't2', type_id: 'b', version: 1 }]);
    const { calls, api } = fakeEtn(
      new Map([
        ['t1', t1],
        ['t2', t2],
      ]),
      new Set(['l-1']),
    );
    install(api);
    try {
      assert.equal(await retypeFocusLinks('net1', 'focus', ['t1', 't2'], 'c'), 1);
    } finally {
      delete (globalThis as any).etn;
    }
    const updates = calls.filter((c) => c.method === 'links.update');
    assert.equal(updates.length, 2, 't2 дошёл до PATCH несмотря на провал t1');
  });
});
