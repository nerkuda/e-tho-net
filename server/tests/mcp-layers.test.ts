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

import type { Layer, LayerMergeReport } from '@etn/shared';
import { BASE_LAYER_ID } from '@etn/shared';

import {
  callOp,
  buildMcpContext, callWrite, closeMcpContext, connectMcpClient, createThoughtViaWrite, nativeAvailable, toolJson, toolText,
} from './mcp-helpers.js';

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
          await callOp(agent.client, 'layers.create', { network_id: ctx.networkId, title: 'Песочница', comment: 'MCP test' }),
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

        // --- Rename while still on the base: `current` mirrors the calling
        // key's session layer, not the edited layer (same contract as
        // create; etn.layers.update used to echo current: true).
        const renamedOnBase = toolJson<Layer & { request_id: string }>(
          await callOp(agent.client, 'layers.update', { network_id: ctx.networkId, layer_id: sandboxId, title: 'Песочница!' }),
        );
        assert.equal(renamedOnBase.title, 'Песочница!');
        assert.equal(renamedOnBase.current, false);

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

        // Editing while sitting ON the layer: `current` is true (the session
        // really is there; the version was bumped by the rename above).
        const renamedInLayer = toolJson<Layer>(
          await callOp(agent.client, 'layers.update', { network_id: ctx.networkId, layer_id: sandboxId, comment: 'sandbox' }),
        );
        assert.equal(renamedInLayer.current, true);

        // The observer key never selected anything: still on the base.
        const observerList = toolJson<Layer[]>(
          await observer.client.callTool({
            name: 'etn.layers.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        assert.equal(observerList.find((l) => l.is_base)!.current, true);

        // --- Write while on the layer: every existing tool honours it. ---
        const written = await callWrite(agent.client, ctx.networkId, [
          { ref: 'l', thought: { title: 'Мысль слоя' } },
        ]);
        const thoughtId = written.items[0]!.id;
        // The mutation echoes the session's current layer (§7.1) — the
        // sandbox, not the base.
        assert.equal(written.layer.id, sandboxId);

        // Isolation (§4.1): the agent's own key sees it (same layer)…
        const seenByAgent = await agent.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thoughtId },
        });
        assert.notEqual(seenByAgent.isError, true);

        // …the observer key (still on the base) does not.
        const seenByObserver = await observer.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thoughtId },
        });
        assert.equal(seenByObserver.isError, true);

        // --- Merge the layer fully into the base. -------------------------
        const report = toolJson<LayerMergeReport>(
          await callOp(agent.client, 'layers.merge', { network_id: ctx.networkId, layer_id: sandboxId }, true),
        );
        assert.equal(report.applied.thoughts, 1);
        assert.deepEqual(report.skipped, []);

        // Transparency after merge: the base-bound observer now sees it.
        const seenAfterMerge = await observer.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: thoughtId },
        });
        assert.notEqual(seenAfterMerge.isError, true);

        // --- Delete the now-empty layer; the agent's session auto-repoints
        // to its parent (mirrors the REST cascade, 13-layers.md §2.4) — no
        // explicit `etn.layers.select` back to the base is needed.
        const del = toolJson<{ deleted: number; purged: number; skipped: number }>(
          await callOp(agent.client, 'layers.delete', { network_id: ctx.networkId, layer_id: sandboxId }, true),
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
          await callOp(agent.client, 'layers.create', { network_id: ctx.networkId, title: 'L1' }),
        );
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: created.id },
        });
        const parentWrite = await callWrite(agent.client, ctx.networkId, [
          { ref: 'p', thought: { title: 'Родитель' } },
        ]);
        const parentId = parentWrite.items[0]!.id;
        const childWrite = await callWrite(agent.client, ctx.networkId, [
          { ref: 'c', thought: { title: 'Ребёнок' } },
        ]);
        const childId = childWrite.items[0]!.id;
        const link = toolJson<{ link_id: string }>(
          await agent.client.callTool({
            name: 'etn.properties.add',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: parentId,
              key: 'Потомки',
              value: childId,
            },
          }),
        );

        // Only the link is selected — its endpoints are not, and neither
        // exists in the base yet: the closure check (§8.1) must reject
        // before touching anything.
        const rejected = await callOp(agent.client, 'layers.merge', {
            network_id: ctx.networkId,
            layer_id: created.id,
            tables: { links: [link.link_id] },
          }, true);
        assert.equal(rejected.isError, true);
      } finally {
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('agrees recovery path: layers.conflicts preview + layers.reset_override unblock a merge (7cc34cf4)', async () => {
    const ctx = await buildMcpContext();
    try {
      const agent = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const net = ctx.networkId;
        const a = (await createThoughtViaWrite(agent.client, net, { title: 'A' })).id;
        const layer = toolJson<Layer>(
          await callOp(agent.client, 'layers.create', { network_id: net, title: 'Конфликтный слой' }),
        );
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: net, layer_id: layer.id },
        });
        // The layer overrides A …
        await callWrite(agent.client, net, [{ thought_id: a, title: 'A (слой)' }]);
        // … the base edits the same row afterwards (the merge now conflicts).
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: net, layer_id: BASE_LAYER_ID },
        });
        await callWrite(agent.client, net, [{ thought_id: a, title: 'A (основа)' }]);
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: net, layer_id: layer.id },
        });

        assert.equal(
          (await callOp(agent.client, 'layers.merge', { network_id: net, layer_id: layer.id }, true)).isError,
          true,
        );

        // Read-only preview names the row and the side-by-side difference.
        const preview = toolJson<{
          overridden: number;
          conflicts: Array<{
            table: string;
            id: string;
            previous_base_version: number;
            current_version: number;
            diff: Array<{ column: string; base: string | null; layer: string | null }>;
          }>;
        }>(await callOp(agent.client, 'layers.conflicts', { network_id: net, layer_id: layer.id }));
        assert.equal(preview.overridden, 1);
        assert.equal(preview.conflicts.length, 1);
        assert.equal(preview.conflicts[0]!.id, a);
        assert.deepEqual(
          preview.conflicts[0]!.diff.find((d) => d.column === 'title'),
          { column: 'title', base: 'A (основа)', layer: 'A (слой)' },
        );

        // Destructive: confirm is required.
        const refused = await callOp(agent.client, 'layers.reset_override', {
          network_id: net,
          layer_id: layer.id,
          tables: { thoughts: [a] },
        });
        assert.equal(refused.isError, true);
        assert.match(toolText(refused), /confirm/);

        const reset = toolJson<{ reset: unknown[]; unchanged: unknown[] }>(
          await callOp(
            agent.client,
            'layers.reset_override',
            { network_id: net, layer_id: layer.id, tables: { thoughts: [a] } },
            true,
          ),
        );
        assert.equal(reset.reset.length, 1);
        assert.deepEqual(reset.unchanged, []);

        // The merge goes through, and the base carries the layer's content.
        assert.equal(
          (await callOp(agent.client, 'layers.merge', { network_id: net, layer_id: layer.id }, true)).isError,
          undefined,
        );
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: net, layer_id: BASE_LAYER_ID },
        });
        const merged = toolJson<{ title: string }>(
          await agent.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: net, thought_id: a },
          }),
        );
        assert.equal(merged.title, 'A (слой)');

        // The guide documents the action (topic reachable from the registry).
        const guide = await agent.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'layers.reset_override' },
        });
        assert.equal(guide.isError, undefined, toolText(guide));
        assert.match(toolText(guide), /base_version/);
        assert.match(toolText(guide), /confirm: true/);
      } finally {
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
