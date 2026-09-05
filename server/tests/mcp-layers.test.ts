/**
 * Integration test for the MCP layer tools (task S10, 13-layers.md §10.2).
 *
 * Drives the full agent cycle "create a layer → write in it → see the
 * isolation → merge → delete" **exclusively through MCP tool calls** — no
 * REST, no direct domain-service access — the exact DoD of S10:
 * "агент проходит цикл … ни разу не обращаясь к REST руками".
 *
 * A second API key of the same user (the read-only key `ctx.readOnlyKey`)
 * doubles as a second, independent MCP "session": layer selection is keyed
 * per API key (`mcpLayerClientId`, 13-layers.md §7.1), so two keys of the
 * same user never share a session layer — exactly like two REST clients with
 * different `Client-Id` headers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Layer, LayerMergeReport, McpMutationResult } from '@etn/shared';

import { buildMcpContext, closeMcpContext, connectMcpClient, nativeAvailable, toolJson } from './mcp-helpers.js';

describe('MCP layer tools (S10)', { skip: !nativeAvailable() }, () => {
  it('create → select → write → isolation → merge → auto-repoint on delete', async () => {
    const ctx = await buildMcpContext();
    try {
      const agent = await connectMcpClient(ctx, ctx.adminKey);
      // A second key of the SAME user: an independent MCP "session" whose
      // layer selection never moves, so it observes the base throughout.
      const observer = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        // --- Only the base exists at first, current for every key. -------
        const initialList = toolJson<Layer[]>(
          await agent.client.callTool({
            name: 'etn.layers.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        assert.equal(initialList.length, 1);
        assert.equal(initialList[0]?.is_base, true);
        assert.equal(initialList[0]?.current, true);

        // --- Create a layer (does not switch the session on its own). ----
        const created = toolJson<Layer & { layer: { id: string; title: string } }>(
          await agent.client.callTool({
            name: 'etn.layers.create',
            arguments: { network_id: ctx.networkId, title: 'Песочница', comment: 'MCP test' },
          }),
        );
        assert.equal(created.title, 'Песочница');
        // Defaults to the calling key's current layer — still the base.
        assert.equal(created.parent_id, initialList[0]?.id);
        // The echoed session layer (§7.1) is also still the base — creating
        // a layer is not the same as switching to it.
        assert.equal(created.layer.id, initialList[0]?.id);
        // The freshly created layer is never `current` — `current` reflects
        // the session's selected layer, and `etn.layers.create` does not
        // switch the session (fix 9b159e7a: `current` used to be `true`).
        assert.equal(created.current, false);
        const sandboxId = created.id;

        // --- Select it: every later call of THIS key runs in it. ---------
        const selected = toolJson<{ id: string; title: string }>(
          await agent.client.callTool({
            name: 'etn.layers.select',
            arguments: { network_id: ctx.networkId, layer_id: sandboxId },
          }),
        );
        assert.equal(selected.id, sandboxId);

        const afterSelect = toolJson<Layer[]>(
          await agent.client.callTool({
            name: 'etn.layers.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        const base = afterSelect.find((l) => l.is_base)!;
        const sandbox = afterSelect.find((l) => l.id === sandboxId)!;
        assert.equal(base.current, false);
        assert.equal(sandbox.current, true);

        // The observer key never selected anything: still on the base.
        const observerList = toolJson<Layer[]>(
          await observer.client.callTool({
            name: 'etn.layers.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        assert.equal(observerList.find((l) => l.is_base)!.current, true);

        // --- Write while on the layer: every existing tool honours it. ---
        const thought = toolJson<McpMutationResult & { title?: string }>(
          await agent.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Мысль слоя' },
          }),
        );
        // The mutation echoes the session's current layer (§7.1) — the
        // sandbox, not the base.
        assert.equal((thought as unknown as { layer: { id: string } }).layer.id, sandboxId);

        // Isolation (§4.1): the agent's own key sees it (same layer)…
        const seenByAgent = await agent.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thought.id },
        });
        assert.notEqual(seenByAgent.isError, true);

        // …the observer key (still on the base) does not.
        const seenByObserver = await observer.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thought.id },
        });
        assert.equal(seenByObserver.isError, true);

        // --- Merge the layer fully into the base. -------------------------
        const report = toolJson<LayerMergeReport>(
          await agent.client.callTool({
            name: 'etn.layers.merge',
            arguments: { network_id: ctx.networkId, layer_id: sandboxId },
          }),
        );
        assert.equal(report.applied.thoughts, 1);
        assert.deepEqual(report.skipped, []);

        // Transparency after merge: the base-bound observer now sees it.
        const seenAfterMerge = await observer.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thought.id },
        });
        assert.notEqual(seenAfterMerge.isError, true);

        // --- Delete the now-empty layer; the agent's session auto-repoints
        // to its parent (mirrors the REST cascade, 13-layers.md §2.4) — no
        // explicit `etn.layers.select` back to the base is needed.
        const del = toolJson<{ deleted: number; purged: number; skipped: number }>(
          await agent.client.callTool({
            name: 'etn.layers.delete',
            arguments: { network_id: ctx.networkId, layer_id: sandboxId },
          }),
        );
        assert.equal(del.deleted, 1);

        const finalList = toolJson<Layer[]>(
          await agent.client.callTool({
            name: 'etn.layers.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        assert.equal(finalList.length, 1);
        assert.equal(finalList[0]?.is_base, true);
        assert.equal(finalList[0]?.current, true);
      } finally {
        await observer.close();
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a partial merge with an unclosed selection (§8.1)', async () => {
    const ctx = await buildMcpContext();
    try {
      const agent = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<Layer>(
          await agent.client.callTool({
            name: 'etn.layers.create',
            arguments: { network_id: ctx.networkId, title: 'L1' },
          }),
        );
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: created.id },
        });
        const parent = toolJson<McpMutationResult>(
          await agent.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Родитель' },
          }),
        );
        const child = toolJson<McpMutationResult>(
          await agent.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Ребёнок' },
          }),
        );
        const link = toolJson<McpMutationResult>(
          await agent.client.callTool({
            name: 'etn.links.create',
            arguments: { network_id: ctx.networkId, source_id: parent.id, target_id: child.id },
          }),
        );

        // Only the link is selected — its endpoints are not, and neither
        // exists in the base yet: the closure check (§8.1) must reject
        // before touching anything.
        const rejected = await agent.client.callTool({
          name: 'etn.layers.merge',
          arguments: {
            network_id: ctx.networkId,
            layer_id: created.id,
            tables: { links: [link.id] },
          },
        });
        assert.equal(rejected.isError, true);
      } finally {
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
