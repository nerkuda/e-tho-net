/**
 * Link-type domain service (task C5, docs/03-server-api.md §8; hierarchy —
 * L21, docs/02-data-model.md §3.7).
 *
 * CRUD over `link_types` with the same protective deletion rule as thought
 * types: a type still referenced by links requires `force`, which nulls
 * `type_id` on those links first. Property definitions of a link type are
 * managed through {@link './property-service.js'} with `owner_type =
 * 'link_type'`. The `description` field is persisted for AI-agent context.
 *
 * Hierarchy (L21): link types form a tree under the undeletable root
 * «основной тип»; `style`/`width` are physically NOT NULL, so their
 * inherit-vs-own state lives in the `style_set`/`width_set` flags — the DTO
 * surfaces `style/width = null` when the flag is off («inherit from the
 * parent type»). `color = null` already means «inherit».
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  LINK_STYLES,
  typeNameKey,
  type LinkStyle,
  type LinkType,
  type LinkTypeInput,
  type LinkTypeUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  assertParentValid,
  getRootTypeId,
  MAX_TYPE_DEPTH,
  typeAncestors,
} from './type-hierarchy.js';

/** Raw `link_types` row. */
interface LinkTypeRow {
  id: string;
  name_forward: string;
  name_reverse: string;
  parent_id: string | null;
  is_root: number;
  color: string | null;
  style: string;
  width: number;
  style_set: number;
  width_set: number;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** Convert a raw row into a {@link LinkType}. */
function rowToLinkType(row: LinkTypeRow): LinkType {
  return {
    id: row.id,
    name_forward: row.name_forward,
    name_reverse: row.name_reverse,
    parent_id: row.parent_id,
    is_root: row.is_root === 1,
    color: row.color,
    style: row.style_set === 1 ? (row.style as LinkStyle) : null,
    width: row.width_set === 1 ? row.width : null,
    description: row.description,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

/** Validate a non-empty label (forward/reverse name). */
function validateLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

/** Validate a link style against the accepted enum (`null` — inherit). */
function validateStyle(style: unknown): LinkStyle | null | undefined {
  if (style === undefined) return undefined;
  if (style === null) return null;
  if (typeof style !== 'string' || !(LINK_STYLES as readonly string[]).includes(style)) {
    throw new EtnError('VALIDATION_ERROR', `invalid style: ${String(style)}`, {
      field: 'style',
      allowed: LINK_STYLES,
    });
  }
  return style as LinkStyle;
}

/** Resolve the input's parent to a concrete id: `null` means «under the root». */
function resolveParentId(ndb: NetworkDb, parentId: string | null | undefined): string | null {
  if (parentId === undefined || parentId === null) {
    return getRootTypeId(ndb, 'link_types');
  }
  return parentId;
}

/** Return a link type by id, or `null` when absent. */
export function getLinkType(ndb: NetworkDb, id: string): LinkType | null {
  const row = ndb.prepare('SELECT * FROM link_types WHERE id = ?').get(id) as
    LinkTypeRow | undefined;
  return row ? rowToLinkType(row) : null;
}

function getLinkTypeOrThrow(ndb: NetworkDb, id: string): LinkType {
  const lt = getLinkType(ndb, id);
  if (!lt) {
    throw new EtnError('NOT_FOUND', `link type ${id} not found`, { entity: 'link_type', id });
  }
  return lt;
}

/** The undeletable root link type («основной тип»); `null` mid-migration. */
export function getRootLinkType(ndb: NetworkDb): LinkType | null {
  const rootId = getRootTypeId(ndb, 'link_types');
  return rootId === null ? null : getLinkType(ndb, rootId);
}

/** List all link types, ordered by forward name. */
export function listLinkTypes(ndb: NetworkDb): LinkType[] {
  const rows = ndb.prepare('SELECT * FROM link_types ORDER BY name_forward').all() as LinkTypeRow[];
  return rows.map(rowToLinkType);
}

/**
 * Create a link type (docs/03-server-api.md §8). `parent_id` defaults to the
 * root type; nesting is capped at {@link MAX_TYPE_DEPTH} levels. `style`/
 * `width = null` mean «inherit from the parent type».
 *
 * Throws `DUPLICATE` (409) if a type with the same `(name_forward, name_reverse)`
 * pair (ignoring case) already exists.
 */
export function createLinkType(
  ndb: NetworkDb,
  input: LinkTypeInput,
  actorUserId: string,
): LinkType {
  const nameForward = validateLabel(input.name_forward, 'name_forward');
  const nameReverse = validateLabel(input.name_reverse, 'name_reverse');
  const nameForwardKey = typeNameKey(nameForward);
  const nameReverseKey = typeNameKey(nameReverse);
  const style = validateStyle(input.style) ?? null;
  const id = randomUUID();
  const now = new Date().toISOString();

  return ndb.transaction(() => {
    const existing = ndb
      .prepare(
        'SELECT 1 FROM link_types WHERE name_forward_key = ? AND name_reverse_key = ?',
      )
      .get(nameForwardKey, nameReverseKey);
    if (existing) {
      throw new EtnError('DUPLICATE', 'a link type with these names already exists', {
        name_forward: nameForward,
        name_reverse: nameReverse,
      });
    }
    const parentId = resolveParentId(ndb, input.parent_id);
    if (parentId !== null) {
      assertParentValid(ndb, 'link_types', null, parentId);
    }
    ndb
      .prepare(
        `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                                  parent_id, is_root, color, style, width, style_set, width_set,
                                  description, version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        nameForward,
        nameForwardKey,
        nameReverse,
        nameReverseKey,
        parentId,
        input.color ?? null,
        // Physical columns stay NOT NULL; the *_set flags carry the
        // own-vs-inherit distinction (docs/02-data-model.md §3.7).
        style ?? 'solid',
        input.width ?? 1,
        style === null ? 0 : 1,
        input.width === null || input.width === undefined ? 0 : 1,
        input.description ?? null,
        now,
        now,
        actorUserId,
      );
    return getLinkTypeOrThrow(ndb, id);
  });
}

/**
 * Patch a link type (docs/03-server-api.md §8). Last-write-wins per field;
 * `version` is bumped on every successful update. `style`/`width = null` mean
 * «inherit from the parent type».
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), `DUPLICATE` (409) when
 * renaming to an existing pair, or `VALIDATION_ERROR` (422) when reparenting a
 * type that is still used by links or when the new parent would break the
 * tree (cycle / depth over {@link MAX_TYPE_DEPTH}).
 */
export function updateLinkType(
  ndb: NetworkDb,
  id: string,
  changes: LinkTypeUpdateInput,
  expectedVersion: number | undefined,
): LinkType {
  return ndb.transaction(() => {
    const current = getLinkTypeOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'link type version mismatch', {
        entity: 'link_type',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    const newNameForward =
      changes.name_forward !== undefined
        ? validateLabel(changes.name_forward, 'name_forward')
        : current.name_forward;
    const newNameReverse =
      changes.name_reverse !== undefined
        ? validateLabel(changes.name_reverse, 'name_reverse')
        : current.name_reverse;
    if (
      typeNameKey(newNameForward) !== typeNameKey(current.name_forward) ||
      typeNameKey(newNameReverse) !== typeNameKey(current.name_reverse)
    ) {
      const clash = ndb
        .prepare(
          'SELECT 1 FROM link_types WHERE name_forward_key = ? AND name_reverse_key = ? AND id <> ?',
        )
        .get(typeNameKey(newNameForward), typeNameKey(newNameReverse), id);
      if (clash) {
        throw new EtnError('DUPLICATE', 'a link type with these names already exists', {
          name_forward: newNameForward,
          name_reverse: newNameReverse,
        });
      }
    }
    const style = validateStyle(changes.style);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.name_forward !== undefined) {
      sets.push('name_forward = ?', 'name_forward_key = ?');
      args.push(newNameForward, typeNameKey(newNameForward));
    }
    if (changes.name_reverse !== undefined) {
      sets.push('name_reverse = ?', 'name_reverse_key = ?');
      args.push(newNameReverse, typeNameKey(newNameReverse));
    }
    if (changes.parent_id !== undefined) {
      if (current.is_root) {
        throw new EtnError('VALIDATION_ERROR', 'у корневого типа нет родителя', {
          entity: 'link_type',
          id,
        });
      }
      const nextParent = resolveParentId(ndb, changes.parent_id);
      if (nextParent !== current.parent_id) {
        const usage = ndb.prepare('SELECT COUNT(*) AS c FROM links WHERE type_id = ?').get(id) as {
          c: number;
        };
        if (usage.c > 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `родительский тип изменить нельзя: тип используется в ${usage.c} связях`,
            { entity: 'link_type', id, in_use: usage.c },
          );
        }
        if (nextParent !== null) {
          assertParentValid(ndb, 'link_types', id, nextParent);
        }
        sets.push('parent_id = ?');
        args.push(nextParent);
      }
    }
    if (changes.color !== undefined) {
      sets.push('color = ?');
      args.push(changes.color ?? null);
    }
    if (style !== undefined) {
      sets.push('style = ?', 'style_set = ?');
      args.push(style ?? 'solid', style === null ? 0 : 1);
    }
    if (changes.width !== undefined) {
      sets.push('width = ?', 'width_set = ?');
      args.push(changes.width ?? 1, changes.width === null ? 0 : 1);
    }
    if (changes.description !== undefined) {
      sets.push('description = ?');
      args.push(changes.description ?? null);
    }

    const now = new Date().toISOString();
    sets.push('version = ?', 'updated_at = ?');
    args.push(current.version + 1, now);
    args.push(id);
    ndb.prepare(`UPDATE link_types SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getLinkTypeOrThrow(ndb, id);
  });
}

/** Options for {@link deleteLinkType}. */
export interface DeleteLinkTypeOptions {
  /** When true, null `type_id` on links of this type before deleting it. */
  force?: boolean;
  /** User performing the delete (recorded on the nulling update). */
  actorUserId?: string;
}

/**
 * Delete a link type (docs/03-server-api.md §8).
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), or `VALIDATION_ERROR`
 * (422) for the root type (undeletable), for a type with child types, or when
 * links still reference the type without `force`. The links themselves stay —
 * with `force` their `type_id` is nulled first.
 *
 * The type's property definitions are deleted along with it; stored values
 * cascade via the `property_values.property_id` FK (ON DELETE CASCADE).
 */
export function deleteLinkType(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
  opts: DeleteLinkTypeOptions = {},
): void {
  ndb.transaction(() => {
    const current = getLinkTypeOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'link type version mismatch', {
        entity: 'link_type',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.is_root) {
      throw new EtnError('VALIDATION_ERROR', 'корневой тип связи удалить нельзя', {
        entity: 'link_type',
        id,
      });
    }
    const childCount = ndb
      .prepare('SELECT COUNT(*) AS c FROM link_types WHERE parent_id = ?')
      .get(id) as { c: number };
    if (childCount.c > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `у типа есть подчинённые типы (${childCount.c}); сначала удалите или переместите их`,
        { entity: 'link_type', id, children: childCount.c },
      );
    }
    const usage = ndb.prepare('SELECT COUNT(*) AS c FROM links WHERE type_id = ?').get(id) as {
      c: number;
    };
    if (usage.c > 0 && !opts.force) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `link type is in use by ${usage.c} link(s); pass force=1 to detach them`,
        { entity: 'link_type', id, in_use: usage.c },
      );
    }
    if (usage.c > 0) {
      ndb.prepare('UPDATE links SET type_id = NULL WHERE type_id = ?').run(id);
    }
    ndb
      .prepare("DELETE FROM type_properties WHERE owner_type = 'link_type' AND owner_id = ?")
      .run(id);
    ndb
      .prepare("DELETE FROM type_property_overrides WHERE owner_type = 'link_type' AND type_id = ?")
      .run(id);
    ndb.prepare('DELETE FROM link_types WHERE id = ?').run(id);
  });
}

/**
 * Validate that a `type_id` value may be stored on a link: the type must
 * exist and must not be the root (the root's settings apply to untyped links
 * implicitly — it is not assignable, docs/08-ui-spec.md §8.1).
 */
export function assertLinkTypeAssignable(ndb: NetworkDb, typeId: string): void {
  const row = ndb.prepare('SELECT is_root FROM link_types WHERE id = ?').get(typeId) as
    | { is_root: number }
    | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', `link type ${typeId} not found`, {
      entity: 'link_type',
      id: typeId,
    });
  }
  if (row.is_root === 1) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'корневой тип не назначается связям; оставьте связь без типа',
      { entity: 'link_type', id: typeId },
    );
  }
}

/** Ancestor chain of a link type, from the type itself up to the root. */
export function linkTypeChain(ndb: NetworkDb, typeId: string): string[] {
  return typeAncestors(ndb, 'link_types', typeId);
}
