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

import {
  EtnError,
  LAYER_DIFF_DEFAULT_LIMIT,
  LAYER_DIFF_MAX_LIMIT,
  LAYER_DIFF_PAGE_BUDGET_BYTES,
  LAYER_DIFF_SECTIONS,
  LAYER_THOUGHT_DIFF_FIELD_KEYS,
  type LayerDiffCounts,
  type LayerDiffDoc,
  type LayerDiffLinkRow,
  type LayerDiffLinks,
  type LayerDiffOverridden,
  type LayerDiffPage,
  type LayerDiffReparented,
  type LayerDiffResult,
  type LayerDiffSection,
  type LayerDiffTypeChange,
  type LayerEcho,
  type LayerMergeReorderCollapsed,
  type LayerThoughtDiff,
  type LayerThoughtDiffField,
  type LayerThoughtDiffFieldKey,
  type LayerThoughtDiffKind,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getPermanentFull } from './comment-service.js';
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

/** The un-paged structural core shared by the full report and the page. */
interface FullLayerDiff {
  links: LayerDiffLinks;
  overridden: LayerDiffOverridden;
}

/**
 * Compute the whole structural diff of `layerId` against its parent (§10.3).
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
function computeLayerDiff(layerNdb: NetworkDb, targetNdb: NetworkDb, layerId: string): FullLayerDiff {
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

  return { links, overridden: overriddenIds(layerNdb, layerId) };
}

/**
 * Structural diff of `layerId` against its parent (§10.3) — the FULL report,
 * used by the REST default (`GET …/diff` without pagination parameters). Paged
 * callers use {@link structuralLayerDiffPage}.
 */
export function structuralLayerDiff(
  layerNdb: NetworkDb,
  targetNdb: NetworkDb,
  layer: { id: string; title: string },
  targetLayer: { id: string; title: string },
): LayerDiffResult {
  const full = computeLayerDiff(layerNdb, targetNdb, layer.id);
  return { layer, target_layer: targetLayer, links: full.links, overridden: full.overridden };
}

// ---------------------------------------------------------------------------
// Paged structural diff (задача ddb67ddc): sections filter + keyset cursor
// (ADR 5f6cb775) under a hard byte budget (05-mcp-server.md §4.1).
// ---------------------------------------------------------------------------

/** One addressable item of the flattened page stream: its section, its stable
 * sort key (the row id) and the payload pushed back into the answer. */
interface DiffEntry {
  section: LayerDiffSection;
  key: string;
  item: unknown;
}

/** Keyset cursor of a paged diff — section + last returned item id. */
interface DiffCursor {
  v: 1;
  s: LayerDiffSection;
  k: string;
}

/** Canonical (deterministic) order of the sections within a page. */
const SECTION_ORDER: readonly LayerDiffSection[] = LAYER_DIFF_SECTIONS;

/** Items of one section, sorted by their stable key (ADR 5f6cb775). */
function sectionEntries(full: FullLayerDiff, section: LayerDiffSection): DiffEntry[] {
  const sortById = <T extends { id: string }>(rows: T[]): DiffEntry[] =>
    rows
      .map((row) => ({ section, key: row.id, item: row }))
      .sort((a, b) => a.key.localeCompare(b.key));
  const sortByThoughtId = <T extends { thought_id: string }>(rows: T[]): DiffEntry[] =>
    rows
      .map((row) => ({ section, key: row.thought_id, item: row }))
      .sort((a, b) => a.key.localeCompare(b.key));
  switch (section) {
    case 'links.added':
      return sortById(full.links.added);
    case 'links.removed':
      return sortById(full.links.removed);
    case 'links.type_changed':
      return sortById(full.links.type_changed);
    case 'links.reorder_collapsed':
      return sortByThoughtId(full.links.reorder_collapsed);
    case 'links.reparented':
      return sortByThoughtId(full.links.reparented);
    case 'overridden.thought_ids':
      return [...full.overridden.thought_ids]
        .sort()
        .map((id) => ({ section, key: id, item: id }));
    case 'overridden.link_ids':
      return [...full.overridden.link_ids].sort().map((id) => ({ section, key: id, item: id }));
  }
}

/** Totals per section across the whole report. */
function diffCounts(full: FullLayerDiff): LayerDiffCounts {
  return {
    'links.added': full.links.added.length,
    'links.removed': full.links.removed.length,
    'links.type_changed': full.links.type_changed.length,
    'links.reorder_collapsed': full.links.reorder_collapsed.length,
    'links.reparented': full.links.reparented.length,
    'overridden.thought_ids': full.overridden.thought_ids.length,
    'overridden.link_ids': full.overridden.link_ids.length,
  };
}

function encodeDiffCursor(section: LayerDiffSection, key: string): string {
  const cursor: DiffCursor = { v: 1, s: section, k: key };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeDiffCursor(raw: string, allowed: readonly LayerDiffSection[]): DiffCursor {
  const invalid = (details: Record<string, unknown> = {}): never => {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Некорректный keyset-курсор диффа: продолжение страницы невозможно.',
      { field: 'cursor', ...details },
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const c = parsed as Partial<DiffCursor>;
  if (c.v !== 1) return invalid({ reason: 'version' });
  if (typeof c.s !== 'string' || !allowed.includes(c.s as LayerDiffSection)) {
    return invalid({ reason: 'section' });
  }
  if (typeof c.k !== 'string' || c.k === '') return invalid({ reason: 'shape' });
  return c as DiffCursor;
}

/** Assemble a page from the chosen items, keeping every requested section key
 * present in the answer (an empty array means «no items in this section»). */
function makeDiffPage(
  layer: LayerEcho,
  targetLayer: LayerEcho,
  sections: readonly LayerDiffSection[],
  counts: LayerDiffCounts,
  taken: readonly DiffEntry[],
  limit: number,
  truncated: boolean,
  nextCursor: string | null,
): LayerDiffPage {
  const links: Partial<LayerDiffLinks> = {};
  const overridden: Partial<LayerDiffOverridden> = {};
  for (const section of sections) {
    switch (section) {
      case 'links.added':
        links.added ??= [];
        break;
      case 'links.removed':
        links.removed ??= [];
        break;
      case 'links.type_changed':
        links.type_changed ??= [];
        break;
      case 'links.reorder_collapsed':
        links.reorder_collapsed ??= [];
        break;
      case 'links.reparented':
        links.reparented ??= [];
        break;
      case 'overridden.thought_ids':
        overridden.thought_ids ??= [];
        break;
      case 'overridden.link_ids':
        overridden.link_ids ??= [];
        break;
    }
  }
  for (const entry of taken) {
    switch (entry.section) {
      case 'links.added':
        links.added?.push(entry.item as LayerDiffLinkRow);
        break;
      case 'links.removed':
        links.removed?.push(entry.item as LayerDiffLinkRow);
        break;
      case 'links.type_changed':
        links.type_changed?.push(entry.item as LayerDiffTypeChange);
        break;
      case 'links.reorder_collapsed':
        links.reorder_collapsed?.push(entry.item as LayerMergeReorderCollapsed);
        break;
      case 'links.reparented':
        links.reparented?.push(entry.item as LayerDiffReparented);
        break;
      case 'overridden.thought_ids':
        overridden.thought_ids?.push(entry.item as string);
        break;
      case 'overridden.link_ids':
        overridden.link_ids?.push(entry.item as string);
        break;
    }
  }
  return {
    layer,
    target_layer: targetLayer,
    sections: [...sections],
    counts,
    links,
    overridden,
    limit,
    truncated,
    reason: truncated ? 'has_more' : null,
    next_cursor: nextCursor,
  };
}

/** Byte size of one answer exactly as the MCP transport serialises it. */
function pageBytes(page: LayerDiffPage): number {
  return Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8');
}

/** Arguments of the paged structural diff. */
export interface StructuralLayerDiffPageOptions {
  /** Sections to include (subset); omitted/empty — all sections. */
  sections?: readonly LayerDiffSection[];
  /** Page size in items; defaults to {@link LAYER_DIFF_DEFAULT_LIMIT}. */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
}

/**
 * Paged structural diff (§10.3; задача ddb67ddc).
 *
 * The report is flattened into a deterministic stream ordered by section
 * ({@link LAYER_DIFF_SECTIONS}) and, within a section, by the row id — the
 * keyset key (ADR 5f6cb775). `cursor` continues the stream; `limit` caps items
 * and the byte budget ({@link LAYER_DIFF_PAGE_BUDGET_BYTES}) can trim a page
 * further, so every answer fits the MCP client budget and is never cut by the
 * transport silently. `counts` always carries the totals of the WHOLE report.
 *
 * `sections` restricts the stream to the named sections; an unknown name is
 * rejected with `VALIDATION_ERROR`, as is a cursor whose section is not part of
 * the request (its continuation would read a different order).
 */
export function structuralLayerDiffPage(
  layerNdb: NetworkDb,
  targetNdb: NetworkDb,
  layer: LayerEcho,
  targetLayer: LayerEcho,
  options: StructuralLayerDiffPageOptions = {},
): LayerDiffPage {
  const requested = options.sections ?? [];
  for (const section of requested) {
    if (!SECTION_ORDER.includes(section)) {
      throw new EtnError('VALIDATION_ERROR', `Неизвестная секция диффа «${section}».`, {
        field: 'sections',
        section,
        allowed: SECTION_ORDER,
      });
    }
  }
  const effectiveSet = new Set<LayerDiffSection>(
    requested.length > 0 ? requested : SECTION_ORDER,
  );
  const sections = SECTION_ORDER.filter((s) => effectiveSet.has(s));

  const full = computeLayerDiff(layerNdb, targetNdb, layer.id);
  const counts = diffCounts(full);

  const flat: DiffEntry[] = [];
  for (const section of sections) flat.push(...sectionEntries(full, section));

  let startIndex = 0;
  if (options.cursor !== undefined) {
    const cursor = decodeDiffCursor(options.cursor, sections);
    // Skip everything up to and including the cursor position: earlier
    // sections, then the cursor's section up to its key.
    const cursorSectionIndex = sections.indexOf(cursor.s);
    startIndex = flat.findIndex((entry) => {
      const entrySectionIndex = sections.indexOf(entry.section);
      return entrySectionIndex > cursorSectionIndex ||
        (entrySectionIndex === cursorSectionIndex && entry.key > cursor.k);
    });
    if (startIndex === -1) startIndex = flat.length;
  }

  const remaining = flat.slice(startIndex);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? LAYER_DIFF_DEFAULT_LIMIT), 1),
    LAYER_DIFF_MAX_LIMIT,
  );
  const maxByLimit = Math.min(limit, remaining.length);

  const build = (count: number): LayerDiffPage => {
    const taken = remaining.slice(0, count);
    const more = startIndex + count < flat.length;
    const last = taken[taken.length - 1];
    const nextCursor = more && last !== undefined ? encodeDiffCursor(last.section, last.key) : null;
    return makeDiffPage(layer, targetLayer, sections, counts, taken, limit, more, nextCursor);
  };

  // Largest page (up to the item limit) that fits the byte budget: page size
  // grows monotonically with the item count, so binary search is exact.
  let low = 0;
  let high = maxByLimit;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (pageBytes(build(mid)) <= LAYER_DIFF_PAGE_BUDGET_BYTES) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return build(best);
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

// ---------------------------------------------------------------------------
// Per-thought textual diff (задача 52c776f1): the same thought read in both
// contexts, field by field, display-ready.
// ---------------------------------------------------------------------------

/** One thought's comparable attributes as seen in a single context. */
interface ThoughtVersionSnapshot {
  title: string;
  type_name: string;
  synonyms: string;
  active: string;
  comment: string;
}

/** Display-ready value of one field key in a snapshot. */
function snapshotField(snapshot: ThoughtVersionSnapshot, key: LayerThoughtDiffFieldKey): string {
  return snapshot[key === 'type' ? 'type_name' : key];
}

/**
 * Read `thoughtId` as visible in `ndb`'s context, resolving the type name,
 * synonyms (display order) and the permanent comment. `null` — the thought is
 * not visible there (absent or tombstoned in this layer).
 */
function readThoughtVersion(ndb: NetworkDb, thoughtId: string): ThoughtVersionSnapshot | null {
  const row = ndb
    .prepare(
      `SELECT t.title AS title, COALESCE(tt.name, '') AS type_name, t.active AS active
         FROM thoughts_v t
         LEFT JOIN thought_types_v tt ON tt.id = t.type_id
        WHERE t.id = ?
        LIMIT 1`,
    )
    .get(thoughtId) as { title: string; type_name: string; active: number } | undefined;
  if (row === undefined) return null;

  const synonyms = (
    ndb
      .prepare('SELECT synonym FROM thought_synonyms_v WHERE thought_id = ? ORDER BY synonym')
      .all(thoughtId) as { synonym: string }[]
  )
    .map((r) => r.synonym)
    .join(', ');

  const comment = getPermanentFull(ndb, 'thought', thoughtId)?.body_md ?? '';

  return {
    title: row.title,
    type_name: row.type_name,
    synonyms,
    active: row.active !== 0 ? 'активна' : 'неактивна',
    comment,
  };
}

/**
 * Textual diff of ONE thought between the diffed layer and its merge target
 * (§10.3; задача 52c776f1). The client cannot build it itself: from inside a
 * layer it cannot read the base version of a shadowed thought. Both versions
 * are read through `*_v`, so layer visibility (§4.1) applies uniformly.
 *
 * Returns one entry per {@link LAYER_THOUGHT_DIFF_FIELD_KEYS} in that order —
 * `{ target, layer, changed }` — plus the relation `kind`:
 * `added` (new in the layer), `removed` (tombstoned in the layer), `changed`
 * (present in both, at least one different attribute) or `unchanged`.
 * A thought invisible in BOTH contexts is `NOT_FOUND`.
 */
export function layerThoughtDiff(
  layerNdb: NetworkDb,
  targetNdb: NetworkDb,
  layer: LayerEcho,
  targetLayer: LayerEcho,
  thoughtId: string,
): LayerThoughtDiff {
  const layerVersion = readThoughtVersion(layerNdb, thoughtId);
  const targetVersion = readThoughtVersion(targetNdb, thoughtId);
  if (layerVersion === null && targetVersion === null) {
    throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found in layer or target`, {
      entity: 'thought',
      id: thoughtId,
    });
  }

  const fields: LayerThoughtDiffField[] = LAYER_THOUGHT_DIFF_FIELD_KEYS.map((key) => {
    const layerText = layerVersion === null ? '' : snapshotField(layerVersion, key);
    const targetText = targetVersion === null ? '' : snapshotField(targetVersion, key);
    return { key, target: targetText, layer: layerText, changed: layerText !== targetText };
  });

  const kind: LayerThoughtDiffKind =
    layerVersion === null
      ? 'removed'
      : targetVersion === null
        ? 'added'
        : fields.some((f) => f.changed)
          ? 'changed'
          : 'unchanged';

  return {
    layer,
    target_layer: targetLayer,
    thought_id: thoughtId,
    title: layerVersion?.title ?? targetVersion?.title ?? '',
    kind,
    fields,
  };
}
