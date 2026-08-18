/**
 * MCP tools behaviour tests (task F4 DoD + F6): an agent creates a thought
 * through `etn.thoughts.create` and network participants see it through the
 * same realtime stream as human changes; the call lands in `audit_log`
 * (category `data`). Also covers find_duplicates-before-create, read-only
 * key rejection (F2), membership isolation, subgraph/export/path read tools
 * and the write-rate limit (F6).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createApiKeyAuthProvider } from '../src/mcp/auth.js';
import { openNetworkDb } from '../src/db/network-db.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

describe('MCP tools (F4)', { skip: !nativeAvailable() }, () => {
  it('find_duplicates is empty before create, then create emits realtime + audit', async () => {
    const ctx = await buildMcpContext();
    try {
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        // The broker types listeners as RealtimeEvent<E=union>; the runtime
        // envelope is a catalogue member, so re-cast (same as emit.ts).
        events.push(event as unknown as AnyRealtimeEvent);
      });
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          // Dedup check first (05 §4.3).
          const dups = await handle.client.callTool({
            name: 'etn.thoughts.find_duplicates',
            arguments: { network_id: ctx.networkId, title: 'Конкуренты 1С' },
          });
          assert.equal(dups.isError, undefined);
          assert.deepEqual(toolJson(dups), []);

          // Create with a child link to HOME.
          const created = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Конкуренты 1С',
              synonyms: ['конкуренты', 'ERP-альтернативы'],
              link: { direction: 'child', target_thought_id: ctx.homeId },
            },
          });
          assert.equal(created.isError, undefined);
          const result = toolJson<{ id: string; version: number; request_id: string }>(created);
          assert.equal(result.version, 1);
          assert.equal(typeof result.id, 'string');
          assert.equal(typeof result.request_id, 'string');

          // Second create of the same title is a duplicate.
          const dupsAfter = await handle.client.callTool({
            name: 'etn.thoughts.find_duplicates',
            arguments: { network_id: ctx.networkId, title: 'Конкуренты 1С' },
          });
          const hits = toolJson<Array<{ matched_on: string }>>(dupsAfter);
          assert.ok(hits.length >= 1);
          assert.equal(hits[0]?.matched_on, 'title');

          // The graph now has the thought linked to HOME.
          const count = openNetworkDb(ctx.dataDir, ctx.networkId)
            .prepare('SELECT COUNT(*) AS c FROM thoughts')
            .get() as { c: number };
          assert.equal(count.c, 2);
        } finally {
          await handle.close();
        }

        // Participants received thought.created (and link.created) via PubSub.
        const types = events.map((e) => e.type).sort();
        assert.ok(types.includes('thought.created'), `events: ${types.join(',')}`);
        assert.ok(types.includes('link.created'), `events: ${types.join(',')}`);
        const createdEvent = events.find((e) => e.type === 'thought.created');
        assert.ok(createdEvent !== undefined);
        assert.equal(createdEvent.actor.user_id, ctx.adminId);
      } finally {
        unsubscribe();
      }

      // The mutating call is in audit_log with category=data (F6).
      const audit = ctx.sys.queryAudit({ category: 'data' });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.action, 'etn.thoughts.create');
      assert.equal(audit[0]?.actor_user_id, ctx.adminId);
      assert.equal(audit[0]?.network_id, ctx.networkId);
      assert.equal((audit[0]?.details as { title?: string }).title, 'Конкуренты 1С');
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('read-only key: reads pass, mutating tools are rejected (F2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        const list = await handle.client.callTool({ name: 'etn.networks.list', arguments: {} });
        assert.equal(list.isError, undefined);
        assert.equal(toolJson<unknown[]>(list).length, 1);

        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Запрещено' },
        });
        assert.equal(created.isError, true);
        assert.match(toolText(created), /read-only/);
      } finally {
        await handle.close();
      }

      // Nothing was written.
      const audit = ctx.sys.queryAudit({ category: 'data' });
      assert.equal(audit.length, 0);
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('a user with a key but no membership cannot touch the network (F2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const strangerId = randomUUID();
      ctx.sys.createUser({ id: strangerId, username: 'stranger', displayName: null });
      const strangerKey = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: strangerId,
        label: 'stranger',
        keyHash: hashApiKey(strangerKey.key),
        keyPrefix: strangerKey.keyPrefix,
      });

      const handle = await connectMcpClient(ctx, strangerKey.key);
      try {
        // Networks list is empty — nothing to see.
        const list = await handle.client.callTool({ name: 'etn.networks.list', arguments: {} });
        assert.deepEqual(toolJson<unknown[]>(list), []);

        // Direct access to the admin network is forbidden.
        const get = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
        });
        assert.equal(get.isError, true);
        assert.match(toolText(get), /not a member/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('subgraph, path and export tools work over a two-node graph', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Вторая мысль',
            link: { direction: 'child', target_thought_id: ctx.homeId },
          },
        });
        const { id: childId } = toolJson<{ id: string; version: number }>(created);

        const subgraph = await handle.client.callTool({
          name: 'etn.thoughts.subgraph',
          arguments: { network_id: ctx.networkId, seed_ids: [ctx.homeId], radius: 1 },
        });
        const sub = toolJson<{
          nodes: Array<{ id: string }>;
          edges: Array<{ id: string }>;
          truncated: boolean;
        }>(subgraph);
        assert.equal(sub.nodes.length, 2);
        assert.equal(sub.edges.length, 1);
        assert.equal(sub.truncated, false);

        const path = await handle.client.callTool({
          name: 'etn.thoughts.path',
          arguments: { network_id: ctx.networkId, from_id: ctx.homeId, to_id: childId },
        });
        const pathResult = toolJson<{ path: string[] | null }>(path);
        assert.deepEqual(pathResult.path, [ctx.homeId, childId]);

        const exported = await handle.client.callTool({
          name: 'etn.export.subgraph',
          arguments: { network_id: ctx.networkId, seed_ids: [ctx.homeId], radius: 1 },
        });
        const doc = toolJson<{ format: string; content: string }>(exported);
        assert.equal(doc.format, 'markdown');
        assert.match(doc.content, /Вторая мысль/);
        assert.match(doc.content, /HOME/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('write rate limit kicks in when the L1 setting is low (F6)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Lower the limit for this server instance (resolved at creation).
      ctx.rawDb
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('mcp.max_writes_per_minute', '2', new Date().toISOString());

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Раз' },
        });
        assert.equal(first.isError, undefined);
        const second = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Два' },
        });
        assert.equal(second.isError, undefined);
        const third = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Три' },
        });
        assert.equal(third.isError, true);
        assert.match(toolText(third), /write limit|RATE_LIMITED/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.usage lists referencing thoughts grouped by property (N3)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed a thought type with a thought_ref property and two thoughts
      // linked through it (direct inserts — no MCP tool creates types).
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const typeId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thought_types (id, name, version, created_at, updated_at, created_by)
           VALUES (?, 'book', 1, '2024', '2024', 'u')`,
        )
        .run(typeId);
      const propId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO type_properties (id, owner_type, owner_id, key, value_type, required, position)
           VALUES (?, 'thought_type', ?, 'author', 'thought_ref', 0, 0)`,
        )
        .run(propId, typeId);
      const seed = (title: string): string => {
        const id = randomUUID();
        ndb
          .prepare(
            `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                   version, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024', 'u', '2024', 'u')`,
          )
          .run(id, title, title.toLowerCase(), typeId);
        return id;
      };
      const target = seed('Автор');
      const book = seed('Книга');
      ndb
        .prepare(
          `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
           VALUES (?, 'thought', ?, ?, ?, '2024')`,
        )
        .run(randomUUID(), book, propId, target);
      // NB: do not close — openNetworkDb caches the connection shared with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const res = await handle.client.callTool({
          name: 'etn.thoughts.usage',
          arguments: { network_id: ctx.networkId, thought_id: target },
        });
        assert.equal(res.isError, undefined);
        const usage = toolJson<{ total: number; groups: Array<{ key: string; thoughts: Array<{ id: string }> }> }>(res);
        assert.equal(usage.total, 1);
        assert.equal(usage.groups.length, 1);
        assert.equal(usage.groups[0]?.key, 'author');
        assert.equal(usage.groups[0]?.thoughts[0]?.id, book);

        // The referencing thought itself has no usages.
        const none = await handle.client.callTool({
          name: 'etn.thoughts.usage',
          arguments: { network_id: ctx.networkId, thought_id: book },
        });
        const noneUsage = toolJson<{ total: number; groups: unknown[] }>(none);
        assert.equal(noneUsage.total, 0);
        assert.deepEqual(noneUsage.groups, []);

        // N4: etn.thoughts.get resolves thought_ref values to {id, title}.
        const got = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: book },
        });
        const thought = toolJson<{ properties: Array<{ value: unknown }> }>(got);
        assert.deepEqual(thought.properties[0]?.value, { id: target, title: 'Автор' });

        // A dangling ref (no SQL FK) resolves to {id, title: null}.
        const orphan = seed('Мысль без ссылки');
        ndb
          .prepare(
            `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
             VALUES (?, 'thought', ?, ?, ?, '2024')`,
          )
          .run(randomUUID(), orphan, propId, randomUUID());
        const gotOrphan = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: orphan },
        });
        const orphanThought = toolJson<{ properties: Array<{ value: unknown }> }>(gotOrphan);
        const dangling = orphanThought.properties[0]?.value as { id: string; title: string | null };
        assert.equal(typeof dangling.id, 'string');
        assert.equal(dangling.title, null);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('subgraph include_comments returns previews with truncation metadata (N5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль с хронией' },
        });
        const { id } = toolJson<{ id: string }>(created);
        // 12 хронологических записей; последняя — длинная (проверка обрезки тела).
        for (let i = 0; i < 12; i++) {
          const res = await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: id,
              kind: 'chronological',
              body_md: i === 11 ? 'y'.repeat(2500) : `Запись ${i}`,
            },
          });
          assert.equal(res.isError, undefined, toolText(res));
        }

        const sub = await handle.client.callTool({
          name: 'etn.thoughts.subgraph',
          arguments: {
            network_id: ctx.networkId,
            seed_ids: [id],
            radius: 0,
            include_comments: true,
          },
        });
        assert.equal(sub.isError, undefined, toolText(sub));
        const res = toolJson<{
          comments: Array<{
            thought_id: string;
            permanent: unknown;
            chronological: {
              entries: Array<{
                body_md: string;
                chars_returned: number;
                chars_total: number;
                truncated: boolean;
              }>;
              total: number;
              returned: number;
              truncated: boolean;
            };
          }>;
        }>(sub);
        const node = res.comments.find((c) => c.thought_id === id);
        assert.ok(node, 'comments array must contain the created thought');
        assert.equal(node.permanent, null);
        assert.equal(node.chronological.total, 12);
        assert.equal(node.chronological.returned, 10);
        assert.equal(node.chronological.truncated, true);
        const longEntry = node.chronological.entries.find((e) => e.truncated);
        assert.ok(longEntry, 'the long entry must be among the returned previews');
        assert.equal(longEntry.chars_total, 2500);
        assert.equal(longEntry.chars_returned, 2000);
        assert.equal(longEntry.body_md.length, 2000);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('read tools attach type catalogues with names and descriptions (N6)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed a thought type and a link type with AI-facing descriptions
      // (direct inserts — no MCP tool creates types).
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtTypeId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thought_types (id, name, description, version, created_at, updated_at, created_by)
           VALUES (?, 'ошибка', 'Дефект: воспроизведение, ожидание, факт', 1, '2024', '2024', 'u')`,
        )
        .run(thoughtTypeId);
      const linkTypeId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO link_types (id, name_forward, name_reverse, description, version, created_at, updated_at, created_by)
           VALUES (?, 'блокирует', 'заблокирован', 'Блокировка: A не даёт завершить B', 1, '2024', '2024', 'u')`,
        )
        .run(linkTypeId);
      // NB: do not close — openNetworkDb caches the connection shared with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Баг: фокус',
            type_id: thoughtTypeId,
            link: { direction: 'child', target_thought_id: ctx.homeId, type_id: linkTypeId },
          },
        });
        const { id } = toolJson<{ id: string }>(created);

        // subgraph: both catalogues, keyed by the ids used in nodes/edges.
        const sub = await handle.client.callTool({
          name: 'etn.thoughts.subgraph',
          arguments: { network_id: ctx.networkId, seed_ids: [ctx.homeId], radius: 1 },
        });
        const sg = toolJson<{
          nodes: Array<{ id: string; type_id: string | null }>;
          edges: Array<{ type_id: string | null }>;
          thought_types: Record<string, { name: string; description: string | null }>;
          link_types: Record<
            string,
            { name_forward: string; name_reverse: string; description: string | null }
          >;
        }>(sub);
        assert.ok(sg.thought_types[thoughtTypeId], 'thought type of a node must be catalogued');
        assert.equal(sg.thought_types[thoughtTypeId]?.name, 'ошибка');
        assert.match(sg.thought_types[thoughtTypeId]?.description ?? '', /Дефект/);
        assert.ok(sg.link_types[linkTypeId], 'link type of an edge must be catalogued');
        assert.equal(sg.link_types[linkTypeId]?.name_forward, 'блокирует');
        assert.equal(sg.link_types[linkTypeId]?.name_reverse, 'заблокирован');
        assert.match(sg.link_types[linkTypeId]?.description ?? '', /Блокировка/);

        // neighbors: the neighbour's link_type_id resolves through the catalogue.
        const neigh = await handle.client.callTool({
          name: 'etn.thoughts.neighbors',
          arguments: { network_id: ctx.networkId, thought_id: ctx.homeId, dir: 'children' },
        });
        const nb = toolJson<{
          neighbors: Array<{ link_type_id: string | null; type_id: string | null }>;
          link_types: Record<string, unknown>;
          thought_types: Record<string, unknown>;
        }>(neigh);
        assert.equal(nb.neighbors[0]?.link_type_id, linkTypeId);
        assert.ok(nb.link_types[linkTypeId]);
        assert.ok(nb.thought_types[thoughtTypeId]);

        // query and path: thought_types catalogue present and resolved.
        const q = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: { network_id: ctx.networkId, type_id: [thoughtTypeId] },
        });
        const qr = toolJson<{ total: number; thought_types: Record<string, { name: string }> }>(q);
        assert.equal(qr.total, 1);
        assert.equal(qr.thought_types[thoughtTypeId]?.name, 'ошибка');

        const p = await handle.client.callTool({
          name: 'etn.thoughts.path',
          arguments: { network_id: ctx.networkId, from_id: ctx.homeId, to_id: id },
        });
        const pr = toolJson<{ path: string[] | null; thought_types: Record<string, unknown> }>(p);
        assert.ok(pr.thought_types[thoughtTypeId]);

        // usage: catalogue is always present, empty when nothing references.
        const u = await handle.client.callTool({
          name: 'etn.thoughts.usage',
          arguments: { network_id: ctx.networkId, thought_id: id },
        });
        const ur = toolJson<{ total: number; thought_types: Record<string, unknown> }>(u);
        assert.equal(ur.total, 0);
        assert.deepEqual(ur.thought_types, {});
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('auth provider rejects garbage, disabled keys and disabled users (F2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const provider = createApiKeyAuthProvider(ctx.sys);
      assert.equal(provider('not-a-key'), null);

      const extra = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: ctx.adminId,
        label: 'doomed',
        keyHash: hashApiKey(extra.key),
        keyPrefix: extra.keyPrefix,
      });
      const resolved = provider(extra.key);
      assert.notEqual(resolved, null);
      ctx.sys.disableApiKey(resolved!.keyId);
      assert.equal(provider(extra.key), null);

      // Disabled owner also rejects.
      const doomed = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: ctx.adminId,
        label: 'user-doomed',
        keyHash: hashApiKey(doomed.key),
        keyPrefix: doomed.keyPrefix,
      });
      assert.notEqual(provider(doomed.key), null);
      ctx.sys.updateUser(ctx.adminId, { displayName: 'Admin', isAdmin: true, disabled: true });
      assert.equal(provider(doomed.key), null);
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
