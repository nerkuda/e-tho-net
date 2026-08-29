/**
 * Tests for layer-aware reading (task S3, docs/13-layers.md §4):
 *
 * - the resolution rule on a three-level hierarchy (base → layer A → layer B):
 *   the nearest ancestor's row wins, a tombstone hides the entity even though
 *   an ancestor still has a live row, and a base-only row is visible from the
 *   deepest layer;
 * - reads through the domain services (they must go via the `*_v` views and
 *   so pick up the connection's layer context, incl. FTS search);
 * - the (network, layer) connection pool: same pair reuses the connection,
 *   different layers get different contexts on the same `data.db`;
 * - the lint rule: domain code must not read the physical branchable tables
 *   (an unmarked `FROM`/`JOIN` is a layer leak and fails the suite).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import {
  closeAll,
  closeNetworkDb,
  createInMemoryNetworkDb,
  getOpenNetworkDb,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import { BRANCHABLE_TABLES } from '../src/db/layer-chain.js';
import { getComment } from '../src/domain/comment-service.js';
import { getLink } from '../src/domain/link-service.js';
import { search } from '../src/domain/search-service.js';
import { createThought, getThought } from '../src/domain/thought-service.js';

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

/** The layer ids of the three-level hierarchy used by the resolution tests. */
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';

/** Seed `layers` with A (child of base) and B (child of A). */
function insertHierarchyLayers(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const ins = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
  );
  ins.run(LAYER_A, BASE_LAYER_ID, 'Слой A', 1, now, now);
  ins.run(LAYER_B, LAYER_A, 'Слой B', 2, now, now);
}

/** Insert a shadow row of a thought into `layerId`, optionally a tombstone. */
function insertThoughtShadow(
  ndb: NetworkDb,
  id: string,
  layerId: string,
  title: string,
  tombstone: boolean,
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, active, deleted, version,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, 2, ?, 'u', ?, 'u')`,
    )
    .run(id, layerId, title, title.toLowerCase(), tombstone ? 1 : 0, now, now);
}

describe(
  'layers S3 — row resolution on a three-level hierarchy',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('nearest ancestor wins, tombstones hide, base-only rows are visible from depth', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);

        // Base rows via the service (S4: writes go to the connection's layer,
        // so the service calls run in the base context; the resolution checks
        // below then switch to B).
        const tBase = createThought(ndb, { title: 'Только основа' }, USER);
        const tA = createThought(ndb, { title: 'A-основа' }, USER);
        const tB = createThought(ndb, { title: 'B-основа' }, USER);
        const tAB = createThought(ndb, { title: 'AB-основа' }, USER);
        const tTombA = createThought(ndb, { title: 'Надгробие в A' }, USER);
        const tTombB = createThought(ndb, { title: 'Надгробие в B' }, USER);

        // The connection's layer context (the resolution views follow it).
        ndb.useLayer(LAYER_B);

        // Shadow rows (raw SQL — materialisation itself is S4+).
        insertThoughtShadow(ndb, tA.id, LAYER_A, 'A-слой', false);
        insertThoughtShadow(ndb, tB.id, LAYER_B, 'B-слой', false);
        insertThoughtShadow(ndb, tAB.id, LAYER_A, 'AB-слой', false);
        insertThoughtShadow(ndb, tAB.id, LAYER_B, 'AB-ближайший', false);
        insertThoughtShadow(ndb, tTombA.id, LAYER_A, 'скрыто', true);
        insertThoughtShadow(ndb, tTombB.id, LAYER_A, 'живая строка в A', false);
        insertThoughtShadow(ndb, tTombB.id, LAYER_B, 'скрыто', true);

        // Context B (the pool opened the connection with LAYER_B).
        const title = (id: string): string | null =>
          (ndb.prepare('SELECT title FROM thoughts_v WHERE id = ?').get(id) as
            | { title: string }
            | undefined)?.title ?? null;

        // A base-only row is visible from the deepest layer.
        assert.equal(title(tBase.id), 'Только основа');
        // Overridden by the nearest ancestor: A for tA, B itself for tB.
        assert.equal(title(tA.id), 'A-слой');
        assert.equal(title(tB.id), 'B-слой');
        // Both A and B shadow tAB — the *nearest* (B) must win.
        assert.equal(title(tAB.id), 'AB-ближайший');
        // A tombstone in the chain hides the entity even though the base row
        // is alive; for tTombB the tombstone sits in B over a live A row.
        assert.equal(title(tTombA.id), null);
        assert.equal(title(tTombB.id), null);

        // The domain service reads through the same views.
        assert.equal(getThought(ndb, tAB.id)?.title, 'AB-ближайший');
        assert.equal(getThought(ndb, tTombA.id), null);

        // Context A: tAB resolves to A's row; tTombB is alive again (its
        // tombstone is in B, outside A's chain); tTombA stays hidden.
        ndb.useLayer(LAYER_A);
        assert.equal(title(tAB.id), 'AB-слой');
        assert.equal(title(tTombB.id), 'живая строка в A');
        assert.equal(title(tTombA.id), null);

        // Context base: every shadow is outside the chain, base rows win and
        // both tombstoned thoughts are back.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(title(tA.id), tA.title);
        assert.equal(title(tB.id), tB.title);
        assert.equal(title(tAB.id), tAB.title);
        assert.equal(title(tTombA.id), tTombA.title);
        assert.equal(title(tTombB.id), tTombB.title);
      } finally {
        ndb.close();
      }
    });

    it('links and comments resolve through the views: shadow overrides, tombstones hide', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const now = new Date().toISOString();
        ndb.useLayer(LAYER_B);

        // l1: active in base, deactivated in B — the edge exists in both
        // contexts but resolves to different rows.
        // l2: exists in base only, tombstoned in B — invisible in B.
        const insLink = ndb.prepare(
          `INSERT INTO links (id, layer_id, source_id, target_id, active, deleted, version,
             created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'u', 'u')`,
        );
        insLink.run('l1', BASE_LAYER_ID, a.id, b.id, 1, 0, now, now);
        insLink.run('l1', LAYER_B, a.id, b.id, 0, 0, now, now);
        insLink.run('l2', BASE_LAYER_ID, a.id, c.id, 1, 0, now, now);
        insLink.run('l2', LAYER_B, a.id, c.id, 1, 1, now, now);

        // Context B: l1 resolves to the shadow (inactive), l2 is hidden.
        assert.equal(getLink(ndb, 'l1')?.active, false);
        assert.equal(getLink(ndb, 'l2'), null);
        assert.deepEqual(ndb.prepare('SELECT id FROM links_v WHERE source_id = ?').all(a.id), [
          { id: 'l1' },
        ]);

        // Context base: both links are live and active.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getLink(ndb, 'l1')?.active, true);
        assert.equal(getLink(ndb, 'l2')?.active, true);

        // A comment shadowed in B: B sees the layer's body, base sees its own.
        ndb.useLayer(LAYER_B);
        const insComment = ndb.prepare(
          `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, body_md, body_html,
             valid_from, version, created_at, updated_at, created_by, updated_by)
           VALUES ('cm1', ?, 'thought', ?, 'permanent', ?, ?, ?, 1, ?, ?, 'u', 'u')`,
        );
        insComment.run(BASE_LAYER_ID, a.id, 'телоосновы', 'телоосновы', now, now, now);
        insComment.run(LAYER_B, a.id, 'телослоя', 'телослоя', now, now, now);
        assert.equal(getComment(ndb, 'cm1')?.body_md, 'телослоя');
        // FTS (§4.3): the index carries both rows, the rowid join with
        // comments_v keeps only the winner — B finds its text, not the base's.
        assert.equal(search(ndb, { q: 'телослоя', scope: 'texts' }).by_texts.length, 1);
        assert.equal(search(ndb, { q: 'телоосновы', scope: 'texts' }).by_texts.length, 0);

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getComment(ndb, 'cm1')?.body_md, 'телоосновы');
        assert.equal(search(ndb, { q: 'телоосновы', scope: 'texts' }).by_texts.length, 1);
        assert.equal(search(ndb, { q: 'телослоя', scope: 'texts' }).by_texts.length, 0);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'layers S3 — (network, layer) connection pool',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;

    before(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-layers3-'));
    });

    after(() => {
      closeAll();
      if (tmpDataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    });

    it('keys connections by (network, layer): reuse per pair, distinct contexts per layer', () => {
      const networkId = randomUUID();
      const ndbBase = openNetworkDb(tmpDataDir, networkId);
      try {
        const now = new Date().toISOString();
        // A thought in the base + layer A over it, straight SQL.
        ndbBase.exec(
          `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
           VALUES ('${LAYER_A}', '${BASE_LAYER_ID}', 'Слой A', 0, 1, 'u', '${now}', '${now}')`,
        );
        const ins = ndbBase.prepare(
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, version,
             created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, ?, 'u', ?, 'u')`,
        );
        ins.run('pool-t', BASE_LAYER_ID, 'основа', 'основа', now, now);
        ins.run('pool-t', LAYER_A, 'слой', 'слой', now, now);

        // Same (network, layer) pair — same connection; base is the default.
        assert.equal(openNetworkDb(tmpDataDir, networkId), ndbBase);
        assert.equal(getOpenNetworkDb(networkId), ndbBase);
        assert.equal(getOpenNetworkDb(networkId, BASE_LAYER_ID), ndbBase);

        // A different layer — a second connection over the same data.db with
        // its own layer_chain: reads resolve to the layer's rows.
        const ndbA = openNetworkDb(tmpDataDir, networkId, undefined, LAYER_A);
        assert.notEqual(ndbA, ndbBase);
        assert.equal(openNetworkDb(tmpDataDir, networkId, undefined, LAYER_A), ndbA);
        assert.equal(getOpenNetworkDb(networkId, LAYER_A), ndbA);
        const titleIn = (ndb: NetworkDb): string | null =>
          (ndb.prepare('SELECT title FROM thoughts_v WHERE id = ?').get('pool-t') as
            | { title: string }
            | undefined)?.title ?? null;
        assert.equal(titleIn(ndbA), 'слой');
        assert.equal(titleIn(ndbBase), 'основа');

        // Closing the network closes every layer connection of it.
        assert.equal(closeNetworkDb(networkId), true);
        assert.ok(ndbBase.isClosed && ndbA.isClosed);
        assert.equal(getOpenNetworkDb(networkId), undefined);
        assert.equal(getOpenNetworkDb(networkId, LAYER_A), undefined);
      } finally {
        closeNetworkDb(networkId);
      }
    });

    it('closeNetworkDb(networkId, layerId) closes exactly that layer connection', () => {
      const networkId = randomUUID();
      const ndbBase = openNetworkDb(tmpDataDir, networkId);
      // Layer A must exist before a connection can be bound to it.
      const now = new Date().toISOString();
      ndbBase.exec(
        `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
         VALUES ('${LAYER_A}', '${BASE_LAYER_ID}', 'Слой A', 0, 1, 'u', '${now}', '${now}')`,
      );
      const ndbA = openNetworkDb(tmpDataDir, networkId, undefined, LAYER_A);
      try {
        assert.equal(closeNetworkDb(networkId, LAYER_A), true);
        assert.ok(ndbA.isClosed);
        assert.ok(!ndbBase.isClosed);
        assert.equal(getOpenNetworkDb(networkId, LAYER_A), undefined);
        assert.equal(getOpenNetworkDb(networkId), ndbBase);
      } finally {
        closeNetworkDb(networkId);
      }
    });
  },
);

describe('layers S3 — lint: domain code reads branchable tables only via the `*_v` views', () => {
  /**
   * The rule (13-layers.md §4.2): a `FROM`/`JOIN` of a physical branchable
   * table in the domain layer is a layer-context leak — the query bypasses
   * the resolution views and can serve another layer's rows. Legitimate
   * physical reads (holding-layer audit, file reference counting, purge
   * cascades — cases that must see every layer's rows) are allowed with an
   * explicit `layers:physical-read` marker on the same line. `DELETE FROM
   * <table>` is a write and always targets the physical table.
   */
  const MARKER = 'layers:physical-read';
  const DIRECT_READ =
    /\b(FROM|JOIN)\s+(thoughts|links|comments|attachments|thought_synonyms|thought_types|link_types|type_properties|type_property_overrides|property_values|comment_targets)(?!_v)\b/g;
  const SCANNED_DIRS = ['domain', 'routes', 'mcp'];

  it('every direct FROM/JOIN of a branchable table is marked layers:physical-read', () => {
    const srcRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '../src',
    );
    const violations: string[] = [];

    /** True when the `FROM` at `at` is the tail of a `DELETE FROM` write. */
    const isDeleteFrom = (line: string, at: number): boolean =>
      /\bDELETE\s+$/.test(line.slice(Math.max(0, at - 12), at));

    const scan = (dir: string): void => {
      for (const entry of readdirSync(path.join(srcRoot, dir), { withFileTypes: true })) {
        const full = path.join(srcRoot, dir, entry.name);
        if (entry.isDirectory()) {
          scan(path.join(dir, entry.name));
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          const reads = [...line.matchAll(DIRECT_READ)].filter(
            (m) => !isDeleteFrom(line, m.index ?? 0),
          );
          if (reads.length > 0 && !line.includes(MARKER)) {
            violations.push(`${path.relative(srcRoot, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };

    for (const dir of SCANNED_DIRS) scan(dir);

    assert.deepEqual(
      violations,
      [],
      `Прямые чтения физических ветвимых таблиц (${BRANCHABLE_TABLES.length} таблиц, ` +
        'docs/13-layers.md §4.2) — утечка контекста слоя. Переведи запрос на `*_v` или пометь ' +
        'строку `layers:physical-read`, если чтение обязано видеть все слои (аудит удержаний, ' +
        'счётчик файла вложения).\n' +
        violations.join('\n'),
    );
  });
});
