/**
 * Tests for the bundled per-network `data.db` migrations (task C2).
 *
 * The first group is a filesystem-only inventory check (no native binding
 * required) and always runs. The second group applies the migrations to an
 * in-memory database, asserts the full schema, and exercises the FTS5
 * synchronisation triggers (docs/02-data-model.md §3.11). It is skipped when
 * `better-sqlite3` is unavailable.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';
import { registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';

const EXPECTED_FILES = [
  '001_thoughts.sql',
  '002_thought_synonyms.sql',
  '003_thought_types.sql',
  '004_link_types.sql',
  '005_type_properties.sql',
  '006_property_values.sql',
  '007_links.sql',
  '008_comments.sql',
  '009_attachments.sql',
  '010_user_state.sql',
  '011_fts.sql',
  '012_embeddings.sql',
  '013_thought_style_inheritance.sql',
  '014_link_style_override.sql',
  '015_attachments_icon.sql',
  '016_saved_filters.sql',
  '016_thought_icon_attachment.sql',
  '017_type_name_keys.sql',
  '018_pinned_thoughts.sql',
  '019_comment_targets.sql',
  '020_saved_filters_view.sql',
  '021_type_hierarchy.sql',
  '022_thought_types_comment_template.sql',
  '023_thought_read_metrics.sql',
  '024_marked_for_deletion.sql',
  '025_layers.sql',
  '026_fts_layer_tombstones.sql',
  '027_session_layers.sql',
  '028_session_layers_switch_seq.sql',
];

/** All `data.db` tables that must exist after migration (FTS5 shadow tables excluded). */
const EXPECTED_TABLES = [
  '_migrations',
  'layers',
  'thoughts',
  'thought_synonyms',
  'thought_types',
  'link_types',
  'type_properties',
  'type_property_overrides',
  'property_values',
  'links',
  'comments',
  'comment_targets',
  'attachments',
  'user_preferences',
  'thought_views',
  'user_focus_preferences',
  'user_focus_order',
  'saved_filters',
  'user_pinned_thoughts',
  'embeddings',
  'thought_read_metrics',
];

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe('network migrations (filesystem)', () => {
  it('ships all expected migration files in sorted order', () => {
    const files = readdirSync(networkMigrationsDir())
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.deepEqual(files, EXPECTED_FILES);
  });
});

describe(
  'network migrations (apply)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('creates every data.db table and is idempotent', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      try {
        const res = runMigrations(db, networkMigrationsDir());
        assert.equal(res.skipped.length, 0);
        assert.equal(res.applied.length, EXPECTED_FILES.length);

        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        for (const t of EXPECTED_TABLES) {
          assert.ok(tables.includes(t), `missing table: ${t}`);
        }
        // FTS5 virtual tables present.
        assert.ok(tables.includes('fts_thought_names'), 'missing fts_thought_names');
        assert.ok(tables.includes('fts_thought_texts'), 'missing fts_thought_texts');
        assert.ok(tables.includes('fts_link_texts'), 'missing fts_link_texts');

        // The three synchronisation trigger groups exist.
        const triggers = (
          db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        for (const name of [
          'trg_thoughts_ai_names',
          'trg_synonyms_ai_names',
          'trg_comments_ai_fts',
        ]) {
          assert.ok(triggers.includes(name), `missing trigger: ${name}`);
        }

        // Re-running is idempotent.
        const res2 = runMigrations(db, networkMigrationsDir());
        assert.equal(res2.applied.length, 0);
        assert.equal(res2.skipped.length, EXPECTED_FILES.length);

        // 013 style-inheritance columns: thoughts.font_manual bitmap and
        // thought_types.icon_kind (02-data-model.md §3.1.1, §3.3).
        const thoughtCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('thoughts') as { name: string }[]
        ).map((r) => r.name);
        assert.ok(thoughtCols.includes('font_manual'), 'missing thoughts.font_manual');
        const typeCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('thought_types') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(typeCols.includes('icon_kind'), 'missing thought_types.icon_kind');

        // 014 link line-style override columns (02-data-model.md §3.6).
        const linkCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('links') as { name: string }[]
        ).map((r) => r.name);
        assert.ok(linkCols.includes('color'), 'missing links.color');
        assert.ok(linkCols.includes('style'), 'missing links.style');
        assert.ok(linkCols.includes('width'), 'missing links.width');

        // 015 attachment preview icon (02-data-model.md §3.9, workplan L1).
        const attCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('attachments') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(attCols.includes('icon'), 'missing attachments.icon');

        // 016b icon ← attachment link (02-data-model.md §3.1, workplan L16).
        assert.ok(
          thoughtCols.includes('icon_attachment_id'),
          'missing thoughts.icon_attachment_id',
        );

        // 024 mark-for-deletion columns (02-data-model.md §3.1.2, task S13).
        assert.ok(thoughtCols.includes('marked_for_deletion'), 'missing thoughts.marked_for_deletion');
        assert.ok(linkCols.includes('marked_for_deletion'), 'missing links.marked_for_deletion');

        // 019 comment_targets: m2m attachments with the primary owner as index.
        const targetCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('comment_targets') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(targetCols.includes('comment_id'), 'missing comment_targets.comment_id');
        assert.ok(targetCols.includes('owner_type'), 'missing comment_targets.owner_type');
        assert.ok(targetCols.includes('owner_id'), 'missing comment_targets.owner_id');

        // 020 saved_filters: the per-view column exists.
        const filterCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('saved_filters') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(filterCols.includes('view'), 'missing saved_filters.view');

        // 025 change layers (S2, 13-layers.md §3): the layers table exists with
        // exactly one base row, and every branchable table carries the layer
        // columns (layer_id / deleted / base_version) plus a surrogate pk.
        const base = db
          .prepare('SELECT id, is_base, depth, title FROM layers WHERE is_base = 1')
          .get() as { id: string; is_base: number; depth: number; title: string };
        assert.equal(base.is_base, 1);
        assert.equal(base.depth, 0);
        assert.equal(base.title, 'Основа');
        for (const table of [
          'thoughts',
          'thought_synonyms',
          'thought_types',
          'link_types',
          'type_properties',
          'type_property_overrides',
          'property_values',
          'links',
          'comments',
          'comment_targets',
          'attachments',
        ]) {
          const cols = (
            db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]
          ).map((r) => r.name);
          assert.ok(cols.includes('layer_id'), `missing ${table}.layer_id`);
          assert.ok(cols.includes('deleted'), `missing ${table}.deleted`);
          assert.ok(cols.includes('base_version'), `missing ${table}.base_version`);
          assert.ok(cols.includes('pk'), `missing ${table}.pk (surrogate)`);
        }
        // thought_synonyms/comment_targets gained a row id; links gained the
        // T1 order field.
        const synCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('thought_synonyms') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(synCols.includes('id'), 'missing thought_synonyms.id');
        assert.ok(linkCols.includes('position'), 'missing links.position');
        // FTS carries layer_id (S6 preparation).
        for (const fts of ['fts_thought_names', 'fts_thought_texts', 'fts_link_texts']) {
          const ftsCols = db.prepare(`PRAGMA table_info(${fts})`).all() as { name: string }[];
          assert.ok(
            ftsCols.some((c) => c.name === 'layer_id'),
            `missing ${fts}.layer_id`,
          );
        }
      } finally {
        db.close();
      }
    });

    it('019 backfills comment_targets for pre-existing comments', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      try {
        const now = '2024-01-01T00:00:00Z';
        db.prepare(
          'INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run('t1', 'A', 'a', 1, 1, now, 'u', now, 'u');
        // Simulate a comment created by the pre-019 code path (no m2m row).
        db.prepare(
          'INSERT INTO comments (id,owner_type,owner_id,kind,title,body_md,body_html,valid_from,version,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run('c1', 'thought', 't1', 'chronological', 'T', 'x', '<p>x</p>', now, 1, now, now, 'u', 'u');
        // Re-running the 019 backfill INSERT OR IGNORE must add the target.
        db.exec(
          'INSERT OR IGNORE INTO comment_targets (comment_id, owner_type, owner_id) ' +
            'SELECT id, owner_type, owner_id FROM comments;',
        );
        const targets = db
          .prepare('SELECT comment_id, owner_type, owner_id FROM comment_targets')
          .all() as Array<{ comment_id: string; owner_type: string; owner_id: string }>;
        assert.deepEqual(targets, [{ comment_id: 'c1', owner_type: 'thought', owner_id: 't1' }]);
      } finally {
        db.close();
      }
    });

    it('020 keeps saved-filters names unique per (user, view)', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      try {
        const ins =
          'INSERT INTO saved_filters (id,user_id,view,name,definition,created_at,updated_at) VALUES (?,?,?,?,?,?,?)';
        db.prepare(ins).run('f1', 'u1', 'structures', 'Отбор', '{}', '2024', '2024');
        db.prepare(ins).run('f2', 'u1', 'chronicle', 'Отбор', '{}', '2024', '2024');
        assert.throws(
          () => db.prepare(ins).run('f3', 'u1', 'structures', 'Отбор', '{}', '2024', '2024'),
          /UNIQUE/,
          'same name within one view must collide',
        );
      } finally {
        db.close();
      }
    });

    it('FTS5 fts_thought_names stays in sync with thoughts and synonyms', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      try {
        const now = '2024-01-01T00:00:00Z';
        const user = 'user-1';
        const insThought =
          'INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)';
        db.prepare(insThought).run('t1', 'Hello World', 'hello world', 1, 1, now, user, now, user);

        // Insert populates the FTS row with the title only.
        let rows = db.prepare('SELECT thought_id, text FROM fts_thought_names').all() as {
          thought_id: string;
          text: string;
        }[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.text, 'Hello World');

        // Adding a synonym rebuilds the row to include it.
        db.prepare(
          'INSERT INTO thought_synonyms (thought_id,synonym,synonym_norm) VALUES (?,?,?)',
        ).run('t1', 'Hi', 'hi');
        rows = db.prepare('SELECT text FROM fts_thought_names WHERE thought_id = ?').all('t1') as {
          text: string;
        }[];
        assert.equal(rows[0]!.text, 'Hello World Hi');

        // Search matches both the title and the synonym.
        const hitHi = db
          .prepare("SELECT thought_id FROM fts_thought_names WHERE fts_thought_names MATCH 'hi'")
          .all() as { thought_id: string }[];
        assert.deepEqual(
          hitHi.map((r) => r.thought_id),
          ['t1'],
        );

        // Deleting the thought removes its FTS row.
        db.prepare('DELETE FROM thoughts WHERE id = ?').run('t1');
        const n = (db.prepare('SELECT COUNT(*) AS c FROM fts_thought_names').get() as { c: number })
          .c;
        assert.equal(n, 0);
      } finally {
        db.close();
      }
    });

    it('FTS5 comment tables split by owner_type and update on change', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      try {
        const now = '2024-01-01T00:00:00Z';
        const user = 'user-1';
        db.prepare(
          'INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run('t1', 'A', 'a', 1, 1, now, user, now, user);
        db.prepare(
          'INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run('t2', 'B', 'b', 1, 1, now, user, now, user);
        db.prepare(
          'INSERT INTO links (id,source_id,target_id,type_id,active,version,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run('l1', 't1', 't2', null, 1, 1, now, now, user, user);

        const insComment =
          'INSERT INTO comments (id,owner_type,owner_id,kind,title,body_md,body_html,valid_from,version,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
        db.prepare(insComment).run(
          'c1',
          'thought',
          't1',
          'chronological',
          'T',
          'alpha note',
          '<p>x</p>',
          now,
          1,
          now,
          now,
          user,
          user,
        );
        db.prepare(insComment).run(
          'c2',
          'link',
          'l1',
          'chronological',
          'T',
          'gamma remark',
          '<p>x</p>',
          now,
          1,
          now,
          now,
          user,
          user,
        );

        // Thought comment landed in fts_thought_texts, link comment in fts_link_texts.
        assert.equal(
          (db.prepare('SELECT COUNT(*) AS c FROM fts_thought_texts').get() as { c: number }).c,
          1,
        );
        assert.equal(
          (db.prepare('SELECT COUNT(*) AS c FROM fts_link_texts').get() as { c: number }).c,
          1,
        );

        // Editing a comment body updates the indexed text.
        db.prepare(
          'UPDATE comments SET body_md = ?, body_html = ?, updated_at = ? WHERE id = ?',
        ).run('edited delta', '<p/>', now, 'c1');
        const row = db
          .prepare('SELECT text FROM fts_thought_texts WHERE thought_id = ?')
          .all('t1') as { text: string }[];
        assert.equal(row[0]!.text, 'edited delta');
      } finally {
        db.close();
      }
    });
  },
);
