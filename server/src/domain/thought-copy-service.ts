/**
 * Bulk "copy / paste" of thoughts across networks (workplan L26).
 *
 * {@link copyThoughtsBatch} materialises the snapshot the client captured
 * (see `shared/src/types/thought-copy.ts`) under a chosen parent thought in
 * the destination network. The whole run is wrapped in a single transaction
 * so a partial failure never leaves the network with half-created rows.
 *
 * Resolution rules:
 *  - thought type: by id → by name (catching NOT_FOUND) → null;
 *  - link type: by id → by `name_forward` → by `name_reverse` → null;
 *  - `thought_ref` property values: a lookup by id, then by title in the
 *    destination network; unresolvable refs are dropped silently per spec.
 *
 * The client is responsible for rewriting wiki-links in permanent comments
 * (`[[#<id>]]` → `[[n:<source_network_id>#<id>]]`) when the source and
 * destination networks differ. The server stores the body verbatim.
 *
 * On top of the inter-thought links in the snapshot the server also creates
 * plain untyped parent-links from `parent_thought_id` to every newly
 * created thought — the spec requires the pasted thoughts to be children of
 * the destination cloud.
 */

import { randomUUID } from 'node:crypto';

import {
  type Attachment,
  EtnError,
  type Link,
  type LinkStyle,
  type PropertyValueValue,
  type Thought,
  type ThoughtCopyInput,
  type ThoughtCopyItem,
  type ThoughtCopyLink,
  type ThoughtCopyResult,
  type ThoughtCopySnapshot,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { createAttachment } from './attachment-service.js';
import { createComment } from './comment-service.js';
import { createLink } from './link-service.js';
import { resolveLinkTypeIdByName } from './link-type-service.js';
import { setPropertyValues } from './property-service.js';
import { resolveThoughtTypeIdByName } from './thought-type-service.js';
import { createThought, getThoughtOrThrow } from './thought-service.js';

// ---------------------------------------------------------------------------
// Resolvers (id → name → null)
// ---------------------------------------------------------------------------

/**
 * Resolve a thought type for a snapshot by id, then by name. Returns `null`
 * when neither matches. The root type is silently ignored — the spec says
 * "очищается", and the root would be rejected by `createThought` anyway
 * (L21). Returns `null` when the snapshot has neither id nor name.
 */
function resolveThoughtTypeId(ndb: NetworkDb, snap: ThoughtCopySnapshot): string | null {
  if (snap.type.id !== null && snap.type.id !== '') {
    const row = ndb.prepare('SELECT id, is_root FROM thought_types WHERE id = ?').get(snap.type.id) as
      | { id: string; is_root: number }
      | undefined;
    if (row !== undefined && row.is_root !== 1) return row.id;
  }
  if (snap.type.name !== null && snap.type.name.trim() !== '') {
    try {
      return resolveThoughtTypeIdByName(ndb, snap.type.name);
    } catch (err) {
      if (err instanceof EtnError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }
  return null;
}

/**
 * Resolve a link type for a snapshot: by id, then by `name_forward`, then
 * by `name_reverse`. Ambiguity or absence degrades to `null` rather than
 * failing the whole paste.
 */
function resolveLinkTypeId(
  ndb: NetworkDb,
  snap: ThoughtCopyLink['type'],
): string | null {
  if (snap.id !== null && snap.id !== '') {
    const row = ndb.prepare('SELECT id, is_root FROM link_types WHERE id = ?').get(snap.id) as
      | { id: string; is_root: number }
      | undefined;
    if (row !== undefined && row.is_root !== 1) return row.id;
  }
  return resolveByNames(ndb, snap.name_forward, snap.name_reverse);
}

/** Try forward name, then reverse; swallow NOT_FOUND and ambiguity. */
function resolveByNames(
  ndb: NetworkDb,
  nameForward: string | null,
  nameReverse: string | null,
): string | null {
  for (const candidate of [nameForward, nameReverse]) {
    if (candidate === null || candidate.trim() === '') continue;
    try {
      return resolveLinkTypeIdByName(ndb, candidate);
    } catch (err) {
      if (!(err instanceof EtnError)) throw err;
      if (err.code !== 'NOT_FOUND' && err.code !== 'VALIDATION_ERROR') throw err;
    }
  }
  return null;
}

/**
 * Resolve a `thought_ref` value for a property. The client may send either
 * the raw id (string) or a `{ id, title }` shape — we tolerate both.
 * Resolution is by id first, then by exact-title match (normalised) in the
 * destination network. Returns `null` when nothing fits, which the caller
 * treats as "drop the value".
 */
function resolveThoughtRefValue(
  ndb: NetworkDb,
  raw: unknown,
): string | null {
  const candidate = normaliseRefCandidate(raw);
  if (candidate === null) return null;
  const { id, title } = candidate;
  if (id !== null && id !== '') {
    const row = ndb.prepare('SELECT id FROM thoughts WHERE id = ? LIMIT 1').get(id) as
      | { id: string }
      | undefined;
    if (row !== undefined) return row.id;
  }
  if (title !== null && title.trim() !== '') {
    const normalised = title.trim().toLowerCase();
    const row = ndb
      .prepare('SELECT id FROM thoughts WHERE title_norm = ? LIMIT 1')
      .get(normalised) as { id: string } | undefined;
    if (row !== undefined) return row.id;
  }
  return null;
}

/** Accept either a plain string id or `{ id, title }`; strip anything else. */
function normaliseRefCandidate(
  raw: unknown,
): { id: string | null; title: string | null } | null {
  if (typeof raw === 'string') return { id: raw, title: null };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const r = raw as { id?: unknown; title?: unknown };
    const id = typeof r.id === 'string' ? r.id : null;
    const title = typeof r.title === 'string' ? r.title : null;
    if (id === null && title === null) return null;
    return { id, title };
  }
  return null;
}

/**
 * Resolve a map of property values, dropping `thought_ref`s that point at
 * no thought on the destination. Other value types are passed through
 * verbatim — the property service rejects anything that doesn't fit the
 * destination type's `value_type`.
 */
function resolveProperties(
  ndb: NetworkDb,
  thoughtId: string,
  raw: Record<string, PropertyValueValue>,
): void {
  // Look up the thought's effective type once so we know which keys are
  // `thought_ref`. Other value types skip this branch.
  const row = ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(thoughtId) as
    | { type_id: string | null }
    | undefined;
  if (row === undefined) return;
  const thoughtTypeId = row.type_id;

  const refKeys = new Set<string>();
  if (thoughtTypeId !== null) {
    const propRows = ndb
      .prepare(
        `SELECT tp.key FROM type_properties tp
         WHERE tp.owner_type = 'thought_type' AND tp.owner_id = ?
           AND tp.value_type = 'thought_ref'`,
      )
      .all(thoughtTypeId) as Array<{ key: string }>;
    for (const p of propRows) refKeys.add(p.key);
  }

  const resolved: Record<string, PropertyValueValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (refKeys.has(key)) {
      const id = resolveThoughtRefValue(ndb, value);
      if (id === null) continue;
      resolved[key] = id;
    } else {
      resolved[key] = value;
    }
  }

  if (Object.keys(resolved).length === 0) return;
  setPropertyValues(ndb, 'thought', thoughtId, resolved);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Materialise a clipboard snapshot inside `ndb`. Throws on the parent-thought
 * validation only — individual thought failures (type unmappable, attachment
 * failure) degrade silently per the spec (the field is cleared, the rest of
 * the batch keeps going).
 */
export function copyThoughtsBatch(
  ndb: NetworkDb,
  input: ThoughtCopyInput,
  actorUserId: string,
): ThoughtCopyResult {
  // The parent must exist up-front — every new thought gets a parent-link
  // to it and we want a precise 404 if the destination cloud was deleted
  // between the menu click and this request landing.
  getThoughtOrThrow(ndb, input.parent_thought_id);

  return ndb.transaction(() => {
    const thoughtIdMap: Record<string, string> = {};
    const linkIdMap: Record<string, string> = {};
    const createdThoughts: Thought[] = [];
    const createdLinks: Link[] = [];
    const createdAttachments: Attachment[] = [];

    // A copied thought must keep its parent-link only when its parent also
    // belongs to the selection (else the link would dangle); on the paste
    // path this same condition is reused to decide who gets a new
    // parent-link to the destination cloud. Any thought that's the target
    // of at least one copied inter-thought link is "internal" to the
    // copied subgraph and will already have its hierarchy preserved
    // through the copied links — attaching it to the paste target would
    // create a second parent (and visually a duplicate child row in the
    // children zone). The remaining thoughts — those that no copied link
    // points to — are the roots of the subgraph and get exactly one new
    // parent-link to the paste target.
    const hasIncomingCopiedLink = new Set<string>();
    for (const link of input.links) {
      hasIncomingCopiedLink.add(link.target_id);
    }

    for (const item of input.thoughts) {
      const created = createOneThought(ndb, item, actorUserId, createdAttachments);
      if (created === null) continue;
      const { sourceId, thought } = created;
      thoughtIdMap[sourceId] = thought.id;
      createdThoughts.push(thought);

      // Skip the parent-link for internal thoughts (they already have a
      // copied parent) and for the trivial self-loop case where the paste
      // target is one of the copied thoughts.
      const isInternal = sourceId !== '' && hasIncomingCopiedLink.has(sourceId);
      if (isInternal) continue;
      if (input.parent_thought_id === thought.id) continue;
      const parentLink = createLink(
        ndb,
        { source_id: input.parent_thought_id, target_id: thought.id, type_id: null },
        actorUserId,
      );
      createdLinks.push(parentLink);
    }

    for (const link of input.links) {
      const newLink = createOneLink(ndb, link, thoughtIdMap, actorUserId, createdAttachments);
      if (newLink === null) continue;
      linkIdMap[linkIdentity(link)] = newLink.id;
      createdLinks.push(newLink);
    }

    // Re-read the freshly created links so the result carries the canonical
    // `version`/`updated_at` values (the realtime layer broadcasts them
    // as-is).
    const finalLinks = createdLinks.map((l) => reReadLink(ndb, l.id));

    return {
      thought_id_map: thoughtIdMap,
      link_id_map: linkIdMap,
      created_thoughts: createdThoughts,
      created_links: finalLinks,
      created_attachments: createdAttachments,
    } satisfies ThoughtCopyResult;
  });
}

// ---------------------------------------------------------------------------
// Per-thought / per-link helpers
// ---------------------------------------------------------------------------

/** Stable identity of a link snapshot for the client-side id_map. */
function linkIdentity(link: ThoughtCopyLink): string {
  return `${link.source_id}:${link.target_id}:${link.type.id ?? ''}`;
}

/**
 * Materialise one thought snapshot. Returns `null` when nothing usable
 * could be created (e.g. the title is empty after validation); the caller
 * continues with the next snapshot.
 *
 * Degradation policy:
 *  - empty title → skip the whole thought (a card with no name is useless);
 *  - unmapped type → type_id becomes null (the thought is created without a
 *    type, the visual style is the root-type default);
 *  - icon of kind 'image' with a non-data/http(s) URL → icon cleared (image
 *    icons must be `data:` or `http(s):`, see `parseIconKind` in routes).
 */
function createOneThought(
  ndb: NetworkDb,
  item: ThoughtCopyItem,
  actorUserId: string,
  createdAttachments: Attachment[],
): { sourceId: string; thought: Thought } | null {
  const snap = item.thought;
  const trimmedTitle = snap.title.trim();
  if (trimmedTitle === '') return null;

  const typeId = resolveThoughtTypeId(ndb, snap);
  const { icon, iconKind } = normaliseIcon(snap.icon, snap.icon_kind);

  const thought = createThought(
    ndb,
    {
      title: trimmedTitle,
      ...(snap.synonyms.length > 0 ? { synonyms: snap.synonyms } : {}),
      type_id: typeId,
      icon,
      icon_kind: iconKind,
      active: snap.active,
      fg_color: snap.fg_color,
      bg_color: snap.bg_color,
      ...(snap.font_bold !== null ? { font_bold: snap.font_bold } : {}),
      ...(snap.font_italic !== null ? { font_italic: snap.font_italic } : {}),
      ...(snap.font_underline !== null ? { font_underline: snap.font_underline } : {}),
      ...(snap.font_strike !== null ? { font_strike: snap.font_strike } : {}),
    },
    actorUserId,
  );

  if (item.permanent_comment !== undefined && item.permanent_comment !== null) {
    const pc = item.permanent_comment;
    try {
      createComment(
        ndb,
        'thought',
        thought.id,
        {
          kind: 'permanent',
          title: pc.title ?? null,
          body_md: pc.body_md,
        },
        actorUserId,
      );
    } catch (err) {
      // A comment we cannot create must not abort the rest of the batch.
      if (!(err instanceof EtnError)) throw err;
    }
  }

  if (item.properties !== undefined && Object.keys(item.properties).length > 0) {
    try {
      resolveProperties(ndb, thought.id, item.properties);
    } catch (err) {
      if (!(err instanceof EtnError)) throw err;
    }
  }

  if (item.attachments !== undefined && item.attachments.length > 0) {
    for (const a of item.attachments) {
      try {
        const created = createAttachment(
          ndb,
          'thought',
          thought.id,
          {
            kind: a.kind,
            url: a.url ?? null,
            file_path: a.file_path ?? null,
            file_size: a.file_size ?? null,
            mime_type: a.mime_type ?? null,
            title: a.title ?? null,
            description: a.description ?? null,
          },
          actorUserId,
        );
        createdAttachments.push(created);
      } catch (err) {
        // Best-effort: skip malformed attachments and keep going.
        if (!(err instanceof EtnError)) throw err;
      }
    }
  }

  return { sourceId: snapshotSourceId(item), thought };
}

/** Read the original thought id the client tagged this snapshot with. */
function snapshotSourceId(item: ThoughtCopyItem): string {
  const ext = item as unknown as { source_id?: unknown };
  return typeof ext.source_id === 'string' ? ext.source_id : '';
}

/**
 * Image-icon policy: must be a `data:` URL or `http(s):` URL (see
 * `parseIconKind` in routes). When the icon fails the check we drop it and
 * fall back to a plain thought without an icon (`icon=null`,
 * `icon_kind='emoji'`).
 */
function normaliseIcon(
  icon: string | null,
  iconKind: 'emoji' | 'image',
): { icon: string | null; iconKind: 'emoji' | 'image' } {
  if (iconKind !== 'image') return { icon, iconKind };
  if (icon === null || icon === '') return { icon: null, iconKind: 'emoji' };
  if (icon.startsWith('data:') || icon.startsWith('http://') || icon.startsWith('https://')) {
    return { icon, iconKind: 'image' };
  }
  return { icon: null, iconKind: 'emoji' };
}

/**
 * Re-create a link snapshot. Both endpoints must map through
 * `thoughtIdMap`; if either endpoint was skipped (no matching snapshot) or
 * unmapped, the link is skipped too. Self-loops are pre-checked to keep
 * the failure silent.
 */
function createOneLink(
  ndb: NetworkDb,
  link: ThoughtCopyLink,
  thoughtIdMap: Record<string, string>,
  actorUserId: string,
  createdAttachments: Attachment[],
): Link | null {
  const sourceId = thoughtIdMap[link.source_id];
  const targetId = thoughtIdMap[link.target_id];
  if (sourceId === undefined || targetId === undefined) return null;
  if (sourceId === targetId) return null;
  const typeId = resolveLinkTypeId(ndb, link.type);
  const created = createLink(
    ndb,
    {
      source_id: sourceId,
      target_id: targetId,
      type_id: typeId,
      color: link.color,
      style: link.style,
      width: link.width,
      active: link.active,
    },
    actorUserId,
  );

  if (link.permanent_comment !== undefined && link.permanent_comment !== null) {
    try {
      createComment(
        ndb,
        'link',
        created.id,
        {
          kind: 'permanent',
          title: link.permanent_comment.title ?? null,
          body_md: link.permanent_comment.body_md,
        },
        actorUserId,
      );
    } catch (err) {
      if (!(err instanceof EtnError)) throw err;
    }
  }
  if (link.attachments !== undefined && link.attachments.length > 0) {
    for (const a of link.attachments) {
      try {
        const att = createAttachment(
          ndb,
          'link',
          created.id,
          {
            kind: a.kind,
            url: a.url ?? null,
            file_path: a.file_path ?? null,
            file_size: a.file_size ?? null,
            mime_type: a.mime_type ?? null,
            title: a.title ?? null,
            description: a.description ?? null,
          },
          actorUserId,
        );
        createdAttachments.push(att);
      } catch (err) {
        if (!(err instanceof EtnError)) throw err;
      }
    }
  }
  return created;
}

/** Re-read a freshly created link so its `version`/`updated_at` are exact. */
function reReadLink(ndb: NetworkDb, id: string): Link {
  const row = ndb.prepare('SELECT * FROM links WHERE id = ? LIMIT 1').get(id) as
    | {
        id: string;
        source_id: string;
        target_id: string;
        type_id: string | null;
        color: string | null;
        style: string | null;
        width: number | null;
        active: number;
        version: number;
        created_at: string;
        updated_at: string;
        created_by: string;
        updated_by: string;
      }
    | undefined;
  if (row === undefined) {
    throw new EtnError('INTERNAL', 'created link vanished mid-transaction', { id });
  }
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    type_id: row.type_id,
    color: row.color,
    style: row.style as LinkStyle | null,
    width: row.width,
    active: row.active === 1,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

// Touch the randomUUID import so it stays when the rest of the file evolves.
void randomUUID;
