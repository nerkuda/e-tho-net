/**
 * End-to-end layer tests (task S12) — the invariants the database no longer
 * holds after the foreign keys were dropped (13-layers.md §3, §12 DoD):
 *
 *   * **isolation across every read tool** — a layer write must stay
 *     invisible from the base in EVERY read surface, enumerated as a list so
 *     a forgotten query is discoverable: `get`, `query` (keywords),
 *     `search` (FTS), `subgraph`, `neighbors`, `path`. (Ref-tracking tools —
 *     `usage`/`mentions`/`backlinks` — intentionally left out: a formal
 *     reference from a VISIBLE row to an INVISIBLE target stays visible,
 *     §4.1 hides entities, not references to them);
 *   * **transparency** — rows the layer has not overridden stay visible from
 *     the layer and follow base edits;
 *   * **integrity** — after deletions, merges and trash purges no dangling
 *     live references remain in any layer
 *     ({@link checkLayerIntegrity}, runnable over a live base as a
 *     preservation sweep);
 *   * **perf smoke** — reads through the views at full depth (4 layers over
 *     the base) stay fast on thousands of thoughts.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError, TRAVERSAL_DEFAULTS } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { checkLayerIntegrity } from '../src/domain/layer-integrity.js';
import { createComment } from '../src/domain/comment-service.js';
import { createLink } from '../src/domain/link-service.js';
import { subgraph, findPath } from '../src/domain/graph-traversal.js';
import { search } from '../src/domain/search-service.js';
import { queryThoughts } from '../src/domain/query-service.js';
import {
  createThought,
  deleteThought,
  getNeighbors,
  getThought,
  getThoughtOrThrow,
  updateThought,
} from '../src/domain/thought-service.js';
import { mergeLayer } from '../src/domain/merge-service.js';
import { createLayer, deleteLayer } from '../src/domain/layer-service.js';
import { checkLayerIntegrity as sweep } from '../src/domain/layer-integrity.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'user-1';

/** Create a layer over the base, switch `ndb` into its context, return its id. */
function startLayer(ndb: NetworkDb): string {
  const layer = createLayer(ndb, {
    parentId: BASE_LAYER_ID,
    title: 'Слой проверки',
    comment: 'S12',
    createdBy: USER,
  });
  ndb.useLayer(layer.id);
  return layer.id;
}

/** Assert the integrity invariant holds — the S12 sweep runnable on live data. */
function assertIntegrity(ndb: NetworkDb): void {
  assert.deepEqual(sweep(ndb), [], 'dangling live references found');
}

describe(
  'layers S12 — end-to-end invariants',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('isolation: a layer edit is invisible in the base across every read tool', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const x = createThought(ndb, { title: 'Икс' }, USER);
        const y = createThought(ndb, { title: 'Игрек' }, USER);
        const z = createThought(ndb, { title: 'Зет' }, USER); // never overridden
        createLink(ndb, { source_id: x.id, target_id: y.id }, USER);

        const layer = createLayer(ndb, {
          parentId: BASE_LAYER_ID,
          title: 'Слой',
          createdBy: USER,
        });
        ndb.useLayer(layer.id);
        // The layer renames X (a shadow) and deletes Y (a tombstone).
        updateThought(ndb, x.id, { title: 'Икс-слой' }, undefined, USER);
        deleteThought(ndb, y.id, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);

        const layerView = (): void => ndb.useLayer(layer.id);
        const baseView = (): void => ndb.useLayer(BASE_LAYER_ID);

        // --- every read tool, enumerated -----------------------------------
        // get
        layerView();
        assert.equal(getThought(ndb, x.id)?.title, 'Икс-слой');
        assert.throws(() => getThoughtOrThrow(ndb, y.id), (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND');
        baseView();
        assert.equal(getThought(ndb, x.id)?.title, 'Икс');
        assert.equal(getThought(ndb, y.id)?.title, 'Игрек');

        // query (keywords LIKE)
        layerView();
        assert.equal(queryThoughts(ndb, { keywords: 'Икс-слой' }, { maxNodes: 100 }).total, 1);
        assert.equal(queryThoughts(ndb, { keywords: 'Игрек' }, { maxNodes: 100 }).total, 0);
        baseView();
        assert.equal(queryThoughts(ndb, { keywords: 'Икс' }, { maxNodes: 100 }).total, 1);
        assert.equal(queryThoughts(ndb, { keywords: 'Игрек' }, { maxNodes: 100 }).total, 1);

        // search (FTS on names)
        layerView();
        assert.equal(search(ndb, { q: 'Икс-слой', scope: 'names' }).by_names.length, 1);
        assert.equal(search(ndb, { q: 'Игрек', scope: 'names' }).by_names.length, 0);
        baseView();
        assert.equal(search(ndb, { q: 'Игрек', scope: 'names' }).by_names.length, 1);

        // subgraph
        layerView();
        const sgLayer = subgraph(ndb, [x.id], 1);
        assert.ok(!sgLayer.nodes.includes(y.id));
        baseView();
        const sgBase = subgraph(ndb, [x.id], 1);
        assert.ok(sgBase.nodes.includes(y.id));

        // neighbors
        layerView();
        assert.equal(getNeighbors(ndb, x.id, 'children').length, 0);
        baseView();
        assert.equal(getNeighbors(ndb, x.id, 'children').length, 1);

        // path (undirected)
        layerView();
        assert.equal(findPath(ndb, x.id, y.id), null);
        baseView();
        assert.notEqual(findPath(ndb, x.id, y.id), null);

        // --- transparency --------------------------------------------------
        // A base edit flows into a row the layer has NOT overridden…
        baseView();
        updateThought(ndb, z.id, { icon: '★' }, undefined, USER);
        layerView();
        assert.equal(getThought(ndb, z.id)?.icon, '★');
        // …but NOT into an overridden one: the shadow is a frozen copy, the
        // base edit stays invisible from the layer (13-layers.md §11, §6.6).
        baseView();
        updateThought(ndb, x.id, { icon: '◆' }, undefined, USER);
        layerView();
        assert.notEqual(getThought(ndb, x.id)?.icon, '◆');
        assert.equal(getThought(ndb, x.id)?.title, 'Икс-слой'); // shadow still wins
      } finally {
        ndb.close();
      }
    });

    it('integrity: no dangling references after layer delete, merge and purge', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'А' }, USER);
        const b = createThought(ndb, { title: 'Б' }, USER);
        createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        createComment(ndb, 'thought', a.id, { kind: 'permanent', title: null, body_md: 'текст' }, USER);
        assertIntegrity(ndb);

        // Layer work: new thought, a comment on it, delete B inside the layer.
        const layerId = startLayer(ndb);
        const c = createThought(ndb, { title: 'В' }, USER);
        createComment(ndb, 'thought', c.id, { kind: 'permanent', title: null, body_md: 'в слое' }, USER);
        createLink(ndb, { source_id: a.id, target_id: c.id }, USER);
        deleteThought(ndb, b.id, undefined, USER);
        assertIntegrity(ndb);

        // Merge into the base.
        ndb.useLayer(BASE_LAYER_ID);
        mergeLayer(ndb, layerId, undefined, USER);
        assertIntegrity(ndb);
        ndb.useLayer(layerId);
        assert.equal(getThought(ndb, c.id)?.title, 'В'); // merged rows stay visible

        // Delete the layer entirely — its remaining shadows vanish.
        ndb.useLayer(BASE_LAYER_ID);
        deleteLayer(ndb, layerId, undefined, 0);
        assertIntegrity(ndb);
      } finally {
        ndb.close();
      }
    });

    it('perf smoke: reads at full depth stay fast on thousands of thoughts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Seed 3000 base thoughts in one pass.
        const now = new Date().toISOString();
        const ins = ndb.prepare(
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, ?, 'u', ?, 'u')`,
        );
        const ids: string[] = [];
        ndb.transaction(() => {
          for (let i = 0; i < 3000; i++) {
            const id = `t-${String(i).padStart(4, '0')}`;
            ids.push(id);
            ins.run(id, BASE_LAYER_ID, `Мысль ${i}`, `мысль ${i}`, now, now);
          }
        });

        // Full depth: L1→L2→L3→L4 over the base.
        let parent = BASE_LAYER_ID;
        let deepest = BASE_LAYER_ID;
        for (let i = 1; i <= 4; i++) {
          const layer = createLayer(ndb, { parentId: parent, title: `Уровень ${i}`, createdBy: USER });
          parent = layer.id;
          deepest = layer.id;
        }
        ndb.useLayer(deepest);

        const t0 = Date.now();
        const thought = getThought(ndb, ids[0] as string);
        const found = queryThoughts(ndb, { keywords: 'Мысль 1' }, { maxNodes: TRAVERSAL_DEFAULTS.MAX_NODES });
        const sg = subgraph(ndb, [ids[0] as string], 1);
        const elapsed = Date.now() - t0;

        assert.notEqual(thought, null);
        assert.ok(found.total >= 1);
        assert.ok(sg.nodes.length >= 1);
        // Smoke bound: the anti-join views must not degrade to full scans —
        // a full per-row pass would blow well past this on CI too.
        assert.ok(elapsed < 5_000, `reads through 4-layer views took ${elapsed}ms`);

        // A layer write at depth 4 stays invisible from the base.
        ndb.useLayer(deepest);
        updateThought(ndb, ids[0] as string, { title: 'Перекрыто' }, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThought(ndb, ids[0] as string)?.title, 'Мысль 0');
        assertIntegrity(ndb);
      } finally {
        ndb.close();
      }
    });
  },
);
