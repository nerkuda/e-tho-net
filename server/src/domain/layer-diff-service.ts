/**
 * Layer diff service (task S11, docs/13-layers.md §10.3; 03-server-api.md
 * §5a.7).
 *
 * Two deliberately different answers to «чем слой отличается от основы»:
 *
 *   * {@link structuralLayerDiff} — the compact link-structure list the spec
 *     makes mandatory (§10.3: «структурный дифф по связям — обязателен
 *     отдельно»): added / removed / type-changed / reordered / reparented.
 *     The textual diff is blind to all of these, which is exactly why it must
 *     not be the only diff.
 *   * {@link layerDiffDoc} — two deterministically assembled markdown
 *     documents (one per context) for a plain text diff on the client. The
 *     full hierarchical assembly is task T2; here a deterministic flat
 *     listing (all visible thoughts ordered by id) already gives a stable,
 *     diffable document — «дешёвый дифф закрывает содержание, но не
 *     структуру».
 *
 * Both run against the caller-provided connections: `layerNdb` resolved in
 * the diffed layer's context, `targetNdb` in its parent's context (the base
 * for depth-1 layers). All reads go through the `*_v` views, so layer
 * visibility (§4.1) — including links with a hidden endpoint (§5.2) — is
 * applied uniformly.
 */

import { EtnError, type LayerDiffDoc, type LayerDiffLinks, type LayerDiffResult } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { exportToMarkdown } from './export-service.js';

/** Physical row shape read from `links_v` — the view already dropped links
 * whose endpoint is invisible in its context (§5.2). */
interface VisibleLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  position: number;
}

/** All links visible in a context, stable-ordered for comparison. */
function visibleLinks(ndb: NetworkDb): VisibleLinkRow[] {
  return ndb
    .prepare(
      `SELECT id, source_id, target_id, type_id, position
         FROM links_v
        ORDER BY id`,
    )
    .all() as VisibleLinkRow[];
}

/** Ids physically present in a layer — shadow rows, fresh inserts and
 * tombstones alike. `layers:<physical-read>` tags mark the deliberate
 * physical-table reads (13-layers.md §4.2: repositories read views; the diff
 * service intentionally looks at raw per-layer rows). */
function physicalIds(ndb: NetworkDb, table: 'thoughts' | 'links', layerId: string): string[] {
  return (
    ndb
      .prepare(`SELECT id FROM ${table} WHERE layer_id = ? ORDER BY id -- layers:physical-read`)
      .all(layerId) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Owners of the layer's own rows in one polymorphic branchable table
 * (`property_values` / `comments` / `comment_targets` / `attachments`).
 * A shadow of a dependent row is as much «the entity carries a layer version»
 * as a shadow of the entity row itself — editing a thought's property or
 * comment in a layer must mark the thought overridden (03-server-api.md
 * §5a.7), not only a title/type/style edit.
 */
function physicalOwners(
  ndb: NetworkDb,
  table: 'property_values' | 'comments' | 'comment_targets' | 'attachments',
  layerId: string,
): { thought: string[]; link: string[] } {
  const rows = ndb
    .prepare(
      `SELECT owner_type, owner_id FROM ${table} WHERE layer_id = ? -- layers:physical-read`,
    )
    .all(layerId) as { owner_type: string; owner_id: string }[];
  const thought: string[] = [];
  const link: string[] = [];
  for (const row of rows) {
    if (row.owner_type === 'link') link.push(row.owner_id);
    else thought.push(row.owner_id);
  }
  return { thought, link };
}

/**
 * The full `overridden` sets: entity rows of the layer plus owners of its
 * dependent rows (synonyms, property values, comments, comment targets,
 * attachments) — everything that travels to the parent on merge and therefore
 * everything the canvas badge means by «изменена в текущем слое».
 */
function overriddenIds(
  layerNdb: NetworkDb,
  layerId: string,
): { thought_ids: string[]; link_ids: string[] } {
  const thoughts = new Set(physicalIds(layerNdb, 'thoughts', layerId));
  const links = new Set(physicalIds(layerNdb, 'links', layerId));

  const synonyms = layerNdb
    .prepare('SELECT thought_id FROM thought_synonyms WHERE layer_id = ? -- layers:physical-read')
    .all(layerId) as { thought_id: string }[];
  for (const row of synonyms) thoughts.add(row.thought_id);

  for (const table of ['property_values', 'comments', 'comment_targets', 'attachments'] as const) {
    const owners = physicalOwners(layerNdb, table, layerId);
    for (const id of owners.thought) thoughts.add(id);
    for (const id of owners.link) links.add(id);
  }

  return {
    thought_ids: [...thoughts].sort(),
    link_ids: [...links].sort(),
  };
}

/** Column name for a row's position-only comparison (all non-id, non-position
 * fields that define the triple and its styling). */
function sameTriple(a: VisibleLinkRow, b: VisibleLinkRow): boolean {
  return (
    a.source_id === b.source_id && a.target_id === b.target_id && a.type_id === b.type_id
  );
}

/**
 * Structural diff of `layerId` against its parent (§10.3).
 *
 * `layerNdb` must be opened in the diffed layer's context; `targetNdb` in its
 * parent's. The layer's own `layers` metadata row (parent resolution) is read
 * on whichever connection is convenient — the table is not branchable (§3).
 *
 * Collapsing rules (§6.5): rows whose ONLY change is `position` fold into
 * `reorder_collapsed` batches per `source_id`; a batch containing a row with
 * any other change is left as ordinary entries. Reparenting is the 1:1 match
 * of one removed incoming link with one added incoming link of the same
 * thought — anything more complex (many parents at once) stays honest as
 * added/removed pairs.
 */
export function structuralLayerDiff(
  layerNdb: NetworkDb,
  targetNdb: NetworkDb,
  layer: { id: string; title: string },
  targetLayer: { id: string; title: string },
): LayerDiffResult {
  const layerLinks = visibleLinks(layerNdb);
  const targetLinks = visibleLinks(targetNdb);
  const targetById = new Map(targetLinks.map((l) => [l.id, l]));
  const layerById = new Map(layerLinks.map((l) => [l.id, l]));

  const links: LayerDiffLinks = {
    added: [],
    removed: [],
    type_changed: [],
    reorder_collapsed: [],
    reparented: [],
  };

  const reorderByParent = new Map<string, number>();
  for (const row of layerLinks) {
    const counterpart = targetById.get(row.id);
    if (counterpart === undefined) {
      links.added.push(row);
      continue;
    }
    if (!sameTriple(row, counterpart)) {
      // Endpoints or type differ — the type change is a §6.1 UPDATE; an
      // endpoint change should not reach here (S14 replaces the id), but if
      // it does, the row is honestly reported as both removed and added.
      if (row.source_id === counterpart.source_id && row.target_id === counterpart.target_id) {
        links.type_changed.push({
          id: row.id,
          from_type_id: counterpart.type_id,
          to_type_id: row.type_id,
        });
      } else {
        links.removed.push(counterpart);
        links.added.push(row);
      }
      continue;
    }
    if (row.position !== counterpart.position) {
      reorderByParent.set(row.source_id, (reorderByParent.get(row.source_id) ?? 0) + 1);
    }
  }
  for (const row of targetLinks) {
    if (layerById.has(row.id)) continue;
    links.removed.push(row);
  }
  links.reorder_collapsed = [...reorderByParent.entries()]
    .map(([thought_id, count]) => ({ thought_id, count }))
    .sort((a, b) => a.thought_id.localeCompare(b.thought_id));

  // Reparenting: 1:1 swap of incoming links per thought.
  const removedIncoming = new Map<string, VisibleLinkRow[]>();
  const addedIncoming = new Map<string, VisibleLinkRow[]>();
  for (const row of links.removed) {
    const list = removedIncoming.get(row.target_id) ?? [];
    list.push(row);
    removedIncoming.set(row.target_id, list);
  }
  for (const row of links.added) {
    const list = addedIncoming.get(row.target_id) ?? [];
    list.push(row);
    addedIncoming.set(row.target_id, list);
  }
  for (const [thoughtId, removed] of removedIncoming) {
    const added = addedIncoming.get(thoughtId) ?? [];
    if (removed.length === 1 && added.length === 1) {
      const from = removed[0] as VisibleLinkRow;
      const to = added[0] as VisibleLinkRow;
      if (from.source_id !== to.source_id) {
        links.reparented.push({
          thought_id: thoughtId,
          from_parent_id: from.source_id,
          to_parent_id: to.source_id,
        });
        links.removed = links.removed.filter((r) => r.id !== from.id);
        links.added = links.added.filter((r) => r.id !== to.id);
      }
    }
  }
  links.reparented.sort((a, b) => a.thought_id.localeCompare(b.thought_id));

  return {
    layer,
    target_layer: targetLayer,
    links,
    overridden: overriddenIds(layerNdb, layer.id),
  };
}

/** All thoughts visible in a context, ordered by id — the deterministic seed
 * list of the textual document (T2 will replace the flat listing with the
 * hierarchical assembly, 13-layers.md §10.3). */
function visibleThoughtIds(ndb: NetworkDb): string[] {
  return (
    ndb.prepare('SELECT id FROM thoughts_v ORDER BY id').all() as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Two deterministically assembled markdown documents for a plain text diff
 * (§10.3). Determinism is guaranteed by the id-ordered seed list and by
 * {@link exportToMarkdown}'s `ORDER BY title` on the child listing.
 */
export function layerDiffDoc(
  layerNdb: NetworkDb,
  targetNdb: NetworkDb,
  layer: { id: string; title: string },
  targetLayer: { id: string; title: string },
): LayerDiffDoc {
  // The export throws on a missing thought only if the view lied — resolve
  // defensively: exportToMarkdown uses getThoughtOrThrow per id, and the ids
  // come from the same context's view, so this cannot fail in practice.
  const layerDoc = exportToMarkdown(layerNdb, visibleThoughtIds(layerNdb));
  const targetDoc = exportToMarkdown(targetNdb, visibleThoughtIds(targetNdb));
  return { layer, target_layer: targetLayer, layer_doc: layerDoc, target_doc: targetDoc };
}

/** Resolve the diffed layer's metadata row + its parent (target) echo. */
export function resolveDiffTarget(
  ndb: NetworkDb,
  layerId: string,
): { layer: { id: string; title: string }; target: { id: string; title: string } } {
  const layerRow = ndb
    .prepare('SELECT id, title, parent_id FROM layers WHERE id = ? LIMIT 1')
    .get(layerId) as { id: string; title: string; parent_id: string | null } | undefined;
  if (layerRow === undefined) {
    throw new EtnError('NOT_FOUND', `layer ${layerId} not found`, { entity: 'layer', id: layerId });
  }
  const targetRow = ndb
    .prepare('SELECT id, title FROM layers WHERE id = ? LIMIT 1')
    .get(layerRow.parent_id ?? '') as { id: string; title: string } | undefined;
  if (targetRow === undefined) {
    throw new EtnError('VALIDATION_ERROR', 'у слоя нет родителя: дифф основы невозможен.', {
      field: 'layer_id',
      layer_id: layerId,
    });
  }
  return {
    layer: { id: layerRow.id, title: layerRow.title },
    target: { id: targetRow.id, title: targetRow.title },
  };
}
