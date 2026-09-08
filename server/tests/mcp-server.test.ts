/**
 * MCP smoke tests (task F1 DoD): a connected client enumerates tools,
 * resources and prompts, and can use basic read operations (F3 resources,
 * F5 prompts) through the SDK protocol over the in-memory transport.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MCP_PROMPT_NAMES,
  MCP_TOOL_ANNOTATIONS,
  MCP_TOOL_NAMES,
} from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import {
  createThoughtType,
} from '../src/domain/thought-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import {
  closeMcpContext,
  buildMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

// Test user for authorship columns (task 5ef8b5bb)

/**
 * Strip annotation fields the MCP SDK's `ToolAnnotationsSchema` does NOT
 * round-trip through the wire. Used by the canonical-registry test
 * (задача 053751b5, 0.7.2) so server-only fields like `deprecated_since`
 * don't trip the deepEqual — they live in the canonical registry for the
 * server's own tracking but don't make it back to the client.
 */
function filterToSdkAnnotations(
  ann: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (ann === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'title',
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ]) {
    if (key in ann) out[key] = ann[key];
  }
  return out;
}
const USER = 'test-user';

describe('MCP server (F1 smoke)', { skip: !nativeAvailable() }, () => {
  it('lists all tools from the shared catalogue', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const names = tools.map((t) => t.name).sort();
        assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists the 13 etn:// resources (1 static + 12 templated)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.listResources();
        const templates = await handle.client.listResourceTemplates();
        // MCP splits static resources and URI templates into two lists.
        const uris = [
          ...listed.resources.map((r) => r.uri),
          ...templates.resourceTemplates.map((r) => r.uriTemplate),
        ].sort();
        assert.equal(uris.length, 13);
        assert.ok(uris.includes('etn://networks'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}/usage'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}/backlinks'));
        assert.ok(uris.includes('etn://networks/{network_id}/thought-types/{type_id}'));
        assert.ok(uris.includes('etn://networks/{network_id}/trash'));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists the prompt templates', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { prompts } = await handle.client.listPrompts();
        const names = prompts.map((p) => p.name).sort();
        assert.deepEqual(names, [...MCP_PROMPT_NAMES].sort());
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.list returns the network of the key user', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({ name: 'etn.networks.list', arguments: {} });
        assert.equal(result.isError, undefined);
        const networks = toolJson<Array<{ id: string }>>(result);
        assert.equal(networks.length, 1);
        assert.equal(networks[0]?.id, ctx.networkId);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('reads the HOME thought through the etn.thought resource (F3)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        const thought = JSON.parse(block.text) as {
          id: string;
          title: string;
          properties: unknown[];
        };
        assert.equal(thought.id, ctx.homeId);
        assert.equal(thought.title, 'HOME');
        assert.deepEqual(thought.properties, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('reads comments as Markdown through the comments resource (F3)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        assert.equal(block.mimeType, 'text/markdown');
        assert.match(block.text, /# Комментарии: HOME/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('getPrompt returns a parameterised text template (F5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.getPrompt({
          name: 'etn.summarize_thought',
          arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
        });
        const message = result.messages[0];
        assert.ok(message !== undefined);
        assert.ok(message.content.type === 'text');
        assert.match(message.content.text, /etn:\/\/networks\//);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('fails a tool call whose input violates the schema', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, true);
        assert.match(toolText(result), /ETN error|Unexpected error|Invalid/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thought-type resource returns effective (inherited) properties with registry property_id (f14cd5f1)', async () => {
    // The resource used to expose only the type's own bindings; since 0.6.5
    // it must mirror `etn.types.list` and include inherited ones — agents
    // pointed at the resource by the docs need the same shape as the tool.
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const parent = createThoughtType(ndb, { name: 'ResParent' }, ctx.adminId);
      const child = createThoughtType(
        ndb,
        { name: 'ResChild', parent_id: parent.id },
        ctx.adminId,
      );
      const def = createTypeProperty(ndb, 'thought_type', parent.id, {
        key: 'status',
        value_type: 'text',
      }, USER);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thought-types/${child.id}`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        const type = JSON.parse(block.text) as {
          id: string;
          properties: Array<{
            key: string;
            property_id: string;
            inherited: boolean;
            defined_on: string;
            value_type: string;
          }>;
        };
        assert.equal(type.id, child.id);
        // The child has no own bindings — but the resource must still list the
        // inherited property because that's what `etn.types.list` does.
        const inherited = type.properties.find((p) => p.key === 'status');
        assert.ok(inherited, 'inherited property must be present');
        assert.equal(inherited.property_id, def.property_id);
        assert.equal(inherited.inherited, true);
        assert.equal(inherited.defined_on, parent.id);
        assert.equal(inherited.value_type, 'text');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tools/list surfaces MCP annotations from the canonical registry (O7)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));

        // Every tool from the catalogue must be present AND carry exactly the
        // annotations declared in `MCP_TOOL_ANNOTATIONS` — a regression
        // guard against (a) a new tool silently shipped without hints or
        // (b) a hint accidentally dropped from an existing registration.
        for (const name of MCP_TOOL_NAMES) {
          const tool = byName.get(name);
          assert.ok(tool, `tools/list must contain ${name}`);
          // The MCP SDK's `ToolAnnotationsSchema` strips unknown fields, so
          // `deprecated_since` (задача 053751b5) does NOT round-trip through
          // the wire — it lives only in the server-side canonical registry.
          // Filter both sides to the SDK-known keys before deepEqual.
          const wire = filterToSdkAnnotations(tool.annotations);
          const canon = filterToSdkAnnotations(
            MCP_TOOL_ANNOTATIONS[name] as Record<string, unknown> | undefined,
          );
          assert.deepEqual(
            wire,
            canon,
            `annotations for ${name} must match the canonical registry`,
          );
        }

        // Spot-check the three hint classes against real tool entries so a
        // blanket deepEqual cannot hide a flipped boolean.
        const get = byName.get('etn.thoughts.get')!;
        assert.equal(get.annotations?.readOnlyHint, true);
        assert.equal(get.annotations?.destructiveHint, undefined);
        assert.equal(get.annotations?.idempotentHint, undefined);

        const del = byName.get('etn.thoughts.delete')!;
        assert.equal(del.annotations?.readOnlyHint, undefined);
        assert.equal(del.annotations?.destructiveHint, true);

        const upsert = byName.get('etn.thoughts.upsert_bundle')!;
        assert.equal(upsert.annotations?.idempotentHint, true);

        const setActive = byName.get('etn.thoughts.set_active')!;
        assert.equal(setActive.annotations?.idempotentHint, true);

        const setProp = byName.get('etn.properties.set')!;
        assert.equal(setProp.annotations?.idempotentHint, true);

        // Sanity check: count coverage matches the registry so a future
        // addition does not silently leak a tool without a hint.
        const annotated = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n] !== undefined,
        ).length;
        const hintReadOnly = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.readOnlyHint === true,
        ).length;
        const hintDestructive = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.destructiveHint === true,
        ).length;
        const hintIdempotent = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.idempotentHint === true,
        ).length;
        // S10 added 8 layer tools: 3 read (list, diff, diff_doc — readOnlyHint),
        // 2 destructive (delete, merge) and 2 idempotent (update, select) —
        // `create` has no hint (matches `thoughts.create`/`links.create`).
        // Task a88acf20 adds 4 object-lock tools: 1 read (`list` — readOnlyHint),
        // 2 destructive (`release`, `clear`) and 1 idempotent (`acquire`
        // продлевает свой захват).
        // Task f2eca5a4 adds 1 activity-log tool: read (`list` — readOnlyHint).
        // Task 6bcccd2b adds 2 activity-maintenance tools: rollup + truncate —
        // оба `destructiveHint: true` (необратимые операции с журналом).
        // Task 940a499d adds 1 read tool (`etn.metrics.tools` — readOnlyHint)
        // over the previous 45/27/10/8 counts.
        // Task 6d45ab37 (P1-паритет MCP↔REST) добавляет 6 инструментов:
        //   * resolve (readOnlyHint) — +1 readOnly;
        //   * bulk_update (явные destructiveHint: false + idempotentHint: false) — не считается ни в readOnly, ни в destructive/idempotent;
        //   * chronicle.query (readOnlyHint) — +1 readOnly;
        //   * members.list (readOnlyHint) — +1 readOnly;
        //   * attachments.update (idempotentHint) — +1 idempotent;
        //   * attachments.delete (destructiveHint) — +1 destructive.
        // Task ba024a45 / 0.7.2 добавляет 3 инструмента:
        //   * `etn.instructions` (readOnlyHint) — +1 readOnly;
        //   * `etn.networks.write` (idempotentHint) — +1 idempotent;
        //   * `etn.networks.delete` (destructiveHint) — +1 destructive.
        // Task 053751b5 / 0.7.2 добавляет `etn.thoughts.write` (idempotentHint)
        // — +1 annotated, +1 idempotent. 4 из 7 поглощённых (`etn.thoughts.create`,
        // `update`, `links.create`, `comments.upsert`) ранее были без записи
        // в `MCP_TOOL_ANNOTATIONS` — теперь у всех семёрки есть пометка
        // `deprecated_since: '0.7.2'`, поэтому canonical registry учитывает
        // их наравне с остальными.
        // P3 (задача e488f4c1): +4 (`copy_subtree`, `mentions_scan`,
        // `import.dry_run`, `import.subgraph`) → 67.
        // Задача c1fa71d4 / 0.7.3: +1 (`etn.views.run`, readOnlyHint) → 68.
        assert.equal(annotated, 68);
        assert.equal(hintReadOnly, 35);
        assert.equal(hintDestructive, 14);
        assert.equal(hintIdempotent, 12);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
