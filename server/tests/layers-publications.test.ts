/**
 * Ветвимость подсистемы «Публикации» (0.11.1, задача 8178e007; требование
 * e7487d77): чтения через `*_v`, правка в слое невидима в основе до слияния,
 * слияние переносит публикации и их детали, а пачка перестановок порядка
 * сворачивается в одну позицию отчёта (`publication_reorder_collapsed`).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { mergeLayer } from '../src/domain/merge-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createPublication,
  getPublication,
  listPublicationOrder,
  setPublicationOrder,
  updatePublication,
} from '../src/domain/publication-service.js';
import {
  acceptPublicationCandidate,
  listPublicationCandidates,
} from '../src/domain/publication-assembly-service.js';

/** Seed a typed thought directly and return its id. */
function seedThought(ndb: NetworkDb, title: string, typeId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now);
  return id;
}

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

/** Insert a working layer as a child of the base and return its id. */
function seedLayer(ndb: NetworkDb): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой', 0, 1, 'u', ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, now, now);
  return id;
}

const ORDER_A_B: Array<{ node_key: string; position: number }> = [
  { node_key: 'a', position: 1 },
  { node_key: 'b', position: 2 },
];

describe(
  'публикации: ветвимость чтений и записи',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('правка публикации в слое невидима в основе; созданная в слое — только там', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'Основа' }, 'u');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        updatePublication(ndb, p.id, { title: 'Слой' }, 'u');
        const layerOnly = createPublication(ndb, { title: 'Только слой' }, 'u');

        assert.equal(getPublication(ndb, p.id)?.title, 'Слой');
        assert.equal(getPublication(ndb, layerOnly.id)?.title, 'Только слой');

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getPublication(ndb, p.id)?.title, 'Основа');
        assert.equal(getPublication(ndb, layerOnly.id), null);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'публикации: слияние слоя',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('слияние переносит публикацию, созданную в слое, вместе с её порядком', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const p = createPublication(ndb, { title: 'Слой' }, 'u');
        setPublicationOrder(ndb, p.id, ORDER_A_B, 'u');

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getPublication(ndb, p.id), null);

        const report = mergeLayer(ndb, layerId, undefined, 'u');
        assert.equal(report.applied.publications, 1);
        assert.equal(report.applied.publication_order, 2);
        assert.equal(getPublication(ndb, p.id)?.title, 'Слой');
        assert.deepEqual(
          listPublicationOrder(ndb, p.id).map((i) => i.node_key),
          ['a', 'b'],
        );
      } finally {
        ndb.close();
      }
    });

    it('пачка перестановок порядка сворачивается в одну позицию отчёта', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'Основа' }, 'u');
        setPublicationOrder(ndb, p.id, ORDER_A_B, 'u');
        const layerId = seedLayer(ndb);

        // В слое меняются ТОЛЬКО позиции тех же узлов — update-путь слияния.
        ndb.useLayer(layerId);
        setPublicationOrder(
          ndb,
          p.id,
          [
            { node_key: 'a', position: 2 },
            { node_key: 'b', position: 1 },
          ],
          'u',
        );

        ndb.useLayer(BASE_LAYER_ID);
        const report = mergeLayer(ndb, layerId, undefined, 'u');
        assert.equal(report.applied.publication_order, 2);
        assert.deepEqual(report.publication_reorder_collapsed, [
          { publication_id: p.id, count: 2 },
        ]);
        assert.deepEqual(
          listPublicationOrder(ndb, p.id).map((i) => i.node_key),
          ['b', 'a'],
        );
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'публикации: кандидаты и принятый срез живут в контексте слоя',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('новая мысль слоя — кандидат только в слое; «расставить» не трогает основу', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Doc' }, 'u');
        const recipe = { type_ids: [type.id], sort: 'alpha' as const, order: 'asc' as const };
        seedThought(ndb, 'A', type.id);
        const p = createPublication(ndb, { title: 'Док', title_recipe: recipe }, 'u');
        // В основе всё отобранное принято — кандидатов нет.
        assert.equal(listPublicationCandidates(ndb, p.id, 'u').total, 0);

        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        // Мысль, созданная в слое, видна только в слое и попадает в отбор.
        const b = seedThought(ndb, 'B', type.id);
        assert.deepEqual(
          listPublicationCandidates(ndb, p.id, 'u').items.map((c) => c.thought_id),
          [b],
        );

        acceptPublicationCandidate(ndb, p.id, b, 'u');
        assert.equal(listPublicationCandidates(ndb, p.id, 'u').total, 0);

        // Основа среза не видит ни мысли b, ни её принятия.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(listPublicationCandidates(ndb, p.id, 'u').total, 0);
        assert.deepEqual(listPublicationOrder(ndb, p.id), []);
      } finally {
        ndb.close();
      }
    });
  },
);
