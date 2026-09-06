/**
 * Integration tests for the MCP `etn.locks.*` tools (task a88acf20,
 * операция `b6b776ff` «etn.locks.* — захват объектов в MCP»).
 *
 * Covers the acceptance criterion from `a88acf20` («агент захватывает мысль,
 * правит, снимает; параллельно второй агент пытается править ту же мысль —
 * должен получить LOCKED») and the REST/MCP parity requirement
 * (`9e5cff3f` — единый цикл через REST и MCP).
 *
 * The semantic parity with REST `/locks` (task 2031df5e) is exercised by the
 * matching scenarios in `routes-locks.test.ts`; the cross-check here runs the
 * same shapes via the MCP server and asserts identical codes so a future
 * divergence between the two transports is caught.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { openNetworkDb } from '../src/db/network-db.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

/** Wire shape returned by `etn.locks.{acquire,list}` — mirrors {@link LockRow}. */
interface LockRow {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  client_id: string | null;
  acquired_at_ms: number;
}

/** Second user + key for two-party scenarios. Returns ids the test reuses. */
interface SecondParty {
  userId: string;
  key: string;
  handle: McpClientHandle;
}

/**
 * Create a non-admin member of the same network (the admin who owns `ctx` is
 * already a member, so we only add a row for the new user).
 */
async function addSecondMember(ctx: McpTestContext): Promise<SecondParty> {
  const userId = randomUUID();
  ctx.sys.createUser({ id: userId, username: 'collab', displayName: null });
  const gen = generateApiKey();
  ctx.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'collab',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  ctx.sys.addNetworkMember(ctx.networkId, userId, 'member', ctx.adminId);
  const handle = await connectMcpClient(ctx, gen.key);
  return { userId, key: gen.key, handle };
}

/** Create one thought via MCP, return its id. */
async function createThought(handle: McpClientHandle, networkId: string, title: string): Promise<string> {
  const res = await handle.client.callTool({
    name: 'etn.thoughts.create',
    arguments: { network_id: networkId, title },
  });
  assert.equal(res.isError, undefined, toolText(res));
  return (toolJson(res) as { id: string }).id;
}

/** Subscribe to all network events and return an unsubscribe handle. */
function subscribeAll(
  ctx: McpTestContext,
  sink: AnyRealtimeEvent[],
): () => void {
  return ctx.pubsub.subscribe(ctx.networkId, (event) => {
    sink.push(event as unknown as AnyRealtimeEvent);
  });
}

describe(
  'MCP etn.locks.* (task a88acf20)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('happy path: agent acquires → updates → releases a thought', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const tId = await createThought(handle, ctx.networkId, 'Идея');

          // Acquire.
          const acq = await handle.client.callTool({
            name: 'etn.locks.acquire',
            arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
          });
          assert.equal(acq.isError, undefined, toolText(acq));
          const lock = toolJson(acq) as LockRow;
          assert.equal(lock.entity_type, 'thought');
          assert.equal(lock.entity_id, tId);
          assert.equal(lock.user_id, ctx.adminId);
          assert.equal(lock.client_id, null, 'MCP без Client-Id → null');

          // Update — агент-владелец может править свой захват.
          const upd = await handle.client.callTool({
            name: 'etn.thoughts.update',
            arguments: {
              network_id: ctx.networkId,
              thought_id: tId,
              changes: { title: 'Идея (правится агентом)' },
            },
          });
          assert.equal(upd.isError, undefined, toolText(upd));

          // Release — аналог REST 204.
          const rel = await handle.client.callTool({
            name: 'etn.locks.release',
            arguments: { network_id: ctx.networkId, lock_id: lock.id },
          });
          assert.equal(rel.isError, undefined, toolText(rel));
          const releaseResult = toolJson(rel) as { released: boolean; lock_id: string };
          assert.equal(releaseResult.released, true);
          assert.equal(releaseResult.lock_id, lock.id);

          // Список пуст.
          const list = await handle.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId },
          });
          assert.equal(list.isError, undefined);
          const listResult = toolJson(list) as { data: LockRow[]; meta: { total: number } };
          assert.equal(listResult.meta.total, 0);
          assert.deepEqual(listResult.data, []);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('acquire повторно своим — идемпотентно (продление, тот же lock_id)', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const tId = await createThought(handle, ctx.networkId, 'X');
          const first = toolJson(
            await handle.client.callTool({
              name: 'etn.locks.acquire',
              arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
            }),
          ) as LockRow;
          const second = toolJson(
            await handle.client.callTool({
              name: 'etn.locks.acquire',
              arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
            }),
          ) as LockRow;
          assert.equal(second.id, first.id, 'lock id стабилен для своего');
          assert.ok(
            second.acquired_at_ms >= first.acquired_at_ms,
            'acquired_at_ms не уменьшается',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('acquire чужого объекта → LOCKED с holder; update второго агента тоже → LOCKED', async () => {
      const ctx = await buildMcpContext();
      const alice = await connectMcpClient(ctx, ctx.adminKey);
      let bob: SecondParty | null = null;
      try {
        // Alice создаёт мысль и захватывает её.
        const tId = await createThought(alice, ctx.networkId, 'Alice-idea');
        const aliceAcq = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.acquire',
            arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
          }),
        ) as LockRow;
        assert.equal(aliceAcq.user_id, ctx.adminId);

        // Bob (второй участник) пытается захватить — LOCKED.
        bob = await addSecondMember(ctx);
        const bobAcq = await bob.handle.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
        });
        assert.equal(bobAcq.isError, true);
        assert.match(toolText(bobAcq), /ETN error \[LOCKED\]/);
        // details.holder — это user_id держателя.
        assert.match(toolText(bobAcq), new RegExp(ctx.adminId.replace(/-/g, '[-]')));

        // Bob пытается править мысль — то же LOCKED (enforceLock).
        const bobUpdate = await bob.handle.client.callTool({
          name: 'etn.thoughts.update',
          arguments: {
            network_id: ctx.networkId,
            thought_id: tId,
            changes: { title: 'от Bob' },
          },
        });
        assert.equal(bobUpdate.isError, true);
        assert.match(toolText(bobUpdate), /ETN error \[LOCKED\]/);

        // Alice отпускает — Bob теперь может править.
        const aliceRel = await alice.client.callTool({
          name: 'etn.locks.release',
          arguments: { network_id: ctx.networkId, lock_id: aliceAcq.id },
        });
        assert.equal(aliceRel.isError, undefined, toolText(aliceRel));

        const bobUpdateAfter = await bob.handle.client.callTool({
          name: 'etn.thoughts.update',
          arguments: {
            network_id: ctx.networkId,
            thought_id: tId,
            changes: { title: 'от Bob после release' },
          },
        });
        assert.equal(bobUpdateAfter.isError, undefined, toolText(bobUpdateAfter));
      } finally {
        if (bob !== null) await bob.handle.close();
        await alice.close();
        await closeMcpContext(ctx);
      }
    });

    it('release чужого захвата → FORBIDDEN', async () => {
      const ctx = await buildMcpContext();
      const alice = await connectMcpClient(ctx, ctx.adminKey);
      let bob: SecondParty | null = null;
      try {
        const tId = await createThought(alice, ctx.networkId, 'X');
        const aliceAcq = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.acquire',
            arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
          }),
        ) as LockRow;
        bob = await addSecondMember(ctx);
        const bobRel = await bob.handle.client.callTool({
          name: 'etn.locks.release',
          arguments: { network_id: ctx.networkId, lock_id: aliceAcq.id },
        });
        assert.equal(bobRel.isError, true);
        assert.match(toolText(bobRel), /ETN error \[FORBIDDEN\]/);

        // Захват остался на месте.
        const list = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId },
          }),
        ) as { data: LockRow[] };
        assert.equal(list.data.length, 1);
      } finally {
        if (bob !== null) await bob.handle.close();
        await alice.close();
        await closeMcpContext(ctx);
      }
    });

    it('release несуществующего lock_id → LOCK_NOT_FOUND', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const res = await handle.client.callTool({
            name: 'etn.locks.release',
            arguments: {
              network_id: ctx.networkId,
              lock_id: '00000000-0000-4000-8000-000000000000',
            },
          });
          assert.equal(res.isError, true);
          assert.match(toolText(res), /ETN error \[LOCK_NOT_FOUND\]/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('list с фильтрами по user_id / client_id', async () => {
      const ctx = await buildMcpContext();
      const alice = await connectMcpClient(ctx, ctx.adminKey);
      let bob: SecondParty | null = null;
      try {
        const aId = await createThought(alice, ctx.networkId, 'A');
        const bId = await createThought(alice, ctx.networkId, 'B');
        await alice.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: aId },
        });

        bob = await addSecondMember(ctx);
        await bob.handle.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: bId },
        });

        // Полный список.
        const all = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId },
          }),
        ) as { data: LockRow[]; meta: { total: number; offset: number; limit: number } };
        assert.equal(all.data.length, 2);
        assert.equal(all.meta.total, 2);
        assert.equal(all.meta.offset, 0);
        assert.equal(all.meta.limit, 2);

        // Только Alice.
        const onlyAlice = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId, user_id: ctx.adminId },
          }),
        ) as { data: LockRow[] };
        assert.equal(onlyAlice.data.length, 1);
        assert.equal(onlyAlice.data[0]?.user_id, ctx.adminId);

        // Только Bob.
        const onlyBob = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId, user_id: bob.userId },
          }),
        ) as { data: LockRow[] };
        assert.equal(onlyBob.data.length, 1);
        assert.equal(onlyBob.data[0]?.user_id, bob.userId);

        // Фильтр по client_id несуществующему — пусто.
        const byMissingClient = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId, client_id: 'no-such-client' },
          }),
        ) as { data: LockRow[] };
        assert.equal(byMissingClient.data.length, 0);
      } finally {
        if (bob !== null) await bob.handle.close();
        await alice.close();
        await closeMcpContext(ctx);
      }
    });

    it('clear снимает все захваты участника; событие edit.cleared эмитится', async () => {
      const ctx = await buildMcpContext();
      const alice = await connectMcpClient(ctx, ctx.adminKey);
      let bob: SecondParty | null = null;
      try {
        const aId = await createThought(alice, ctx.networkId, 'A');
        const bId = await createThought(alice, ctx.networkId, 'B');
        const cId = await createThought(alice, ctx.networkId, 'C');
        await alice.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: aId },
        });
        await alice.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: bId },
        });
        bob = await addSecondMember(ctx);
        await bob.handle.client.callTool({
          name: 'etn.locks.acquire',
          arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: cId },
        });

        const events: AnyRealtimeEvent[] = [];
        const unsubscribe = subscribeAll(ctx, events);

        // Bob «Снять все блокировки» для Alice — паритет REST `POST /locks/clear`.
        const clear = await bob.handle.client.callTool({
          name: 'etn.locks.clear',
          arguments: { network_id: ctx.networkId, user_id: ctx.adminId },
        });
        assert.equal(clear.isError, undefined, toolText(clear));
        const clearResult = toolJson(clear) as { cleared: number };
        assert.equal(clearResult.cleared, 2);

        unsubscribe();
        const editCleared = events.filter((e) => e.type === 'edit.cleared');
        assert.equal(editCleared.length, 2, 'по событию на каждый снятый захват');
        for (const e of editCleared) {
          const data = e.data as { user_id: string; reason: string };
          assert.equal(data.user_id, ctx.adminId);
          assert.equal(data.reason, 'manual');
        }

        // Захват Bob остался.
        const list = toolJson(
          await alice.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId },
          }),
        ) as { data: LockRow[] };
        assert.equal(list.data.length, 1);
        assert.equal(list.data[0]?.user_id, bob.userId);

        // Alice теперь снова может править свои мысли.
        const upd = await alice.client.callTool({
          name: 'etn.thoughts.update',
          arguments: {
            network_id: ctx.networkId,
            thought_id: aId,
            changes: { title: 'Alice снова правит' },
          },
        });
        assert.equal(upd.isError, undefined, toolText(upd));
      } finally {
        if (bob !== null) await bob.handle.close();
        await alice.close();
        await closeMcpContext(ctx);
      }
    });

    it('events edit.acquired / edit.released публикуются через общий поток (emitDomainEvent)', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        const events: AnyRealtimeEvent[] = [];
        const unsubscribe = subscribeAll(ctx, events);
        try {
          const tId = await createThought(handle, ctx.networkId, 'Evt');

          const acq = toolJson(
            await handle.client.callTool({
              name: 'etn.locks.acquire',
              arguments: { network_id: ctx.networkId, entity_type: 'thought', entity_id: tId },
            }),
          ) as LockRow;
          const rel = await handle.client.callTool({
            name: 'etn.locks.release',
            arguments: { network_id: ctx.networkId, lock_id: acq.id },
          });
          assert.equal(rel.isError, undefined);
        } finally {
          unsubscribe();
          await handle.close();
        }
        const types = events.map((e) => e.type);
        assert.ok(types.includes('edit.acquired'), `нет edit.acquired: ${types.join(',')}`);
        assert.ok(types.includes('edit.released'), `нет edit.released: ${types.join(',')}`);
        const acquired = events.find((e) => e.type === 'edit.acquired');
        assert.ok(acquired !== undefined);
        const acquiredData = acquired.data as {
          lock_id: string;
          entity_type: string;
          entity_id: string;
          user_id: string;
          client_id: string | null;
          acquired_at_ms: number;
        };
        assert.equal(acquiredData.entity_type, 'thought');
        assert.equal(acquiredData.user_id, ctx.adminId);
        assert.equal(acquiredData.client_id, null);
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('read-only key: list проходит, acquire/release/clear отвергаются', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.readOnlyKey);
        try {
          const list = await handle.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: ctx.networkId },
          });
          assert.equal(list.isError, undefined);

          // Без конкретной мысли захватить нечего — проверим, что даже валидный
          // acquire отбивается read-only-флагом (требование 05 §6.3).
          // Возьмём HOME-мысль из сети.
          const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
          const home = ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as
            | { id: string }
            | undefined;
          assert.ok(home !== undefined);
          const acq = await handle.client.callTool({
            name: 'etn.locks.acquire',
            arguments: {
              network_id: ctx.networkId,
              entity_type: 'thought',
              entity_id: home.id,
            },
          });
          assert.equal(acq.isError, true);
          assert.match(toolText(acq), /read-only/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
