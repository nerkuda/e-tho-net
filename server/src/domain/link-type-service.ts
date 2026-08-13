/**
 * Link-type domain service (task C5, docs/03-server-api.md §8).
 *
 * CRUD over `link_types` with the same protective deletion rule as thought
 * types: a type still referenced by links requires `force`, which nulls
 * `type_id` on those links first. Property definitions of a link type are
 * managed through {@link './property-service.js'} with `owner_type =
 * 'link_type'`. The `description` field is persisted for AI-agent context.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  LINK_STYLES,
  type LinkStyle,
  type LinkType,
  type LinkTypeInput,
  type LinkTypeUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Raw `link_types` row. */
interface LinkTypeRow {
  id: string;
  name_forward: string;
  name_reverse: string;
  color: string | null;
  style: string;
  width: number;
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
    color: row.color,
    style: row.style as LinkStyle,
    width: row.width,
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

/** Validate a link style against the accepted enum. */
function validateStyle(style: unknown): LinkStyle | undefined {
  if (style === undefined) return undefined;
  if (typeof style !== 'string' || !(LINK_STYLES as readonly string[]).includes(style)) {
    throw new EtnError('VALIDATION_ERROR', `invalid style: ${String(style)}`, {
      field: 'style',
      allowed: LINK_STYLES,
    });
  }
  return style as LinkStyle;
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

/** List all link types, ordered by forward name. */
export function listLinkTypes(ndb: NetworkDb): LinkType[] {
  const rows = ndb.prepare('SELECT * FROM link_types ORDER BY name_forward').all() as LinkTypeRow[];
  return rows.map(rowToLinkType);
}

/**
 * Create a link type (docs/03-server-api.md §8).
 *
 * Throws `DUPLICATE` (409) if a type with the same `(name_forward, name_reverse)`
 * pair already exists.
 */
export function createLinkType(
  ndb: NetworkDb,
  input: LinkTypeInput,
  actorUserId: string,
): LinkType {
  const nameForward = validateLabel(input.name_forward, 'name_forward');
  const nameReverse = validateLabel(input.name_reverse, 'name_reverse');
  const style = validateStyle(input.style) ?? 'solid';
  const id = randomUUID();
  const now = new Date().toISOString();

  return ndb.transaction(() => {
    const existing = ndb
      .prepare('SELECT 1 FROM link_types WHERE name_forward = ? AND name_reverse = ?')
      .get(nameForward, nameReverse);
    if (existing) {
      throw new EtnError('DUPLICATE', 'a link type with these names already exists', {
        name_forward: nameForward,
        name_reverse: nameReverse,
      });
    }
    ndb
      .prepare(
        `INSERT INTO link_types (id, name_forward, name_reverse, color, style, width,
                                  description, version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        nameForward,
        nameReverse,
        input.color ?? null,
        style,
        input.width ?? 1,
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
 * `version` is bumped on every successful update.
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), or `DUPLICATE` (409) when
 * renaming to an existing pair.
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
    if (newNameForward !== current.name_forward || newNameReverse !== current.name_reverse) {
      const clash = ndb
        .prepare('SELECT 1 FROM link_types WHERE name_forward = ? AND name_reverse = ? AND id <> ?')
        .get(newNameForward, newNameReverse, id);
      if (clash) {
        throw new EtnError('DUPLICATE', 'a link type with these names already exists', {
          name_forward: newNameForward,
          name_reverse: newNameReverse,
        });
      }
    }
    const style = changes.style !== undefined ? validateStyle(changes.style) : undefined;

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.name_forward !== undefined) {
      sets.push('name_forward = ?');
      args.push(newNameForward);
    }
    if (changes.name_reverse !== undefined) {
      sets.push('name_reverse = ?');
      args.push(newNameReverse);
    }
    if (changes.color !== undefined) {
      sets.push('color = ?');
      args.push(changes.color ?? null);
    }
    if (style !== undefined) {
      sets.push('style = ?');
      args.push(style);
    }
    if (changes.width !== undefined) {
      sets.push('width = ?');
      args.push(changes.width);
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
 * (422) when links still reference the type without `force`.
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
    ndb.prepare('DELETE FROM link_types WHERE id = ?').run(id);
  });
}
