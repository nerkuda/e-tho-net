/**
 * Unit tests for the subgraph budget shrinker (task O13,
 * docs/05-mcp-server.md §4.1). No native binding needed — operates on
 * already-materialised JSON payloads, so the algorithm is exercised in
 * isolation from the SQLite layer.
 *
 * The helper {@link buildPayload} produces a small chain graph with
 * optional comment previews; the per-test scenarios tweak the budget /
 * chain length to drive each shrink step.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SubgraphBudgetPayload } from '../src/mcp/subgraph-budget.js';
import { shrinkSubgraphToBudget } from '../src/mcp/subgraph-budget.js';

/**
 * Build a chain `seed → n1 → n2 → n3 → n4` (5 nodes, 4 edges). Comments
 * default to a 1500-character body on the last node, so the chain is
 * naturally a few KB — enough to exercise both shrink steps without
 * making the test slow.
 */
function buildPayload(
  opts: { withComments?: boolean; longBodies?: boolean } = {},
): SubgraphBudgetPayload {
  const body = opts.longBodies === false ? '' : 'x'.repeat(1500);
  const nodes: SubgraphBudgetPayload['nodes'] = [
    { id: 'seed', title: 'Seed' },
    { id: 'n1', title: 'Node 1' },
    { id: 'n2', title: 'Node 2' },
    { id: 'n3', title: 'Node 3' },
    { id: 'n4', title: 'Node 4' },
  ];
  const edges: SubgraphBudgetPayload['edges'] = [
    { id: 'e1', source_id: 'seed', target_id: 'n1', type_id: null },
    { id: 'e2', source_id: 'n1', target_id: 'n2', type_id: null },
    { id: 'e3', source_id: 'n2', target_id: 'n3', type_id: null },
    { id: 'e4', source_id: 'n3', target_id: 'n4', type_id: null },
  ];
  const comments = opts.withComments === false
    ? undefined
    : (['seed', 'n1', 'n2', 'n3', 'n4'].map((thought_id) => ({
        thought_id,
        permanent: {
          id: `p-${thought_id}`,
          body_md: body,
          chars_returned: body.length,
          chars_total: body.length,
          truncated: false,
          valid_from: '2024-01-01',
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
        chronological: {
          entries: [
            {
              id: `c-${thought_id}`,
              title: null,
              body_md: body,
              chars_returned: body.length,
              chars_total: body.length,
              truncated: false,
              valid_from: '2024-01-01',
              valid_to: null,
              created_by: 'u',
              created_at: '2024-01-01',
            },
          ],
          total: 1,
          returned: 1,
          truncated: false,
        },
      })) satisfies SubgraphBudgetPayload['comments']);
  return { nodes, edges, ...(comments === undefined ? {} : { comments }) };
}

describe('shrinkSubgraphToBudget (task O13)', () => {
  it('returns the payload untouched when it already fits', () => {
    const payload = buildPayload();
    const originalSize = JSON.stringify(payload).length;
    const result = shrinkSubgraphToBudget(payload, { seed_ids: ['seed'], max_chars: originalSize });
    assert.equal(result.truncated, false);
    assert.equal(result.reason, null);
    assert.equal(result.original_chars, originalSize);
    assert.equal(result.final_chars, originalSize);
    assert.equal(result.payload.nodes.length, 5);
    assert.equal(result.payload.edges.length, 4);
  });

  it('reports max_chars_preview when only the comment bodies need shortening', () => {
    // 5 nodes × 1500 chars per comment × 2 entries ≈ 15 KB of body content;
    // set the budget so the long bodies must shrink but the topology fits.
    const payload = buildPayload();
    const originalSize = JSON.stringify(payload).length;
    const targetBudget = Math.floor(originalSize * 0.6);
    const result = shrinkSubgraphToBudget(payload, {
      seed_ids: ['seed'],
      max_chars: targetBudget,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.reason, 'max_chars_preview');
    assert.ok(result.final_chars <= targetBudget, `final ${result.final_chars} > ${targetBudget}`);
    // Topology preserved — every node and every edge survives the preview step.
    assert.equal(result.payload.nodes.length, 5);
    assert.equal(result.payload.edges.length, 4);
    assert.ok(payload.comments !== undefined);
    for (const c of result.payload.comments ?? []) {
      // Both the permanent preview and each chronological entry were
      // trimmed to the floor (SUBGRAPH_BUDGET_PREVIEW_CHARS).
      assert.ok(c.permanent !== null);
      assert.ok(c.permanent.body_md.length <= 500);
      for (const entry of c.chronological.entries) {
        assert.ok(entry.body_md.length <= 500);
      }
    }
  });

  it('drops the farthest nodes first when even shortened previews do not fit', () => {
    const payload = buildPayload();
    // Force the budget well below what comment shrinking can achieve —
    // the only way to fit is to drop nodes.
    const targetBudget = 800;
    const result = shrinkSubgraphToBudget(payload, {
      seed_ids: ['seed'],
      max_chars: targetBudget,
      preview_chars: 50, // aggressive preview floor for the test
    });
    assert.equal(result.truncated, true);
    assert.equal(result.reason, 'max_chars_nodes');
    assert.ok(result.final_chars <= targetBudget, `final ${result.final_chars} > ${targetBudget}`);
    // Seed must survive; farthest nodes (n3, n4) must be the first dropped.
    assert.ok(result.payload.nodes.some((n) => n.id === 'seed'));
    assert.equal(
      result.payload.nodes.some((n) => n.id === 'n4'),
      false,
      'farthest node n4 should be dropped first',
    );
    assert.equal(
      result.payload.nodes.some((n) => n.id === 'n3'),
      false,
      'second-farthest n3 should also be dropped before any nearer node',
    );
  });

  it('protects the seed nodes from removal even when the budget cannot fit anything else', () => {
    // Build a payload so big that the only way to satisfy a tiny budget is
    // to delete everything except the seed — and verify the seed survives.
    const payload = buildPayload({ longBodies: true });
    for (let i = 0; i < 5; i++) {
      payload.nodes.push({ id: `extra-${i}`, title: `Extra ${i}` });
      payload.edges.push({
        id: `ee-${i}`,
        source_id: `extra-${i}`,
        target_id: 'n4',
        type_id: null,
      });
    }
    if (payload.comments) {
      for (let i = 0; i < 5; i++) {
        payload.comments.push({
          thought_id: `extra-${i}`,
          permanent: {
            id: `p-extra-${i}`,
            body_md: 'y'.repeat(2000),
            chars_returned: 2000,
            chars_total: 2000,
            truncated: false,
            valid_from: '2024-01-01',
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
          chronological: { entries: [], total: 0, returned: 0, truncated: false },
        });
      }
    }
    const result = shrinkSubgraphToBudget(payload, {
      seed_ids: ['seed'],
      max_chars: 300,
      preview_chars: 50,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.payload.nodes.some((n) => n.id === 'seed'), 'seed must survive');
    // The seed's incident edges reference a node (`n1`) that was dropped, so
    // the only surviving edge incident to the seed is the one whose other
    // endpoint also survived.
    for (const edge of result.payload.edges) {
      assert.ok(
        result.payload.nodes.some((n) => n.id === edge.source_id),
        `edge ${edge.id} source_id ${edge.source_id} must reference a surviving node`,
      );
      assert.ok(
        result.payload.nodes.some((n) => n.id === edge.target_id),
        `edge ${edge.id} target_id ${edge.target_id} must reference a surviving node`,
      );
    }
  });

  it('removes the dropped node comment slot from the comments array', () => {
    const payload = buildPayload();
    assert.ok(payload.comments !== undefined);
    const result = shrinkSubgraphToBudget(payload, {
      seed_ids: ['seed'],
      max_chars: 600,
      preview_chars: 50,
    });
    assert.equal(result.reason, 'max_chars_nodes');
    assert.ok(result.payload.comments !== undefined);
    for (const c of result.payload.comments) {
      assert.ok(
        result.payload.nodes.some((n) => n.id === c.thought_id),
        `comment slot for ${c.thought_id} must not survive without its node`,
      );
    }
  });

  it('keeps the original payload reference (mutates in place)', () => {
    const payload = buildPayload();
    const ref = payload;
    shrinkSubgraphToBudget(payload, { seed_ids: ['seed'], max_chars: 200, preview_chars: 50 });
    assert.strictEqual(ref, payload, 'payload reference must be preserved');
  });

  it('does not mutate the payload when the budget is already met', () => {
    const payload = buildPayload();
    const snapshot = JSON.parse(JSON.stringify(payload)) as SubgraphBudgetPayload;
    const originalSize = JSON.stringify(payload).length;
    shrinkSubgraphToBudget(payload, { seed_ids: ['seed'], max_chars: originalSize });
    assert.deepEqual(payload, snapshot);
  });
});
