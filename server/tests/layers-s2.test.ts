/**
 * Tests for the change-layers schema (task S2, docs/13-layers.md §2–§3, §9;
 * docs/02-data-model.md §3.0).
 *
 * The first group emulates a «копия боевой базы»: a database of the previous
 * schema (migrations 001–024) with rows in **every** table is upgraded by
 * migration 025; all data must survive and land in the base layer. The second
 * group exercises behaviour on the new schema: base-layer defaults for service
 * writes, explicit deletion cascades (no SQL FKs any more), holding layers in
 * `deletion-check`, cross-layer uniqueness and layer-delete cascades, and the
 * layer-aware FTS triggers.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { runMigrations } from '../src/db/migrator.js';
import { createInMemoryNetworkDb, type NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { networkMigrationsDir } from '../src/paths.js';
import { createComment } from '../src/domain/comment-service.js';
import { createLink, deleteLink, checkLinkDeletion } from '../src/domain/link-service.js';
import { createTypeProperty, setPropertyValue, setTypePropertyDefaultOverride } from '../src/domain/property-service.js';
import { createThought, deleteThought, checkThoughtDeletion } from '../src/domain/thought-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

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

/**
 * Apply network migrations up to (and including) `lastFile` — the state of a
 * database that has never seen migration 025. Bookkeeping rows are written the
 * same way the real migrator does, so a later {@link runMigrations} call
 * applies only what is left.
 */
function applyMigrationsThrough(db: DatabaseConstructor.Database, lastFile: string): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(networkMigrationsDir())
    .filter((f) => f.endsWith('.sql') && f <= lastFile)
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(networkMigrationsDir(), file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    })();
  }
}

/** Row counts of every network table (except `_migrations` and FTS). */
function tableCounts(db: DatabaseConstructor.Database): Record<string, number> {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((t) => !t.startsWith('fts_') && !t.startsWith('_') && !t.startsWith('sqlite_'));
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  }
  return counts;
}

/** Seed a pre-025 database with at least one row in EVERY table. */
function seedPreLayersData(db: DatabaseConstructor.Database): void {
  const now = '2026-08-28T10:00:00Z';
  const ins = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

  ins(
    `INSERT INTO thoughts (id,title,title_norm,type_id,icon,icon_kind,icon_attachment_id,active,
       is_protected,is_root,marked_for_deletion,fg_color,bg_color,font_bold,font_italic,
       font_underline,font_strike,font_manual,version,created_at,created_by,updated_at,updated_by)
     VALUES ('home','HOME','home',NULL,'💬','emoji',NULL,1,1,1,0,NULL,NULL,0,0,0,0,0,1,?,?, 'u',?)`,
    now,
    now,
    now,
  );
  ins(
    `INSERT INTO thoughts (id,title,title_norm,type_id,icon,icon_kind,active,is_protected,is_root,
       marked_for_deletion,fg_color,bg_color,font_bold,font_italic,font_underline,font_strike,
       font_manual,version,created_at,created_by,updated_at,updated_by)
     VALUES ('t1','Мысль','мысль',NULL,'🌟','image',1,0,0,0,'#111','#222',1,0,1,0,3,3,?, 'u',?, 'u')`,
    now,
    now,
  );
  ins(
    `INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by)
     VALUES ('t2','Вторая','вторая',1,1,?,'u',?,'u')`,
    now,
    now,
  );
  // Several synonyms: 025 gives each row its own gen_uuid() id — a
  // deterministic no-arg function would fold into one UUID per statement and
  // trip UNIQUE (id, layer_id) on the second row, so a realistic fixture needs
  // ≥2 rows here to expose that regression (the real database has dozens).
  ins(`INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES ('t1','Идея','идея')`);
  ins(`INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES ('t1','Замысел','замысел')`);
  ins(`INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES ('t1','Мыслишка','мыслишка')`);
  ins(`INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES ('t2','Дубль','дубль')`);

  ins(
    `INSERT INTO thought_types (id,name,name_key,parent_id,is_root,icon,icon_kind,fg_color,
       font_bold,description,comment_template_md,version,created_at,updated_at,created_by)
     VALUES ('tt1','Проект','проект',
       (SELECT id FROM thought_types WHERE is_root = 1),0,'📁','emoji','#0a0',1,'тип','шаблон',1,?,?, 'u')`,
    now,
    now,
  );
  ins(
    `INSERT INTO link_types (id,name_forward,name_forward_key,name_reverse,name_reverse_key,
       parent_id,is_root,color,style,width,style_set,width_set,description,version,created_at,updated_at,created_by)
     VALUES ('lt1','родитель','родитель','ребёнок','ребёнок',
       (SELECT id FROM link_types WHERE is_root = 1),0,'#f00','dashed',2,1,0,'тип связи',1,?,?, 'u')`,
    now,
    now,
  );
  ins(
    `INSERT INTO type_properties (id,owner_type,owner_id,key,value_type,config,required,position)
     VALUES ('tp1','thought_type','tt1','статус','text','{"options":["новый"]}',1,0)`,
  );
  ins(
    `INSERT INTO type_property_overrides (id,owner_type,type_id,property_id,default_value,created_at,updated_at)
     VALUES ('tpo1','thought_type',
       (SELECT id FROM thought_types WHERE is_root = 1),'tp1','"новый"',?,?)`,
    now,
    now,
  );
  ins(
    `INSERT INTO property_values (id,owner_type,owner_id,property_id,value_text,updated_at)
     VALUES ('pv1','thought','t1','tp1','в работе',?)`,
    now,
  );

  ins(
    `INSERT INTO links (id,source_id,target_id,type_id,color,style,width,active,marked_for_deletion,
       version,created_at,updated_at,created_by,updated_by)
     VALUES ('l1','home','t1','lt1','red','dotted',3,1,0,1,?,?,'u','u')`,
    now,
    now,
  );
  ins(
    `INSERT INTO links (id,source_id,target_id,type_id,active,version,created_at,updated_at,created_by,updated_by)
     VALUES ('l2','t1','t2',NULL,1,1,?,?,'u','u')`,
    now,
    now,
  );

  ins(
    `INSERT INTO comments (id,owner_type,owner_id,kind,title,body_md,body_html,valid_from,valid_to,
       version,created_at,updated_at,created_by,updated_by)
     VALUES ('c1','thought','t1','permanent',NULL,'# Заголовок','<h1>Заголовок</h1>',?,NULL,1,?,?,'u','u')`,
    now,
    now,
    now,
  );
  ins(
    `INSERT INTO comments (id,owner_type,owner_id,kind,title,body_md,body_html,valid_from,
       version,created_at,updated_at,created_by,updated_by)
     VALUES ('c2','link','l1','chronological','Заметка','текст хроники','<p>текст хроники</p>',?,1,?,?,'u','u')`,
    now,
    now,
    now,
  );
  // One chronological comment fanned out to several owners (the multi-target
  // shape of 019): exercises the same gen_uuid() backfill with ≥3 rows, like
  // the secondary targets on a real database.
  ins(`INSERT INTO comment_targets (comment_id, owner_type, owner_id) VALUES ('c2','thought','t2')`);
  ins(`INSERT INTO comment_targets (comment_id, owner_type, owner_id) VALUES ('c2','thought','t1')`);
  ins(`INSERT INTO comment_targets (comment_id, owner_type, owner_id) VALUES ('c2','thought','home')`);

  ins(
    `INSERT INTO attachments (id,owner_type,owner_id,kind,url,file_path,file_size,mime_type,title,
       icon,description,position,created_at,created_by)
     VALUES ('a1','thought','t1','url','https://etn.example',NULL,NULL,NULL,'Сайт','data:image/gif;base64,x','ссылка',2,?,'u')`,
    now,
  );

  ins(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ('u','show_inactive','true',?)`, now);
  ins(`INSERT INTO thought_views (user_id, thought_id, last_viewed_at) VALUES ('u','t1',?)`, now);
  ins(
    `INSERT INTO user_focus_preferences (user_id, focus_thought_id, dir, sort, sort_order, updated_at)
     VALUES ('u','t1','children','manual','asc',?)`,
    now,
  );
  ins(
    `INSERT INTO user_focus_order (user_id, focus_thought_id, dir, thought_id, position, updated_at)
     VALUES ('u','t1','children','t2',0,?)`,
    now,
  );
  ins(
    `INSERT INTO saved_filters (id,user_id,view,name,definition,created_at,updated_at)
     VALUES ('sf1','u','structures','Отбор','{}',?,?)`,
    now,
    now,
  );
  ins(`INSERT INTO user_pinned_thoughts (user_id, thought_id, position, pinned_at) VALUES ('u','t1',0,?)`, now);
  ins(
    `INSERT INTO thought_read_metrics (thought_id, reads_count, first_read_at, last_read_at)
     VALUES ('t1',7,?,?)`,
    now,
    now,
  );
  ins(
    `INSERT INTO embeddings (owner_type, owner_id, model, vector, ts) VALUES ('thought','t1','m1',NULL,?)`,
    now,
  );
}

describe(
  'layers schema S2 — upgrade of a pre-layers database (копия боевой базы)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('migration 025 preserves every row and lands it in the base layer', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      try {
        applyMigrationsThrough(db, '024_marked_for_deletion.sql');
        seedPreLayersData(db);
        const before = tableCounts(db);
        // Every content table was seeded.
        for (const [table, count] of Object.entries(before)) {
          assert.ok(count > 0, `seed produced no rows in ${table}`);
        }
        const beforeFts = {
          names: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_thought_names').get() as { c: number }
          ).c,
          texts: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_thought_texts').get() as { c: number }
          ).c,
          links: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_link_texts').get() as { c: number }
          ).c,
        };
        assert.ok(beforeFts.names >= 3 && beforeFts.texts >= 1 && beforeFts.links >= 1);

        // The upgrade: runMigrations applies only the pending layer files
        // (025 + the S6 trigger fix that follows it).
        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, [
          '025_layers.sql',
          '026_fts_layer_tombstones.sql',
          '027_session_layers.sql',
          '028_session_layers_switch_seq.sql',
          '029_links_triple_live.sql',
        ]);

        // 1. Row counts unchanged (the layers table is new, everything else kept).
        const after = tableCounts(db);
        assert.deepEqual(after, { ...before, layers: 1, session_layers: 0 });

        // 2. The base layer row.
        const base = db
          .prepare(
            'SELECT id, parent_id, title, is_service, is_base, depth, created_by, version FROM layers',
          )
          .get() as {
          id: string;
          parent_id: string | null;
          title: string;
          is_service: number;
          is_base: number;
          depth: number;
          created_by: string;
          version: number;
        };
        assert.equal(base.id, BASE_LAYER_ID);
        assert.equal(base.parent_id, null);
        assert.equal(base.title, 'Основа');
        assert.equal(base.is_base, 1);
        assert.equal(base.is_service, 0);
        assert.equal(base.depth, 0);
        assert.ok(base.created_by.length > 0 && base.version === 1);

        // 3. All rows sit in the base layer with no tombstones: layer_id,
        //    deleted = 0, base_version = 0 in every branchable table.
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
          const wrong = (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM ${table}
                 WHERE layer_id <> ? OR deleted <> 0 OR base_version <> 0`,
              )
              .get(BASE_LAYER_ID) as { c: number }
          ).c;
          assert.equal(wrong, 0, `${table} has rows outside the base layer`);
        }

        // 4. Spot-check preserved values across the rebuilt tables.
        const thought = db
          .prepare(
            'SELECT icon, icon_kind, fg_color, font_bold, font_manual, version, is_root FROM thoughts WHERE id = ?',
          )
          .get('t1') as Record<string, unknown>;
        assert.deepEqual(thought, {
          icon: '🌟',
          icon_kind: 'image',
          fg_color: '#111',
          font_bold: 1,
          font_manual: 3,
          version: 3,
          is_root: 0,
        });
        const link = db
          .prepare('SELECT color, style, width, position FROM links WHERE id = ?')
          .get('l1') as Record<string, unknown>;
        assert.deepEqual(link, { color: 'red', style: 'dotted', width: 3, position: 0 });
        const attachment = db
          .prepare('SELECT icon, position FROM attachments WHERE id = ?')
          .get('a1') as Record<string, unknown>;
        assert.deepEqual(attachment, { icon: 'data:image/gif;base64,x', position: 2 });
        const metrics = db
          .prepare('SELECT reads_count FROM thought_read_metrics WHERE thought_id = ?')
          .get('t1') as { reads_count: number };
        assert.equal(metrics.reads_count, 7);

        // 5. thought_synonyms / comment_targets got unique row ids.
        for (const [table, col] of [
          ['thought_synonyms', 'id'],
          ['comment_targets', 'id'],
        ] as const) {
          const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
          const distinct = (
            db.prepare(`SELECT COUNT(DISTINCT ${col}) AS c FROM ${table}`).get() as { c: number }
          ).c;
          assert.ok(total > 0 && total === distinct, `${table}.id not unique after backfill`);
        }

        // 6. FTS rebuilt: same counts, base layer, same texts, rowid joins intact.
        const fts = {
          names: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_thought_names').get() as { c: number }
          ).c,
          texts: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_thought_texts').get() as { c: number }
          ).c,
          links: (
            db.prepare('SELECT COUNT(*) AS c FROM fts_link_texts').get() as { c: number }
          ).c,
        };
        assert.deepEqual(fts, beforeFts);
        const nameRow = db
          .prepare("SELECT layer_id, text FROM fts_thought_names WHERE thought_id = 't1'")
          .get() as { layer_id: string; text: string };
        assert.equal(nameRow.layer_id, BASE_LAYER_ID);
        assert.match(nameRow.text, /Мысль Идея/);
        const matchJoined = db
          .prepare(
            `SELECT c.id FROM fts_thought_texts f JOIN comments c ON c.rowid = f.rowid
             WHERE fts_thought_texts MATCH 'заголовок'`,
          )
          .all() as { id: string }[];
        assert.deepEqual(matchJoined.map((r) => r.id), ['c1']);

        // 7. Database is consistent.
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
        const leftovers = (
          db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_new'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.deepEqual(leftovers, []);
      } finally {
        db.close();
      }
    });

    it('branchable uniqueness is per (id, layer_id), links per triple+layer', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      try {
        runMigrations(db, networkMigrationsDir());
        const now = '2026-08-28T10:00:00Z';
        db.prepare(
          `INSERT INTO thoughts (id,title,title_norm,active,version,created_at,created_by,updated_at,updated_by)
           VALUES ('t1','A','a',1,1,?,'u',?,'u')`,
        ).run(now, now);
        const layer = randomUUID();
        db.prepare(
          `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
           VALUES (?, ?, 'Черновик', 0, 1, 'u', ?, ?)`,
        ).run(layer, BASE_LAYER_ID, now, now);

        // Same logical id in another layer is fine…
        db.prepare(
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
           VALUES ('t1', ?, 'A (слой)', 'a (слой)', 1, 2, ?, 'u', ?, 'u')`,
        ).run(layer, now, now);
        // …but a second row with the same (id, layer_id) is not.
        assert.throws(
          () =>
            db
              .prepare(
                `INSERT INTO thoughts (id, layer_id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
                 VALUES ('t1', ?, 'дубль', 'дубль', 1, 1, ?, 'u', ?, 'u')`,
              )
              .run(layer, now, now),
          /UNIQUE constraint failed: thoughts\.id, thoughts\.layer_id/,
        );

        // The typed-link triple is unique within a layer; the same triple may
        // exist in another layer (13-layers.md §3).
        db.prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
           VALUES ('l1', 't1', 't1x', NULL, 1, 1, ?, ?, 'u', 'u')`,
        ).run(now, now);
        db.prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
           VALUES ('l1b', 't1', 't1x', NULL, 1, 1, ?, ?, 'u', 'u')`,
        ).run(now, now); // untyped duplicates stay app-enforced (NULL semantics kept from 007)
        db.prepare(
          `INSERT INTO links (id, layer_id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
           VALUES ('l2', ?, 't1', 't1x', NULL, 1, 1, ?, ?, 'u', 'u')`,
        ).run(layer, now, now);

        // Deleting the layer row physically removes its shadow rows (FK cascade).
        db.prepare('DELETE FROM layers WHERE id = ?').run(layer);
        assert.equal(
          (db.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE id = ?').get('t1') as { c: number }).c,
          1,
        );
        assert.equal(
          (db.prepare("SELECT COUNT(*) AS c FROM links WHERE id = 'l2'").get() as { c: number }).c,
          0,
        );
      } finally {
        db.close();
      }
    });
  },
);

describe(
  'layers schema S2 — behaviour on the new schema',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('service writes land in the base layer without naming it', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'Мысль' }, USER);
        const type = createThoughtType(ndb, { name: 'Тип' }, USER);
        const t2 = createThought(ndb, { title: 'Вторая', type_id: type.id }, USER);
        const link = createLink(ndb, { source_id: t.id, target_id: t2.id }, USER);
        createComment(ndb, 'thought', t.id, { kind: 'permanent', body_md: 'текст' }, USER);
        createTypeProperty(ndb, 'thought_type', type.id, { key: 'поле', value_type: 'text' });

        for (const [table, id] of [
          ['thoughts', t.id],
          ['thought_types', type.id],
          ['links', link.id],
        ] as const) {
          const row = ndb
            .prepare(`SELECT layer_id, deleted, base_version FROM ${table} WHERE id = ?`)
            .get(id) as { layer_id: string; deleted: number; base_version: number };
          assert.equal(row.layer_id, BASE_LAYER_ID, `${table} row not in base`);
          assert.equal(row.deleted, 0);
          assert.equal(row.base_version, 0);
        }
        const commentRow = ndb
          .prepare('SELECT layer_id FROM comments WHERE owner_id = ?')
          .get(t.id) as { layer_id: string };
        assert.equal(commentRow.layer_id, BASE_LAYER_ID);
        // The synonym row id default (gen_uuid) produces real UUIDs.
        const syn = ndb
          .prepare('INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?) RETURNING id')
          .get(t.id, 'Синоним', 'синоним') as { id: string };
        assert.match(syn.id, /^[0-9a-f-]{36}$/);
      } finally {
        ndb.close();
      }
    });

    it('property upserts work against the per-layer unique constraints', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const rootTypeId = (
          ndb.prepare('SELECT id FROM thought_types WHERE is_root = 1').get() as { id: string }
        ).id;
        const child = createThoughtType(ndb, { name: 'Подтип', parent_id: rootTypeId }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', rootTypeId, {
          key: 'поле',
          value_type: 'number',
        });
        const t = createThought(ndb, { title: 'Владелец', type_id: child.id }, USER);
        // Two writes to the same (owner, property) exercise the upsert's
        // ON CONFLICT(owner_type, owner_id, property_id, layer_id) target.
        setPropertyValue(ndb, 'thought', t.id, 'поле', 1);
        setPropertyValue(ndb, 'thought', t.id, 'поле', 2);
        const values = ndb
          .prepare('SELECT value_number FROM property_values WHERE owner_id = ?')
          .all(t.id) as { value_number: number }[];
        assert.deepEqual(values, [{ value_number: 2 }]);
        // Same for the inherited-default override upsert (child overrides root).
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 7);
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 8);
        const override = ndb
          .prepare('SELECT default_value FROM type_property_overrides')
          .get() as { default_value: string };
        assert.equal(override.default_value, '8');
      } finally {
        ndb.close();
      }
    });

    it('deleteThought cleans everything the removed FKs used to cascade', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        // A root-type property is resolvable for a typeless owner (§3.4.1).
        const rootTypeId = (
          ndb.prepare('SELECT id FROM thought_types WHERE is_root = 1').get() as { id: string }
        ).id;
        const prop = createTypeProperty(ndb, 'thought_type', rootTypeId, {
          key: 'ф',
          value_type: 'text',
        });
        const link = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: null }, USER);
        createComment(ndb, 'thought', a.id, { kind: 'permanent', body_md: 'x' }, USER);
        createComment(ndb, 'link', link.id, { kind: 'chronological', body_md: 'y' }, USER);
        setPropertyValue(ndb, 'thought', a.id, 'ф', 'зн');
        ndb
          .prepare(
            'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
          )
          .run(a.id, 'Син', 'син');
        const now = new Date().toISOString();
        const insPerUser = (sql: string) => ndb.prepare(sql).run();
        insPerUser(`INSERT INTO thought_views (user_id, thought_id, last_viewed_at) VALUES ('u', '${a.id}', '${now}')`);
        insPerUser(
          `INSERT INTO user_focus_preferences (user_id, focus_thought_id, dir, sort, sort_order, updated_at)
           VALUES ('u', '${a.id}', 'children', 'manual', 'asc', '${now}')`,
        );
        insPerUser(
          `INSERT INTO user_focus_order (user_id, focus_thought_id, dir, thought_id, position, updated_at)
           VALUES ('u', '${a.id}', 'children', '${b.id}', 0, '${now}')`,
        );
        insPerUser(
          `INSERT INTO user_pinned_thoughts (user_id, thought_id, position, pinned_at)
           VALUES ('u', '${a.id}', 0, '${now}')`,
        );
        insPerUser(
          `INSERT INTO thought_read_metrics (thought_id, reads_count, first_read_at, last_read_at)
           VALUES ('${a.id}', 1, '${now}', '${now}')`,
        );

        deleteThought(ndb, a.id, undefined);

        const remaining = (sql: string): number =>
          (ndb.prepare(sql).get() as { c: number }).c;
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM thoughts WHERE id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM links WHERE id = '${link.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM thought_synonyms WHERE thought_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM comments WHERE owner_id = '${a.id}' OR owner_id = '${link.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM comment_targets WHERE owner_id = '${a.id}' OR owner_id = '${link.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM property_values WHERE owner_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM thought_views WHERE thought_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM user_focus_preferences WHERE focus_thought_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM user_focus_order WHERE focus_thought_id = '${a.id}' OR thought_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM user_pinned_thoughts WHERE thought_id = '${a.id}'`), 0);
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM thought_read_metrics WHERE thought_id = '${a.id}'`), 0);
        // The property definition itself survives (it belongs to the type).
        assert.equal(remaining(`SELECT COUNT(*) AS c FROM type_properties WHERE id = '${prop.id}'`), 1);
      } finally {
        ndb.close();
      }
    });

    it('deletion-check reports live shadow rows as holding layers (tombstones do not)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        const now = new Date().toISOString();
        const layer = randomUUID();
        ndb
          .prepare(
            `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
             VALUES (?, ?, 'Слой с правками', 0, 1, ?, ?, ?)`,
          )
          .run(layer, BASE_LAYER_ID, USER, now, now);

        // No shadow rows yet — nothing blocks (the a→b link leaves b orphaned
        // if a goes, hence orphaned_children = 1).
        assert.deepEqual(checkThoughtDeletion(ndb, a.id), {
          blocked: false,
          blocking: { properties: 0, layers: [] },
          orphaned_children: 1,
        });
        assert.deepEqual(checkLinkDeletion(ndb, link.id), {
          blocked: false,
          blocking: { layers: [] },
        });

        // A live shadow row of the thought holds it back.
        ndb
          .prepare(
            `INSERT INTO thoughts (id, layer_id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, 'A в слое', 'a в слое', 1, 1, ?, ?, ?, ?)`,
          )
          .run(a.id, layer, now, USER, now, USER);
        const thoughtCheck = checkThoughtDeletion(ndb, a.id);
        assert.equal(thoughtCheck.blocked, true);
        assert.deepEqual(thoughtCheck.blocking.layers, [{ id: layer, title: 'Слой с правками' }]);
        assert.throws(() => deleteThought(ndb, a.id, undefined), /VALIDATION_ERROR|held/);

        // Turn the thought's shadow row into a tombstone — the thought is
        // released, but a live shadow LINK row with it as endpoint still holds.
        ndb
          .prepare('UPDATE thoughts SET deleted = 1 WHERE id = ? AND layer_id = ?')
          .run(a.id, layer);
        const released = checkThoughtDeletion(ndb, a.id);
        assert.equal(released.blocked, false, 'tombstone must not hold the thought');
        assert.deepEqual(released.blocking.layers, []);

        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), layer, a.id, b.id, now, now, USER, USER);
        const linkHeld = checkThoughtDeletion(ndb, a.id);
        assert.equal(linkHeld.blocked, true, 'shadow link with the thought as endpoint must hold it');
        assert.deepEqual(linkHeld.blocking.layers, [{ id: layer, title: 'Слой с правками' }]);

        // For the link itself: a live shadow row blocks, a tombstone does not.
        const linkLayer = randomUUID();
        ndb
          .prepare(
            `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
             VALUES (?, ?, 'Слой связи', 0, 1, ?, ?, ?)`,
          )
          .run(linkLayer, BASE_LAYER_ID, USER, now, now);
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
          )
          .run(link.id, linkLayer, a.id, b.id, now, now, USER, USER);
        const linkCheck = checkLinkDeletion(ndb, link.id);
        assert.equal(linkCheck.blocked, true);
        assert.deepEqual(linkCheck.blocking.layers, [{ id: linkLayer, title: 'Слой связи' }]);
        assert.throws(() => deleteLink(ndb, link.id, undefined), /held by a layer/);

        // A tombstone of the link releases it.
        ndb
          .prepare('UPDATE links SET deleted = 1, base_version = 1 WHERE id = ? AND layer_id = ?')
          .run(link.id, linkLayer);
        assert.deepEqual(checkLinkDeletion(ndb, link.id), {
          blocked: false,
          blocking: { layers: [] },
        });
        deleteLink(ndb, link.id, undefined);
        assert.equal(
          (ndb.prepare("SELECT COUNT(*) AS c FROM links WHERE id = ?").get(link.id) as { c: number })
            .c,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('layer-aware FTS triggers keep the index in sync on the new schema', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'Альфа' }, USER);
        const row = (sql: string, ...args: unknown[]): { layer_id: string; text: string } =>
          ndb.prepare(sql).get(...args) as { layer_id: string; text: string };
        let ftsName = row('SELECT layer_id, text FROM fts_thought_names WHERE thought_id = ?', t.id);
        assert.equal(ftsName.layer_id, BASE_LAYER_ID);
        assert.equal(ftsName.text, 'Альфа');

        ndb
          .prepare('INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)')
          .run(t.id, 'Бета', 'бета');
        ftsName = row('SELECT layer_id, text FROM fts_thought_names WHERE thought_id = ?', t.id);
        assert.equal(ftsName.text, 'Альфа Бета');

        // An update of the title rewrites the row.
        ndb.prepare('UPDATE thoughts SET title = ? WHERE id = ?').run('Гамма', t.id);
        ftsName = row('SELECT layer_id, text FROM fts_thought_names WHERE thought_id = ?', t.id);
        assert.equal(ftsName.text, 'Гамма Бета');

        // A comment lands in fts_thought_texts with its layer.
        createComment(ndb, 'thought', t.id, { kind: 'chronological', body_md: 'дельта' }, USER);
        const ftsText = row(
          'SELECT layer_id, text FROM fts_thought_texts WHERE thought_id = ?',
          t.id,
        );
        assert.equal(ftsText.layer_id, BASE_LAYER_ID);
        assert.equal(ftsText.text, 'дельта');

        // Deleting the thought removes its FTS rows.
        deleteThought(ndb, t.id, undefined);
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM fts_thought_names').get() as { c: number }).c,
          0,
        );
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM fts_thought_texts').get() as { c: number }).c,
          0,
        );
      } finally {
        ndb.close();
      }
    });
  },
);
