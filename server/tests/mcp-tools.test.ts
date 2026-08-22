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
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
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

  it('etn.comments.get returns the full text by comment id and by thought id (N7)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const longBody = 'z'.repeat(3000);
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль с большим комментарием' },
        });
        const { id } = toolJson<{ id: string }>(created);
        const perm = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: id,
            kind: 'permanent',
            body_md: longBody,
          },
        });
        const permId = toolJson<{ id: string }>(perm).id;

        // By comment_id: the complete body_md, no truncation.
        const byId = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, comment_id: permId },
        });
        assert.equal(byId.isError, undefined, toolText(byId));
        const full = toolJson<{ id: string; kind: string; body_md: string }>(byId);
        assert.equal(full.id, permId);
        assert.equal(full.kind, 'permanent');
        assert.equal(full.body_md, longBody);

        // By thought_id: the thought's permanent comment.
        const byThought = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, thought_id: id },
        });
        const tp = toolJson<{
          thought_id: string;
          permanent: { id: string; body_md: string } | null;
        }>(byThought);
        assert.equal(tp.thought_id, id);
        assert.equal(tp.permanent?.id, permId);
        assert.equal(tp.permanent?.body_md, longBody);

        // meta.permanent now carries the comment id, so the agent can follow up.
        const got = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: id },
        });
        const thought = toolJson<{
          meta: { permanent: { id: string; truncated: boolean } | null };
        }>(got);
        assert.equal(thought.meta.permanent?.id, permId);
        assert.equal(thought.meta.permanent?.truncated, true);

        // Exactly one of comment_id / thought_id is required.
        const bad = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(bad.isError, true);
        assert.match(toolText(bad), /exactly one/);

        // Unknown comment id → NOT_FOUND.
        const missing = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, comment_id: 'no-such-comment' },
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);

        // A thought without a permanent comment → { thought_id, permanent: null }.
        const bare = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль без комментария' },
        });
        const bareId = toolJson<{ id: string }>(bare).id;
        const none = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, thought_id: bareId },
        });
        const noPerm = toolJson<{ permanent: unknown }>(none);
        assert.equal(noPerm.permanent, null);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.comments.update edits and etn.comments.delete removes a comment', async () => {
    const ctx = await buildMcpContext();
    let thoughtId = '';
    let commentId = '';
    try {
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        events.push(event as unknown as AnyRealtimeEvent);
      });
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const created = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Мысль с правкой хронологии' },
          });
          thoughtId = toolJson<{ id: string }>(created).id;

          const upserted = await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'chronological',
              title: 'Запись',
              body_md: 'Первоначальный текст',
              valid_from: '2026-08-01',
            },
          });
          assert.equal(upserted.isError, undefined, toolText(upserted));
          commentId = toolJson<{ id: string; version: number }>(upserted).id;

          // Patch body + title with optimistic concurrency.
          const updated = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: commentId,
              changes: { body_md: 'Исправленный текст', title: 'Запись (правка)' },
              expected_version: 1,
            },
          });
          assert.equal(updated.isError, undefined, toolText(updated));
          assert.equal(toolJson<{ version: number }>(updated).version, 2);

          const got = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          const after = toolJson<{
            body_md: string;
            title: string | null;
            valid_from: string;
            version: number;
          }>(got);
          assert.equal(after.body_md, 'Исправленный текст');
          assert.equal(after.title, 'Запись (правка)');
          assert.equal(after.valid_from, '2026-08-01');
          assert.equal(after.version, 2);

          // Stale expected_version → VERSION_CONFLICT.
          const conflict = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: commentId,
              changes: { body_md: 'Никогда' },
              expected_version: 1,
            },
          });
          assert.equal(conflict.isError, true);
          assert.match(toolText(conflict), /VERSION_CONFLICT/);

          // Empty changes are rejected by the schema.
          const emptyChanges = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: { network_id: ctx.networkId, comment_id: commentId, changes: {} },
          });
          assert.equal(emptyChanges.isError, true);

          // Unknown comment id → NOT_FOUND.
          const missing = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: 'no-such-comment',
              changes: { body_md: 'Никогда' },
            },
          });
          assert.equal(missing.isError, true);
          assert.match(toolText(missing), /NOT_FOUND/);

          // Delete, then the comment is gone.
          const deleted = await handle.client.callTool({
            name: 'etn.comments.delete',
            arguments: { network_id: ctx.networkId, comment_id: commentId, expected_version: 2 },
          });
          assert.equal(deleted.isError, undefined, toolText(deleted));
          assert.equal(toolJson<{ version: number }>(deleted).version, 0);

          const gone = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          assert.equal(gone.isError, true);
          assert.match(toolText(gone), /NOT_FOUND/);

          const missingDelete = await handle.client.callTool({
            name: 'etn.comments.delete',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          assert.equal(missingDelete.isError, true);
          assert.match(toolText(missingDelete), /NOT_FOUND/);
        } finally {
          await handle.close();
        }

        // Participants saw the same catalogue events as for human edits.
        const types = events.map((e) => e.type);
        assert.ok(types.includes('comment.updated'), `events: ${types.join(',')}`);
        assert.ok(types.includes('comment.deleted'), `events: ${types.join(',')}`);
        const deletedEvent = events.find((e) => e.type === 'comment.deleted');
        assert.ok(deletedEvent !== undefined);
        assert.equal(deletedEvent.data.id, commentId);
        assert.equal(deletedEvent.data.owner_id, thoughtId);
      } finally {
        unsubscribe();
      }

      // Both mutating calls landed in audit_log.
      const actions = ctx.sys.queryAudit({ category: 'data' }).map((a) => a.action);
      assert.ok(actions.includes('etn.comments.update'));
      assert.ok(actions.includes('etn.comments.delete'));
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.comments.upsert accepts multi-target chronological entries (O3)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль A (multi-target)' },
        });
        const firstId = toolJson<{ id: string }>(first).id;
        const second = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль B (multi-target)' },
        });
        const secondId = toolJson<{ id: string }>(second).id;

        // Attaches one chronological entry to two owners in one call; first target is primary.
        const upserted = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            targets: [
              { owner_type: 'thought', owner_id: firstId },
              { owner_type: 'thought', owner_id: secondId },
            ],
            kind: 'chronological',
            body_md: 'Общая запись для двух мыслей',
          },
        });
        assert.equal(upserted.isError, undefined, toolText(upserted));
        const commentId = toolJson<{ id: string }>(upserted).id;

        const got = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, comment_id: commentId },
        });
        const comment = toolJson<{
          owner_type: string;
          owner_id: string;
          targets: Array<{ owner_type: string; owner_id: string }>;
        }>(got);
        assert.equal(comment.owner_type, 'thought');
        assert.equal(comment.owner_id, firstId, 'first target must become the primary owner');
        assert.deepEqual(comment.targets, [
          { owner_type: 'thought', owner_id: firstId },
          { owner_type: 'thought', owner_id: secondId },
        ]);

        // Duplicate targets collapse (domain layer, same as REST — L20).
        const withDupes = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            targets: [
              { owner_type: 'thought', owner_id: firstId },
              { owner_type: 'thought', owner_id: firstId },
            ],
            kind: 'chronological',
            body_md: 'Дубли схлопываются',
          },
        });
        assert.equal(withDupes.isError, undefined, toolText(withDupes));
        const dupComment = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, comment_id: toolJson<{ id: string }>(withDupes).id },
        });
        assert.deepEqual(toolJson<{ targets: unknown[] }>(dupComment).targets, [
          { owner_type: 'thought', owner_id: firstId },
        ]);

        // targets[] is rejected for a permanent comment (exactly one owner allowed).
        const permanentWithTargets = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            targets: [{ owner_type: 'thought', owner_id: firstId }],
            kind: 'permanent',
            body_md: 'Не должно пройти',
          },
        });
        assert.equal(permanentWithTargets.isError, true);

        // Neither owner_type/owner_id nor targets → schema rejects.
        const missingOwner = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: { network_id: ctx.networkId, kind: 'chronological', body_md: 'Без владельца' },
        });
        assert.equal(missingOwner.isError, true);

        // Both forms at once → schema rejects (exactly one of the two).
        const bothForms = await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: firstId,
            targets: [{ owner_type: 'thought', owner_id: secondId }],
            kind: 'chronological',
            body_md: 'Обе формы сразу',
          },
        });
        assert.equal(bothForms.isError, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.types.list returns both catalogues with hierarchy and effective properties (O4)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const parentType = createThoughtType(ndb, { name: 'Проект' }, ctx.adminId);
      createTypeProperty(ndb, 'thought_type', parentType.id, {
        key: 'дедлайн',
        value_type: 'date',
        required: true,
      });
      const childType = createThoughtType(
        ndb,
        { name: 'Подпроект', parent_id: parentType.id },
        ctx.adminId,
      );

      const parentLinkType = createLinkType(
        ndb,
        { name_forward: 'содержит', name_reverse: 'входит в' },
        ctx.adminId,
      );
      // NB: do not close — openNetworkDb caches the connection shared with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(listed.isError, undefined, toolText(listed));
        const result = toolJson<{
          thought_types: Array<{
            id: string;
            name: string;
            parent_id: string | null;
            is_root: boolean;
            properties: Array<{ key: string; inherited: boolean; defined_on: string }>;
          }>;
          link_types: Array<{ id: string; name_forward: string; name_reverse: string }>;
        }>(listed);

        const parentEntry = result.thought_types.find((t) => t.id === parentType.id);
        const childEntry = result.thought_types.find((t) => t.id === childType.id);
        assert.ok(parentEntry, 'parent type must be listed');
        assert.ok(childEntry, 'child type must be listed');
        assert.equal(childEntry.parent_id, parentType.id);
        // The child inherits the parent's property (L21) as an effective one.
        const inherited = childEntry.properties.find((p) => p.key === 'дедлайн');
        assert.ok(inherited, 'child must see the inherited property');
        assert.equal(inherited.inherited, true);
        assert.equal(inherited.defined_on, parentType.id);
        // The parent's own definition is not marked inherited.
        const ownDef = parentEntry.properties.find((p) => p.key === 'дедлайн');
        assert.ok(ownDef);
        assert.equal(ownDef.inherited, false);

        const linkEntry = result.link_types.find((t) => t.id === parentLinkType.id);
        assert.ok(linkEntry, 'link type must be listed');
        assert.equal(linkEntry.name_forward, 'содержит');
        assert.equal(linkEntry.name_reverse, 'входит в');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.list exposes description/when_to_use/has_structure (O5)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Fill the four markdown fields directly through the system DB so the
      // test does not depend on a (yet-to-exist) MCP wrapper for PATCH /networks.
      const current = ctx.sys.getNetworkById(ctx.networkId);
      assert.ok(current);
      ctx.sys.updateNetwork(ctx.networkId, {
        displayName: current!.display_name,
        description: 'Назначение сети',
        when_to_use: 'Coding → conventions',
        conventions: null,
        examples: null,
        node_section_type_id: null,
      });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.callTool({
          name: 'etn.networks.list',
          arguments: {},
        });
        assert.equal(listed.isError, undefined, toolText(listed));
        const data = toolJson<Array<{
          id: string;
          description: string | null;
          when_to_use: string | null;
          has_structure: boolean;
          // These two must NOT be present in the compact list (O5).
          conventions?: unknown;
          examples?: unknown;
          node_section_type_id?: unknown;
        }>>(listed);
        assert.equal(data.length, 1);
        const item = data[0]!;
        assert.equal(item.id, ctx.networkId);
        assert.equal(item.description, 'Назначение сети');
        assert.equal(item.when_to_use, 'Coding → conventions');
        assert.equal(item.has_structure, false);
        assert.equal(item.conventions, undefined);
        assert.equal(item.examples, undefined);
        assert.equal(item.node_section_type_id, undefined);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.structure returns empty sections when no node_section_type_id (O5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.networks.structure',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          network_id: string;
          has_structure: boolean;
          node_section_type_id: string | null;
          sections: unknown[];
          thought_types: unknown[];
        }>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_structure, false);
        assert.equal(data.node_section_type_id, null);
        assert.deepEqual(data.sections, []);
        assert.deepEqual(data.thought_types, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.structure returns active section nodes with counters + permanent preview (O5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const sectionType = createThoughtType(ndb, { name: 'Раздел' }, ctx.adminId);
      const noteType = createThoughtType(ndb, { name: 'Заметка' }, ctx.adminId);

      // Two active section nodes + one inactive (must be skipped) + a child thought.
      const sectionA = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'Введение', 'введение', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(sectionA, sectionType.id, ctx.adminId, ctx.adminId);
      const sectionB = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'Заключение', 'заключение', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(sectionB, sectionType.id, ctx.adminId, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'Скрытый', 'скрытый', ?, 0, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(randomUUID(), sectionType.id, ctx.adminId, ctx.adminId);
      // A child thought of sectionA (so counters.parents_count > 0 on the child
      // is irrelevant; we just want a link from sectionA to a note to make
      // usage_count sensible).
      const note = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'Подтема', 'подтема', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(note, noteType.id, ctx.adminId, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, active, version,
                              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, 1, 1, '2024', '2024', ?, ?)`,
        )
        .run(randomUUID(), sectionA, note, ctx.adminId, ctx.adminId);

      // Set the network node_section_type_id via the system DB.
      const current = ctx.sys.getNetworkById(ctx.networkId)!;
      ctx.sys.updateNetwork(ctx.networkId, {
        displayName: current.display_name,
        description: current.description,
        when_to_use: current.when_to_use,
        conventions: current.conventions,
        examples: current.examples,
        node_section_type_id: sectionType.id,
      });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.networks.structure',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          network_id: string;
          has_structure: boolean;
          node_section_type_id: string;
          node_section_type: { id: string; name: string };
          sections: Array<{
            id: string;
            title: string;
            counters: {
              parents_count: number;
              children_count: number;
              attachments_count: number;
              usage_count: number;
            };
          }>;
          thought_types: Record<string, { id: string; name: string }>;
        }>(result);

        assert.equal(data.has_structure, true);
        assert.equal(data.node_section_type_id, sectionType.id);
        assert.equal(data.node_section_type.id, sectionType.id);

        // Inactive "Скрытый" is excluded; only the two active section nodes remain.
        assert.equal(data.sections.length, 2);
        const titles = data.sections.map((s) => s.title).sort();
        assert.deepEqual(titles, ['Введение', 'Заключение']);

        // sectionA has an outgoing link → parents_count stays 0 (no parents),
        // but children_count is at least 1 because of the link to Подтема.
        const intro = data.sections.find((s) => s.id === sectionA);
        assert.ok(intro, 'sectionA must be present');
        assert.equal(intro!.counters.parents_count, 0);
        assert.ok(intro!.counters.children_count >= 1);

        // The catalogue includes the section type itself (noteType is a child
        // thought but not a section — it's not in the catalogue). N6-style
        // object keyed by id.
        assert.ok(data.thought_types[sectionType.id]);
        assert.equal(data.thought_types[sectionType.id].name, 'Раздел');
        assert.equal(data.thought_types[noteType.id], undefined);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.structure rejects a non-member (FORBIDDEN, O5)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Create a second user that is NOT a member of ctx.networkId.
      const { id: outsiderId } = ctx.sys.createUser({
        id: randomUUID(),
        username: 'outsider',
        displayName: 'Outsider',
      });
      const gen = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: outsiderId,
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const handle = await connectMcpClient(ctx, gen.key);
      try {
        const result = await handle.client.callTool({
          name: 'etn.networks.structure',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, true);
        assert.match(toolText(result), /FORBIDDEN/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.types.list with in_subtree_of returns only types used in the subtree (O16)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const sectionType = createThoughtType(ndb, { name: 'Раздел' }, ctx.adminId);
      const noteType = createThoughtType(ndb, { name: 'Заметка' }, ctx.adminId);
      // A second type that lives OUTSIDE the subtree and must not leak in.
      const strayType = createThoughtType(ndb, { name: 'Сторонний' }, ctx.adminId);
      const linkType = createLinkType(
        ndb,
        { name_forward: 'содержит', name_reverse: 'входит в' },
        ctx.adminId,
      );

      // Seed → A (Раздел) → B (Заметка), one typed link.
      const seedId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'Корень', 'корень', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(seedId, sectionType.id, ctx.adminId, ctx.adminId);
      const aId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'A', 'a', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(aId, sectionType.id, ctx.adminId, ctx.adminId);
      const bId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'B', 'b', ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
        )
        .run(bId, noteType.id, ctx.adminId, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', ?, ?)`,
        )
        .run(randomUUID(), seedId, aId, linkType.id, ctx.adminId, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', ?, ?)`,
        )
        .run(randomUUID(), aId, bId, linkType.id, ctx.adminId, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: { network_id: ctx.networkId, in_subtree_of: aId },
        });
        assert.equal(listed.isError, undefined, toolText(listed));
        const data = toolJson<{
          thought_types: Array<{ id: string; name: string; usage_count?: number }>;
          link_types: Array<{ id: string; usage_count?: number }>;
          scope?: {
            in_subtree_of: string;
            max_depth: number;
            thought_types_total: number;
            link_types_total: number;
          };
        }>(listed);

        // The stray type is NOT in the subtree's reach — it must be excluded.
        assert.ok(!data.thought_types.some((t) => t.id === strayType.id));
        // Section + Note are inside the subtree of `aId` (a itself + b).
        const thoughtNames = data.thought_types.map((t) => t.name).sort();
        assert.deepEqual(thoughtNames, ['Заметка', 'Раздел']);
        const sectionEntry = data.thought_types.find((t) => t.id === sectionType.id);
        const noteEntry = data.thought_types.find((t) => t.id === noteType.id);
        assert.ok(sectionEntry && noteEntry);
        // The subtree rooted at `a` contains: a (Раздел), b (Заметка).
        // The seed→a link has source outside the subtree, so it does not
        // contribute a link count.
        assert.equal(sectionEntry!.usage_count, 1);
        assert.equal(noteEntry!.usage_count, 1);

        // Only a→b sits fully inside the subtree → exactly one link.
        const linkEntry = data.link_types.find((l) => l.id === linkType.id);
        assert.ok(linkEntry);
        assert.equal(linkEntry!.usage_count, 1);

        // scope echo: subtree is rooted at A.
        assert.ok(data.scope);
        assert.equal(data.scope!.in_subtree_of, aId);
        assert.equal(data.scope!.thought_types_total, 2);
        assert.equal(data.scope!.link_types_total, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.types.list with unknown in_subtree_of returns NOT_FOUND (O16)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: { network_id: ctx.networkId, in_subtree_of: randomUUID() },
        });
        assert.equal(listed.isError, true);
        assert.match(toolText(listed), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.create resolves a thought type by name; rejects unknown/both forms (O4)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'Задача' }, ctx.adminId);
      // NB: do not close — shared connection with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Case-insensitive match by name.
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Сделать релиз', type: 'задача' },
        });
        assert.equal(created.isError, undefined, toolText(created));
        const { id } = toolJson<{ id: string }>(created);
        const got = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: id },
        });
        assert.equal(toolJson<{ type_id: string | null }>(got).type_id, type.id);

        // Unknown name → NOT_FOUND.
        const unknown = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мимо кассы', type: 'нет такого типа' },
        });
        assert.equal(unknown.isError, true);
        assert.match(toolText(unknown), /NOT_FOUND/);

        // Both type_id and type at once → schema rejects.
        const both = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Обе формы',
            type_id: type.id,
            type: 'Задача',
          },
        });
        assert.equal(both.isError, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.links.create resolves a link type by forward/reverse name; ambiguous name errors (O4)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const blocks = createLinkType(
        ndb,
        { name_forward: 'блокирует', name_reverse: 'заблокирован' },
        ctx.adminId,
      );
      // A second type whose reverse label collides with the first type's forward label
      // ("блокирует"); its own forward label ("связан с") does not collide with anything.
      createLinkType(ndb, { name_forward: 'связан с', name_reverse: 'блокирует' }, ctx.adminId);
      // NB: do not close — shared connection with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const a = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль А (links.create)' },
        });
        const aId = toolJson<{ id: string }>(a).id;
        const b = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Мысль Б (links.create)' },
        });
        const bId = toolJson<{ id: string }>(b).id;

        // "блокирует" is `blocks.name_forward` AND the second type's
        // `name_reverse` — genuinely ambiguous.
        const ambiguous = await handle.client.callTool({
          name: 'etn.links.create',
          arguments: {
            network_id: ctx.networkId,
            source_id: aId,
            target_id: bId,
            type: 'блокирует',
          },
        });
        assert.equal(ambiguous.isError, true);
        assert.match(toolText(ambiguous), /VALIDATION_ERROR/);
        assert.match(toolText(ambiguous), /candidates/);

        // "заблокирован" only matches `blocks.name_reverse` — unambiguous.
        const created = await handle.client.callTool({
          name: 'etn.links.create',
          arguments: {
            network_id: ctx.networkId,
            source_id: aId,
            target_id: bId,
            type: 'заблокирован',
          },
        });
        assert.equal(created.isError, undefined, toolText(created));
        const link = await handle.client.callTool({
          name: 'etn.links.get',
          arguments: { network_id: ctx.networkId, link_id: toolJson<{ id: string }>(created).id },
        });
        assert.equal(toolJson<{ type_id: string | null }>(link).type_id, blocks.id);

        // Unknown name and both forms at once are rejected too.
        const unknown = await handle.client.callTool({
          name: 'etn.links.create',
          arguments: { network_id: ctx.networkId, source_id: aId, target_id: bId, type: 'нет такой связи' },
        });
        assert.equal(unknown.isError, true);
        assert.match(toolText(unknown), /NOT_FOUND/);

        const both = await handle.client.callTool({
          name: 'etn.links.create',
          arguments: {
            network_id: ctx.networkId,
            source_id: aId,
            target_id: bId,
            type_id: blocks.id,
            type: 'блокирует',
          },
        });
        assert.equal(both.isError, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.upsert_bundle resolves thought.type and links[].type by name (O4)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtType = createThoughtType(ndb, { name: 'Грабли' }, ctx.adminId);
      const linkType = createLinkType(
        ndb,
        { name_forward: 'иллюстрирует', name_reverse: 'иллюстрируется' },
        ctx.adminId,
      );
      // NB: do not close — shared connection with the MCP server.

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const bundled = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: {
            network_id: ctx.networkId,
            thought: { title: 'Забыли про часовой пояс', type: 'грабли' },
            links: [{ direction: 'child', target_thought_id: ctx.homeId, type: 'иллюстрирует' }],
          },
        });
        assert.equal(bundled.isError, undefined, toolText(bundled));
        const { id } = toolJson<{ id: string }>(bundled);

        const got = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: id },
        });
        assert.equal(toolJson<{ type_id: string | null }>(got).type_id, thoughtType.id);

        const neighbors = await handle.client.callTool({
          name: 'etn.thoughts.neighbors',
          arguments: { network_id: ctx.networkId, thought_id: id, dir: 'parents' },
        });
        const { neighbors: list } = toolJson<{
          neighbors: Array<{ id: string; link_type_id: string | null }>;
        }>(neighbors);
        const home = list.find((n) => n.id === ctx.homeId);
        assert.ok(home, 'HOME must be a parent neighbour');
        assert.equal(home.link_type_id, linkType.id);
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

  it('etn.thoughts.upsert_bundle writes thought+comment+property+link+attachment ' +
    'atomically, emits one realtime event per entity and one audit row (O1)', async () => {
    const ctx = await buildMcpContext();
    try {
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        events.push(event as unknown as AnyRealtimeEvent);
      });
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const res = await handle.client.callTool({
            name: 'etn.thoughts.upsert_bundle',
            arguments: {
              network_id: ctx.networkId,
              thought: { title: 'Дюна' },
              comment: { body_md: 'Роман Фрэнка Герберта.' },
              links: [{ direction: 'child', target_thought_id: ctx.homeId }],
              attachments: [{ kind: 'url', url: 'https://example.com/dune' }],
            },
          });
          assert.equal(res.isError, undefined, res.isError === true ? toolText(res) : undefined);
          const result = toolJson<{
            id: string;
            version: number;
            thought_action: string;
            matched_on: string | null;
            comment?: { id: string; version: number };
            links?: Array<{ id: string; version: number }>;
            attachments?: Array<{ id: string }>;
          }>(res);
          assert.equal(result.thought_action, 'created');
          assert.equal(result.matched_on, null);
          assert.ok(result.comment !== undefined);
          assert.equal(result.links?.length, 1);
          assert.equal(result.attachments?.length, 1);

          const count = openNetworkDb(ctx.dataDir, ctx.networkId)
            .prepare('SELECT COUNT(*) AS c FROM thoughts')
            .get() as { c: number };
          assert.equal(count.c, 2); // HOME + Дюна
        } finally {
          await handle.close();
        }

        const types = events.map((e) => e.type).sort();
        assert.deepEqual(types, [
          'attachment.created',
          'comment.created',
          'link.created',
          'thought.created',
        ]);
      } finally {
        unsubscribe();
      }

      // A five-entity bundle writes exactly one audit row (O1/O8: bundle = 1 record).
      const audit = ctx.sys.queryAudit({ category: 'data' });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.action, 'etn.thoughts.upsert_bundle');
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.upsert_bundle: on_duplicate="fail" rejects with candidates, ' +
    'nothing is written mid-bundle (atomicity, O1)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: { network_id: ctx.networkId, thought: { title: 'Конкуренты 1С' } },
        });
        assert.equal(first.isError, undefined);

        const second = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: {
            network_id: ctx.networkId,
            thought: { title: 'Конкуренты 1С' },
            comment: { body_md: 'Не должно записаться.' },
          },
        });
        assert.equal(second.isError, true);
        assert.match(toolText(second), /DUPLICATE/);

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const thoughts = ndb
          .prepare("SELECT COUNT(*) AS c FROM thoughts WHERE title = 'Конкуренты 1С'")
          .get() as { c: number };
        assert.equal(thoughts.c, 1, 'no second thought was created');
        const comments = ndb.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number };
        assert.equal(comments.c, 0, 'the comment must not have been written');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.upsert_bundle: a bundle costs exactly one write-budget slot ' +
    'regardless of how many entities it touches (O1/O8)', async () => {
    const ctx = await buildMcpContext();
    try {
      ctx.rawDb
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('mcp.max_writes_per_minute', '2', new Date().toISOString());

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const bundleArgs = (title: string): Record<string, unknown> => ({
          network_id: ctx.networkId,
          thought: { title },
          comment: { body_md: 'x' },
          links: [{ direction: 'child', target_thought_id: ctx.homeId }],
          attachments: [{ kind: 'url', url: 'https://example.com/x' }],
        });

        const first = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: bundleArgs('Раз'),
        });
        assert.equal(first.isError, undefined, first.isError === true ? toolText(first) : undefined);

        const second = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: bundleArgs('Два'),
        });
        assert.equal(second.isError, undefined, second.isError === true ? toolText(second) : undefined);

        const third = await handle.client.callTool({
          name: 'etn.thoughts.upsert_bundle',
          arguments: bundleArgs('Три'),
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

  it('a per-key max_writes_per_minute override beats the global limit (O8)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Global limit stays at its default (60); the key itself caps writes at 1.
      const gen = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: ctx.adminId,
        label: 'o8',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
        maxWritesPerMinute: 1,
      });

      const handle = await connectMcpClient(ctx, gen.key);
      try {
        const first = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Раз' },
        });
        assert.equal(first.isError, undefined, first.isError === true ? toolText(first) : undefined);

        const second = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Два' },
        });
        assert.equal(second.isError, true);
        assert.match(toolText(second), /write limit|RATE_LIMITED/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.properties.set accepts a values map, writes mixed types in one call (O2)', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed a type with text/number/bool properties (direct inserts).
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const typeId = randomUUID();
      ndb
        .prepare(
          `INSERT INTO thought_types (id, name, version, created_at, updated_at, created_by)
           VALUES (?, 'book', 1, '2024', '2024', 'u')`,
        )
        .run(typeId);
      const props = [
        { key: 'title', value_type: 'text' },
        { key: 'year', value_type: 'number' },
        { key: 'published', value_type: 'bool' },
      ];
      for (const p of props) {
        ndb
          .prepare(
            `INSERT INTO type_properties (id, owner_type, owner_id, key, value_type, required, position)
             VALUES (?, 'thought_type', ?, ?, ?, 0, 0)`,
          )
          .run(randomUUID(), typeId, p.key, p.value_type);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'Дюна', type_id: typeId },
        });
        const { id: thoughtId } = toolJson<{ id: string; version: number }>(created);

        const res = await handle.client.callTool({
          name: 'etn.properties.set',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: thoughtId,
            values: { title: 'Dune', year: 1965, published: true },
          },
        });
        assert.equal(res.isError, undefined, res.isError === true ? toolText(res) : undefined);
        const result = toolJson<{ values?: Record<string, { id: string }>; version: number }>(res);
        assert.equal(result.version, 0);
        assert.ok(result.values?.title?.id);
        assert.ok(result.values?.year?.id);
        assert.ok(result.values?.published?.id);

        const count = ndb
          .prepare('SELECT COUNT(*) AS c FROM property_values WHERE owner_id = ?')
          .get(thoughtId) as { c: number };
        assert.equal(count.c, 3);

        // Single-property form is still backward compatible.
        const single = await handle.client.callTool({
          name: 'etn.properties.set',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: thoughtId,
            key: 'year',
            value: 2020,
          },
        });
        assert.equal(single.isError, undefined);
        const singleResult = toolJson<{ id: string; version: number }>(single);
        assert.equal(singleResult.version, 0);
        assert.equal(typeof singleResult.id, 'string');

        // Providing neither/neither is rejected by the schema (zod refine).
        const invalid = await handle.client.callTool({
          name: 'etn.properties.set',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: thoughtId,
            key: 'year',
          },
        });
        assert.equal(invalid.isError, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
