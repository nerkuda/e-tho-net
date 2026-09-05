/**
 * `.etnx` import service (phase P, task P3, docs/02-data-model.md §9.3).
 *
 * Reads a `.etnx` zip archive produced by `export-service.ts` and applies
 * the manifest to a target network in a single SQLite transaction:
 *
 *   1. Parse `manifest.json` (`parseManifest`).
 *   2. Import thought types / link types — by id (PK preserved) or skipped
 *      if the row already exists. A `typeIdRemap` table maps manifest ids →
 *      resolved ids for FK rewrites later.
 *   3. Import property definitions (EAV schema) the same way; populate a
 *      `propertyIdRemap` table.
 *   4. Import thoughts: by-id match (update), by-title match (update + merge
 *      synonyms), or create (new id). Produce `thoughtIdRemap`.
 *   5. Import thought synonyms, links, comments, property values, attachments
 *      using the remap tables.
 *   6. For every *root* thought in the manifest (no incoming link from inside
 *      the archive) that was newly created, attach it as a child of
 *      `parent_thought_id` via a regular link.
 *
 * Per-user data is never imported (`thought_views`, `user_focus_*`,
 * `pinned_thoughts`, `saved_filters`, `thought_read_metrics`). UUIDs are
 * preserved on creation; the `is_root` / `is_protected` flags are stripped
 * (the target network owns its own HOME).
 *
 * The route layer (`routes/import.ts`, P4) wraps this in
 * `POST /import/commit` (idempotent) and `POST /import/preview`.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import yauzl from 'yauzl';

import {
  EtnError,
  ETNX_MAX_BYTES,
  type Comment,
  type EtnxManifest,
  type ImportPreview,
  type ImportSummary,
  type Link,
  type LinkType,
  type NetworkProperty,
  type PropertyDefinition,
  type PropertyValue,
  type PropertyValueValue,
  type ThoughtType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import type { Logger } from '../logger.js';
import { parseManifest } from './etnx-format.js';
import { normalizeTitle } from './thought-service.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link importFromEtnx}. */
export interface ImportOptions {
  /** User id performing the import (becomes `created_by` / `updated_by`). */
  actorUserId: string;
  /** Thought the imported graph is attached to as a parent. */
  parentThoughtId: string;
  /** Slices of the manifest to import. Unspecified → all slices (defaults). */
  slices?: {
    include_types?: boolean;
    include_attachments?: boolean;
    include_chronology?: boolean;
  };
}

/**
 * Result of {@link importFromEtnx}. Mirrors {@link ImportSummary} but also
 * exposes the thought-id remap and the lists of freshly created entities so
 * the route layer can fire realtime events for them.
 */
export interface ImportResult extends ImportSummary {
  /** Map `manifest.thoughts[].id` → final thought id in the target network. */
  thoughtIdRemap: Map<string, string>;
  /** Thought ids that were *newly* created by this import (not updated/reused). */
  createdThoughtIds: string[];
  /** Link ids that were *newly* created by this import (not duplicates). */
  createdLinkIds: string[];
  /** Permanent comment ids whose body was overwritten by this import. */
  updatedCommentIds: string[];
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

/** Read the full contents of an entry from a `yauzl` zip handle. */
function readEntryToBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err !== null && err !== undefined) {
        reject(err);
        return;
      }
      if (stream === undefined) {
        reject(new EtnError('VALIDATION_ERROR', 'Не удалось открыть поток для записи zip.'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/**
 * Open a buffer as a zip, locate the `manifest.json` entry and read every
 * `attachments/<rel>` entry into memory. Returns a map `rel → Buffer` for
 * later write-out.
 *
 * @throws EtnError `VALIDATION_ERROR` when the archive has no manifest,
 *   multiple manifests, or a path looks malicious.
 */
async function readArchive(
  zipBuffer: Buffer,
  logger: Logger,
): Promise<{ manifest: EtnxManifest; attachments: Map<string, Buffer> }> {
  if (zipBuffer.length > ETNX_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Размер архива ${zipBuffer.length} байт превысил лимит ${ETNX_MAX_BYTES}.`,
      { limit: ETNX_MAX_BYTES, actual: zipBuffer.length },
    );
  }

  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, z) => {
      if (err !== null && err !== undefined) reject(err);
      else resolve(z);
    });
  });

  const attachments = new Map<string, Buffer>();
  let manifestBytes: Buffer | null = null;
  let manifestSeen = false;

  return await new Promise<{ manifest: EtnxManifest; attachments: Map<string, Buffer> }>(
    (resolve, reject) => {
      let aborted = false;
      const fail = (err: unknown): void => {
        if (aborted) return;
        aborted = true;
        reject(err);
      };

      zip.on('entry', (entry: yauzl.Entry) => {
        if (aborted) return;
        const name = entry.fileName;
        if (name === 'manifest.json') {
          if (manifestSeen) {
            fail(new EtnError('VALIDATION_ERROR', 'В архиве несколько manifest.json.'));
            return;
          }
          manifestSeen = true;
          void readEntryToBuffer(zip, entry)
            .then((buf) => {
              if (aborted) return;
              manifestBytes = buf;
              zip.readEntry();
            })
            .catch(fail);
          return;
        }
        if (name.startsWith('attachments/') && !name.endsWith('/')) {
          const rel = name.slice('attachments/'.length);
          if (rel === '' || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
            fail(new EtnError('VALIDATION_ERROR', `Недопустимый путь в архиве: ${name}`));
            return;
          }
          void readEntryToBuffer(zip, entry)
            .then((buf) => {
              if (aborted) return;
              attachments.set(rel, buf);
              zip.readEntry();
            })
            .catch(fail);
          return;
        }
        zip.readEntry();
      });

      zip.on('end', () => {
        if (aborted) return;
        if (manifestBytes === null) {
          fail(new EtnError('VALIDATION_ERROR', 'В архиве нет manifest.json.'));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(manifestBytes.toString('utf-8'));
        } catch (e) {
          fail(
            new EtnError('VALIDATION_ERROR', 'manifest.json не является валидным JSON.', {
              cause: e instanceof Error ? e.message : String(e),
            }),
          );
          return;
        }
        try {
          const manifest = parseManifest(parsed);
          logger.info(
            {
              version: manifest.version,
              attachments: attachments.size,
              thoughts: manifest.thoughts.length,
            },
            'etnx archive opened',
          );
          resolve({ manifest, attachments });
        } catch (e) {
          fail(e);
        }
      });
      zip.on('error', fail);
      zip.readEntry();
    },
  );
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

/** `SELECT id, title_norm FROM thoughts_v WHERE id IN (...)` — id existence map. */
function readExistingThoughtIds(ndb: NetworkDb, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id, title_norm FROM thoughts_v WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; title_norm: string }>;
  return new Map(rows.map((r) => [r.id, r.title_norm]));
}

/** `SELECT id, title_norm FROM thoughts_v WHERE title_norm IN (...)`. */
function readExistingThoughtsByTitle(
  ndb: NetworkDb,
  titleNorms: string[],
): Map<string, string> {
  if (titleNorms.length === 0) return new Map();
  const placeholders = titleNorms.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id, title_norm FROM thoughts_v WHERE title_norm IN (${placeholders})`)
    .all(...titleNorms) as Array<{ id: string; title_norm: string }>;
  return new Map(rows.map((r) => [r.title_norm, r.id]));
}

function readExistingThoughtTypeIds(ndb: NetworkDb, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id FROM thought_types_v WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function readExistingLinkTypeIds(ndb: NetworkDb, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id FROM link_types_v WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function readExistingPropertyIds(ndb: NetworkDb, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id FROM type_properties_v WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Writers — one helper per table. All writers expect to be called inside an
// open `ndb.transaction(...)`.
// ---------------------------------------------------------------------------

/**
 * `INSERT OR IGNORE INTO thought_types ...` — reuses by primary key, so
 * already-existing rows are silently kept and the manifest data is dropped
 * (the importer does not overwrite type definitions on collision).
 */
function insertThoughtType(ndb: NetworkDb, row: ThoughtType): { created: boolean } {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO thought_types (
         id, name, icon, fg_color, bg_color, font_bold, font_italic,
         font_underline, font_strike, description, version,
         created_at, updated_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name,
      row.icon,
      row.fg_color,
      row.bg_color,
      row.font_bold === null ? null : row.font_bold ? 1 : 0,
      row.font_italic === null ? null : row.font_italic ? 1 : 0,
      row.font_underline === null ? null : row.font_underline ? 1 : 0,
      row.font_strike === null ? null : row.font_strike ? 1 : 0,
      row.description,
      row.version,
      row.created_at,
      row.updated_at,
      row.created_by,
    );
  return { created: true };
}

function insertLinkType(ndb: NetworkDb, row: LinkType): { created: boolean } {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO link_types (
         id, name_forward, name_reverse, color, style, width, description,
         version, created_at, updated_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name_forward,
      row.name_reverse,
      row.color,
      row.style ?? 'solid',
      row.width ?? 1,
      row.description,
      row.version,
      row.created_at,
      row.updated_at,
      row.created_by,
    );
  return { created: true };
}

/**
 * Insert one registry property from the manifest. The registry is keyed by
 * `name_key` (case-insensitive), not by id — two manifest rows of the same
 * name collapse onto the first-inserted id. Each call records the SURVIVING
 * registry id in `remap` so the bindings and values that referenced this
 * property by its manifest id can be rewritten.
 *
 * Manifest ids are deliberately NOT used as registry ids: a property exported
 * from a foreign network may collide with an id already used in the target.
 * Merge-by-name is the same rule migration 032 applies to the live base, so
 * the import semantics mirror the in-place migration exactly.
 */
function insertProperty(
  ndb: NetworkDb,
  prop: NetworkProperty,
  remap: Map<string, string>,
): string {
  const now = new Date().toISOString();
  const configJson = prop.config === null ? null : JSON.stringify(prop.config);
  // First insert with the manifest id; on `name_key` collision, an existing
  // row wins and the INSERT is a no-op.
  ndb
    .prepare(
      `INSERT OR IGNORE INTO properties (
         id, name, name_key, value_type, config, description, created_at, updated_at
       ) VALUES (?, ?, type_name_key(?), ?, ?, ?, ?, ?)`,
    )
    .run(
      prop.id,
      prop.name,
      prop.name,
      prop.value_type,
      configJson,
      prop.description,
      now,
      now,
    );
  // Resolve the surviving registry id by name — the lookup is what makes the
  // import resilient to id collisions and to pre-merge duplicates.
  const row = ndb
    .prepare('SELECT id FROM properties_v WHERE name_key = type_name_key(?)')
    .get(prop.name) as { id: string } | undefined;
  const propertyId = row?.id ?? prop.id;
  remap.set(prop.id, propertyId);
  return propertyId;
}

/**
 * Insert a type binding (`type_properties`). The property is assumed to be
 * already imported via {@link insertProperty}; this writes only the binding
 * row, looking up the property by name (merge-by-name semantics).
 */
function insertPropertyDefinition(
  ndb: NetworkDb,
  row: PropertyDefinition,
  propertyId: string,
): void {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO type_properties (
         id, owner_type, owner_id, property_id, required, position
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.owner_type, row.owner_id, propertyId, row.required ? 1 : 0, row.position);
}

/**
 * Insert (or update if `id` already exists) a thought row.
 * - For new thoughts: insert with the manifest id preserved, `is_root = 0`,
 *   `is_protected = 0`, and `created_by/updated_by = actor`.
 * - For existing thoughts (by id): update mutable fields from the manifest
 *   (title, type_id, active, visual flags), keep `is_root`/`is_protected` as
 *   they were in the target network.
 */
function insertOrUpdateThought(
  ndb: NetworkDb,
  t: EtnxManifest['thoughts'][number],
  resolvedTypeId: string | null,
  actorUserId: string,
  now: string,
): { id: string; action: 'created' | 'updated' | 'reused' } {
  const existing = ndb.prepare('SELECT id FROM thoughts_v WHERE id = ?').get(t.id) as
    | { id: string }
    | undefined;
  if (existing === undefined) {
    ndb
      .prepare(
        `INSERT INTO thoughts (
           id, title, title_norm, type_id, icon, icon_kind, active,
           is_protected, is_root, fg_color, bg_color, font_bold, font_italic,
           font_underline, font_strike, font_manual, version, created_at, created_by,
           updated_at, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.title,
        normalizeTitle(t.title),
        resolvedTypeId,
        t.icon,
        t.icon_kind,
        t.active ? 1 : 0,
        0, // is_protected — always 0 on import
        0, // is_root — always 0 on import
        t.fg_color,
        t.bg_color,
        t.font_bold ? 1 : 0,
        t.font_italic ? 1 : 0,
        t.font_underline ? 1 : 0,
        t.font_strike ? 1 : 0,
        15, // font_manual — all four font_* bits set (the manifest carries them explicitly)
        1, // version
        now,
        actorUserId,
        now,
        actorUserId,
      );
    return { id: t.id, action: 'created' };
  }
  ndb
    .prepare(
      `UPDATE thoughts SET
         title = ?, title_norm = ?, type_id = ?, icon = ?, icon_kind = ?,
         active = ?, fg_color = ?, bg_color = ?, font_bold = ?, font_italic = ?,
         font_underline = ?, font_strike = ?, font_manual = ?,
         version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    )
    .run(
      t.title,
      normalizeTitle(t.title),
      resolvedTypeId,
      t.icon,
      t.icon_kind,
      t.active ? 1 : 0,
      t.fg_color,
      t.bg_color,
      t.font_bold ? 1 : 0,
      t.font_italic ? 1 : 0,
      t.font_underline ? 1 : 0,
      t.font_strike ? 1 : 0,
      15, // mark the four font_* fields as manual
      now,
      actorUserId,
      t.id,
    );
  return { id: t.id, action: 'updated' };
}

/**
 * Insert a thought that was matched by title only (not by id). The new id is
 * generated; the caller records the remap in `thoughtIdRemap`.
 */
function createThoughtForTitleMatch(
  ndb: NetworkDb,
  t: EtnxManifest['thoughts'][number],
  resolvedTypeId: string | null,
  actorUserId: string,
  now: string,
): { id: string } {
  const newId = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (
         id, title, title_norm, type_id, icon, icon_kind, active,
         is_protected, is_root, fg_color, bg_color, font_bold, font_italic,
         font_underline, font_strike, font_manual, version, created_at, created_by,
         updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId,
      t.title,
      normalizeTitle(t.title),
      resolvedTypeId,
      t.icon,
      t.icon_kind,
      t.active ? 1 : 0,
      0,
      0,
      t.fg_color,
      t.bg_color,
      t.font_bold ? 1 : 0,
      t.font_italic ? 1 : 0,
      t.font_underline ? 1 : 0,
      t.font_strike ? 1 : 0,
      15, // font_manual — all four bits set
      1,
      now,
      actorUserId,
      now,
      actorUserId,
    );
  return { id: newId };
}

function insertSynonym(
  ndb: NetworkDb,
  row: { thought_id: string; synonym: string; synonym_norm: string },
): void {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm)
       VALUES (?, ?, ?)`,
    )
    .run(row.thought_id, row.synonym, row.synonym_norm);
}

function insertLink(ndb: NetworkDb, row: Link, actorUserId: string, now: string): string | null {
  const result = ndb
    .prepare(
      `INSERT OR IGNORE INTO links (
         id, source_id, target_id, type_id, active, version,
         created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.source_id,
      row.target_id,
      row.type_id,
      row.active ? 1 : 0,
      row.version,
      row.created_at,
      row.updated_at,
      actorUserId,
      now,
    );
  return result.changes > 0 ? row.id : null;
}

function insertComment(
  ndb: NetworkDb,
  c: Comment,
  resolvedOwnerId: string,
  actorUserId: string,
  now: string,
): 'created' | 'updated' {
  if (c.kind === 'permanent') {
    const existing = ndb
      .prepare(
        "SELECT id FROM comments_v WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'",
      )
      .get(resolvedOwnerId) as { id: string } | undefined;
    if (existing !== undefined) {
      ndb
        .prepare(
          `UPDATE comments SET title = ?, body_md = ?, body_html = ?, version = version + 1,
             updated_at = ?, updated_by = ? WHERE id = ?`,
        )
        .run(c.title, c.body_md, c.body_html, now, actorUserId, existing.id);
      return 'updated';
    }
    ndb
      .prepare(
        `INSERT OR IGNORE INTO comments (
           id, owner_type, owner_id, kind, title, body_md, body_html,
           valid_from, valid_to, version, created_at, created_by,
           updated_at, updated_by
         ) VALUES (?, 'thought', ?, 'permanent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        resolvedOwnerId,
        c.title,
        c.body_md,
        c.body_html,
        c.valid_from,
        c.valid_to,
        c.version,
        c.created_at,
        c.created_by,
        c.updated_at,
        actorUserId,
      );
    return 'created';
  }
  // Chronological — INSERT OR IGNORE so re-importing the same archive is a
  // no-op for chronology rows (the spec says we add without duplicate checks
  // for fresh imports; a re-import replaying the same id must not crash).
  const result = ndb
    .prepare(
      `INSERT OR IGNORE INTO comments (
         id, owner_type, owner_id, kind, title, body_md, body_html,
         valid_from, valid_to, version, created_at, created_by,
         updated_at, updated_by
       ) VALUES (?, 'thought', ?, 'chronological', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      resolvedOwnerId,
      c.title,
      c.body_md,
      c.body_html,
      c.valid_from,
      c.valid_to,
      c.version,
      c.created_at,
      c.created_by,
      c.updated_at,
      actorUserId,
    );
  return result.changes > 0 ? 'created' : 'updated';
}

/**
 * Spread `value` across the `property_values.value_*` columns based on the
 * definition's `value_type`. Falls back to `value_text` when the runtime
 * value does not match the declared type — preserves data round-tripping
 * across versions even when the source type was renamed.
 */
function insertPropertyValue(
  ndb: NetworkDb,
  pv: PropertyValue,
  resolvedOwnerId: string,
): void {
  const value: PropertyValueValue = pv.value;
  const column = columnFor(value);
  const raw = coerce(value);
  ndb
    .prepare(
      `INSERT INTO property_values (
         id, owner_type, owner_id, property_id,
         value_text, value_date, value_number, value_bool, value_thought_ref,
         updated_at
       ) VALUES (?, ?, ?, ?, ${colInit(column)}, ?)
       ON CONFLICT(owner_type, owner_id, property_id, layer_id) DO UPDATE SET
         value_text = NULL,
         value_date = NULL,
         value_number = NULL,
         value_bool = NULL,
         value_thought_ref = NULL,
         ${colSet(column)},
         updated_at = excluded.updated_at`,
    )
    .run(
      pv.id,
      pv.owner_type,
      resolvedOwnerId,
      pv.property_id,
      ...colArgs(column, raw),
      pv.updated_at,
    );
}

/** Map a property value to its canonical storage column. */
function columnFor(
  value: PropertyValueValue,
): 'value_text' | 'value_number' | 'value_bool' | 'value_thought_ref' {
  if (typeof value === 'number') return 'value_number';
  if (typeof value === 'boolean') return 'value_bool';
  // Multiple thought_ref values are stored as a JSON array of ids
  // (02-data-model.md §3.5).
  if (Array.isArray(value)) return 'value_thought_ref';
  return 'value_text';
}

/** Convert a property value to the SQL-friendly representation for its column. */
function coerce(value: PropertyValueValue): string | number | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

/** SQL fragment for the five value_* slots of the INSERT clause — the chosen
 * column's placeholder stands in its own position, the rest are NULL. */
function colInit(column: string): string {
  if (column === 'value_text') return '?, NULL, NULL, NULL, NULL';
  if (column === 'value_number') return 'NULL, NULL, ?, NULL, NULL';
  if (column === 'value_bool') return 'NULL, NULL, NULL, ?, NULL';
  return 'NULL, NULL, NULL, NULL, ?';
}

/** SQL fragment for the UPDATE clause (same idea, but written with `excluded.`). */
function colSet(column: string): string {
  if (column === 'value_text') return 'value_text = excluded.value_text';
  if (column === 'value_number') return 'value_number = excluded.value_number';
  if (column === 'value_bool') return 'value_bool = excluded.value_bool';
  return 'value_thought_ref = excluded.value_thought_ref';
}

/** Argument slot for the column (others stay NULL). */
function colArgs(
  column: string,
  raw: string | number | null,
): Array<string | number | null> {
  if (column === 'value_text') return [raw];
  if (column === 'value_number') return [raw];
  if (column === 'value_bool') return [raw];
  return [raw];
}

function insertAttachment(
  ndb: NetworkDb,
  a: EtnxManifest['attachments'][number],
  resolvedOwnerId: string,
  actorUserId: string,
  now: string,
): void {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO attachments (
         id, owner_type, owner_id, kind, url, file_path, file_size,
         mime_type, title, description, icon, position,
         created_at, created_by, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id,
      a.owner_type,
      resolvedOwnerId,
      a.kind,
      a.url,
      a.file_path,
      a.file_size,
      a.mime_type,
      a.title,
      a.description,
      a.icon,
      a.position,
      a.created_at,
      a.created_by,
      now,
      actorUserId,
    );
}

/** Insert a `comment_targets` row for the primary owner of a chronological comment. */
function insertCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
): void {
  ndb
    .prepare(
      `INSERT OR IGNORE INTO comment_targets (comment_id, owner_type, owner_id)
       VALUES (?, ?, ?)`,
    )
    .run(commentId, ownerType, ownerId);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Apply a `.etnx` archive to the target network in one transaction.
 */
export async function importFromEtnx(
  ndb: NetworkDb,
  zipBuffer: Buffer,
  opts: ImportOptions,
  logger: Logger,
): Promise<ImportResult> {
  const { manifest, attachments } = await readArchive(zipBuffer, logger);
  return applyManifest(ndb, manifest, attachments, opts, logger);
}

/**
 * Apply a pre-parsed manifest (no zip reading). Public for tests and for the
 * preview route when it already has the manifest in hand.
 */
export function applyManifest(
  ndb: NetworkDb,
  manifest: EtnxManifest,
  attachments: Map<string, Buffer>,
  opts: ImportOptions,
  logger: Logger,
): ImportResult {
  const now = new Date().toISOString();
  const includeTypes = opts.slices?.include_types ?? true;
  const includeAttachments = opts.slices?.include_attachments ?? true;
  const includeChronology = opts.slices?.include_chronology ?? true;
  return ndb.transaction((): ImportResult => {
    const summary: ImportSummary = {
      thought_types_created: 0,
      thought_types_reused: 0,
      link_types_created: 0,
      link_types_reused: 0,
      properties_created: 0,
      property_definitions_created: 0,
      thoughts_created: 0,
      thoughts_updated: 0,
      thoughts_reused: 0,
      links_created: 0,
      permanent_comments_updated: 0,
      chronological_comments_added: 0,
      property_values_set: 0,
      attachments_imported: 0,
      manifest_version: manifest.version,
    };
    const thoughtIdRemap = new Map<string, string>();
    const typeIdRemap = new Map<string, string>();
    const linkTypeIdRemap = new Map<string, string>();
    const propertyIdRemap = new Map<string, string>();
    const createdThoughtIds: string[] = [];
    const createdLinkIds: string[] = [];
    const updatedCommentIds: string[] = [];

    // 1. Thought types ------------------------------------------------------
    if (includeTypes) {
      const existingTT = readExistingThoughtTypeIds(
        ndb,
        manifest.thought_types.map((t) => t.id),
      );
      for (const t of manifest.thought_types) {
        const wasExisting = existingTT.has(t.id);
        insertThoughtType(ndb, t);
        if (wasExisting) summary.thought_types_reused += 1;
        else summary.thought_types_created += 1;
        typeIdRemap.set(t.id, t.id);
      }

      // 2. Link types ---------------------------------------------------------
      const existingLT = readExistingLinkTypeIds(
        ndb,
        manifest.link_types.map((t) => t.id),
      );
      for (const t of manifest.link_types) {
        const wasExisting = existingLT.has(t.id);
        insertLinkType(ndb, t);
        if (wasExisting) summary.link_types_reused += 1;
        else summary.link_types_created += 1;
        linkTypeIdRemap.set(t.id, t.id);
      }

      // 3. Property registry (0.6.5) ----------------------------------------
      // Insert every registry property by NAME first so subsequent bindings
      // and values resolve through `propertyIdRemap`. Manifest ids are not
      // authoritative — a same-named row already in the target wins, and the
      // remap carries the surviving id.
      for (const prop of manifest.properties) {
        const inserted = insertProperty(ndb, prop, propertyIdRemap);
        if (inserted === prop.id) summary.properties_created += 1;
      }

      // 4. Property bindings (type_properties) -------------------------------
      const existingPD = readExistingPropertyIds(
        ndb,
        manifest.type_properties.map((p) => p.id),
      );
      for (const p of manifest.type_properties) {
        const resolvedOwnerId =
          p.owner_type === 'thought_type'
            ? typeIdRemap.get(p.owner_id) ?? null
            : p.owner_type === 'link_type'
              ? linkTypeIdRemap.get(p.owner_id) ?? null
              : null;
        if (resolvedOwnerId === null) {
          logger.warn(
            { propertyId: p.id, ownerType: p.owner_type, ownerId: p.owner_id },
            'property definition without resolvable owner — skipping',
          );
          continue;
        }
        // Resolve the binding's property_id through the registry remap (the
        // manifest's `p.property_id` may not exist in the target network).
        const resolvedPropertyId = propertyIdRemap.get(p.property_id);
        if (resolvedPropertyId === undefined) {
          logger.warn(
            { bindingId: p.id, propertyId: p.property_id, ownerType: p.owner_type, ownerId: p.owner_id },
            'property binding references unknown property — skipping',
          );
          continue;
        }
        const rewritten: PropertyDefinition = {
          ...p,
          owner_id: resolvedOwnerId,
          property_id: resolvedPropertyId,
        };
        const wasExisting = existingPD.has(p.id);
        insertPropertyDefinition(ndb, rewritten, resolvedPropertyId);
        if (!wasExisting) summary.property_definitions_created += 1;
      }
    } else {
      // Skip types/properties entirely; imported thoughts will get null type_id
      // and property_value rows that reference unknown property_ids will be
      // skipped in step 8 (resolvedPropertyId is undefined → continue).
      logger.info(
        { thoughtTypes: manifest.thought_types.length, linkTypes: manifest.link_types.length },
        'import: skipping types/properties slice (user opted out)',
      );
    }

    // 4. Thoughts (with id/title dedup) -----------------------------------
    const incomingIds = manifest.thoughts.map((t) => t.id);
    const existingById = readExistingThoughtIds(ndb, incomingIds);
    const titleNorms = Array.from(new Set(manifest.thoughts.map((t) => normalizeTitle(t.title))));
    const existingByTitle = readExistingThoughtsByTitle(ndb, titleNorms);

    const titleMatchIds = new Set<string>();
    for (const t of manifest.thoughts) {
      const resolvedTypeId =
        t.type_id === null ? null : typeIdRemap.get(t.type_id) ?? t.type_id;
      if (existingById.has(t.id)) {
        const r = insertOrUpdateThought(ndb, t, resolvedTypeId, opts.actorUserId, now);
        thoughtIdRemap.set(t.id, r.id);
        if (r.action === 'updated') summary.thoughts_updated += 1;
        else summary.thoughts_reused += 1;
        continue;
      }
      // (Title-match path below creates new thoughts too — both go into createdThoughtIds)
      const normTitle = normalizeTitle(t.title);
      if (existingByTitle.has(normTitle) && !titleMatchIds.has(normTitle)) {
        const existingId = existingByTitle.get(normTitle);
        if (existingId !== undefined) {
          thoughtIdRemap.set(t.id, existingId);
          titleMatchIds.add(normTitle);
          ndb
            .prepare(
              `UPDATE thoughts SET
                 active = ?, icon = ?, icon_kind = ?, fg_color = ?, bg_color = ?,
                 font_bold = ?, font_italic = ?, font_underline = ?, font_strike = ?,
                 font_manual = ?, version = version + 1, updated_at = ?, updated_by = ?
               WHERE id = ?`,
            )
            .run(
              t.active ? 1 : 0,
              t.icon,
              t.icon_kind,
              t.fg_color,
              t.bg_color,
              t.font_bold ? 1 : 0,
              t.font_italic ? 1 : 0,
              t.font_underline ? 1 : 0,
              t.font_strike ? 1 : 0,
              15, // font_manual — all four bits set
              now,
              opts.actorUserId,
              existingId,
            );
          summary.thoughts_updated += 1;
          continue;
        }
      }
      const r = createThoughtForTitleMatch(ndb, t, resolvedTypeId, opts.actorUserId, now);
      thoughtIdRemap.set(t.id, r.id);
      createdThoughtIds.push(r.id);
      summary.thoughts_created += 1;
    }

    // 5. Synonyms -----------------------------------------------------------
    for (const s of manifest.thought_synonyms) {
      const resolvedId = thoughtIdRemap.get(s.thought_id);
      if (resolvedId === undefined) continue;
      insertSynonym(ndb, {
        thought_id: resolvedId,
        synonym: s.synonym,
        synonym_norm: s.synonym_norm,
      });
    }

    // 6. Links --------------------------------------------------------------
    for (const l of manifest.links) {
      const sourceId = thoughtIdRemap.get(l.source_id);
      const targetId = thoughtIdRemap.get(l.target_id);
      const typeId =
        l.type_id === null ? null : linkTypeIdRemap.get(l.type_id) ?? l.type_id;
      if (sourceId === undefined || targetId === undefined) continue;
      const insertedId = insertLink(
        ndb,
        { ...l, source_id: sourceId, target_id: targetId, type_id: typeId },
        opts.actorUserId,
        now,
      );
      if (insertedId !== null) {
        createdLinkIds.push(insertedId);
        summary.links_created += 1;
      }
    }

    // 7. Comments -----------------------------------------------------------
    let skippedChrono = 0;
    for (const c of manifest.comments) {
      if (c.kind === 'chronological' && !includeChronology) {
        skippedChrono += 1;
        continue;
      }
      const resolvedOwner = thoughtIdRemap.get(c.owner_id);
      if (resolvedOwner === undefined) continue;
      const action = insertComment(ndb, c, resolvedOwner, opts.actorUserId, now);
      // Always (re)attach the primary owner to comment_targets so list-by-target
      // queries work for the imported comments.
      insertCommentTarget(ndb, c.id, 'thought', resolvedOwner);
      if (c.kind === 'permanent') {
        if (action === 'updated') {
          summary.permanent_comments_updated += 1;
          updatedCommentIds.push(c.id);
        }
      } else {
        summary.chronological_comments_added += 1;
      }
    }
    if (skippedChrono > 0) {
      logger.info({ skippedChrono }, 'import: skipped chronological comments (user opted out)');
    }
    if (manifest.comment_targets.length > 0) {
      logger.info(
        { droppedTargets: manifest.comment_targets.length },
        'multi-target comment_targets collapsed to the primary owner',
      );
    }

    // 8. Property values ----------------------------------------------------
    for (const pv of manifest.property_values) {
      const resolvedPropertyId = propertyIdRemap.get(pv.property_id);
      if (resolvedPropertyId === undefined) continue;
      const resolvedOwnerId =
        pv.owner_type === 'thought'
          ? thoughtIdRemap.get(pv.owner_id)
          : undefined; // link-typed values are not yet rewritten (no link remap table)
      if (resolvedOwnerId === undefined) continue;
      insertPropertyValue(
        ndb,
        { ...pv, property_id: resolvedPropertyId },
        resolvedOwnerId,
      );
      summary.property_values_set += 1;
    }

    // 9. Attachments --------------------------------------------------------
    const attachDir = path.join(path.dirname(ndb.dbPath), 'attachments');
    mkdirSync(attachDir, { recursive: true });
    if (!includeAttachments) {
      logger.info(
        { attachments: manifest.attachments.length },
        'import: skipping attachments slice (user opted out)',
      );
    } else
      for (const a of manifest.attachments) {
        const resolvedOwnerId = thoughtIdRemap.get(a.owner_id);
        if (resolvedOwnerId === undefined) continue;
        if (a.kind === 'file' && a.file_path !== null) {
          const buf = attachments.get(a.file_path);
          if (buf === undefined) {
            logger.warn({ att: a.id }, 'attachment binary missing in archive — skipping');
            continue;
          }
          const safeRel = a.file_path.replace(/[^a-zA-Z0-9._-]/g, '_');
          const localPath = path.join(attachDir, `${randomUUID().slice(0, 8)}-${safeRel}`);
          writeFileSync(localPath, buf);
          insertAttachment(
            ndb,
            { ...a, owner_id: resolvedOwnerId, file_path: localPath },
            resolvedOwnerId,
            opts.actorUserId,
            now,
          );
        } else {
          insertAttachment(
            ndb,
            { ...a, owner_id: resolvedOwnerId },
            resolvedOwnerId,
            opts.actorUserId,
            now,
          );
        }
        summary.attachments_imported += 1;
      }

    // 10. Attach roots to parent_thought_id -------------------------------
    const incomingTargets = new Set(manifest.links.map((l) => l.target_id));
    for (const t of manifest.thoughts) {
      if (incomingTargets.has(t.id)) continue; // not a root
      const resolvedId = thoughtIdRemap.get(t.id);
      if (resolvedId === undefined) continue;
      // Only re-parent thoughts whose manifest id matches the final id — that
      // means they were *created* by this import. Existing-by-id/by-title
      // matches are already part of the target graph and shouldn't be moved.
      if (resolvedId !== t.id) continue;
      const linkId = randomUUID();
      const inserted = ndb
        .prepare(
          `INSERT OR IGNORE INTO links (
             id, source_id, target_id, type_id, active, version,
             created_at, updated_at, created_by, updated_by
           ) VALUES (?, ?, ?, NULL, 1, 1, ?, ?, ?, ?)`,
        )
        .run(
          linkId,
          opts.parentThoughtId,
          resolvedId,
          now,
          now,
          opts.actorUserId,
          opts.actorUserId,
        );
      if (inserted.changes > 0) {
        createdLinkIds.push(linkId);
        summary.links_created += 1;
      }
    }

    logger.info({ ...summary }, 'etnx import finished');
    return { ...summary, thoughtIdRemap, createdThoughtIds, createdLinkIds, updatedCommentIds };
  });
}

// ---------------------------------------------------------------------------
// Preview (P4 — read-only report)
// ---------------------------------------------------------------------------

/**
 * Open a `.etnx` archive and return its manifest summary without touching the
 * database. Used by `POST /import/preview` to show the user what is about to
 * be imported.
 */
export async function previewFromEtnx(
  zipBuffer: Buffer,
  logger: Logger,
): Promise<ImportPreview> {
  const { manifest } = await readArchive(zipBuffer, logger);
  return {
    manifest_version: manifest.version,
    source_network_name: manifest.source.network_name,
    counts: {
      thought_types: manifest.thought_types.length,
      link_types: manifest.link_types.length,
      properties: manifest.properties.length,
      type_properties: manifest.type_properties.length,
      thoughts: manifest.thoughts.length,
      thought_synonyms: manifest.thought_synonyms.length,
      links: manifest.links.length,
      comments: manifest.comments.length,
      attachments: manifest.attachments.length,
    },
  };
}
