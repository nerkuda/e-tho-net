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

import {
  closeMcpContext,
  buildMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

describe('MCP server (F1 smoke)', { skip: !nativeAvailable() }, () => {
  it('lists all 19 tools from the shared catalogue', async () => {
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

  it('lists the 4 prompt templates', async () => {
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
          assert.deepEqual(
            tool.annotations ?? {},
            MCP_TOOL_ANNOTATIONS[name] ?? {},
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
        // S10 added 6 layer tools: 1 read (readOnlyHint), 2 destructive
        // (delete, merge) and 2 idempotent (update, select) — `create` has no
        // hint (matches `thoughts.create`/`links.create`).
        assert.equal(annotated, 36);
        assert.equal(hintReadOnly, 23);
        assert.equal(hintDestructive, 6);
        assert.equal(hintIdempotent, 7);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
