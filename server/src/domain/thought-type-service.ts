/**
 * Thought-type domain service (task C5, docs/03-server-api.md §8; hierarchy —
 * L21, docs/02-data-model.md §3.3).
 *
 * CRUD over `thought_types` plus the protective deletion rule: a type that is
 * still in use can only be removed with `force`, which nulls `type_id` on the
 * affected thoughts first (docs/03-server-api.md §8). Property definitions of a
 * type are managed through {@link './property-service.js'} (`owner_type =
 * 'thought_type'`); this module re-exports nothing for them — callers use the
 * property service directly with the type id.
 *
 * Hierarchy rules (L21): types form a tree under the undeletable root
 * «основной тип»; nesting is capped at {@link MAX_TYPE_DEPTH} levels; a type
 * used by thoughts cannot be reparented; a type with child types cannot be
 * deleted; the root type is never deletable and never assignable to thoughts.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  typeNameKey,
  type IconKind,
  type ThoughtType,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  assertParentValid,
  getRootTypeId,
  typeAncestors,
} from './type-hierarchy.js';

/** Raw `thought_types` row (INTEGER booleans, may be NULL for font_*). */
interface ThoughtTypeRow {
  id: string;
  name: string;
  parent_id: string | null;
  is_root: number;
  icon: string | null;
  icon_kind: string;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: number | null;
  font_italic: number | null;
  font_underline: number | null;
  font_strike: number | null;
  description: string | null;
  comment_template_md: string | null;
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
    parent_id: row.parent_id,
    is_root: row.is_root === 1,
    icon: row.icon,
    icon_kind: row.icon_kind as IconKind,
    fg_color: row.fg_color,
    bg_color: row.bg_color,
    // NULL = «not set on this type» — the parent chain supplies the value
    // (L21), so the DTO keeps the null distinction for font styles.
    font_bold: row.font_bold === null ? null : row.font_bold === 1,
    font_italic: row.font_italic === null ? null : row.font_italic === 1,
    font_underline: row.font_underline === null ? null : row.font_underline === 1,
    font_strike: row.font_strike === null ? null : row.font_strike === 1,
    description: row.description,
    comment_template_md: row.comment_template_md,
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

/** Resolve the input's parent to a concrete id: `null` means «under the root». */
function resolveParentId(ndb: NetworkDb, parentId: string | null | undefined): string | null {
  if (parentId === undefined || parentId === null) {
    // «Очистка родителя» equals attaching the type directly under the root.
    return getRootTypeId(ndb, 'thought_types');
  }
  return parentId;
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

/** The undeletable root thought type («основной тип»); `null` mid-migration. */
export function getRootThoughtType(ndb: NetworkDb): ThoughtType | null {
  const rootId = getRootTypeId(ndb, 'thought_types');
  return rootId === null ? null : getThoughtType(ndb, rootId);
}

/** List all thought types, ordered by name. */
export function listThoughtTypes(ndb: NetworkDb): ThoughtType[] {
  const rows = ndb.prepare('SELECT * FROM thought_types ORDER BY name').all() as ThoughtTypeRow[];
  return rows.map(rowToThoughtType);
}

/**
 * Resolve a thought type id by its display name, case-insensitively (task O4,
 * `name_key`, same normalization as the {@link createThoughtType} duplicate
 * check). Throws `NOT_FOUND` when no type matches, `VALIDATION_ERROR` with
 * `details.candidates` when more than one does (defensive — `name_key` is
 * globally unique per the `idx_thought_types_name_key` index, so this should
 * be unreachable in practice).
 */
export function resolveThoughtTypeIdByName(ndb: NetworkDb, name: string): string {
  const key = typeNameKey(name);
  const rows = ndb
    .prepare('SELECT id, name, parent_id FROM thought_types WHERE name_key = ?')
    .all(key) as Array<{ id: string; name: string; parent_id: string | null }>;
  if (rows.length === 0) {
    throw new EtnError('NOT_FOUND', `thought type "${name}" not found`, { field: 'type', name });
  }
  if (rows.length > 1) {
    throw new EtnError('VALIDATION_ERROR', `thought type name "${name}" is ambiguous`, {
      field: 'type',
      name,
      candidates: rows.map((r) => ({ id: r.id, name: r.name, parent_id: r.parent_id })),
    });
  }
  return rows[0]!.id;
}

/**
 * Create a thought type (docs/03-server-api.md §8). The `description` field is
 * persisted verbatim so AI agents can read type context (§8). `parent_id`
 * defaults to the root type; the nesting depth is validated against
 * {@link MAX_TYPE_DEPTH}.
 *
 * Throws `DUPLICATE` (409) if a type with the same name (ignoring case) already
 * exists.
 */
export function createThoughtType(
  ndb: NetworkDb,
  input: ThoughtTypeInput,
  actorUserId: string,
): ThoughtType {
  const name = validateName(input.name);
  const nameKey = typeNameKey(name);
  const id = randomUUID();
  const now = new Date().toISOString();

  return ndb.transaction(() => {
    const existing = ndb.prepare('SELECT 1 FROM thought_types WHERE name_key = ?').get(nameKey);
    if (existing) {
      throw new EtnError('DUPLICATE', `thought type "${name}" already exists`, { name });
    }
    const parentId = resolveParentId(ndb, input.parent_id);
    if (parentId !== null) {
      assertParentValid(ndb, 'thought_types', null, parentId);
    }
    ndb
      .prepare(
        `INSERT INTO thought_types (id, name, name_key, parent_id, is_root,
                                     icon, icon_kind, fg_color, bg_color,
                                     font_bold, font_italic, font_underline, font_strike,
                                     description, comment_template_md,
                                     version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        nameKey,
        parentId,
        input.icon ?? null,
        input.icon_kind ?? 'emoji',
        input.fg_color ?? null,
        input.bg_color ?? null,
        input.font_bold === undefined || input.font_bold === null ? null : input.font_bold ? 1 : 0,
        input.font_italic === undefined || input.font_italic === null
          ? null
          : input.font_italic
            ? 1
            : 0,
        input.font_underline === undefined || input.font_underline === null
          ? null
          : input.font_underline
            ? 1
            : 0,
        input.font_strike === undefined || input.font_strike === null
          ? null
          : input.font_strike
            ? 1
            : 0,
        input.description ?? null,
        input.comment_template_md ?? null,
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
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), `DUPLICATE` (409) when
 * renaming to an existing name, or `VALIDATION_ERROR` (422) when reparenting a
 * type that is still used by thoughts (docs/08-ui-spec.md §8.1) or when the
 * new parent would break the tree (cycle / depth over {@link MAX_TYPE_DEPTH}).
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
    let newName: string | undefined;
    if (changes.name !== undefined) {
      newName = validateName(changes.name);
      if (typeNameKey(newName) !== typeNameKey(current.name)) {
        const clash = ndb
          .prepare('SELECT 1 FROM thought_types WHERE name_key = ? AND id <> ?')
          .get(typeNameKey(newName), id);
        if (clash) {
          throw new EtnError('DUPLICATE', `thought type "${newName}" already exists`, {
            name: newName,
          });
        }
      }
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    if (newName !== undefined) {
      sets.push('name = ?', 'name_key = ?');
      args.push(newName, typeNameKey(newName));
    }
    if (changes.parent_id !== undefined) {
      if (current.is_root) {
        throw new EtnError('VALIDATION_ERROR', 'у корневого типа нет родителя', {
          entity: 'thought_type',
          id,
        });
      }
      const nextParent = resolveParentId(ndb, changes.parent_id);
      if (nextParent !== current.parent_id) {
        // Reparenting is locked while any thought still uses the type
        // (docs/08-ui-spec.md §8.1).
        const usage = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE type_id = ?').get(id) as {
          c: number;
        };
        if (usage.c > 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `родительский тип изменить нельзя: тип используется в ${usage.c} мыслях`,
            { entity: 'thought_type', id, in_use: usage.c },
          );
        }
        if (nextParent !== null) {
          assertParentValid(ndb, 'thought_types', id, nextParent);
        }
        sets.push('parent_id = ?');
        args.push(nextParent);
      }
    }
    const optStr = (v: string | null | undefined, col: string) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v ?? null);
      }
    };
    optStr(changes.icon, 'icon');
    optStr(changes.icon_kind, 'icon_kind');
    optStr(changes.fg_color, 'fg_color');
    optStr(changes.bg_color, 'bg_color');
    optStr(changes.description, 'description');
    optStr(changes.comment_template_md, 'comment_template_md');
    const optFont = (v: boolean | null | undefined, col: string) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v === null ? null : v ? 1 : 0);
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
 *   * `VALIDATION_ERROR` (422) for the root type (undeletable), for a type
 *     with child types (reparent or delete them first), or when thoughts still
 *     reference the type and `force` is not set. With `force`, those thoughts'
 *     `type_id` is set to NULL (and their `updated_at`/`updated_by` refreshed)
 *     before the type row is removed.
 *
 * The type's property definitions are deleted along with it — and, since S2
 * dropped the `property_id` FKs (docs/13-layers.md §3), their stored values and
 * default overrides are removed explicitly in the same transaction. Child
 * types are impossible here (rejected up front), so no orphaned parents remain.
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
    if (current.is_root) {
      throw new EtnError('VALIDATION_ERROR', 'корневой тип мысли удалить нельзя', {
        entity: 'thought_type',
        id,
      });
    }
    const childCount = ndb
      .prepare('SELECT COUNT(*) AS c FROM thought_types WHERE parent_id = ?')
      .get(id) as { c: number };
    if (childCount.c > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `у типа есть подчинённые типы (${childCount.c}); сначала удалите или переместите их`,
        { entity: 'thought_type', id, children: childCount.c },
      );
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
    // The type's property definitions go with it — together with their stored
    // values and default overrides, which had no other SQL path anyway and,
    // since S2, no FK either (docs/13-layers.md §3).
    ndb
      .prepare(
        `DELETE FROM property_values WHERE property_id IN
           (SELECT id FROM type_properties WHERE owner_type = 'thought_type' AND owner_id = ?)`,
      )
      .run(id);
    ndb
      .prepare(
        `DELETE FROM type_property_overrides WHERE property_id IN
           (SELECT id FROM type_properties WHERE owner_type = 'thought_type' AND owner_id = ?)`,
      )
      .run(id);
    ndb
      .prepare("DELETE FROM type_properties WHERE owner_type = 'thought_type' AND owner_id = ?")
      .run(id);
    ndb
      .prepare(
        "DELETE FROM type_property_overrides WHERE owner_type = 'thought_type' AND type_id = ?",
      )
      .run(id);
    ndb.prepare('DELETE FROM thought_types WHERE id = ?').run(id);
  });
}

/**
 * Validate that a `type_id` value may be stored on a thought: the type must
 * exist and must not be the root (the root's settings apply to untyped
 * thoughts implicitly — it is not assignable, docs/08-ui-spec.md §8.1).
 */
export function assertThoughtTypeAssignable(ndb: NetworkDb, typeId: string): void {
  const row = ndb
    .prepare('SELECT is_root FROM thought_types WHERE id = ?')
    .get(typeId) as { is_root: number } | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', `thought type ${typeId} not found`, {
      entity: 'thought_type',
      id: typeId,
    });
  }
  if (row.is_root === 1) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'корневой тип не назначается мыслям; оставьте мысль без типа',
      { entity: 'thought_type', id: typeId },
    );
  }
}

/** Ancestor chain of a thought type, from the type itself up to the root. */
export function thoughtTypeChain(ndb: NetworkDb, typeId: string): string[] {
  return typeAncestors(ndb, 'thought_types', typeId);
}
