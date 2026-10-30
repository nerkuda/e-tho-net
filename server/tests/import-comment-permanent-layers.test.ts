/**
 * Импорт `.etnx` перезаписывал постоянный комментарий ВСЕХ слоёв (ошибка
 * ab696fb1, версия 0.15.1).
 *
 * `insertComment` (ветка `kind === 'permanent'`) выбирал существующий
 * комментарий из `comments_v` — представления в контексте слоя соединения —
 * а затем выполнял `UPDATE comments … WHERE id = ?` без слоя/`pk`. Логический
 * `id` общий у одноимённых строк всех слоёв (тень копирует id предка, у
 * постоянного комментария он ещё и детерминирован от владельца — миграция
 * 048), поэтому импорт в контексте слоя подменял `body_md`/`body_html` не
 * только видимой строки слоя, но и основы, и соседних слоёв.
 *
 * Ожидание: UPDATE адресует ровно прочитанную физическую строку (`WHERE
 * pk = ?`) — меняется только строка, видимая в контексте импорта.
 *
 * Слой-осознанность импорта в целом (`INSERT` без `layer_id` в
 * `thoughts`/`comments`/`comment_targets`) — отдельный вопрос, здесь не
 * проверяется: тест фиксирует только изоляцию строк постоянного комментария.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, ETNX_VERSION, type EtnxManifest } from '@etn/shared';
import { renderMarkdown } from '@etn/markdown';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  createComment,
  getComment,
  updateComment,
} from '../src/domain/comment-service.js';
import { applyManifest } from '../src/domain/import-service.js';
import { createThought, getThought } from '../src/domain/thought-service.js';
import { createLogger } from '../src/logger.js';

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

const LAYER_A = '33333333-3333-4333-8333-333333333333';
const USER = 'user-import';
const log = createLogger('silent');

/** Seed the layer hierarchy (base → A) — same shape as layers-s4 tests. */
function insertLayerA(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой A', 0, 1, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, now, now);
}

/** Physical `comments` row of a layer (raw SQL — проверка изоляции строк). */
function physicalCommentRow(
  ndb: NetworkDb,
  id: string,
  layerId: string,
): { body_md: string; body_html: string; version: number } | undefined {
  return ndb
    .prepare('SELECT body_md, body_html, version FROM comments WHERE id = ? AND layer_id = ?')
    .get(id, layerId) as
    | { body_md: string; body_html: string; version: number }
    | undefined;
}

/**
 * Манифест `.etnx` с одной существующей мыслью и её постоянным комментарием:
 * ровно срез, который импорт обрабатывает веткой `permanent_comments_updated`.
 */
function manifestWithPermanentComment(
  ndb: NetworkDb,
  thoughtId: string,
  permanent: { id: string; body_md: string; body_html: string; version: number },
): EtnxManifest {
  const now = new Date().toISOString();
  const thought = getThought(ndb, thoughtId);
  assert.ok(thought !== null, 'мысль манифеста должна существовать');
  return {
    format: 'etnx',
    version: ETNX_VERSION,
    exported_at: now,
    source: { network_id: 'src', network_name: 'src', user_id: USER },
    thought_types: [],
    link_types: [],
    properties: [],
    type_properties: [],
    thoughts: [thought],
    thought_synonyms: [],
    links: [],
    comments: [
      {
        id: permanent.id,
        owner_type: 'thought',
        owner_id: thoughtId,
        targets: [{ owner_type: 'thought', owner_id: thoughtId }],
        kind: 'permanent',
        title: null,
        body_md: permanent.body_md,
        body_html: permanent.body_html,
        valid_from: thought.created_at,
        valid_to: null,
        use_time: false,
        version: permanent.version,
        created_at: thought.created_at,
        updated_at: now,
        created_by: USER,
        updated_by: USER,
      },
    ],
    comment_targets: [],
    property_values: [],
    attachments: [],
    publications: [],
    publication_order: [],
    publication_exclusions: [],
    shelves: [],
    shelf_items: [],
  };
}

describe(
  'import .etnx: постоянный комментарий адресуется по pk (ab696fb1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('импорт в слое меняет строку слоя, не трогая основу', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        // Основа: мысль и её постоянный комментарий.
        const thought = createThought(ndb, { title: 'Мысль импорта' }, USER);
        const permanent = createComment(
          ndb,
          'thought',
          thought.id,
          { kind: 'permanent', body_md: 'основа' },
          USER,
        );
        // Слой A: тень комментария с другим телом (правка в контексте слоя).
        ndb.useLayer(LAYER_A);
        updateComment(ndb, permanent.id, { body_md: 'слой' }, undefined, USER);
        assert.equal(getComment(ndb, permanent.id)?.body_md, 'слой', 'в слое видна его редакция');

        // Импорт `.etnx` в контексте слоя A: обновляет постоянный комментарий
        // той же мысли.
        const manifest = manifestWithPermanentComment(ndb, thought.id, {
          id: permanent.id,
          body_md: 'импорт',
          body_html: '<p>импорт</p>',
          version: 3,
        });
        const result = applyManifest(
          ndb,
          manifest,
          new Map(),
          { actorUserId: USER, parentThoughtId: thought.id },
          log,
        );

        assert.equal(result.permanent_comments_updated, 1);
        assert.deepEqual(result.updatedCommentIds, [permanent.id]);

        // Строка слоя A — единственная, которую импорт имел право менять.
        const layerRow = physicalCommentRow(ndb, permanent.id, LAYER_A);
        assert.ok(layerRow !== undefined, 'у слоя должна остаться своя строка');
        assert.equal(layerRow.body_md, 'импорт');
        assert.equal(layerRow.body_html, '<p>импорт</p>');

        // Основа сохранила собственную редакцию и HTML (ошибка ab696fb1:
        // UPDATE по логическому id перезаписывал и её).
        const baseRow = physicalCommentRow(ndb, permanent.id, BASE_LAYER_ID);
        assert.ok(baseRow !== undefined);
        assert.equal(baseRow.body_md, 'основа', 'основа не должна получить тело импорта');
        assert.equal(baseRow.body_html, renderMarkdown('основа'));

        // В контексте основы виден именно её текст.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getComment(ndb, permanent.id)?.body_md, 'основа');
      } finally {
        ndb.close();
      }
    });

    it('импорт в основе по-прежнему обновляет строку основы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const thought = createThought(ndb, { title: 'Мысль основы' }, USER);
        const permanent = createComment(
          ndb,
          'thought',
          thought.id,
          { kind: 'permanent', body_md: 'базовый текст' },
          USER,
        );

        const manifest = manifestWithPermanentComment(ndb, thought.id, {
          id: permanent.id,
          body_md: 'импорт в основу',
          body_html: '<p>импорт в основу</p>',
          version: 2,
        });
        const result = applyManifest(
          ndb,
          manifest,
          new Map(),
          { actorUserId: USER, parentThoughtId: thought.id },
          log,
        );

        assert.equal(result.permanent_comments_updated, 1);
        assert.equal(getComment(ndb, permanent.id)?.body_md, 'импорт в основу');
      } finally {
        ndb.close();
      }
    });
  },
);
