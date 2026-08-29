/**
 * Layer merge domain service (task S8, docs/13-layers.md §8;
 * docs/03-server-api.md §5a.6).
 *
 * Merging layer `L` into its parent `P` is a **row-by-row replay** of L's
 * final state into `P`: shadow rows overwrite the parent's rows, tombstones
 * become deletions. Conflict resolution is out of scope — but detection is
 * mandatory: `base_version` of every merged row plays the role of
 * `expected_version` against the current version of the same logical row in
 * `P`; any divergence rejects the whole operation (422) with the divergence
 * list. No partial application.
 *
 * Phases (one transaction on the base-layer connection):
 *
 *   1. collect L's rows (all of them, or the requested closed subset);
 *   2. resolve each row's current winner along `P`'s ancestor chain
 *      (`temp.merge_chain` — the same anti-join the `*_v` views use, but
 *      without the `deleted = 0` and endpoint-visibility filters: a tombstone
 *      in an intermediate layer is a version bump like any other edit);
 *   3. conflict detection (versioned tables only) — fail before any write;
 *   4. closure check (§8.1) + the §6.4 residual case — fail before any write;
 *   5. reserve layer (§8.2): copy the pre-merge winners of every affected
 *      row into a fresh service layer under `P`;
 *   6. replay in the §8.1 order — tombstones → updates → inserts;
 *   7. remove the merged rows from `L` physically (they moved to `P`,
 *      §8.4) and auto-purge the trash (same call as layer deletion, S13).
 *
 * The replay touches **only `P`'s rows** (13-layers.md §8.1, реализация):
 * a tombstone-replayed deletion physically removes the row in `P` alone —
 * it does not sweep other layers' shadow rows the way a direct base-layer
 * deletion does. Sibling overlays survive the merge and catch the divergence
 * via `base_version` when they merge themselves; this is also what keeps the
 * §6.4 residual case (a physically gone link endpoint) reachable.
 *
 * Version semantics (§8.1 «с теми же правилами версий»): a replayed row keeps
 * its numbering — `version` moves to `P` verbatim, so a client that last saw
 * the row in `L` keeps matching `If-Match` after the merge. The one exception
 * is the §6.2 logical-duplicate collapse: edits apply to someone else's row,
 * which increments that row's version like an ordinary edit.
 */

import { randomUUID } from 'node:crypto';

import {
  BASE_LAYER_ID,
  EtnError,
  type LayerMergeConflict,
  type LayerMergeMissingClosure,
  type LayerMergeReport,
  type LayerMergeReorderCollapsed,
  type LayerMergeSkip,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { BRANCHABLE_TABLES } from '../db/layer-chain.js';
import type { BranchableTable } from '../db/layer-write.js';
import { purgeTrash } from './trash-service.js';

/** Subset selection of a partial merge: logical row ids per branchable table. */
export type MergeSelection = Partial<Record<BranchableTable, string[]>>;

/** Full outcome of a merge: the wire {@link LayerMergeReport} plus the ids the
 * route needs to fan out trash-purge deletion events and the layer identities
 * for the single `layer.merged` event (04-realtime.md §11.4). */
export interface LayerMergeOutcome extends LayerMergeReport {
  deleted_thought_ids: string[];
  deleted_link_ids: string[];
  merged_layer: { id: string; title: string };
  target_layer: { id: string; title: string };
}

/** A physical row of a branchable table, keyed by rowid. */
type AnyRow = Record<string, unknown> & { rowid: number };

/** Column layout of one branchable table (from PRAGMA, fixed per schema). */
interface TableLayout {
  /** Content columns copied verbatim on replay: everything except the
   * surrogate pk and the layer columns (`layer_id`, `base_version`,
   * `deleted`, `version`) — those are always stated explicitly per replay
   * statement (kept, bumped or pinned depending on the phase). */
  copyCols: string[];
  hasVersion: boolean;
}

/** `PRAGMA table_info` per table — schema is fixed after migrations. */
const LAYOUTS = new Map<BranchableTable, TableLayout>();

function layoutOf(ndb: NetworkDb, table: BranchableTable): TableLayout {
  const cached = LAYOUTS.get(table);
  if (cached) return cached;
  const info = ndb.pragma(`table_info(${table})`) as Array<{ name: string }>;
  const skip = new Set(['pk', 'layer_id', 'deleted', 'base_version', 'version']);
  const result: TableLayout = {
    copyCols: info.map((c) => c.name).filter((n) => !skip.has(n)),
    hasVersion: info.some((c) => c.name === 'version'),
  };
  LAYOUTS.set(table, result);
  return result;
}

/**
 * Fill `temp.merge_chain` with `P → … → base` (§4.1 chain of the merge
 * target). The merge runs on the base-layer connection, whose own
 * `layer_chain` is the base's — so the service carries the target's chain in
 * a separate temp table instead of switching the connection context.
 */
function setupMergeChain(ndb: NetworkDb, targetLayerId: string): void {
  ndb.exec(
    `CREATE TEMP TABLE IF NOT EXISTS merge_chain (
       layer_id TEXT PRIMARY KEY,
       depth    INTEGER NOT NULL
     )`,
  );
  ndb.prepare('DELETE FROM merge_chain').run();
  const byId = ndb.prepare('SELECT id, parent_id FROM layers WHERE id = ?');
  const insert = ndb.prepare('INSERT INTO merge_chain (layer_id, depth) VALUES (?, ?)');
  let current: string | null = targetLayerId;
  let depth = 0;
  while (current !== null) {
    if (depth > 16) throw new Error('merge target chain is cyclic or too deep');
    const row = byId.get(current) as { id: string; parent_id: string | null } | undefined;
    if (row === undefined) throw new Error(`layer ${current} not found in layers`);
    insert.run(row.id, depth);
    current = row.parent_id;
    depth += 1;
  }
}

/** Nearest row for `id` along the merge chain — tombstones included (a
 * tombstone between `P` and the base is a version bump the conflict check
 * must see). Returns `undefined` when no layer of the chain has the id. */
function resolveRow(ndb: NetworkDb, table: BranchableTable, id: string): AnyRow | undefined {
  return ndb
    .prepare(
      `SELECT t.*, t.rowid AS rowid FROM main.${table} t
       JOIN temp.merge_chain mc ON mc.layer_id = t.layer_id
       WHERE t.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM main.${table} t2
           JOIN temp.merge_chain mc2 ON mc2.layer_id = t2.layer_id
           WHERE t2.id = t.id AND mc2.depth < mc.depth
         )
       LIMIT 1`,
    )
    .get(id) as AnyRow | undefined;
}

/** Nearest **live** row for `id` along the merge chain (closure check). */
function resolveLiveRow(ndb: NetworkDb, table: BranchableTable, id: string): AnyRow | undefined {
  const row = resolveRow(ndb, table, id);
  return row !== undefined && row.deleted === 0 ? row : undefined;
}

/** Whether the logical id has any physical row at all, in any layer.
 * Service (reserve) layers do not count: their copies are backups, not
 * working state — an endpoint alive only in a reserve is §6.4-gone. */
function existsAnywhere(ndb: NetworkDb, table: BranchableTable, id: string): boolean {
  // layers:physical-read — вопрос о физическом наличии строки, не о цепочке.
  return (
    ndb
      .prepare(
        `SELECT 1 FROM ${table} t
         WHERE t.id = ? AND EXISTS (SELECT 1 FROM layers l WHERE l.id = t.layer_id AND l.is_service = 0)
         LIMIT 1`,
      )
      .get(id) !== undefined
  );
}

/** Sentinel making NULL link types comparable in the triple lookup (§6.2). */
const NULL_TYPE_SENTINEL = '\u0000';

/** Nearest live row in the merge chain with the same link triple (§6.2). */
function resolveLiveLinkByTriple(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
): AnyRow | undefined {
  return ndb
    .prepare(
      `SELECT t.*, t.rowid AS rowid FROM main.links t
       JOIN temp.merge_chain mc ON mc.layer_id = t.layer_id
       WHERE t.deleted = 0 AND t.source_id = ? AND t.target_id = ? AND ifnull(t.type_id, ?) = ?
         AND NOT EXISTS (
           SELECT 1 FROM main.links t2
           JOIN temp.merge_chain mc2 ON mc2.layer_id = t2.layer_id
           WHERE t2.deleted = 0 AND t2.id = t.id AND mc2.depth < mc.depth
         )
       LIMIT 1`,
    )
    .get(sourceId, targetId, NULL_TYPE_SENTINEL, typeId ?? NULL_TYPE_SENTINEL) as AnyRow | undefined;
}

/** One merged row with its resolution against the target chain. */
interface MergedRow {
  table: BranchableTable;
  row: AnyRow;
  /** Nearest row of the same logical id along P's chain (tombstones count);
   * `undefined` — the chain never had the id (insert path). */
  winner: AnyRow | undefined;
}

/**
 * Load L's own rows with their winners. `selection === undefined` is a full
 * merge (every row of the layer); a defined selection is partial — **only**
 * the listed tables' listed ids merge, unlisted tables contribute nothing
 * (03-server-api.md §5a.6).
 */
function collectMergedRows(
  ndb: NetworkDb,
  layerId: string,
  selection: MergeSelection | undefined,
): MergedRow[] {
  const merged: MergedRow[] = [];
  const unknown: Array<{ table: string; id: string }> = [];
  for (const table of BRANCHABLE_TABLES) {
    const selected = selection?.[table];
    const rows =
      selected === undefined
        ? selection === undefined
          ? (ndb.prepare(`SELECT t.*, t.rowid AS rowid FROM ${table} t WHERE t.layer_id = ?`).all(layerId) as AnyRow[])
          : [] // partial merge: an unlisted table merges nothing
        : selected.length === 0
          ? []
          : (ndb
              .prepare(
                `SELECT t.*, t.rowid AS rowid FROM ${table} t
                 WHERE t.layer_id = ? AND t.id IN (${selected.map(() => '?').join(', ')})`,
              )
              .all(layerId, ...selected) as AnyRow[]);
    if (selected !== undefined) {
      const found = new Set(rows.map((r) => r.id as string));
      for (const id of selected) {
        if (!found.has(id)) unknown.push({ table, id });
      }
    }
    for (const row of rows) {
      merged.push({ table, row, winner: resolveRow(ndb, table, row.id as string) });
    }
  }
  if (unknown.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'в слое нет перечисленных для слияния строк — обновите выбор и повторите.',
      { unknown },
    );
  }
  return merged;
}

/** Non-null reference helper for {@link rowReferences}. */
function ref(table: BranchableTable, id: unknown): { table: BranchableTable; id: string } | null {
  return typeof id === 'string' && id.length > 0 ? { table, id } : null;
}

/** Table owning a polymorphic `(owner_type, owner_id)` pair. */
function ownerTableOf(ownerType: unknown): BranchableTable {
  return ownerType === 'link' ? 'links' : 'thoughts';
}

/** Table owning a type-side `(owner_type, owner_id)` pair. */
function typeOwnerTableOf(ownerType: unknown): BranchableTable {
  return ownerType === 'link_type' ? 'link_types' : 'thought_types';
}

/** References a live merged row carries (§8.1 closure): referent table +
 * logical id. Link endpoints are handled separately (§6.4), and a thought's
 * `icon_attachment_id` is deliberately not a closure reference — a deleted
 * attachment nulls the pointer during the replay instead. */
function rowReferences(entry: MergedRow): Array<{ table: BranchableTable; id: string }> {
  const r = entry.row;
  switch (entry.table) {
    case 'thoughts':
      return compact([ref('thought_types', r.type_id)]);
    case 'thought_synonyms':
      return compact([ref('thoughts', r.thought_id)]);
    case 'links':
      return compact([ref('link_types', r.type_id)]);
    case 'thought_types':
      return compact([ref('thought_types', r.parent_id)]);
    case 'link_types':
      return compact([ref('link_types', r.parent_id)]);
    case 'type_properties':
      return compact([ref(typeOwnerTableOf(r.owner_type), r.owner_id)]);
    case 'type_property_overrides':
      return compact([
        ref(typeOwnerTableOf(r.owner_type), r.type_id),
        ref('type_properties', r.property_id),
      ]);
    case 'property_values':
      return compact([
        ref(ownerTableOf(r.owner_type), r.owner_id),
        ref('type_properties', r.property_id),
        ref('thoughts', r.value_thought_ref),
      ]);
    case 'comments':
      return compact([ref(ownerTableOf(r.owner_type), r.owner_id)]);
    case 'comment_targets':
      return compact([ref('comments', r.comment_id), ref(ownerTableOf(r.owner_type), r.owner_id)]);
    case 'attachments':
      return compact([ref(ownerTableOf(r.owner_type), r.owner_id)]);
    default:
      return [];
  }
}

/** Filter nulls out of a reference list. */
function compact(
  refs: Array<{ table: BranchableTable; id: string } | null>,
): Array<{ table: BranchableTable; id: string }> {
  return refs.filter((x): x is { table: BranchableTable; id: string } => x !== null);
}

/** Link content fields that must match for a row to count as position-only
 * (§6.5: «тройка, стиль и остальные поля совпадают с целевыми»). */
const LINK_CONTENT_FIELDS = [
  'source_id',
  'target_id',
  'type_id',
  'color',
  'style',
  'width',
  'active',
  'marked_for_deletion',
] as const;

/** Whether an update-path link row differs from its winner by `position`
 * only — such rows collapse into one `reorder_collapsed` entry (§6.5). */
function isPositionOnlyChange(row: AnyRow, winner: AnyRow): boolean {
  if (row.position === winner.position) return false;
  for (const field of LINK_CONTENT_FIELDS) {
    if (row[field] !== winner[field]) return false;
  }
  return true;
}

/** Copy a physical row verbatim into another layer (reserve layer, §8.2). */
function copyRowToLayer(ndb: NetworkDb, table: BranchableTable, rowid: number, layerId: string): void {
  const { copyCols, hasVersion } = layoutOf(ndb, table);
  const cols = ['id', 'layer_id', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...copyCols];
  const select = ['id', '?', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...copyCols];
  ndb
    .prepare(
      `INSERT INTO ${table} (${cols.join(', ')})
       SELECT ${select.join(', ')} FROM ${table} WHERE rowid = ?`,
    )
    .run(layerId, rowid);
}

/** ISO-8601 with second precision — matches the layers metadata style (§2.2). */
function nowSeconds(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/**
 * Merge layer `layerId` into its parent (§8). Runs on the **base-layer**
 * connection in one transaction; `actorUserId` stamps the reserve layer's
 * `created_by`.
 *
 * Throws:
 *   * `NOT_FOUND` — the layer does not exist;
 *   * `VALIDATION_ERROR` (422) — merging the base or a service layer; unknown
 *     selection ids; `base_version` conflicts (`details.conflicts`);
 *     a non-closed selection (`details.missing_closure`); a natural-key
 *     collision against an independent parent edit (`details.constraint`).
 */
export function mergeLayer(
  ndb: NetworkDb,
  layerId: string,
  selection: MergeSelection | undefined,
  actorUserId: string,
): LayerMergeOutcome {
  try {
    // NetworkDb.transaction wraps AND invokes the body — rollback on throw.
    return ndb.transaction(() => mergeLayerInner(ndb, layerId, selection, actorUserId));
  } catch (err) {
    if (err instanceof EtnError) throw err;
    // A natural-key collision (synonym uniqueness, the single permanent
    // comment, type name keys…) means the parent gained a conflicting row
    // after the layer was born — the base_version check cannot see it. Surface
    // it as a 422 with the constraint code instead of an opaque 500.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'слияние нарушает уникальный ключ в родителе: независимая правка предка создала конфликтующую строку.',
        { constraint: code },
      );
    }
    throw err;
  }
}

/** Transaction body of {@link mergeLayer}. */
function mergeLayerInner(
  ndb: NetworkDb,
  layerId: string,
  selection: MergeSelection | undefined,
  actorUserId: string,
): LayerMergeOutcome {
  const layer = ndb
    .prepare('SELECT id, parent_id, title, is_service, is_base FROM layers WHERE id = ? LIMIT 1')
    .get(layerId) as
    | { id: string; parent_id: string | null; title: string; is_service: number; is_base: number }
    | undefined;
  if (layer === undefined) {
    throw new EtnError('NOT_FOUND', `layer ${layerId} not found`, { entity: 'layer', id: layerId });
  }
  if (layer.is_base === 1) {
    throw new EtnError('VALIDATION_ERROR', 'основа не может быть слита: у неё нет родителя.', {
      layer_id: layerId,
    });
  }
  if (layer.is_service === 1) {
    throw new EtnError('VALIDATION_ERROR', 'служебный (резервный) слой нельзя слить.', {
      layer_id: layerId,
    });
  }
  const target = ndb
    .prepare('SELECT id, title FROM layers WHERE id = ? LIMIT 1')
    .get(layer.parent_id) as { id: string; title: string };
  const targetIsBase = target.id === BASE_LAYER_ID;

  setupMergeChain(ndb, target.id);
  const merged = collectMergedRows(ndb, layerId, selection);

  // --- Phase A (read-only): conflict detection (§8.1) --------------------
  const conflicts: LayerMergeConflict[] = [];
  for (const { table, row, winner } of merged) {
    if (winner === undefined || !layoutOf(ndb, table).hasVersion) continue;
    // A tombstone that found nothing to delete is a no-op, not a conflict;
    // every other row with a resolvable winner goes through the check. A
    // winner that is itself a tombstone (deleted in an intermediate layer)
    // counts as a changed row — its version carries the deletion bump.
    const expected = row.base_version as number;
    const current = winner.version as number;
    if (expected !== current) {
      conflicts.push({
        table,
        id: row.id as string,
        expected_base_version: expected,
        current_version: current,
      });
    }
  }
  if (conflicts.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `предок изменён после создания слоя: ${conflicts.length} расхождений. Слияние отклонено целиком.`,
      { conflicts },
    );
  }

  // --- Phase B (read-only): closure (§8.1) + §6.4 residual ---------------
  const inSet = new Set(merged.map((m) => `${m.table}\u0000${m.row.id as string}`));
  const missingClosure: LayerMergeMissingClosure[] = [];
  const skipped: LayerMergeSkip[] = [];
  const closedOrInSet = (table: BranchableTable, id: string): boolean =>
    inSet.has(`${table}\u0000${id}`) || resolveLiveRow(ndb, table, id) !== undefined;

  for (const entry of merged) {
    if (entry.row.deleted === 1) continue; // tombstones reference nothing
    for (const ref of rowReferences(entry)) {
      if (!closedOrInSet(ref.table, ref.id)) {
        missingClosure.push({
          table: ref.table,
          id: ref.id,
          referenced_by: { table: entry.table, id: entry.row.id as string },
        });
      }
    }
    // §6.4: an endpoint of a newly created link that is physically gone
    // everywhere is skipped with a report entry, not a rejection; an endpoint
    // that exists somewhere but does not resolve in the target chain is a
    // plain closure violation.
    if (entry.table === 'links' && entry.winner === undefined) {
      for (const [role, endpoint] of [
        ['source', entry.row.source_id],
        ['target', entry.row.target_id],
      ] as const) {
        const id = endpoint as string;
        if (closedOrInSet('thoughts', id)) continue;
        if (!existsAnywhere(ndb, 'thoughts', id)) {
          skipped.push({ table: 'links', id: entry.row.id as string, reason: 'endpoint_missing', missing: role });
        } else {
          missingClosure.push({
            table: 'thoughts',
            id,
            referenced_by: { table: 'links', id: entry.row.id as string },
          });
        }
      }
    }
  }
  if (missingClosure.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `набор слияния не замкнут: ${missingClosure.length} ссылок не разрешаются. Дополните выбор и повторите.`,
      { missing_closure: missingClosure },
    );
  }
  const skippedLinkIds = new Set(skipped.map((s) => s.id));
  const isSkipped = (table: BranchableTable, id: string): boolean =>
    table === 'links' && skippedLinkIds.has(id);

  // --- Phase C: reserve layer (§8.2) --------------------------------------
  // Affected = rows that overwrite or delete something in P (a winner
  // exists). Pure inserts have nothing to back up, so an insert-only merge
  // creates no reserve (report carries null).
  const affected = merged.filter((m) => m.winner !== undefined && !isSkipped(m.table, m.row.id as string));
  let reserveLayerId: string | null = null;
  if (affected.length > 0) {
    reserveLayerId = randomUUID();
    const now = nowSeconds();
    ndb
      .prepare(
        `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                             depth, created_by, created_at, last_activity_at, version)
         VALUES (?, ?, ?, ?, NULL, 1, 0,
                 (SELECT depth FROM layers WHERE id = ?) + 1, ?, ?, ?, 1)`,
      )
      .run(
        reserveLayerId,
        target.id,
        `резерв: слияние «${layer.title}» → «${target.title}»`.slice(0, 200),
        `резерв: слияние «${layer.title}» → «${target.title}», ${now}`,
        target.id,
        actorUserId,
        now,
        now,
      );
    for (const { table, winner } of affected) {
      copyRowToLayer(ndb, table, winner!.rowid, reserveLayerId);
    }
  }

  // --- Phase D: replay (tombstones → updates → inserts, §8.1) -------------
  const applied: Record<string, number> = {};
  const reorderGroups = new Map<string, number>();
  const deletedAttachmentIds = new Set<string>();

  /** Tombstone replay: the deletion lands in P (§8.1, реализация — only P's
   * row; other layers' shadows survive and conflict-detect at their own
   * merges). */
  const deleteInTarget = (entry: MergedRow): void => {
    const { table, row, winner } = entry;
    if (winner === undefined) return; // nothing to delete — no-op drop
    if (targetIsBase) {
      ndb.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(winner.rowid);
      if (table === 'attachments') deletedAttachmentIds.add(row.id as string);
      return;
    }
    if (winner.layer_id === target.id) {
      const hasVersion = layoutOf(ndb, table).hasVersion;
      ndb
        .prepare(`UPDATE ${table} SET deleted = 1${hasVersion ? ', version = ?' : ''} WHERE rowid = ?`)
        .run(...(hasVersion ? [row.version as number, winner.rowid] : [winner.rowid]));
      return;
    }
    // The winner lives above P: deleting in P materialises a tombstone row of
    // P (§5.2 semantics), copied from the winner row.
    const { copyCols, hasVersion } = layoutOf(ndb, table);
    const cols = ['id', 'layer_id', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...copyCols];
    const select = [
      'id',
      '?',
      '1',
      hasVersion ? 'COALESCE(version, 0)' : '0',
      ...(hasVersion ? ['version + 1'] : []),
      ...copyCols,
    ];
    ndb
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')})
         SELECT ${select.join(', ')} FROM ${table} WHERE rowid = ?`,
      )
      .run(target.id, winner.rowid);
  };

  /** Live-row replay onto an existing (live) winner. */
  const updateInTarget = (entry: MergedRow): void => {
    const { table, row, winner } = entry;
    // The caller partitions rows: updates always have a live winner (a
    // tombstone winner fails the conflict check; a missing one is an insert).
    if (winner === undefined || winner.deleted === 1) return;
    if (winner.layer_id === target.id) {
      // Copy the row's final state onto P's own row. `base_version` keeps
      // P's value (its own ancestor snapshot — used by P's future merge);
      // `version` moves verbatim (§8.1 version continuity).
      const { copyCols, hasVersion } = layoutOf(ndb, table);
      const sets = ['deleted', ...(hasVersion ? ['version'] : []), ...copyCols];
      ndb
        .prepare(
          `UPDATE ${table} SET (${sets.join(', ')}) =
             (SELECT ${sets.join(', ')} FROM ${table} WHERE rowid = ?)
           WHERE rowid = ?`,
        )
        .run(row.rowid, winner.rowid);
    } else {
      // First touch of this id in P: materialise a shadow carrying L's final
      // state, with base_version pinned to the winner's version (§5.1
      // semantics for a row that appears in P already edited).
      const { copyCols, hasVersion } = layoutOf(ndb, table);
      const cols = ['id', 'layer_id', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...copyCols];
      const select = ['id', '?', 'deleted', '?', ...(hasVersion ? ['version'] : []), ...copyCols];
      ndb
        .prepare(
          `INSERT INTO ${table} (${cols.join(', ')})
           SELECT ${select.join(', ')} FROM ${table} WHERE rowid = ?`,
        )
        .run(target.id, winner.version as number, row.rowid);
    }
    // §6.5: position-only link updates collapse into one report entry.
    if (table === 'links' && isPositionOnlyChange(row, winner)) {
      const key = row.source_id as string;
      reorderGroups.set(key, (reorderGroups.get(key) ?? 0) + 1);
    }
  };

  /** Live-row replay with no winner: an insert into P. */
  const insertInTarget = (entry: MergedRow): void => {
    const { table, row } = entry;
    if (isSkipped(table, row.id as string)) return; // §6.4 — reported, not created
    if (table === 'links') {
      // §6.2: a live row with the same triple already in the target chain —
      // collapse instead of inserting: apply the non-triple fields (order,
      // style, flags) to the existing row as an ordinary edit (version + 1).
      const dup = resolveLiveLinkByTriple(
        ndb,
        row.source_id as string,
        row.target_id as string,
        (row.type_id as string | null) ?? null,
      );
      if (dup !== undefined) {
        ndb
          .prepare(
            `UPDATE links SET (position, color, style, width, active, marked_for_deletion,
                               marked_for_deletion_at, marked_for_deletion_by, version, updated_at, updated_by) =
               (SELECT position, color, style, width, active, marked_for_deletion,
                       marked_for_deletion_at, marked_for_deletion_by, version + 1, updated_at, updated_by
                FROM links WHERE rowid = ?) -- layers:physical-read (реплей слияния: строка слоя)
             WHERE rowid = ?`,
          )
          .run(row.rowid, dup.rowid);
        return;
      }
    }
    const { copyCols, hasVersion } = layoutOf(ndb, table);
    const cols = ['id', 'layer_id', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...copyCols];
    const select = ['id', '?', 'deleted', '0', ...(hasVersion ? ['version'] : []), ...copyCols];
    ndb
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')})
         SELECT ${select.join(', ')} FROM ${table} WHERE rowid = ?`,
      )
      .run(target.id, row.rowid);
  };

  // §8.1 order: tombstones → updates → inserts. Deletes first so a new row
  // with the same triple cannot run into the old one it replaces (§6.2);
  // updates before inserts keep natural keys freed by edits available to the
  // rows that follow.
  const liveUpdates: MergedRow[] = [];
  const liveInserts: MergedRow[] = [];
  for (const entry of merged) {
    if (entry.row.deleted === 1) {
      deleteInTarget(entry);
    } else if (entry.winner === undefined || entry.winner.deleted === 1) {
      // A tombstone winner is unreachable (its version bump fails the
      // conflict check) — route defensively to the insert path.
      liveInserts.push(entry);
    } else {
      liveUpdates.push(entry);
    }
  }
  for (const entry of liveUpdates) updateInTarget(entry);
  for (const entry of liveInserts) insertInTarget(entry);

  // Attachment rows deleted by the replay must not leave dangling
  // `icon_attachment_id` pointers in P (mirrors the physical purge path).
  for (const attachmentId of deletedAttachmentIds) {
    ndb
      .prepare('UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ? AND layer_id = ?')
      .run(attachmentId, target.id);
  }

  // --- Phase E: remove the merged rows from L (§8.4) ----------------------
  // §6.4-skipped links stay in the layer: they were not merged (their target
  // end is gone), and «слитые строки удаляются из слоя» does not cover them.
  const removalByTable = new Map<BranchableTable, string[]>();
  for (const entry of merged) {
    if (isSkipped(entry.table, entry.row.id as string)) continue;
    const list = removalByTable.get(entry.table) ?? [];
    list.push(entry.row.id as string);
    removalByTable.set(entry.table, list);
  }
  for (const [table, ids] of removalByTable) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      ndb
        .prepare(`DELETE FROM ${table} WHERE layer_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`)
        .run(layerId, ...chunk);
    }
  }
  if (merged.length > 0) {
    const now = new Date().toISOString();
    ndb.prepare('UPDATE layers SET last_activity_at = ? WHERE id IN (?, ?)').run(now, layerId, target.id);
  }

  for (const entry of merged) {
    if (isSkipped(entry.table, entry.row.id as string)) continue;
    applied[entry.table] = (applied[entry.table] ?? 0) + 1;
  }
  const reorder_collapsed: LayerMergeReorderCollapsed[] = [...reorderGroups.entries()].map(
    ([thought_id, count]) => ({ thought_id, count }),
  );

  // --- Phase F: trash auto-purge (§8.4, same call as layer deletion) ------
  const purge = purgeTrash(ndb);

  return {
    applied,
    skipped,
    reorder_collapsed,
    reserve_layer_id: reserveLayerId,
    purged: purge.purged,
    deleted_thought_ids: purge.deleted_thought_ids,
    deleted_link_ids: purge.deleted_link_ids,
    merged_layer: { id: layer.id, title: layer.title },
    target_layer: { id: target.id, title: target.title },
  };
}
