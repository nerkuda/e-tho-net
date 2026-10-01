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
  type EtnxManifestProperty,
  type EtnxPublicationExclusion,
  type EtnxPublicationOrder,
  type EtnxShelf,
  type EtnxShelfItem,
  type ImportPreview,
  type ImportSummary,
  type Link,
  type LinkType,
  type NetworkProperty,
  type PropertyDefinition,
  type PropertyValue,
  type PropertyValueValue,
  type Publication,
  type ThoughtType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { propertyValueId } from '../db/property-value-id.js';
import {
  publicationExclusionId,
  publicationOrderId,
  shelfItemId,
} from '../db/publication-id.js';
import type { Logger } from '../logger.js';
import { parseManifest } from './etnx-format.js';
import { normaliseInstant } from './dates.js';
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
  /**
   * Политика разрешения коллизий мыслей (MCP `collision_policy`, ошибка
   * ebe93450). Значения:
   *   * `fail` — любая коллизия (по id или по title) отвергает импорт
   *     `VALIDATION_ERROR` со списком конфликтов;
   *   * `overwrite` (по умолчанию) — существующая мысль обновляется
   *     (историческое поведение импорта);
   *   * `rename` — для коллизии создаётся новая мысль с уникализированным
   *     title, существующая не трогается;
   *   * `skip` — конфликтующая мысль пропускается вместе со своими связями,
   *     комментариями, значениями свойств и вложениями.
   */
  collisionPolicy?: ImportCollisionPolicy;
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

/** Политика разрешения коллизий при импорте (MCP `collision_policy`). */
export type ImportCollisionPolicy = 'fail' | 'rename' | 'skip' | 'overwrite';

/** Одна коллизия манифеста с существующей мыслью целевой сети. */
export interface ImportConflict {
  /** Природа коллизии: совпадение id манифеста или нормализованного title. */
  kind: 'id' | 'title';
  /** id мысли в манифесте. */
  id: string;
  /** title мысли в манифесте. */
  title: string;
  /** id существующей мысли целевой сети — только для `kind: 'title'`. */
  existing_id?: string;
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

/**
 * Коллизии мыслей манифеста с существующими мыслями целевой сети (ошибка
 * ebe93450): совпадение по id (та же мысль) или по нормализованному title.
 * Используется политикой `fail` и превью `dry_run`.
 */
export function findImportConflicts(
  ndb: NetworkDb,
  manifest: EtnxManifest,
): ImportConflict[] {
  const existingById = readExistingThoughtIds(
    ndb,
    manifest.thoughts.map((t) => t.id),
  );
  const titleNorms = Array.from(new Set(manifest.thoughts.map((t) => normalizeTitle(t.title))));
  const existingByTitle = readExistingThoughtsByTitle(ndb, titleNorms);

  const conflicts: ImportConflict[] = [];
  for (const t of manifest.thoughts) {
    if (existingById.has(t.id)) {
      conflicts.push({ kind: 'id', id: t.id, title: t.title });
      continue;
    }
    const existingId = existingByTitle.get(normalizeTitle(t.title));
    if (existingId !== undefined) {
      conflicts.push({ kind: 'title', id: t.id, title: t.title, existing_id: existingId });
    }
  }
  return conflicts;
}

/**
 * Множество id мыслей манифеста, которые политика `skip` пропускает: сами
 * конфликты (`findImportConflicts`) плюс их потомки по рёбрам манифеста
 * (пропуск дубля и его подграфа).
 */
export function computeSkippedThoughtIds(
  ndb: NetworkDb,
  manifest: EtnxManifest,
): Set<string> {
  const skipped = new Set<string>();
  for (const c of findImportConflicts(ndb, manifest)) skipped.add(c.id);
  const adj = new Map<string, string[]>();
  for (const l of manifest.links) {
    const list = adj.get(l.source_id);
    if (list === undefined) adj.set(l.source_id, [l.target_id]);
    else list.push(l.target_id);
  }
  const queue = [...skipped];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const child of adj.get(id) ?? []) {
      if (!skipped.has(child)) {
        skipped.add(child);
        queue.push(child);
      }
    }
  }
  return skipped;
}

/**
 * Уникализировать title при политике `rename`: базовое название, при
 * совпадении `title_norm` с уже существующим (или только что созданным) —
 * суффикс ` (N)`, N = 1, 2, ….
 */
function uniqueImportedTitle(ndb: NetworkDb, base: string): string {
  const taken = (candidate: string): boolean =>
    ndb.prepare('SELECT 1 FROM thoughts_v WHERE title_norm = ? LIMIT 1').get(normalizeTitle(candidate)) !==
    undefined;
  if (!taken(base)) return base;
  for (let n = 1; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken(candidate)) return candidate;
  }
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
 * `INSERT OR IGNORE INTO thought_types ...` — reuses by primary key (and, by
 * the `name_key` UNIQUE index, by case-insensitive name), so already-existing
 * rows are silently kept and the manifest definition is dropped.
 *
 * Нормализованный `name_key` (ошибка e7d1b27a) обязателен: колонка —
 * `NOT NULL DEFAULT ''`, а UNIQUE-индекс `idx_thought_types_name_key` делает
 * `''` занятым уже первой вставкой; без ключа все последующие типы молча
 * отбрасывались `OR IGNORE`. `parent_id` сохраняет иерархию типов. `created`
 * отражает фактическую вставку (`changes`), а не факт вызова — счётчики
 * отчёта не врут.
 */
function insertThoughtType(ndb: NetworkDb, row: ThoughtType): { created: boolean } {
  const result = ndb
    .prepare(
      `INSERT OR IGNORE INTO thought_types (
         id, name, name_key, parent_id, icon, fg_color, bg_color, font_bold, font_italic,
         font_underline, font_strike, description, version,
         created_at, updated_at, created_by
       ) VALUES (?, ?, type_name_key(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name,
      row.name,
      row.parent_id,
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
  return { created: result.changes > 0 };
}

/**
 * `INSERT OR IGNORE INTO link_types ...` — см. {@link insertThoughtType}:
 * нормализованные `name_forward_key`/`name_reverse_key` (ошибка e7d1b27a),
 * `parent_id` и честный `created` по `changes`.
 */
function insertLinkType(ndb: NetworkDb, row: LinkType): { created: boolean } {
  const result = ndb
    .prepare(
      `INSERT OR IGNORE INTO link_types (
         id, name_forward, name_forward_key, name_reverse, name_reverse_key,
         parent_id, color, style, width, style_set, width_set, description,
         version, created_at, updated_at, created_by
       ) VALUES (?, ?, type_name_key(?), ?, type_name_key(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name_forward,
      row.name_forward,
      row.name_reverse,
      row.name_reverse,
      row.parent_id,
      row.color,
      row.style ?? 'solid',
      row.width ?? 1,
      row.style === null ? 0 : 1,
      row.width === null ? 0 : 1,
      row.description,
      row.version,
      row.created_at,
      row.updated_at,
      row.created_by,
    );
  return { created: result.changes > 0 };
}

/** id существующего типа мысли в целевой сети: по id, иначе по `name_key`
 *  (слияние по имени — тот же приём, что у `insertProperty`). */
function resolveThoughtTypeId(ndb: NetworkDb, row: ThoughtType): string {
  const byId = ndb.prepare('SELECT id FROM thought_types_v WHERE id = ?').get(row.id) as
    | { id: string }
    | undefined;
  if (byId !== undefined) return byId.id;
  const byName = ndb
    .prepare('SELECT id FROM thought_types_v WHERE name_key = type_name_key(?)')
    .get(row.name) as { id: string } | undefined;
  return byName?.id ?? row.id;
}

/** id существующего типа связи: по id, иначе по паре ключей имён. */
function resolveLinkTypeId(ndb: NetworkDb, row: LinkType): string {
  const byId = ndb.prepare('SELECT id FROM link_types_v WHERE id = ?').get(row.id) as
    | { id: string }
    | undefined;
  if (byId !== undefined) return byId.id;
  const byName = ndb
    .prepare(
      `SELECT id FROM link_types_v
        WHERE name_forward_key = type_name_key(?) AND name_reverse_key = type_name_key(?)`,
    )
    .get(row.name_forward, row.name_reverse) as { id: string } | undefined;
  return byName?.id ?? row.id;
}

/** id корневого типа мысли/связи целевой сети (единственный с `is_root = 1`). */
function rootTypeId(ndb: NetworkDb, table: 'thought_types_v' | 'link_types_v'): string | null {
  const row = ndb.prepare(`SELECT id FROM ${table} WHERE is_root = 1 LIMIT 1`).get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Перепривязать родителя СОЗДАННОГО типа (ошибка e7d1b27a): `parent_id`
 * манифеста может быть переименован/слит по имени (смотри `typeIdRemap`),
 * а тип-родитель, не попавший в манифест, в целевой сети отсутствует —
 * тогда родителем становится корень целевой сети, чтобы не создать висячую
 * ссылку (инвариант: NULL-родитель только у корня).
 */
function setThoughtTypeParent(ndb: NetworkDb, typeId: string, parentId: string | null): void {
  const root = rootTypeId(ndb, 'thought_types_v');
  let resolved = parentId;
  if (resolved !== null) {
    const exists = ndb
      .prepare('SELECT 1 FROM thought_types_v WHERE id = ? LIMIT 1')
      .get(resolved) as { '1': number } | undefined;
    if (exists === undefined) resolved = root;
  }
  ndb
    .prepare(
      `UPDATE thought_types SET parent_id = ?
        WHERE id = ? AND deleted = 0
          AND layer_id = '00000000-0000-4000-8000-0000000000ba5e' /* импорт пишет в основу */`,
    )
    .run(resolved, typeId);
}

function setLinkTypeParent(ndb: NetworkDb, typeId: string, parentId: string | null): void {
  const root = rootTypeId(ndb, 'link_types_v');
  let resolved = parentId;
  if (resolved !== null) {
    const exists = ndb
      .prepare('SELECT 1 FROM link_types_v WHERE id = ? LIMIT 1')
      .get(resolved) as { '1': number } | undefined;
    if (exists === undefined) resolved = root;
  }
  ndb
    .prepare(
      `UPDATE link_types SET parent_id = ?
        WHERE id = ? AND deleted = 0
          AND layer_id = '00000000-0000-4000-8000-0000000000ba5e' /* импорт пишет в основу */`,
    )
    .run(resolved, typeId);
}

/**
 * Find or create the link type `upd: <name>` (symmetric names) in the base
 * layer — the import counterpart of migration 040 for legacy `thought_ref`
 * properties of pre-0.8.1 archives. Returns the type id.
 */
function upsertUpdLinkType(
  ndb: NetworkDb,
  propName: string,
  actorUserId: string,
  now: string,
): string {
  const name = `upd: ${propName}`;
  const nameKey = name.trim().toLowerCase();
  const existing = ndb
    .prepare(
      `SELECT id FROM link_types WHERE layer_id = '00000000-0000-4000-8000-0000000000ba5e' /* layers:physical-read — ищем существующий «upd:»-вид связи строго в слое основы */
         AND name_forward_key = ? AND name_reverse_key = ? AND deleted = 0 LIMIT 1`,
    )
    .get(nameKey, nameKey) as { id: string } | undefined;
  if (existing !== undefined) return existing.id;
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (
         id, layer_id, deleted, base_version, name_forward, name_forward_key,
         name_reverse, name_reverse_key, parent_id, is_root, color, style, width,
         style_set, width_set, description, version, created_at, updated_at, created_by,
         updated_by, created_at_ms, updated_at_ms
       ) VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', 0, 0, ?, ?, ?, ?,
         '00000000-0000-4000-8000-000000000002', 0, NULL, 'solid', 1, 1, 1,
         ?, 1, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      id,
      name,
      nameKey,
      name,
      nameKey,
      `создано импортом из thought_ref-свойства «${propName}» — переименуйте в осмысленное`,
      now,
      now,
      actorUserId,
      actorUserId,
    );
  return id;
}

/** `config.link_type_id` свойства-связи по id реестровой строки; `null` —
 *  строка не свойство-связь (или конфиг бит). */
function readLinkPropertyTypeId(ndb: NetworkDb, propertyId: string): string | null {
  const row = ndb
    .prepare("SELECT config FROM properties WHERE id = ? AND deleted = 0 LIMIT 1")
    .get(propertyId) as { config: string | null } | undefined;
  if (row?.config === undefined || row.config === null) return null;
  try {
    const cfg = JSON.parse(row.config) as { link_type_id?: unknown };
    return typeof cfg.link_type_id === 'string' && cfg.link_type_id !== ''
      ? cfg.link_type_id
      : null;
  } catch {
    return null;
  }
}

/**
 * Convert a legacy `thought_ref` property of a pre-0.8.1 archive into a link
 * property — the import counterpart of migration 040. `allowed_type_ids`
 * (and the legacy single `allowed_type_id`) become `allowed_target_type_ids`,
 * the `multiple` flag is preserved; values are later materialised as edges by
 * {@link insertLegacyRefEdges}.
 */
function convertLegacyThoughtRefProperty(
  ndb: NetworkDb,
  prop: EtnxManifestProperty,
  actorUserId: string,
  now: string,
): NetworkProperty {
  const linkTypeId = upsertUpdLinkType(ndb, prop.name, actorUserId, now);
  const oldCfg = (prop.config ?? {}) as Record<string, unknown>;
  const config: Record<string, unknown> = {
    link_type_id: linkTypeId,
    direction: 'out',
    show_on_map: false,
    blocks_target_deletion: true,
  };
  const allowed = Array.isArray(oldCfg['allowed_type_ids'])
    ? (oldCfg['allowed_type_ids'] as unknown[]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      )
    : typeof oldCfg['allowed_type_id'] === 'string' && oldCfg['allowed_type_id'] !== ''
      ? [oldCfg['allowed_type_id'] as string]
      : [];
  if (allowed.length > 0) config['allowed_target_type_ids'] = allowed;
  if (oldCfg['multiple'] === true) config['multiple'] = true;
  return { ...prop, value_type: 'link', config: config as NetworkProperty['config'] };
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
 *
 * Legacy `thought_ref` properties (pre-0.8.1 archives) are converted to link
 * properties on the fly (ADR «вид значения thought_ref упраздняется»): the
 * manifest id is recorded in `legacyRefProps` so the value phase materialises
 * edges instead of `property_values` rows.
 */
function insertProperty(
  ndb: NetworkDb,
  prop: EtnxManifestProperty,
  remap: Map<string, string>,
  legacyRefProps: Set<string>,
  actorUserId: string,
  now: string,
): string {
  const effective =
    prop.value_type === 'thought_ref'
      ? convertLegacyThoughtRefProperty(ndb, prop, actorUserId, now)
      : prop;
  if (prop.value_type === 'thought_ref') legacyRefProps.add(prop.id);
  prop = effective;
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
  // 0.10.1: архив несёт полные UTC-инстансы, но старые/внешние .etnx могут
  // содержать «голую дату» или пустое окончание хронологической — приводим
  // их к конвенции записи, иначе импорт нарушил бы инвариант хранилища.
  const validFrom = normaliseInstant(c.valid_from, 'valid_from', 'start') ?? c.created_at;
  const validTo =
    c.kind === 'permanent'
      ? null
      : (normaliseInstant(c.valid_to, 'valid_to', 'end') ?? validFrom);
  const useTime = c.use_time === true ? 1 : 0;
  if (c.kind === 'permanent') {
    const existing = ndb
      .prepare(
        "SELECT id FROM comments_v WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'",
      )
      .get(resolvedOwnerId) as { id: string } | undefined;
    if (existing !== undefined) {
      ndb
        .prepare(
          `UPDATE comments SET title = ?, body_md = ?, body_html = ?, use_time = ?, version = version + 1,
             updated_at = ?, updated_by = ? WHERE id = ?`,
        )
        .run(c.title, c.body_md, c.body_html, useTime, now, actorUserId, existing.id);
      return 'updated';
    }
    ndb
      .prepare(
        `INSERT OR IGNORE INTO comments (
           id, owner_type, owner_id, kind, title, body_md, body_html,
           valid_from, valid_to, use_time, version, created_at, created_by,
           updated_at, updated_by
         ) VALUES (?, 'thought', ?, 'permanent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        resolvedOwnerId,
        c.title,
        c.body_md,
        c.body_html,
        validFrom,
        validTo,
        useTime,
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
         valid_from, valid_to, use_time, version, created_at, created_by,
         updated_at, updated_by
       ) VALUES (?, 'thought', ?, 'chronological', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      resolvedOwnerId,
      c.title,
      c.body_md,
      c.body_html,
      validFrom,
      validTo,
      useTime,
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
 * definition's value_type. Falls back to `value_text` when the runtime
 * value does not match the declared type — preserves data round-tripping
 * across versions even when the source type was renamed.
 *
 * The row id is recomputed deterministically from the RESOLVED natural key
 * (bug dc119240): the archive's own `pv.id` was minted against the SOURCE
 * network's owner/property ids and can differ after remapping, which would
 * reintroduce the random-id divergence this id scheme exists to prevent.
 * Nothing ever references a `property_values` id, so replacing it is safe.
 */
function insertPropertyValue(
  ndb: NetworkDb,
  pv: PropertyValue,
  resolvedOwnerId: string,
): void {
  const value: PropertyValueValue = pv.value;
  const column = columnFor(value);
  const raw = coerce(value);
  const id = propertyValueId(pv.owner_type, resolvedOwnerId, pv.property_id);
  ndb
    .prepare(
      `INSERT INTO property_values (
         id, owner_type, owner_id, property_id,
         value_text, value_date, value_number, value_bool,
         updated_at
       ) VALUES (?, ?, ?, ?, ${colInit(column)}, ?)
       ON CONFLICT(owner_type, owner_id, property_id, layer_id) DO UPDATE SET
         value_text = NULL,
         value_date = NULL,
         value_number = NULL,
         value_bool = NULL,
         ${colSet(column)},
         updated_at = excluded.updated_at`,
    )
    .run(
      id,
      pv.owner_type,
      resolvedOwnerId,
      pv.property_id,
      ...colArgs(column, raw),
      pv.updated_at,
    );
}

/** Map a property value to its canonical storage column. Множественные
 *  `url`-значения (JSON-массив строк) лежат в `value_text`, как и в
 *  рантайме (02-data-model.md §3.5); легаси thought_ref-массивы сюда не
 *  доходят — они материализуются рёбрами до insertPropertyValue. */
function columnFor(
  value: PropertyValueValue,
): 'value_text' | 'value_number' | 'value_bool' {
  if (typeof value === 'number') return 'value_number';
  if (typeof value === 'boolean') return 'value_bool';
  return 'value_text';
}

/** Convert a property value to the SQL-friendly representation for its column. */
function coerce(value: PropertyValueValue): string | number | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

/** SQL fragment for the value_* slots of the INSERT clause — the chosen
 * column's placeholder stands in its own position, the rest are NULL. */
function colInit(column: string): string {
  if (column === 'value_text') return '?, NULL, NULL, NULL';
  if (column === 'value_number') return 'NULL, NULL, ?, NULL';
  return 'NULL, NULL, NULL, ?';
}

/** SQL fragment for the UPDATE clause (same idea, but written with `excluded.`). */
function colSet(column: string): string {
  if (column === 'value_text') return 'value_text = excluded.value_text';
  if (column === 'value_number') return 'value_number = excluded.value_number';
  return 'value_bool = excluded.value_bool';
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
  // Схема `attachments` (009 + 015 + 025 + 033) не имеет колонки `updated_at`
  // (только `created_at` + пара `updated_by` / `*_ms`). Пишем существующие
  // колонки — как в каноническом INSERT `attachment-service.ts` (ошибка
  // af6ebdea).
  const nowMs = Date.parse(now);
  const createdMs = Date.parse(a.created_at);
  ndb
    .prepare(
      `INSERT OR IGNORE INTO attachments (
         id, owner_type, owner_id, kind, url, file_path, file_size,
         mime_type, title, description, icon, position,
         created_at, created_by, updated_by, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      actorUserId,
      Number.isNaN(createdMs) ? nowMs : createdMs,
      nowMs,
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
// Публикации и полки (0.11.1, задача 950e0a59; требование de697045)
// ---------------------------------------------------------------------------

/**
 * Идемпотентный upsert публикации по `id` (требование de697045). Все поля
 * карточки переносятся как есть: `title_recipe`/`text_sources`/
 * `extra_properties` — из JSON-полей DTO в JSON-текст хранилища; рецепты,
 * адресующие мысли, отсутствующие в срезе, остаются как есть и просто
 * возвращают пустой результат (данные не теряются). `cover_kind` — вычисляемое
 * поле DTO, не хранится и игнорируется. Аудит-поля (`created_*`/`updated_*`) и
 * `version` берутся из манифеста — иначе повторный экспорт не совпал бы с
 * исходным, а повторный импорт не был бы тождественным (DoD: раунд-трип
 * «идентично»). Существующая публикация обновляется, новая вставляется с тем
 * же `id`.
 */
function upsertPublication(ndb: NetworkDb, p: Publication): 'created' | 'updated' {
  const titleRecipe = p.title_recipe === null ? null : JSON.stringify(p.title_recipe);
  const textSources = JSON.stringify(p.text_sources ?? []);
  const extraProperties = JSON.stringify(p.extra_properties ?? []);
  const existing = ndb.prepare('SELECT 1 FROM publications_v WHERE id = ? LIMIT 1').get(p.id);
  if (existing !== undefined) {
    ndb
      .prepare(
        `UPDATE publications SET
           title = ?, subtitle = ?, summary_md = ?, authorship = ?,
           cover_attachment_id = ?, cover_url = ?, assembly_date = ?, title_recipe = ?,
           text_sources = ?, extra_properties = ?, numbering_from = ?, numbering_to = ?,
           active = ?, marked_for_deletion = ?, marked_for_deletion_at = ?,
           marked_for_deletion_by = ?, version = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
      )
      .run(
        p.title,
        p.subtitle,
        p.summary_md,
        p.authorship,
        p.cover_attachment_id,
        p.cover_url,
        p.assembly_date,
        titleRecipe,
        textSources,
        extraProperties,
        p.numbering_from,
        p.numbering_to,
        p.active ? 1 : 0,
        p.marked_for_deletion ? 1 : 0,
        p.marked_for_deletion_at,
        p.marked_for_deletion_by,
        p.version,
        p.updated_at,
        p.updated_by,
        p.id,
      );
    return 'updated';
  }
  ndb
    .prepare(
      `INSERT INTO publications (
         id, title, subtitle, summary_md, authorship, cover_attachment_id, cover_url,
         assembly_date, title_recipe, text_sources, extra_properties,
         numbering_from, numbering_to, active, marked_for_deletion,
         marked_for_deletion_at, marked_for_deletion_by, version,
         created_at, created_by, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.id,
      p.title,
      p.subtitle,
      p.summary_md,
      p.authorship,
      p.cover_attachment_id,
      p.cover_url,
      p.assembly_date,
      titleRecipe,
      textSources,
      extraProperties,
      p.numbering_from,
      p.numbering_to,
      p.active ? 1 : 0,
      p.marked_for_deletion ? 1 : 0,
      p.marked_for_deletion_at,
      p.marked_for_deletion_by,
      p.version,
      p.created_at,
      p.created_by,
      p.updated_at,
      p.updated_by,
    );
  return 'created';
}

/**
 * Идемпотентный upsert поузлового порядка: `id` детерминирован от
 * `(publication_id, node_key)` (db/publication-id.ts) — надгробие той же
 * поузловой строки оживляется (`deleted = 0`), как в домене.
 */
function upsertPublicationOrder(
  ndb: NetworkDb,
  row: EtnxPublicationOrder,
  actorUserId: string,
  now: string,
): void {
  const id = publicationOrderId(row.publication_id, row.node_key);
  ndb
    .prepare(
      `INSERT INTO publication_order (id, publication_id, node_key, position, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, layer_id) DO UPDATE SET
         position = excluded.position, deleted = 0,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(id, row.publication_id, row.node_key, row.position, now, actorUserId);
}

/** Идемпотентный upsert исключения мысли из публикации (детерминированный id). */
function upsertPublicationExclusion(
  ndb: NetworkDb,
  row: EtnxPublicationExclusion,
  thoughtId: string,
  actorUserId: string,
): void {
  const id = publicationExclusionId(row.publication_id, thoughtId);
  ndb
    .prepare(
      `INSERT INTO publication_exclusions (id, publication_id, thought_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id, layer_id) DO UPDATE SET deleted = 0`,
    )
    .run(id, row.publication_id, thoughtId, row.created_at, row.created_by || actorUserId);
}

/**
 * Идемпотентный upsert полки по `id`. Аудит-поля и `version` — из манифеста
 * (тождественность повторного экспорта/импорта, как у публикаций).
 */
function upsertShelf(ndb: NetworkDb, row: EtnxShelf): 'created' | 'updated' {
  const existing = ndb.prepare('SELECT 1 FROM shelves_v WHERE id = ? LIMIT 1').get(row.id);
  if (existing !== undefined) {
    ndb
      .prepare(
        `UPDATE shelves SET title = ?, title_key = ?, position = ?, version = ?,
           updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .run(
        row.title,
        normalizeTitle(row.title),
        row.position,
        row.version,
        row.updated_at,
        row.updated_by,
        row.id,
      );
    return 'updated';
  }
  ndb
    .prepare(
      `INSERT INTO shelves (id, title, title_key, position, version,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.title,
      normalizeTitle(row.title),
      row.position,
      row.version,
      row.created_at,
      row.created_by,
      row.updated_at,
      row.updated_by,
    );
  return 'created';
}

/** Идемпотентный upsert элемента состава полки (детерминированный id). */
function upsertShelfItem(ndb: NetworkDb, row: EtnxShelfItem): void {
  const id = shelfItemId(row.shelf_id, row.publication_id);
  ndb
    .prepare(
      `INSERT INTO shelf_items (id, shelf_id, publication_id, position)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id, layer_id) DO UPDATE SET position = excluded.position, deleted = 0`,
    )
    .run(id, row.shelf_id, row.publication_id, row.position);
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
  try {
    const { manifest, attachments } = await readArchive(zipBuffer, logger);
    return applyManifest(ndb, manifest, attachments, opts, logger);
  } catch (err) {
    // Любой сбой импорта (битый zip, несовпадение схемы, отказ политики)
    // предъявляем агенту как ETN-ошибку с кодом, а не сырым «Unexpected
    // error» (ошибка af6ebdea). EtnError (в т.ч. VALIDATION_ERROR политики
    // `fail`) пробрасываем без изменений.
    if (err instanceof EtnError) throw err;
    logger.error({ err }, 'import: unexpected failure');
    throw new EtnError('INTERNAL', 'Не удалось применить .etnx-архив.', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Прочитать манифест из .etnx-буфера, не применяя его (для `dry_run`). */
export async function readManifestFromBuffer(
  zipBuffer: Buffer,
  logger: Logger,
): Promise<EtnxManifest> {
  const { manifest } = await readArchive(zipBuffer, logger);
  return manifest;
}

/** План импорта мыслей с учётом `collision_policy` — для превью `dry_run`. */
export interface ImportThoughtPlan {
  thoughts_to_create: number;
  thoughts_to_reuse: number;
  thoughts_to_skip: number;
  /**
   * `true`, когда политика `fail` и есть конфликты: импорт будет ОТВЕРГНУТ
   * целиком (ничего не создастся, не переиспользуется и не пропустится).
   * Отличает отказ `fail` от реального пропуска `skip` (мелкий дефект
   * превью, 0.8.3).
   */
  rejected: boolean;
  conflicts: ImportConflict[];
}

/**
 * Отражают ли план `overwrite`/`fail`-без-конфликтов обновление существующей
 * мысли, `fail`-с-конфликтами — полный отказ (`rejected: true`, счётчики
 * нулевые), `skip` — пропуск, `rename` — создание новой. Используется
 * `etn.import.dry_run`, чтобы превью совпадало с фактическим поведением
 * `importFromEtnx` (ошибки ebe93450, 0.8.3).
 */
export function planImportThoughts(
  ndb: NetworkDb,
  manifest: EtnxManifest,
  policy: ImportCollisionPolicy,
): ImportThoughtPlan {
  const conflicts = findImportConflicts(ndb, manifest);
  const total = manifest.thoughts.length;
  if (policy === 'fail' && conflicts.length > 0) {
    // `fail` отвергает весь импорт — превью не должно показывать это как
    // «пропуск» (`skip`): счётчики нулевые, отказ — в `rejected` + `conflicts`.
    return {
      thoughts_to_create: 0,
      thoughts_to_reuse: 0,
      thoughts_to_skip: 0,
      rejected: true,
      conflicts,
    };
  }
  if (policy === 'skip') {
    const skipped = computeSkippedThoughtIds(ndb, manifest);
    return {
      thoughts_to_create: total - skipped.size,
      thoughts_to_reuse: 0,
      thoughts_to_skip: skipped.size,
      rejected: false,
      conflicts,
    };
  }
  if (policy === 'rename') {
    return {
      thoughts_to_create: total,
      thoughts_to_reuse: 0,
      thoughts_to_skip: 0,
      rejected: false,
      conflicts,
    };
  }
  // `overwrite` (по умолчанию) и `fail` без конфликтов: существующая мысль
  // обновляется/переиспользуется, новые создаются.
  return {
    thoughts_to_create: total - conflicts.length,
    thoughts_to_reuse: conflicts.length,
    thoughts_to_skip: 0,
    rejected: false,
    conflicts,
  };
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
      thoughts_skipped: 0,
      links_created: 0,
      permanent_comments_updated: 0,
      chronological_comments_added: 0,
      property_values_set: 0,
      attachments_imported: 0,
      publications_created: 0,
      publications_updated: 0,
      shelves_created: 0,
      shelves_updated: 0,
      manifest_version: manifest.version,
    };
    const thoughtIdRemap = new Map<string, string>();
    const typeIdRemap = new Map<string, string>();
    const linkTypeIdRemap = new Map<string, string>();
    const propertyIdRemap = new Map<string, string>();
    /** Manifest property ids, конвертированные из легаси `thought_ref` (0.8.1):
     *  их значения материализуются рёбрами, а не строками property_values. */
    const legacyRefProps = new Set<string>();
    const createdThoughtIds: string[] = [];
    const createdLinkIds: string[] = [];
    const updatedCommentIds: string[] = [];

    // 1. Thought types ------------------------------------------------------
    if (includeTypes) {
      // Проход 1: вставка типов и построение remap (id манифеста → выживший
      // id целевой сети). Счётчики — по фактической вставке (`changes`),
      // иначе отчёт врёт (ошибка e7d1b27a). Тип, слитый по имени, попадает в
      // remap под чужим id — мысли и привязки резолвятся через него.
      const createdThoughtTypeIds = new Set<string>();
      for (const t of manifest.thought_types) {
        const { created } = insertThoughtType(ndb, t);
        const survivingId = created ? t.id : resolveThoughtTypeId(ndb, t);
        typeIdRemap.set(t.id, survivingId);
        if (created) {
          createdThoughtTypeIds.add(t.id);
          summary.thought_types_created += 1;
        } else {
          summary.thought_types_reused += 1;
        }
      }
      // Проход 2: иерархия созданных типов — родитель резолвится через remap
      // (родитель может быть слит по имени) с фолбэком на корень целевой
      // сети, если родителя нет ни в манифесте, ни в цели.
      for (const t of manifest.thought_types) {
        if (!createdThoughtTypeIds.has(t.id)) continue;
        const survivingId = typeIdRemap.get(t.id) ?? t.id;
        const parentId =
          t.parent_id === null ? null : typeIdRemap.get(t.parent_id) ?? t.parent_id;
        setThoughtTypeParent(ndb, survivingId, parentId);
      }

      // 2. Link types ---------------------------------------------------------
      const createdLinkTypeIds = new Set<string>();
      for (const t of manifest.link_types) {
        const { created } = insertLinkType(ndb, t);
        const survivingId = created ? t.id : resolveLinkTypeId(ndb, t);
        linkTypeIdRemap.set(t.id, survivingId);
        if (created) {
          createdLinkTypeIds.add(t.id);
          summary.link_types_created += 1;
        } else {
          summary.link_types_reused += 1;
        }
      }
      for (const t of manifest.link_types) {
        if (!createdLinkTypeIds.has(t.id)) continue;
        const survivingId = linkTypeIdRemap.get(t.id) ?? t.id;
        const parentId =
          t.parent_id === null ? null : linkTypeIdRemap.get(t.parent_id) ?? t.parent_id;
        setLinkTypeParent(ndb, survivingId, parentId);
      }

      // 3. Property registry (0.6.5) ----------------------------------------
      // Insert every registry property by NAME first so subsequent bindings
      // and values resolve through `propertyIdRemap`. Manifest ids are not
      // authoritative — a same-named row already in the target wins, and the
      // remap carries the surviving id. Легаси `thought_ref`-свойства (архивы
      // до 0.8.1) конвертируются в свойства-связи, их значения фазой 8
      // материализуются рёбрами.
      for (const prop of manifest.properties) {
        const inserted = insertProperty(
          ndb,
          prop,
          propertyIdRemap,
          legacyRefProps,
          opts.actorUserId,
          now,
        );
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
    const policy: ImportCollisionPolicy = opts.collisionPolicy ?? 'overwrite';
    const incomingIds = manifest.thoughts.map((t) => t.id);
    const existingById = readExistingThoughtIds(ndb, incomingIds);
    const titleNorms = Array.from(new Set(manifest.thoughts.map((t) => normalizeTitle(t.title))));
    const existingByTitle = readExistingThoughtsByTitle(ndb, titleNorms);

    // `fail` — любая коллизия отвергает импорт целиком; проверяем до записей
    // (транзакция откатит уже вставленные типы/свойства).
    if (policy === 'fail') {
      const conflicts = findImportConflicts(ndb, manifest);
      if (conflicts.length > 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `Импорт конфликтует с существующими мыслями целевой сети (${conflicts.length}).`,
          { conflicts },
        );
      }
    }

    // `skip` — конфликтующая мысль и весь её подграф не импортируются
    // (id не попадает в remap, потомки по рёбрам манифеста — тоже).
    const skippedIds =
      policy === 'skip' ? computeSkippedThoughtIds(ndb, manifest) : new Set<string>();

    const titleMatchIds = new Set<string>();
    for (const t of manifest.thoughts) {
      const resolvedTypeId =
        t.type_id === null ? null : typeIdRemap.get(t.type_id) ?? t.type_id;
      const normTitle = normalizeTitle(t.title);
      const idConflict = existingById.has(t.id);
      const titleConflict =
        !idConflict && existingByTitle.has(normTitle) && !titleMatchIds.has(normTitle);

      // `skip` — конфликтующая мысль и её подграф не импортируются.
      if (policy === 'skip' && skippedIds.has(t.id)) {
        summary.thoughts_skipped = (summary.thoughts_skipped ?? 0) + 1;
        continue;
      }
      // `rename` — создаём новую мысль с уникальным title, существующую не трогаем.
      if (policy === 'rename' && (idConflict || titleConflict)) {
        const renamed = uniqueImportedTitle(ndb, t.title);
        const r = createThoughtForTitleMatch(
          ndb,
          { ...t, title: renamed },
          resolvedTypeId,
          opts.actorUserId,
          now,
        );
        thoughtIdRemap.set(t.id, r.id);
        createdThoughtIds.push(r.id);
        summary.thoughts_created += 1;
        continue;
      }

      if (idConflict) {
        const r = insertOrUpdateThought(ndb, t, resolvedTypeId, opts.actorUserId, now);
        thoughtIdRemap.set(t.id, r.id);
        if (r.action === 'updated') summary.thoughts_updated += 1;
        else summary.thoughts_reused += 1;
        continue;
      }
      // (Title-match path below creates new thoughts too — both go into createdThoughtIds)
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
      // Легаси `thought_ref`-значение (архив до 0.8.1): свойство уже
      // сконвертировано в свойство-связь — материализуем ребро (зеркало
      // миграции 040). Нерезолвнутые цели молча пропускаются.
      if (legacyRefProps.has(pv.property_id)) {
        const linkTypeId = readLinkPropertyTypeId(ndb, resolvedPropertyId);
        if (linkTypeId === null) continue;
        const targets = Array.isArray(pv.value)
          ? pv.value.filter((v): v is string => typeof v === 'string' && v !== '')
          : typeof pv.value === 'string' && pv.value !== ''
            ? [pv.value]
            : [];
        let position = 0;
        for (const targetId of targets) {
          const resolvedTargetId = thoughtIdRemap.get(targetId) ?? targetId;
          const exists = ndb
            .prepare('SELECT 1 FROM thoughts_v WHERE id = ? AND deleted = 0 LIMIT 1')
            .get(resolvedTargetId);
          if (exists === undefined) continue;
          const result = ndb
            .prepare(
              `INSERT OR IGNORE INTO links (
                 id, source_id, target_id, type_id, position, active, version,
                 created_at, updated_at, created_by, updated_by
               ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              resolvedOwnerId,
              resolvedTargetId,
              linkTypeId,
              position,
              now,
              now,
              opts.actorUserId,
              opts.actorUserId,
            );
          if (result.changes > 0) {
            summary.links_created += 1;
            position += 1;
          }
        }
        continue;
      }
      insertPropertyValue(
        ndb,
        { ...pv, property_id: resolvedPropertyId },
        resolvedOwnerId,
      );
      summary.property_values_set += 1;
    }

    // 8b. Публикации и полки (0.11.1, задача 950e0a59, требование de697045) --
    // Формат 1.2 добавляет секции publications/publication_order/
    // publication_exclusions/shelves/shelf_items. Манифест 1.1 их не несёт —
    // секции читаются как пустые (обратная совместимость). Публикации и полки
    // импортируются идемпотентным upsert по `id`; строки-детали получают
    // детерминированный id от естественного ключа и оживляют надгробие.
    const importedPublicationIds = new Set<string>();
    for (const p of manifest.publications ?? []) {
      const action = upsertPublication(ndb, p);
      importedPublicationIds.add(p.id);
      if (action === 'created') summary.publications_created = (summary.publications_created ?? 0) + 1;
      else summary.publications_updated = (summary.publications_updated ?? 0) + 1;
    }
    for (const row of manifest.publication_order ?? []) {
      if (!importedPublicationIds.has(row.publication_id)) continue;
      // `node_key` — либо id ребра вхождения (рёбра сохраняют id), либо id
      // мысли-корня (мысли при импорте получают новый id). Remap через
      // thoughtIdRemap следует за мыслью; id ребра проходит без изменений.
      const nodeKey = thoughtIdRemap.get(row.node_key) ?? row.node_key;
      upsertPublicationOrder(ndb, { ...row, node_key: nodeKey }, opts.actorUserId, now);
    }
    for (const row of manifest.publication_exclusions ?? []) {
      if (!importedPublicationIds.has(row.publication_id)) continue;
      // Исключение следует за мыслью через remap импорта; мысль, отсутствующая
      // в срезе, не теряет строку — исключение остаётся с исходным id.
      const thoughtId = thoughtIdRemap.get(row.thought_id) ?? row.thought_id;
      upsertPublicationExclusion(ndb, row, thoughtId, opts.actorUserId);
    }
    const importedShelfIds = new Set<string>();
    for (const row of manifest.shelves ?? []) {
      const action = upsertShelf(ndb, row);
      importedShelfIds.add(row.id);
      if (action === 'created') summary.shelves_created = (summary.shelves_created ?? 0) + 1;
      else summary.shelves_updated = (summary.shelves_updated ?? 0) + 1;
    }
    for (const row of manifest.shelf_items ?? []) {
      // Состав полки имеет смысл, только когда есть и полка, и публикация.
      if (!importedShelfIds.has(row.shelf_id) || !importedPublicationIds.has(row.publication_id)) {
        continue;
      }
      upsertShelfItem(ndb, row);
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
        // Владелец вложения: мысль резолвится через remap импорта; публикация
        // (строка-вложение-обложка, owner_type='publication') сохраняет свой id
        // и должна быть импортирована этим же архивом.
        const resolvedOwnerId =
          a.owner_type === 'publication' && importedPublicationIds.has(a.owner_id)
            ? a.owner_id
            : a.owner_type === 'thought'
              ? thoughtIdRemap.get(a.owner_id)
              : undefined;
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
