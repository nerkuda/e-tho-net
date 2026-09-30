/**
 * MCP contour of the paged layer diff (задача ddb67ddc): the default
 * `etn.ops { action: "layers.diff" }` call must return the FIRST page (with
 * counts over all sections and a `next_cursor`), and every answer must fit the
 * MCP client budget `maxModelBytes = 50000` — the transport must never cut a
 * page silently.
 *
 * Scale (~300 removed links) is reproduced synthetically with the domain
 * services: the layer tombstones the base links, giving a non-empty large
 * `links.removed` section — reachable page by page, without `trash.list` /
 * `activity_list`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type Layer, type LayerDiffPage } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createLink, deleteLink } from '../src/domain/link-service.js';
import { createThought } from '../src/domain/thought-service.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
/** The default MCP-client response budget (05-mcp-server.md §4.1). */
const MAX_MODEL_BYTES = 50_000;

describe('MCP layers.diff pagination (ddb67ddc)', { skip: !nativeAvailable() }, () => {
  it('default call returns the first page within budget, counts and cursor', async () => {
    const ctx = await buildMcpContext();
    try {
      const agent = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const net = ctx.networkId;
        const layer = toolJson<Layer>(
          await callOp(agent.client, 'layers.create', { network_id: net, title: 'Большой слой' }),
        );
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: net, layer_id: layer.id },
        });

        // --- Synthetic scale: 300 base links, all tombstoned in the layer. ---
        const base = openNetworkDb(ctx.dataDir, net, undefined, BASE_LAYER_ID);
        const hub = createThought(base, { title: 'Хаб' }, SYSTEM).id;
        const linkIds: string[] = [];
        for (let i = 0; i < 300; i += 1) {
          const target = createThought(base, { title: `Цель ${i}` }, SYSTEM).id;
          linkIds.push(createLink(base, { source_id: hub, target_id: target }, SYSTEM).id);
        }
        const layerNdb = openNetworkDb(ctx.dataDir, net, undefined, layer.id);
        for (const id of linkIds) deleteLink(layerNdb, id, undefined);

        // --- Default MCP call: no pagination parameters at all. -------------
        const first = await callOp(agent.client, 'layers.diff', { network_id: net, layer_id: layer.id });
        assert.equal(first.isError, undefined, toolText(first));
        const firstText = toolText(first);
        assert.ok(
          Buffer.byteLength(firstText, 'utf8') <= MAX_MODEL_BYTES,
          `default page ${Buffer.byteLength(firstText, 'utf8')} Б exceeds ${MAX_MODEL_BYTES}`,
        );
        const page1 = toolJson<LayerDiffPage>(first);
        assert.deepEqual(page1.sections, [
          'links.added',
          'links.removed',
          'links.type_changed',
          'links.reorder_collapsed',
          'links.reparented',
          'overridden.thought_ids',
          'overridden.link_ids',
        ]);
        assert.equal(page1.counts['links.removed'], 300);
        assert.equal(page1.truncated, true);
        assert.equal(page1.reason, 'has_more');
        assert.ok(page1.next_cursor);
        assert.ok(
          (page1.links.removed?.length ?? 0) < 300,
          'default page must be a slice, not the whole report',
        );

        // --- Walk links.removed page by page; sums equal counts. ------------
        const ids: string[] = [...(page1.links.removed ?? [])].map((r) => r.id);
        let cursor: string | null = page1.next_cursor;
        while (cursor !== null) {
          const res = await callOp(agent.client, 'layers.diff', {
            network_id: net,
            layer_id: layer.id,
            sections: ['links.removed'],
            limit: 100,
            cursor,
          });
          assert.equal(res.isError, undefined, toolText(res));
          const text = toolText(res);
          assert.ok(
            Buffer.byteLength(text, 'utf8') <= MAX_MODEL_BYTES,
            `page ${Buffer.byteLength(text, 'utf8')} Б exceeds ${MAX_MODEL_BYTES}`,
          );
          const page = toolJson<LayerDiffPage>(res);
          assert.deepEqual(page.sections, ['links.removed']);
          ids.push(...(page.links.removed ?? []).map((r) => r.id));
          cursor = page.next_cursor;
          if (!page.truncated) break;
        }
        assert.equal(ids.length, 300, 'cursor walk must reach every removed link');
        assert.equal(new Set(ids).size, 300, 'no duplicates across pages');

        // --- Boundary errors are explicit and safe. -------------------------
        const badSection = await callOp(agent.client, 'layers.diff', {
          network_id: net,
          layer_id: layer.id,
          sections: ['thoughts.added'],
        });
        assert.equal(badSection.isError, true);

        const badCursor = await callOp(agent.client, 'layers.diff', {
          network_id: net,
          layer_id: layer.id,
          cursor: '!!!not-base64',
        });
        assert.equal(badCursor.isError, true);

        // --- The guide documents the new contract and diff_doc limits. ------
        const guide = await agent.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'layers.diff' },
        });
        assert.equal(guide.isError, undefined, toolText(guide));
        assert.match(toolText(guide), /sections/);
        assert.match(toolText(guide), /cursor/);
        assert.match(toolText(guide), /counts/);
        const diffDocGuide = await agent.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'layers.diff_doc' },
        });
        assert.equal(diffDocGuide.isError, undefined, toolText(diffDocGuide));
        assert.match(toolText(diffDocGuide), /НЕ пагинируется/);
      } finally {
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
