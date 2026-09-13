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
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';
import { registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { propertyValueId } from '../src/db/property-value-id.js';
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
  '029_links_triple_live.sql',
  '030_type_property_description.sql',
  '031_layer_colors.sql',
  '032_properties_registry.sql',
  '033_authorship_columns.sql',
  '034_object_locks.sql',
  '035_activity_log.sql',
  '036_property_values_deterministic_id.sql',
  '037_thought_type_views.sql',
  '038_search_trigram.sql',
  '039_structural_link_properties.sql',
  '040_thought_ref_to_link_properties.sql',
];

/** All `data.db` tables that must exist after migration (FTS5 shadow tables excluded). */
const EXPECTED_TABLES = [
  '_migrations',
  'layers',
  'thoughts',
  'thought_synonyms',
  'thought_types',
  'thought_type_views',
  'link_types',
  'properties',
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
  'object_locks',
  'activity_log',
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

        // 030 + 032 property descriptions & registry (02-data-model.md
        // §3.4/§3.4a/§3.7.1): the description-override column on
        // type_property_overrides, the `properties` registry (name/name_key/
        // value_type/config/description) and the rebuilt binding shape of
        // type_properties (property_id + role columns, nature columns gone).
        const propDefCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('type_properties') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(propDefCols.includes('property_id'), 'missing type_properties.property_id');
        assert.ok(propDefCols.includes('required'), 'missing type_properties.required');
        assert.ok(propDefCols.includes('position'), 'missing type_properties.position');
        assert.ok(!propDefCols.includes('key'), 'type_properties.key must be gone (0.6.5)');
        assert.ok(
          !propDefCols.includes('value_type'),
          'type_properties.value_type must be gone (0.6.5)',
        );
        const propOverrideCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('type_property_overrides') as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(
          propOverrideCols.includes('description'),
          'missing type_property_overrides.description',
        );
        const registryCols = (
          db.prepare('SELECT name FROM pragma_table_info(?)').all('properties') as {
            name: string;
          }[]
        ).map((r) => r.name);
        for (const col of [
          'name',
          'name_key',
          'value_type',
          'config',
          'description',
          'created_at',
          'updated_at',
        ]) {
          assert.ok(registryCols.includes(col), `missing properties.${col}`);
        }

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
          'thought_type_views',
          'link_types',
          'properties',
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
        ).run('t1', 'Hey', 'hey');
        rows = db
          .prepare('SELECT thought_id, text FROM fts_thought_names WHERE thought_id = ?')
          .all('t1') as {
          thought_id: string;
          text: string;
        }[];
        assert.equal(rows[0]!.text, 'Hello World Hey');

        // Search matches both the title and the synonym. `MATCH 'hey'`, not
        // `'hi'`: the `trigram` tokenizer (038_search_trigram.sql) needs ≥3
        // characters per term to produce any index entry.
        const hitHi = db
          .prepare("SELECT thought_id FROM fts_thought_names WHERE fts_thought_names MATCH 'hey'")
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

    // ------------------------------------------------------------------
    // 032: properties registry migration (0.6.5 — «Унификация работы со
    // свойствами»). Scenarios: a snapshot of the real ETN network, an
    // artificial rename set, and saved-filter redirection.
    // ------------------------------------------------------------------

    /** Apply migrations up to (excluding) 032 and return the prepared db. */
    function pre032Db(): Database.Database {
      const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig-'));
      for (const f of readdirSync(networkMigrationsDir()).filter(
        (f) => f.endsWith('.sql') && f < '032',
      )) {
        cpSync(path.join(networkMigrationsDir(), f), path.join(dir, f));
      }
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, dir);
      rmSync(dir, { recursive: true, force: true });
      return db;
    }

    const BASE = '00000000-0000-4000-8000-0000000000ba5e';

    /** Seed a pre-0.6.5 property definition (old type_properties shape). */
    function seedDef(
      db: Database.Database,
      id: string,
      ownerId: string,
      key: string,
      valueType: string,
      config: string | null,
      position = 0,
      ownerType: 'thought_type' | 'link_type' = 'thought_type',
      description: string | null = null,
    ): void {
      db
        .prepare(
          `INSERT INTO type_properties
             (id, layer_id, owner_type, owner_id, key, value_type, config, required, position, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, BASE, ownerType, ownerId, key, valueType, config, position, description);
    }

    it('032 migrates the ETN snapshot: 18 definitions → 15 properties, 3 merged groups, no renames', () => {
      const db = pre032Db();
      try {
        // Snapshot of the ETN thought network's own type_properties as of
        // 0.6.5 (ids shortened, natures exact).
        const espec = 'espec';
        const versiya = 'versiya';
        const rabota = 'rabota';
        const komponent = 'komponent';
        const resurs = 'resurs';
        const ukaz = 'ukaz';
        const ssylka = 'ssylka';
        const texproekt = 'texproekt';
        const defs: Array<[string, string, string, string, string | null]> = [
          ['d1', espec, 'для сервера', 'bool', null],
          ['d2', espec, 'для клиента', 'bool', null],
          ['d3', espec, 'подсистемы', 'thought_ref', '{"multiple":true,"allowed_type_ids":["podsys"]}'],
          ['d4', espec, 'источник', 'thought_ref', '{"multiple":true,"allowed_type_ids":["ukaz"]}'],
          ['d5', versiya, 'Плановый срок', 'date', null],
          ['d6', versiya, 'Опубликована', 'bool', null],
          ['d7', versiya, 'Дата публикации', 'date', null],
          ['d8', versiya, 'слой', 'text', null],
          ['d9', rabota, 'Плановый срок', 'date', null],
          [
            'd10',
            rabota,
            'Статус',
            'text',
            '{"options":["черновик","в реализации","реализовано"],"default_value":"черновик"}',
          ],
          ['d11', rabota, 'версия', 'thought_ref', '{"allowed_type_ids":["versiya"]}'],
          ['d12', komponent, 'путь', 'text', null],
          ['d13', resurs, 'URL', 'text', null],
          ['d14', resurs, 'Вид', 'text', null],
          ['d15', ukaz, 'Путь', 'text', null],
          ['d16', ukaz, 'Актуально на версию', 'text', null],
          ['d17', ssylka, 'перенесено', 'bool', null],
          ['d18', texproekt, 'слой', 'text', null],
        ];
        for (const [id, owner, key, vt, cfg] of defs) {
          seedDef(db, id, owner, key, vt, cfg, defs.findIndex((d) => d[0] === id));
        }

        // Values on definitions that will be merged away (d9 «Плановый срок»
        // of «работа», d15 «Путь» of «указатель на документ»).
        db.prepare(
          `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_date, updated_at)
           VALUES ('v1', ?, 'thought', 'th1', 'd9', '2026-10-01', '2026-01-01')`,
        ).run(BASE);
        db.prepare(
          `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_text, updated_at)
           VALUES ('v2', ?, 'thought', 'th2', 'd15', 'docs/x.md', '2026-01-01')`,
        ).run(BASE);
        // A saved filter referencing the merged-away d9.
        db.prepare(
          `INSERT INTO saved_filters (id, user_id, view, name, definition, created_at, updated_at)
           VALUES ('f1', 'u1', 'structures', 'Мой отбор',
                   '{"properties":[{"property_id":"d9","op":"eq","value":"2026-10-01"}]}', '2026-01-01', '2026-01-01')`,
        ).run();

        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, [
          '032_properties_registry.sql',
          '033_authorship_columns.sql',
          '034_object_locks.sql',
          '035_activity_log.sql',
          '036_property_values_deterministic_id.sql',
          '037_thought_type_views.sql',
          '038_search_trigram.sql',
          '039_structural_link_properties.sql',
          '040_thought_ref_to_link_properties.sql',
        ]);

        // 18 definitions became 15 properties: three groups merged
        // («Плановый срок» d5+d9, «слой» d8+d18, «путь»/«Путь» d12+d15),
        // zero renames. Плюс 2 структурных свойства-связи «Родители»/«Потомки»
        // от миграции 039.
        const props = db
          .prepare('SELECT id, name, name_key, value_type, config FROM properties ORDER BY name')
          .all() as Array<{
          id: string;
          name: string;
          name_key: string;
          value_type: string;
          config: string | null;
        }>;
        assert.equal(props.length, 17, '18 − 3 merged + 2 structural = 17');
        const names = props.map((p) => p.name);
        for (const expected of [
          'URL',
          'Актуально на версию',
          'Вид',
          'Дата публикации',
          'Опубликована',
          'Плановый срок',
          'Статус',
          'версия',
          'перенесено',
          'для клиента',
          'для сервера',
          'источник',
          'подсистемы',
          'путь',
          'слой',
        ]) {
          assert.ok(names.includes(expected), `missing property ${expected}`);
        }
        // No composite (renamed) names: none contains a dot.
        assert.ok(props.every((p) => !p.name.includes('.')), 'renames must not happen');
        // Registry ids are the survivors' old ids (earliest pk per group):
        // d5 (Плановый срок), d8 (слой), d12 (путь) — spelled by the winner.
        assert.equal(props.find((p) => p.name === 'Плановый срок')!.id, 'd5');
        assert.equal(props.find((p) => p.name === 'слой')!.id, 'd8');
        assert.equal(props.find((p) => p.name === 'путь')!.id, 'd12');

        // Every old definition became a binding; merged losers point at the
        // survivor property.
        const bindings = db
          .prepare('SELECT id, owner_id, property_id FROM type_properties ORDER BY id')
          .all() as Array<{ id: string; owner_id: string; property_id: string }>;
        // 18 старых определений → 18 привязок; + 2 структурных «Родители»/
        // «Потомки» на корневом типе от миграции 039.
        assert.equal(bindings.length, 20);
        const byId = new Map(bindings.map((b) => [b.id, b.property_id]));
        assert.equal(byId.get('d5'), 'd5');
        assert.equal(byId.get('d9'), 'd5');
        assert.equal(byId.get('d8'), 'd8');
        assert.equal(byId.get('d18'), 'd8');
        assert.equal(byId.get('d12'), 'd12');
        assert.equal(byId.get('d15'), 'd12');
        // Untouched definitions bind to themselves.
        for (const untouched of ['d1', 'd2', 'd3', 'd4', 'd6', 'd7', 'd10', 'd11', 'd13', 'd14', 'd16', 'd17']) {
          assert.equal(byId.get(untouched), untouched);
        }

        // Values stayed and were redirected to the survivors. (032 itself
        // preserves the seeded row ids, but the run continues into 036,
        // which rewrites the arbitrary legacy ids 'v1'/'v2' to the
        // deterministic UUIDv5 of each natural key.)
        const values = db
          .prepare('SELECT id, property_id, value_date, value_text FROM property_values ORDER BY id')
          .all() as Array<{ id: string; property_id: string; value_date: string | null; value_text: string | null }>;
        assert.deepEqual(
          values.map((v) => ({ id: v.id, property_id: v.property_id })),
          [
            { id: propertyValueId('thought', 'th1', 'd5'), property_id: 'd5' },
            { id: propertyValueId('thought', 'th2', 'd12'), property_id: 'd12' },
          ],
        );
        assert.equal(values[0]!.value_date, '2026-10-01');
        assert.equal(values[1]!.value_text, 'docs/x.md');

        // The saved filter now references the survivor id (see the separate
        // filter scenario below for the full assertion).
        const filter = db.prepare('SELECT definition FROM saved_filters').get() as {
          definition: string;
        };
        assert.ok(filter.definition.includes('"d5"'), 'filter must reference the survivor');
        assert.ok(!filter.definition.includes('"d9"'));
      } finally {
        db.close();
      }
    });

    it('032 renames same-named properties of different nature with composite names and never merges them', () => {
      const db = pre032Db();
      try {
        const now = '2026-01-01T00:00:00Z';
        const seedType = db.prepare(
          `INSERT INTO thought_types
             (id, layer_id, name, name_key, parent_id, is_root, icon_kind, version, created_at, updated_at, created_by)
           VALUES (?, ?, ?, type_name_key(?), '00000000-0000-4000-8000-000000000001', 0, 'emoji', 1, ?, ?, 'u')`,
        );
        seedType.run('t-problem', BASE, 'проблема', 'проблема', now, now);
        seedType.run('t-zadacha', BASE, 'задача2', 'задача2', now, now);
        db.prepare(
          `INSERT INTO link_types
             (id, layer_id, name_forward, name_forward_key, name_reverse, name_reverse_key,
              parent_id, is_root, style, width, style_set, width_set, version, created_at, updated_at, created_by)
           VALUES ('lt-1', ?, 'связан с', type_name_key('связан с'), 'связь', type_name_key('связь'),
                   '00000000-0000-4000-8000-000000000002', 0, 'solid', 1, 1, 1, 1, ?, ?, 'u')`,
        ).run(BASE, now, now);

        // Same name, three different natures — none may merge.
        seedDef(db, 'a1', 't-problem', 'подсистема', 'text', null);
        seedDef(db, 'a2', 't-zadacha', 'подсистема', 'number', null);
        seedDef(
          db,
          'a3',
          'lt-1',
          'подсистема',
          'thought_ref',
          '{"multiple":true,"allowed_type_ids":["t-problem"]}',
          0,
          'link_type',
        );
        // Same nature on two types → merge, allowed_type_ids unioned
        // (list form + legacy single form both count).
        seedDef(db, 'a4', 't-problem', 'связь', 'thought_ref', '{"multiple":true,"allowed_type_ids":["t-problem"]}');
        seedDef(db, 'a5', 't-zadacha', 'связь', 'thought_ref', '{"multiple":true,"allowed_type_id":"t-zadacha"}');

        runMigrations(db, networkMigrationsDir());

        const props = db
          .prepare('SELECT id, name, value_type, config FROM properties ORDER BY name')
          .all() as Array<{ id: string; name: string; value_type: string; config: string | null }>;
        // 5 definitions − 1 merge (a4+a5) = 4 registry properties; плюс 2
        // структурных свойства-связи «Родители»/«Потомки» от миграции 039.
        assert.equal(props.length, 6);

        // The earliest definition (a1) keeps the plain name; the others get
        // composite names from their owner types (link type → forward name).
        const byName = new Map(props.map((p) => [p.name, p]));
        assert.equal(byName.get('подсистема')!.id, 'a1');
        assert.equal(byName.get('задача2.подсистема')!.value_type, 'number');
        // 040 конвертирует thought_ref-свойства в свойства-связи.
        assert.equal(byName.get('связан с.подсистема')!.value_type, 'link');
        assert.equal(byName.get('связь')!.id, 'a4');

        // Merged thought_ref property: allowed ids unioned across both forms;
        // 040 конвертирует в свойство-связь — multiple сохранён, объединённый
        // allowed_type_ids переехал в allowed_target_type_ids.
        const svyaz = byName.get('связь')!;
        const cfg = JSON.parse(svyaz.config!) as {
          multiple?: number | boolean;
          allowed_target_type_ids?: string[];
          link_type_id?: string;
          direction?: string;
          show_on_map?: number;
          blocks_target_deletion?: number;
        };
        assert.equal(cfg.multiple, 1);
        assert.equal(cfg.direction, 'out');
        assert.equal(cfg.show_on_map, 0);
        assert.equal(cfg.blocks_target_deletion, 1);
        assert.ok(typeof cfg.link_type_id === 'string' && cfg.link_type_id.length > 0);
        assert.deepEqual([...(cfg.allowed_target_type_ids ?? [])].sort(), ['t-problem', 't-zadacha']);

        // Bindings: a5 attaches to the surviving a4.
        const a5 = db
          .prepare('SELECT property_id FROM type_properties WHERE id = ?')
          .get('a5') as { property_id: string };
        assert.equal(a5.property_id, 'a4');
      } finally {
        db.close();
      }
    });

    it('032 rewrites saved filters referencing a merged duplicate so the filter still resolves', () => {
      const db = pre032Db();
      try {
        seedDef(db, 'x1', 'tt', 'Статус', 'text', '{"options":["a","b"],"default_value":"a"}');
        seedDef(db, 'x2', 'tt2', 'Статус', 'text', '{"options":["a","b"],"default_value":"a"}');
        db.prepare(
          `INSERT INTO saved_filters (id, user_id, view, name, definition, created_at, updated_at)
           VALUES ('f1', 'u1', 'structures', 'Отбор по статусу',
                   '{"keywords":"x","properties":[{"property_id":"x2","op":"eq","value":"a"}],"sort":"title"}',
                   '2026-01-01', '2026-01-01')`,
        ).run();

        runMigrations(db, networkMigrationsDir());

        const filter = db.prepare('SELECT definition FROM saved_filters WHERE id = ?').get('f1') as {
          definition: string;
        };
        const parsed = JSON.parse(filter.definition) as {
          keywords: string;
          properties: Array<{ property_id: string; op: string; value: string }>;
          sort: string;
        };
        assert.equal(parsed.properties[0]!.property_id, 'x1', 'loser x2 → survivor x1');
        assert.equal(parsed.keywords, 'x', 'unrelated JSON parts untouched');
        assert.equal(parsed.sort, 'title');
      } finally {
        db.close();
      }
    });

    // ------------------------------------------------------------------
    // 036: property_values — deterministic ids from the natural key
    // (bug dc119240). Historical databases can hold TWO different random ids
    // for one natural key (independent first-writes in layers that could not
    // see each other); the migration collapses every row onto the
    // deterministic UUIDv5 of its natural key.
    // ------------------------------------------------------------------

    /** Apply migrations up to (excluding) 036 and return the prepared db. */
    function pre036Db(): Database.Database {
      const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig-'));
      for (const f of readdirSync(networkMigrationsDir()).filter(
        (f) => f.endsWith('.sql') && f < '036',
      )) {
        cpSync(path.join(networkMigrationsDir(), f), path.join(dir, f));
      }
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, dir);
      rmSync(dir, { recursive: true, force: true });
      return db;
    }

    /** Seed a legacy property_values row with an arbitrary (pre-fix) id. */
    function seedPv(
      db: Database.Database,
      id: string,
      layerId: string,
      ownerId: string,
      propertyId: string,
      valueText: string,
      deleted = 0,
    ): void {
      db
        .prepare(
          `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id,
                                        value_text, updated_at, deleted)
           VALUES (?, ?, 'thought', ?, ?, ?, '2026-09-01T00:00:00Z', ?)`,
        )
        .run(id, layerId, ownerId, propertyId, valueText, deleted);
    }

    it('036 collapses historical duplicate ids of one natural key onto the deterministic id', () => {
      const db = pre036Db();
      try {
        // A child layer and a grandchild layer (as in the bug's repro).
        db.prepare(
          `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
           VALUES ('11111111-1111-4111-8111-111111111111', ?, 'A', 0, 1, 'u', '2026-01-01', '2026-01-01')`,
        ).run(BASE);
        db.prepare(
          `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
           VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'B', 0, 2, 'u', '2026-01-01', '2026-01-01')`,
        ).run();
        const owner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const prop = '01234567-89ab-4cde-8f01-234567890abc';

        // Pre-fix shape: two independent live rows for the same natural key
        // with DIFFERENT random ids (layer A's own write + base's
        // independent write — UNIQUE (…, layer_id) keeps them in separate
        // layers), plus a tombstone shadow copy of A's winner in child
        // layer B (materializeTombstone copies the nearest row's id).
        seedPv(db, '11111111-2222-4333-8444-555555555555', '11111111-1111-4111-8111-111111111111', owner, prop, 'в работе (А)');
        seedPv(db, '66666666-7777-4888-8999-aaaaaaaaaaaa', BASE, owner, prop, 'открыто (основа)');
        seedPv(db, '11111111-2222-4333-8444-555555555555', '22222222-2222-4222-8222-222222222222', owner, prop, 'в работе (А)', 1);

        const applied = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(applied.applied, [
          '036_property_values_deterministic_id.sql',
          '037_thought_type_views.sql',
          '038_search_trigram.sql',
          '039_structural_link_properties.sql',
          '040_thought_ref_to_link_properties.sql',
        ]);

        const expectedId = propertyValueId('thought', owner, prop);
        const rows = db
          .prepare('SELECT id, layer_id, value_text, deleted FROM property_values ORDER BY layer_id, deleted')
          .all() as Array<{ id: string; layer_id: string; value_text: string; deleted: number }>;
        // Every row of the natural key — live, shadow and tombstone alike —
        // converged on ONE deterministic id; values/columns are untouched.
        assert.equal(rows.length, 3);
        assert.deepEqual(
          rows.map((r) => r.id),
          [expectedId, expectedId, expectedId],
        );
        assert.deepEqual(
          rows.map((r) => [r.layer_id, r.value_text, r.deleted]),
          [
            [BASE, 'открыто (основа)', 0],
            ['11111111-1111-4111-8111-111111111111', 'в работе (А)', 0],
            ['22222222-2222-4222-8222-222222222222', 'в работе (А)', 1],
          ],
        );
        // The id stays a well-formed UUIDv5 (clients parse it as a UUID).
        assert.match(expectedId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      } finally {
        db.close();
      }
    });

    it('036 leaves already-deterministic rows and other natural keys alone', () => {
      const db = pre036Db();
      try {
        const owner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const prop = '01234567-89ab-4cde-8f01-234567890abc';
        const detId = propertyValueId('thought', owner, prop);
        // A row that already carries the deterministic id (e.g. re-applying
        // the UPDATE manually) and an unrelated row that must keep its own
        // deterministic id, not inherit the first one's.
        seedPv(db, detId, BASE, owner, prop, 'v1');
        const owner2 = '99999999-9999-4999-8999-999999999999';
        seedPv(db, 'deadbeef-dead-4dea-8dea-deaddeadbeef', BASE, owner2, prop, 'v2');

        runMigrations(db, networkMigrationsDir());

        const byOwner = new Map(
          (db.prepare('SELECT id, owner_id FROM property_values').all() as Array<{
            id: string;
            owner_id: string;
          }>).map((r) => [r.owner_id, r.id]),
        );
        assert.equal(byOwner.get(owner), detId, 'already-deterministic row untouched');
        assert.equal(
          byOwner.get(owner2),
          propertyValueId('thought', owner2, prop),
          'other natural key gets its OWN deterministic id',
        );
      } finally {
        db.close();
      }
    });

    it('040 converts thought_ref properties to link properties with materialised edges', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      try {
        const res = runMigrations(db, networkMigrationsDir());
        assert.equal(res.applied[res.applied.length - 1], '040_thought_ref_to_link_properties.sql');
        // 040 уже применён в прогоне — откатываем запись, сеем данные
        // thought_ref-эпохи и применяем повторно (как апгрейд живой сети).
        db.prepare(
          "DELETE FROM _migrations WHERE name = '040_thought_ref_to_link_properties.sql'",
        ).run();
        const now = '2026-09-13T00:00:00Z';
        const BASE = '00000000-0000-4000-8000-0000000000ba5e';

        const insThought = db.prepare(
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 1, ?, ?, 'u1', 'u1', 0, 0)`,
        );
        insThought.run('ta', BASE, 'Мысль A', 'мысль a', now, now);
        insThought.run('tb', BASE, 'Мысль B', 'мысль b', now, now);
        insThought.run('tc', BASE, 'Мысль C', 'мысль c', now, now);

        const insProp = db.prepare(
          `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, type_name_key(?), 'thought_ref', ?, ?, ?, 'u1', 'u1')`,
        );
        insProp.run('p1', BASE, 'версия', 'версия', '{"allowed_type_ids":["tt1"]}', now, now);
        insProp.run('p2', BASE, 'подсистемы', 'подсистемы', '{"multiple":true}', now, now);

        const insVal = db.prepare(
          `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_thought_ref, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'thought', ?, ?, ?, ?, 'u1', 'u1', 0, 0)`,
        );
        insVal.run('v1', BASE, 'ta', 'p1', 'tb', now); // одиночная
        insVal.run('v2', BASE, 'tc', 'p2', '["ta","tb"]', now); // multiple: порядок → position
        insVal.run('v3', BASE, 'ta', 'p2', '["tb","tz"]', now); // цель tz не существует — призрак

        // Второй слой со своим thought_ref-свойством и значением.
        db.prepare(
          `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base, depth, created_by, updated_by, created_at, last_activity_at, created_at_ms, updated_at_ms, version)
           VALUES ('lay1', ?, 'слой', NULL, NULL, 0, 0, 1, 'u1', 'u1', ?, ?, 0, 0, 1)`,
        ).run(BASE, now, now);
        insProp.run('p3', 'lay1', 'источник', 'источник', null, now, now);
        insVal.run('v4', 'lay1', 'tb', 'p3', 'ta', now);

        // Ребро с хроно-комментарием, вложением, значением свойства на ребре,
        // постоянным комментарием и привязкой свойства к типу связи.
        db.prepare(
          `INSERT INTO links (id, layer_id, source_id, target_id, type_id, position, active, version, created_at, updated_at, created_by, updated_by)
           VALUES ('lnk1', ?, 'ta', 'tb', NULL, 0, 1, 1, ?, ?, 'u1', 'u1')`,
        ).run(BASE, now, now);
        const insComment = db.prepare(
          `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html, valid_from, version, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, 'u1', 'u1')`,
        );
        insComment.run('cch', BASE, 'link', 'lnk1', 'chronological', 'хроника ребра', '<p>x</p>', now, now, now);
        insComment.run('cper', BASE, 'link', 'lnk1', 'permanent', 'постоянный', '<p>x</p>', now, now, now);
        db.prepare(
          `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, title, position, created_at, created_by)
           VALUES ('at1', ?, 'link', 'lnk1', 'url', 'https://x', 'вложение', 0, ?, 'u1')`,
        ).run(BASE, now);
        db.prepare(
          `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, created_at, updated_at, created_by, updated_by)
           VALUES ('p9', ?, 'путь', type_name_key('путь'), 'text', NULL, ?, ?, 'u1', 'u1')`,
        ).run(BASE, now, now);
        db.prepare(
          `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_text, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
           VALUES ('v5', ?, 'link', 'lnk1', 'p9', ' docs/x.md ', ?, 'u1', 'u1', 0, 0)`,
        ).run(BASE, now);
        db.prepare(
          `INSERT INTO type_properties (id, layer_id, owner_type, owner_id, property_id, required, position)
           VALUES ('tp9', ?, 'link_type', '00000000-0000-4000-8000-000000000002', 'p9', 0, 0)`,
        ).run(BASE);

        const res2 = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res2.applied, ['040_thought_ref_to_link_properties.sql']);

        // Виды связи: по одному на якорь каждого свойства, в слое якоря.
        const lts = db
          .prepare(
            "SELECT id, name_forward, layer_id FROM link_types WHERE name_forward LIKE 'upd: %'",
          )
          .all() as Array<{ id: string; name_forward: string; layer_id: string }>;
        assert.equal(lts.length, 3, JSON.stringify(lts));
        const ltNames = lts.map((l) => `${l.name_forward}@${l.layer_id === BASE ? 'base' : 'lay1'}`);
        for (const expected of ['upd: версия@base', 'upd: подсистемы@base', 'upd: источник@lay1']) {
          assert.ok(ltNames.includes(expected), `missing ${expected}`);
        }

        // Определения сконвертированы на месте (id сохранены), config по АДР.
        const props = db
          .prepare("SELECT id, value_type, config FROM properties WHERE id IN ('p1','p2','p3')")
          .all() as Array<{ id: string; value_type: string; config: string }>;
        assert.equal(props.length, 3);
        const cfg1 = JSON.parse(props.find((p) => p.id === 'p1')!.config!);
        assert.equal(props.find((p) => p.id === 'p1')!.value_type, 'link');
        assert.ok(typeof cfg1.link_type_id === 'string' && cfg1.link_type_id.length > 0);
        assert.equal(cfg1.direction, 'out');
        assert.equal(cfg1.show_on_map, 0);
        assert.equal(cfg1.blocks_target_deletion, 1);
        assert.deepEqual(cfg1.allowed_target_type_ids, ['tt1']);
        assert.equal(cfg1.multiple, undefined);
        const cfg2 = JSON.parse(props.find((p) => p.id === 'p2')!.config!);
        assert.equal(cfg2.multiple, 1);
        assert.equal(cfg2.allowed_target_type_ids, undefined);

        // Значения → рёбра в тех же слоях; position хранит порядок массива.
        const edges = db
          .prepare(
            `SELECT source_id, target_id, layer_id, position FROM links
              WHERE type_id IN (SELECT id FROM link_types WHERE name_forward LIKE 'upd: %')
              ORDER BY source_id, position`,
          )
          .all() as Array<{ source_id: string; target_id: string; layer_id: string; position: number }>;
        assert.equal(edges.length, 4, JSON.stringify(edges));
        const e1 = edges.find((e) => e.source_id === 'ta' && e.target_id === 'tb');
        assert.ok(e1 !== undefined && e1.layer_id === BASE && e1.position === 0);
        const tcEdges = edges.filter((e) => e.source_id === 'tc');
        assert.deepEqual(
          tcEdges.map((e) => [e.target_id, e.position]),
          [
            ['ta', 0],
            ['tb', 1],
          ],
        );
        const layEdge = edges.find((e) => e.layer_id === 'lay1');
        assert.ok(layEdge !== undefined && layEdge.source_id === 'tb' && layEdge.target_id === 'ta');

        // Призрак с несуществующей целью остался строкой; остальные значения удалены.
        const ghost = db
          .prepare("SELECT owner_id, value_thought_ref FROM property_values WHERE id = 'v3'")
          .get() as { owner_id: string; value_thought_ref: string };
        assert.equal(ghost.owner_id, 'ta');
        assert.equal(ghost.value_thought_ref, '["tb","tz"]');
        assert.equal(
          (db.prepare('SELECT COUNT(*) AS c FROM property_values').get() as { c: number }).c,
          1,
        );

        // Хроно-комментарий переподчинён источнику с пометкой о переносе.
        const chrono = db
          .prepare("SELECT owner_type, owner_id, body_md, body_html FROM comments WHERE id = 'cch'")
          .get() as { owner_type: string; owner_id: string; body_md: string; body_html: string };
        assert.equal(chrono.owner_type, 'thought');
        assert.equal(chrono.owner_id, 'ta');
        assert.ok(
          chrono.body_md.startsWith('*(перенесено с связи «Мысль A» → «Мысль B»'),
          chrono.body_md,
        );
        assert.ok(chrono.body_md.endsWith('хроника ребра'));
        assert.equal(chrono.body_html, '', 'body_html пересоберёт markdown-sweep');

        // Вложение ребра переподчинено источнику.
        const att = db
          .prepare("SELECT owner_type, owner_id FROM attachments WHERE id = 'at1'")
          .get() as { owner_type: string; owner_id: string };
        assert.equal(att.owner_type, 'thought');
        assert.equal(att.owner_id, 'ta');

        // Значение свойства на ребре дописано в постоянный комментарий
        // (markdown-списком), строка значения удалена.
        const perm = db
          .prepare("SELECT body_md FROM comments WHERE id = 'cper'")
          .get() as { body_md: string };
        assert.ok(perm.body_md.startsWith('постоянный'), perm.body_md);
        assert.ok(perm.body_md.includes('- путь: docs/x.md'), perm.body_md);
        assert.equal(
          (
            db
              .prepare("SELECT COUNT(*) AS c FROM property_values WHERE owner_type = 'link'")
              .get() as { c: number }
          ).c,
          0,
        );

        // Привязка свойства к типу связи удалена.
        assert.equal(
          (
            db
              .prepare("SELECT COUNT(*) AS c FROM type_properties WHERE owner_type = 'link_type'")
              .get() as { c: number }
          ).c,
          0,
        );
      } finally {
        db.close();
      }
    });
  },
);
