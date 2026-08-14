/**
 * Thought-type domain service (task C5, docs/03-server-api.md §8).
 *
 * CRUD over `thought_types` plus the protective deletion rule: a type that is
 * still in use can only be removed with `force`, which nulls `type_id` on the
 * affected thoughts first (docs/03-server-api.md §8). Property definitions of a
 * type are managed through {@link './property-service.js'} (`owner_type =
 * 'thought_type'`); this module re-exports nothing for them — callers use the
 * property service directly with the type id.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  type IconKind,
  type ThoughtType,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Raw `thought_types` row (INTEGER booleans, may be NULL for font_*). */
interface ThoughtTypeRow {
  id: string;
  name: string;
  icon: string | null;
  icon_kind: string;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: number | null;
  font_italic: number | null;
  font_underline: number | null;
  font_strike: number | null;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** Convert a raw row into a {@link ThoughtType}. */
function rowToThoughtType(row: ThoughtTypeRow): ThoughtType {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    icon_kind: row.icon_kind as IconKind,
    fg_color: row.fg_color,
    bg_color: row.bg_color,
    font_bold: row.font_bold === 1,
    font_italic: row.font_italic === 1,
    font_underline: row.font_underline === 1,
    font_strike: row.font_strike === 1,
    description: row.description,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

/** Validate a type name: non-empty string. */
function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'name must be a non-empty string', { field: 'name' });
  }
  return name.trim();
}

/** Return a thought type by id, or `null` when absent. */
export function getThoughtType(ndb: NetworkDb, id: string): ThoughtType | null {
  const row = ndb.prepare('SELECT * FROM thought_types WHERE id = ?').get(id) as
    ThoughtTypeRow | undefined;
  return row ? rowToThoughtType(row) : null;
}

function getThoughtTypeOrThrow(ndb: NetworkDb, id: string): ThoughtType {
  const tt = getThoughtType(ndb, id);
  if (!tt) {
    throw new EtnError('NOT_FOUND', `thought type ${id} not found`, {
      entity: 'thought_type',
      id,
    });
  }
  return tt;
}

/** List all thought types, ordered by name. */
export function listThoughtTypes(ndb: NetworkDb): ThoughtType[] {
  const rows = ndb.prepare('SELECT * FROM thought_types ORDER BY name').all() as ThoughtTypeRow[];
  return rows.map(rowToThoughtType);
}

/**
 * Create a thought type (docs/03-server-api.md §8). The `description` field is
 * persisted verbatim so AI agents can read type context (§8).
 *
 * Throws `DUPLICATE` (409) if a type with the same name already exists.
 */
export function createThoughtType(
  ndb: NetworkDb,
  input: ThoughtTypeInput,
  actorUserId: string,
): ThoughtType {
  const name = validateName(input.name);
  const id = randomUUID();
  const now = new Date().toISOString();

  return ndb.transaction(() => {
    const existing = ndb.prepare('SELECT 1 FROM thought_types WHERE name = ?').get(name);
    if (existing) {
      throw new EtnError('DUPLICATE', `thought type "${name}" already exists`, { name });
    }
    ndb
      .prepare(
        `INSERT INTO thought_types (id, name, icon, icon_kind, fg_color, bg_color,
                                     font_bold, font_italic, font_underline, font_strike,
                                     description, version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.icon ?? null,
        input.icon_kind ?? 'emoji',
        input.fg_color ?? null,
        input.bg_color ?? null,
        input.font_bold ? 1 : null,
        input.font_italic ? 1 : null,
        input.font_underline ? 1 : null,
        input.font_strike ? 1 : null,
        input.description ?? null,
        now,
        now,
        actorUserId,
      );
    return getThoughtTypeOrThrow(ndb, id);
  });
}

/**
 * Patch a thought type (docs/03-server-api.md §8). Last-write-wins per field;
 * `version` is bumped on every successful update.
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), or `DUPLICATE` (409) when
 * renaming to an existing name.
 */
export function updateThoughtType(
  ndb: NetworkDb,
  id: string,
  changes: ThoughtTypeUpdateInput,
  expectedVersion: number | undefined,
): ThoughtType {
  return ndb.transaction(() => {
    const current = getThoughtTypeOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'thought type version mismatch', {
        entity: 'thought_type',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (changes.name !== undefined) {
      const newName = validateName(changes.name);
      if (newName !== current.name) {
        const clash = ndb
          .prepare('SELECT 1 FROM thought_types WHERE name = ? AND id <> ?')
          .get(newName, id);
        if (clash) {
          throw new EtnError('DUPLICATE', `thought type "${newName}" already exists`, {
            name: newName,
          });
        }
      }
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    const optStr = (v: string | null | undefined, col: string) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v ?? null);
      }
    };
    optStr(changes.name, 'name');
    optStr(changes.icon, 'icon');
    optStr(changes.icon_kind, 'icon_kind');
    optStr(changes.fg_color, 'fg_color');
    optStr(changes.bg_color, 'bg_color');
    optStr(changes.description, 'description');
    const optFont = (v: boolean | undefined, col: string) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v ? 1 : null);
      }
    };
    optFont(changes.font_bold, 'font_bold');
    optFont(changes.font_italic, 'font_italic');
    optFont(changes.font_underline, 'font_underline');
    optFont(changes.font_strike, 'font_strike');

    const now = new Date().toISOString();
    sets.push('version = ?', 'updated_at = ?');
    args.push(current.version + 1, now);
    args.push(id);
    ndb.prepare(`UPDATE thought_types SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getThoughtTypeOrThrow(ndb, id);
  });
}

/** Options for {@link deleteThoughtType}. */
export interface DeleteThoughtTypeOptions {
  /** When true, null `type_id` on thoughts of this type before deleting it. */
  force?: boolean;
  /** User performing the delete (recorded on the nulling update). */
  actorUserId?: string;
}

/**
 * Delete a thought type (docs/03-server-api.md §8).
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the type does not exist;
 *   * `VERSION_CONFLICT` (409) if `expectedVersion` is set and does not match;
 *   * `VALIDATION_ERROR` (422) if thoughts still reference the type and `force`
 *     is not set. With `force`, those thoughts' `type_id` is set to NULL (and
 *     their `updated_at`/`updated_by` refreshed) before the type row is removed.
 *
 * The type's property definitions are deleted along with it; stored values
 * cascade via the `property_values.property_id` FK (ON DELETE CASCADE).
 */
export function deleteThoughtType(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
  opts: DeleteThoughtTypeOptions = {},
): void {
  ndb.transaction(() => {
    const current = getThoughtTypeOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'thought type version mismatch', {
        entity: 'thought_type',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    const usage = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE type_id = ?').get(id) as {
      c: number;
    };
    if (usage.c > 0 && !opts.force) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `thought type is in use by ${usage.c} thought(s); pass force=1 to detach them`,
        { entity: 'thought_type', id, in_use: usage.c },
      );
    }
    if (usage.c > 0) {
      const now = new Date().toISOString();
      ndb
        .prepare(
          'UPDATE thoughts SET type_id = NULL, updated_at = ?, updated_by = ? WHERE type_id = ?',
        )
        .run(now, opts.actorUserId ?? 'system', id);
    }
    ndb
      .prepare("DELETE FROM type_properties WHERE owner_type = 'thought_type' AND owner_id = ?")
      .run(id);
    ndb.prepare('DELETE FROM thought_types WHERE id = ?').run(id);
  });
}
