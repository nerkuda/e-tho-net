/**
 * MCP tool-call telemetry + progressive disclosure (task 940a499d).
 *
 * Covers:
 *   * the aggregate `mcp_tool_call_metrics` table in `_system.db` — increments
 *     on success and error, network-less rows for `etn.networks.list`,
 *     read-only keys counted the same, rows separated by (network, key);
 *   * a failed increment never breaks the call itself;
 *   * `etn.metrics.tools` aggregation and its permission cut (admin sees all,
 *     a regular member only their networks + own network-less rows);
 *   * the two procedural prompts `etn.how_to_*` (ADR b2eebf8b level 1);
 *   * the level-2 hint navigators: `details.how_to` on merge closure /
 *     conflict errors and on the blocked physical deletion;
 *   * a size guard over `tools/list` so the trimmed descriptions do not creep
 *     back (progressive disclosure, ADR b2eebf8b).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { MCP_TOOL_NAMES } from '@etn/shared';

import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { seedThoughtRefProperty } from './seed-thought-ref.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Raw telemetry row of `_system.db`. */
interface MetricRow {
  tool_name: string;
  network_id: string | null;
  api_key_id: string;
  calls_count: number;
  errors_count: number;
}

/** All telemetry rows, ordered deterministically. */
function metricRows(ctx: Awaited<ReturnType<typeof buildMcpContext>>): MetricRow[] {
  return ctx.rawDb
    .prepare(
      'SELECT tool_name, network_id, api_key_id, calls_count, errors_count FROM mcp_tool_call_metrics ORDER BY tool_name, network_id, api_key_id',
    )
    .all() as MetricRow[];
}

/** The `api_keys.id` of a key created by the fixture, by label. */
function keyIdByLabel(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  label: string,
): string {
  const row = ctx.rawDb
    .prepare('SELECT id FROM api_keys WHERE label = ? LIMIT 1')
    .get(label) as { id: string } | undefined;
  assert.ok(row !== undefined, `api key ${label} must exist`);
  return row.id;
}

describe('MCP tool-call telemetry (940a499d)', { skip: !nativeAvailable() }, () => {
  it('increments calls_count on success and errors_count on error', async () => {
    const ctx = await buildMcpContext();
    try {
      const adminKeyId = keyIdByLabel(ctx, 'mcp-test');
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Success outside any network → (tool, NULL, key) row.
        const ok = await handle.client.callTool({ name: 'etn.networks.list', arguments: {} });
        assert.equal(ok.isError, undefined);

        // Error inside a network → same-table row keyed by the network.
        const bad = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: 'no-such-thought' },
        });
        assert.equal(bad.isError, true);

        const rows = metricRows(ctx).filter((r) => r.api_key_id === adminKeyId);
        const listRow = rows.find((r) => r.tool_name === 'etn.networks.list');
        assert.ok(listRow !== undefined, 'etn.networks.list must be counted');
        assert.equal(listRow.network_id, null);
        assert.equal(listRow.calls_count, 1);
        assert.equal(listRow.errors_count, 0);

        const getRow = rows.find((r) => r.tool_name === 'etn.thoughts.get');
        assert.ok(getRow !== undefined, 'etn.thoughts.get must be counted');
        assert.equal(getRow.network_id, ctx.networkId);
        assert.equal(getRow.calls_count, 1);
        assert.equal(getRow.errors_count, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('counts read-only keys (success and rejected mutation)', async () => {
    const ctx = await buildMcpContext();
    try {
      const roKeyId = keyIdByLabel(ctx, 'mcp-test-ro');
      const handle = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        const ok = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
        });
        assert.equal(ok.isError, undefined);

        const rejected = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'RO must fail' },
        });
        assert.equal(rejected.isError, true);

        const rows = metricRows(ctx).filter((r) => r.api_key_id === roKeyId);
        const get = rows.find((r) => r.tool_name === 'etn.thoughts.get');
        assert.ok(get !== undefined);
        assert.equal(get.calls_count, 1);
        assert.equal(get.errors_count, 0);
        const create = rows.find((r) => r.tool_name === 'etn.thoughts.create');
        assert.ok(create !== undefined, 'rejected mutation must still be counted');
        assert.equal(create.calls_count, 1);
        assert.equal(create.errors_count, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('separates rows per network and per key', async () => {
    const ctx = await buildMcpContext();
    let net2Id: string | null = null;
    try {
      const net2 = await new NetworkServiceImpl(ctx.sys, ctx.dataDir, createLogger('silent')).createNetwork(
        ctx.adminId,
        'Second Net',
      );
      net2Id = net2.id;
      const adminKeyId = keyIdByLabel(ctx, 'mcp-test');
      const roKeyId = keyIdByLabel(ctx, 'mcp-test-ro');

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      const roHandle = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        // `etn.locks.list` is network-scoped with no entity ids, so the same
        // call works verbatim against both networks.
        for (const networkId of [ctx.networkId, net2.id]) {
          const r = await handle.client.callTool({
            name: 'etn.locks.list',
            arguments: { network_id: networkId },
          });
          assert.equal(r.isError, undefined);
        }
        await roHandle.client.callTool({
          name: 'etn.locks.list',
          arguments: { network_id: ctx.networkId },
        });

        const rows = metricRows(ctx).filter((r) => r.tool_name === 'etn.locks.list');
        const combos = rows.map((r) => `${r.network_id}|${r.api_key_id}`);
        assert.ok(combos.includes(`${ctx.networkId}|${adminKeyId}`));
        assert.ok(combos.includes(`${net2.id}|${adminKeyId}`));
        assert.ok(combos.includes(`${ctx.networkId}|${roKeyId}`));
        assert.equal(rows.length, 3);
      } finally {
        await roHandle.close();
        await handle.close();
      }
    } finally {
      if (net2Id !== null) closeNetworkDb(net2Id);
      await closeMcpContext(ctx);
    }
  });

  it('a broken telemetry table never fails the tool call', async () => {
    const ctx = await buildMcpContext();
    try {
      ctx.rawDb.exec('DROP TABLE mcp_tool_call_metrics');
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.networks.list',
          arguments: {},
        });
        assert.equal(result.isError, undefined);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('etn.metrics.tools (940a499d)', { skip: !nativeAvailable() }, () => {
  /** Seed one telemetry row directly. */
  function seed(
    ctx: Awaited<ReturnType<typeof buildMcpContext>>,
    row: MetricRow & { first?: string; last?: string },
  ): void {
    const now = row.last ?? '2026-09-07T00:00:00.000Z';
    ctx.rawDb
      .prepare(
        `INSERT INTO mcp_tool_call_metrics
           (tool_name, network_id, api_key_id, calls_count, errors_count, first_call_at, last_call_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.tool_name,
        row.network_id,
        row.api_key_id,
        row.calls_count,
        row.errors_count,
        row.first ?? now,
        now,
      );
  }

  it('aggregates by tool and cuts permissions for a regular member', async () => {
    const ctx = await buildMcpContext();
    try {
      const adminKeyId = keyIdByLabel(ctx, 'mcp-test');
      const bobId = randomUUID();
      ctx.sys.createUser({
        id: bobId,
        username: 'bob',
        displayName: 'Bob',
        isAdmin: false,
        isFirstUser: false,
      });
      const bobGen = generateApiKey();
      const bobKeyId = randomUUID();
      ctx.sys.createApiKey({
        id: bobKeyId,
        userId: bobId,
        label: 'bob-key',
        keyHash: hashApiKey(bobGen.key),
        keyPrefix: bobGen.keyPrefix,
      });
      // Bob is a member of the fixture network only.
      ctx.sys.addNetworkMember(ctx.networkId, bobId, 'member', ctx.adminId);

      const alienNet = '11111111-2222-4333-8444-555555555555';
      const alienKey = '99999999-9999-4999-8999-999999999999';
      seed(ctx, { tool_name: 'etn.thoughts.get', network_id: ctx.networkId, api_key_id: adminKeyId, calls_count: 5, errors_count: 1 });
      seed(ctx, { tool_name: 'etn.thoughts.get', network_id: alienNet, api_key_id: alienKey, calls_count: 7, errors_count: 0 });
      seed(ctx, { tool_name: 'etn.networks.list', network_id: null, api_key_id: bobKeyId, calls_count: 3, errors_count: 0 });
      seed(ctx, { tool_name: 'etn.networks.list', network_id: null, api_key_id: alienKey, calls_count: 9, errors_count: 0 });

      // Admin sees everything: two tool groups, summed across keys/networks.
      const adminHandle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await adminHandle.client.callTool({
          name: 'etn.metrics.tools',
          arguments: {},
        });
        assert.equal(result.isError, undefined);
        const data = toolJson<{ group_by: string; items: Array<{ tool_name: string; network_id: string | null; calls_count: number; errors_count: number }> }>(result);
        assert.equal(data.group_by, 'tool');
        const get = data.items.find((i) => i.tool_name === 'etn.thoughts.get');
        assert.ok(get !== undefined);
        assert.equal(get.network_id, null, 'group_by tool folds networks');
        assert.equal(get.calls_count, 12);
        assert.equal(get.errors_count, 1);
        const list = data.items.find((i) => i.tool_name === 'etn.networks.list');
        assert.ok(list !== undefined);
        assert.equal(list.calls_count, 12);
      } finally {
        await adminHandle.close();
      }

      // Bob: own network rows + own network-less rows only.
      const bobHandle = await connectMcpClient(ctx, bobGen.key);
      try {
        const result = await bobHandle.client.callTool({
          name: 'etn.metrics.tools',
          arguments: { group_by: 'tool+network' },
        });
        assert.equal(result.isError, undefined);
        const data = toolJson<{
          items: Array<{ tool_name: string; network_id: string | null; api_key_id?: string; calls_count: number }>;
        }>(result);
        assert.equal(data.items.length, 2);
        const get = data.items.find((i) => i.tool_name === 'etn.thoughts.get');
        assert.ok(get !== undefined);
        assert.equal(get.network_id, ctx.networkId);
        assert.equal(get.calls_count, 5);
        const list = data.items.find((i) => i.tool_name === 'etn.networks.list');
        assert.ok(list !== undefined);
        assert.equal(list.network_id, null);
        assert.equal(list.calls_count, 3);
      } finally {
        await bobHandle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('supports tool+key grouping and the from_ms window', async () => {
    const ctx = await buildMcpContext();
    try {
      const keyA = keyIdByLabel(ctx, 'mcp-test');
      const keyB = keyIdByLabel(ctx, 'mcp-test-ro');
      ctx.rawDb
        .prepare(
          `INSERT INTO mcp_tool_call_metrics
             (tool_name, network_id, api_key_id, calls_count, errors_count, first_call_at, last_call_at)
           VALUES
             ('etn.thoughts.search', ?, ?, 4, 0, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
             ('etn.thoughts.search', ?, ?, 6, 2, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
        )
        .run(ctx.networkId, keyA, ctx.networkId, keyB);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.metrics.tools',
          arguments: {
            group_by: 'tool+key',
            // Window ends between the two rows: only the fresh one survives.
            to_ms: Date.parse('2026-08-15T00:00:00.000Z'),
          },
        });
        assert.equal(result.isError, undefined);
        const data = toolJson<{
          items: Array<{ tool_name: string; api_key_id?: string; calls_count: number; errors_count: number }>;
        }>(result);
        assert.equal(data.items.length, 1);
        assert.equal(data.items[0]?.api_key_id, keyA);
        assert.equal(data.items[0]?.calls_count, 4);
        assert.equal(data.items[0]?.errors_count, 0);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('Progressive disclosure (940a499d, ADR b2eebf8b)', { skip: !nativeAvailable() }, () => {
  it('how_to prompts return procedural instructions', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const merge = await handle.client.getPrompt({
          name: 'etn.how_to_merge_partial',
          arguments: { network_id: ctx.networkId },
        });
        const mergeText = merge.messages[0]?.content;
        assert.ok(mergeText !== undefined && mergeText.type === 'text');
        assert.match(mergeText.text, /missing_closure/);
        assert.match(mergeText.text, /reserve/i);

        const purge = await handle.client.getPrompt({
          name: 'etn.how_to_purge',
          arguments: { network_id: ctx.networkId },
        });
        const purgeText = purge.messages[0]?.content;
        assert.ok(purgeText !== undefined && purgeText.type === 'text');
        assert.match(purgeText.text, /etn\.trash\.purge/);
        assert.match(purgeText.text, /blocking/i);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('an unclosed partial merge points to etn.how_to_merge_partial (level 2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Create a layer, switch the session into it, add a thought + link
        // there, then select ONLY the link for a partial merge — its layer-only
        // endpoint is not closed → missing_closure + the how_to hint.
        const layer = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.layers.create',
            arguments: { network_id: ctx.networkId, title: 'L-telemetry' },
          }),
        );
        await handle.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: layer.id },
        });
        const thought = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Layer-only endpoint',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        // The link is created as part of the thought; find it via neighbors.
        const neighbors = toolJson<{ neighbors: Array<{ id: string; link_id?: string; thought_id?: string }> }>(
          await handle.client.callTool({
            name: 'etn.thoughts.neighbors',
            arguments: { network_id: ctx.networkId, thought_id: thought.id, dir: 'parents' },
          }),
        );
        const linkId = neighbors.neighbors[0]?.link_id;
        assert.ok(typeof linkId === 'string', 'parent link must exist');

        const merge = await handle.client.callTool({
          name: 'etn.layers.merge',
          arguments: { network_id: ctx.networkId, layer_id: layer.id, tables: { links: [linkId] } },
        });
        assert.equal(merge.isError, true);
        const text = toolText(merge);
        assert.match(text, /missing_closure/);
        assert.match(text, /etn\.how_to_merge_partial/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('a blocked physical deletion points to etn.how_to_purge (level 2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'TRefHolder' }, ctx.adminId);
      seedThoughtRefProperty(ndb, 'thought_type', type.id, 'related', {}, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const target = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Referenced target' },
          }),
        );
        const holder = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Holder',
              type: 'TRefHolder',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        const set = await handle.client.callTool({
          name: 'etn.properties.set',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: holder.id,
            key: 'related',
            value: target.id,
          },
        });
        assert.equal(set.isError, undefined);

        const del = await handle.client.callTool({
          name: 'etn.thoughts.delete',
          arguments: { network_id: ctx.networkId, thought_id: target.id },
        });
        assert.equal(del.isError, true);
        const text = toolText(del);
        assert.match(text, /blocking/);
        assert.match(text, /etn\.how_to_purge/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tools/list stays within the 0.7.3 size budget', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        assert.equal(tools.length, MCP_TOOL_NAMES.length);
        // Guard of the progressive-disclosure ADR: before the 0.7.2 trim the
        // payload was 57 960 B for 54 tools; after the trim + etn.metrics.tools
        // it measured 50 318 B. Task 6d45ab37 (P1-паритет MCP↔REST) re-baselines
        // to 58 000 B for 60 tools: 6 новых описаний (resolve, bulk_update,
        // chronicle.query, members.list, attachments.update, attachments.delete)
        // добавляют ~7 300 B. Task ba024a45 / 0.7.2 re-baselines again to
        // 62 000 B for 63 tools: 3 новых описания (instructions,
        // networks.write, networks.delete) добавляют ~1 800 B. Задача 053751b5
        // (0.7.2) re-baselines ещё раз до 66 000 B для 64 инструментов:
        // `etn.thoughts.write` добавляет ~3 200 B (подробное описание сценария
        // батча). Задача cc9ca65e (0.7.2) re-baselines до 72 000 B для 65
        // инструментов: `etn.ontology.write` / `etn.ontology.delete` добавляют
        // ~5 000 B (подробное описание батча и каскада). Задача e488f4c1 (0.7.2
        // P3) re-baselines до 78 000 B для 67 инструментов: `copy_subtree`,
        // `mentions_scan`, `import.dry_run`, `import.subgraph` добавляют
        // ~5 500 B (длинные описания подграфных операций и dry_run/scan).
        // Задача c1fa71d4 (0.7.3) re-baselines до 84 000 B для 68
        // инструментов: `etn.views.run` добавляет ~3 500 B (длинное
        // описание контракта + описание `meta.views` в `etn.thoughts.get`).
        const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
        assert.ok(
          bytes <= 84_000,
          `tools/list JSON is ${bytes} bytes — over the 0.7.3 budget of 84000`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
