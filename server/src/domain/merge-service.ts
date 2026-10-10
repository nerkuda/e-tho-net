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
  type LayerDiscardReport,
  type LayerMergeConflict,
  type LayerMergeMissingClosure,
  type LayerMergePublicationReorderCollapsed,
  type LayerMergeReport,
  type LayerMergeReorderCollapsed,
  type LayerMergeSkip,
  type LayerOverrideDiffField,
  type LayerOverrideRow,
  type LayerPendingConflictsReport,
  type LayerResetOverrideReport,
  type LayerThoughtMergeMode,
  type LayerThoughtMergeResult,
} from '@etn/shared';

import { renderMarkdown } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { BRANCHABLE_TABLES } from '../db/layer-chain.js';
import type { BranchableTable } from '../db/layer-write.js';
import { autoRollupLayerActivity } from './activity-service.js';
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
  /** Сводка авто-свёртки журнала активности (задача 6bcccd2b, требование
   * 1f7f789b «авто-свёртка при слиянии слоя»): сколько ключевых сущностей
   * получили итоговую запись и сколько детальных строк удалено из журнала. */
  activity_rollup: { groups: number; removed: number };
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

/**
 * Есть ли у вложения живое владение хотя бы в одном рабочем (не служебном)
 * слое (0.12.1, ADR 9f90b010): вложение живёт, пока в любом слое остаётся
 * живое владение. Служебные (резервные) слои — технические копии для отката —
 * не считаются. Чтение физическое и осознанное: вопрос «в каком-либо слое», а
 * не о цепочке одного контекста.
 */
function hasLiveOwnershipAnywhere(ndb: NetworkDb, attachmentId: string): boolean {
  return (
    ndb
      .prepare(
        `SELECT 1 FROM attachment_owners o -- layers:physical-read
         JOIN layers l ON l.id = o.layer_id AND l.is_service = 0
         WHERE o.attachment_id = ? AND o.deleted = 0
         LIMIT 1`,
      )
      .get(attachmentId) !== undefined
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
    .get(sourceId, targetId, NULL_TYPE_SENTINEL, typeId ?? NULL_TYPE_SENTINEL) as
    AnyRow | undefined;
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
          ? (ndb
              .prepare(`SELECT t.*, t.rowid AS rowid FROM ${table} t WHERE t.layer_id = ?`)
              .all(layerId) as AnyRow[])
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

/** A mergeable working layer with the parent it merges into. */
interface MergeTarget {
  layer: { id: string; parent_id: string | null; title: string; is_service: number; is_base: number };
  target: { id: string; title: string };
  targetIsBase: boolean;
}

/**
 * Load the layer to merge/reset from and its target (parent), rejecting the
 * base and service layers — they have no merge target chain to reconcile
 * against. Shared by the merge (§8.1) and the override reset (§8.5).
 */
function loadMergeTarget(ndb: NetworkDb, layerId: string): MergeTarget {
  const layer = ndb
    .prepare('SELECT id, parent_id, title, is_service, is_base FROM layers WHERE id = ? LIMIT 1')
    .get(layerId) as MergeTarget['layer'] | undefined;
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
  return { layer, target, targetIsBase: target.id === BASE_LAYER_ID };
}

/**
 * Phase A of the merge (§8.1): every versioned merged row whose `base_version`
 * diverges from the current version of the same logical id in the target chain.
 * Shared with the reset preview (§8.5) — one definition of «предстоящий
 * конфликт».
 */
function detectVersionConflicts(ndb: NetworkDb, merged: MergedRow[]): LayerMergeConflict[] {
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
  return conflicts;
}

// ---------------------------------------------------------------------------
// Override reset (§8.5, задача 7cc34cf4)
// ---------------------------------------------------------------------------

/** Text values in the override diff are clipped to keep the report bounded. */
const OVERRIDE_DIFF_VALUE_MAX = 200;

/** Clip one diff value; scalars pass through untouched. */
function clipDiffValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value);
  return text.length > OVERRIDE_DIFF_VALUE_MAX ? `${text.slice(0, OVERRIDE_DIFF_VALUE_MAX)}…` : text;
}

/** Changed copy columns between the target's row and the layer's shadow —
 * «было в основе / стало в слое». */
function overrideRowDiff(
  ndb: NetworkDb,
  table: BranchableTable,
  layerRow: AnyRow,
  targetRow: AnyRow | undefined,
): LayerOverrideDiffField[] {
  const { copyCols } = layoutOf(ndb, table);
  const diff: LayerOverrideDiffField[] = [];
  for (const column of copyCols) {
    const base = targetRow === undefined ? null : (targetRow[column] ?? null);
    const layer = layerRow[column] ?? null;
    if (base !== layer) {
      diff.push({ column, base: clipDiffValue(base), layer: clipDiffValue(layer) });
    }
  }
  return diff;
}

/** Describe one shadow row against its target-chain winner. */
function describeOverrideRow(
  ndb: NetworkDb,
  table: BranchableTable,
  row: AnyRow,
  winner: AnyRow | undefined,
  versionRaisedTo: number | null,
): LayerOverrideRow {
  return {
    table,
    id: row.id as string,
    previous_base_version: row.base_version as number,
    current_version: winner === undefined ? 0 : (winner.version as number),
    layer_version: (row.version as number | undefined) ?? 0,
    version_raised_to: versionRaisedTo,
    base_deleted: winner !== undefined && winner.deleted === 1,
    layer_deleted: row.deleted === 1,
    diff: overrideRowDiff(ndb, table, row, winner),
  };
}

/**
 * Read-only preview of the conflicts that would reject a merge (§8.5): the
 * layer's versioned shadow rows whose `base_version` no longer matches the
 * target chain, each with its «было в основе / стало в слое» difference. Lets
 * an agent learn about a future conflict without attempting the merge (a
 * trial merge is unsafe: a conflict-free layer would merge early).
 *
 * `selection === undefined` inspects the whole layer; a defined selection is
 * the same closed subset shape the merge takes.
 */
export function listPendingMergeConflicts(
  ndb: NetworkDb,
  layerId: string,
  selection?: MergeSelection,
): LayerPendingConflictsReport {
  return ndb.transaction(() => {
    const { layer, target } = loadMergeTarget(ndb, layerId);
    setupMergeChain(ndb, target.id);
    const merged = collectMergedRows(ndb, layerId, selection);
    const conflicts = detectVersionConflicts(ndb, merged);
    const stale = new Set(conflicts.map((c) => `${c.table}\u0000${c.id}`));
    return {
      layer: { id: layer.id, title: layer.title },
      target_layer: { id: target.id, title: target.title },
      overridden: merged.length,
      conflicts: merged
        .filter((m) => stale.has(`${m.table}\u0000${m.row.id as string}`))
        .map((m) => describeOverrideRow(ndb, m.table, m.row, m.winner, null)),
    };
  });
}

/**
 * Reset the override of the selected shadow rows (§8.5): re-pin `base_version`
 * to the current version of the same logical row in the merge target. The
 * layer's content is preserved and the target is not touched — the operation
 * only says «I have seen the ancestor's change and take responsibility for
 * it», after which the merge conflict check passes. Destructive by nature: the
 * «ancestor changed» signal is deliberately dropped, so callers are expected
 * to have inspected the preview ({@link listPendingMergeConflicts}) first.
 *
 * A shadow whose `version` lags behind the target is raised to the target's
 * version: replaying it verbatim (§8.1) must not walk the target's version
 * backwards.
 *
 * Throws `VALIDATION_ERROR` for the base/service layer, an empty selection or
 * rows the layer does not hold (same `unknown` detail as the merge).
 */
export function resetLayerOverride(
  ndb: NetworkDb,
  layerId: string,
  selection: MergeSelection,
): LayerResetOverrideReport {
  return ndb.transaction(() => {
    const { layer, target } = loadMergeTarget(ndb, layerId);
    setupMergeChain(ndb, target.id);
    const merged = collectMergedRows(ndb, layerId, selection);
    if (merged.length === 0) {
      throw new EtnError('VALIDATION_ERROR', 'набор сброса пуст: укажите хотя бы одну строку слоя.', {
        field: 'tables',
      });
    }
    const reset: LayerOverrideRow[] = [];
    const unchanged: LayerResetOverrideReport['unchanged'] = [];
    for (const { table, row, winner } of merged) {
      const id = row.id as string;
      if (!layoutOf(ndb, table).hasVersion) {
        // Versionless tables carry `base_version = 0` and never conflict
        // (§8.1) — there is nothing to re-pin.
        unchanged.push({ table, id, reason: 'not_versioned' });
        continue;
      }
      const previous = row.base_version as number;
      const current = winner === undefined ? 0 : (winner.version as number);
      if (previous === current) {
        unchanged.push({ table, id, reason: 'up_to_date' });
        continue;
      }
      const layerVersion = (row.version as number | undefined) ?? 0;
      const raiseTo = current > layerVersion ? current : null;
      ndb
        .prepare(
          `UPDATE ${table} SET base_version = ?${raiseTo === null ? '' : ', version = ?'} WHERE rowid = ?`,
        )
        .run(...(raiseTo === null ? [current, row.rowid] : [current, raiseTo, row.rowid]));
      reset.push(describeOverrideRow(ndb, table, row, winner, raiseTo));
    }
    if (reset.length > 0) {
      ndb
        .prepare('UPDATE layers SET last_activity_at = ? WHERE id = ?')
        .run(new Date().toISOString(), layerId);
    }
    return {
      layer: { id: layer.id, title: layer.title },
      target_layer: { id: target.id, title: target.title },
      reset,
      unchanged,
    };
  });
}

/** Non-null reference helper for {@link rowReferences}. */
function ref(table: BranchableTable, id: unknown): { table: BranchableTable; id: string } | null {
  return typeof id === 'string' && id.length > 0 ? { table, id } : null;
}

/** Table owning a polymorphic `(owner_type, owner_id)` pair. */
function ownerTableOf(ownerType: unknown): BranchableTable {
  if (ownerType === 'link') return 'links';
  if (ownerType === 'publication') return 'publications';
  return 'thoughts';
}

/** Table owning a type-side `(owner_type, owner_id)` pair. */
function typeOwnerTableOf(ownerType: unknown): BranchableTable {
  return ownerType === 'link_type' ? 'link_types' : 'thought_types';
}

/** References a live merged row carries (§8.1 closure): referent table +
 * logical id. Link endpoints are handled separately (§6.4), and a thought's
 * `icon_attachment_id` is deliberately not a closure reference — a disappeared
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
      return compact([
        ref(typeOwnerTableOf(r.owner_type), r.owner_id),
        ref('properties', r.property_id), // 0.6.5: привязка ссылается на справочник properties
      ]);
    case 'type_property_overrides':
      return compact([
        ref(typeOwnerTableOf(r.owner_type), r.type_id),
        ref('properties', r.property_id), // 0.6.5: property_id ссылается на справочник properties
      ]);
    case 'property_values':
      return compact([
        ref(ownerTableOf(r.owner_type), r.owner_id),
        ref('properties', r.property_id), // 0.6.5: значение ссылается на справочник, не на привязку
      ]);
    case 'comments':
      return compact([ref(ownerTableOf(r.owner_type), r.owner_id)]);
    case 'comment_targets':
      return compact([ref('comments', r.comment_id), ref(ownerTableOf(r.owner_type), r.owner_id)]);
    // ПЕРЕХОДНЫЙ ПЕРИОД (0.12.1 → задача домена 7678876a): замыкание читает ОБА
    // источника. Целевая модель (ADR 9f90b010, тех.проект f9b8917c) — владелец
    // живёт в `attachment_owners` (строка владения замыкается ниже), а строка
    // вложения сама ни на кого не ссылается. Но пока домен пишет только
    // owner-колонки `attachments` (attachment-service) и снимает их задача
    // 7678876a, замыкание строки вложения по owner-колонкам СОХРАНЯЕТСЯ —
    // иначе вложение слоя, созданное доменным кодом, выпадало бы из набора.
    // После 7678876a ветка станет недостижимой (`owner_type` = undefined → []),
    // двойное чтение убирается вместе со снятием колонок.
    case 'attachments':
      return compact([ref(ownerTableOf(r.owner_type), r.owner_id)]);
    // Владение ссылается на своё вложение (attachment_id) и на объект-владельца:
    // без живого вложения или владельца строка владения бессмысленна.
    case 'attachment_owners':
      return compact([
        ref('attachments', r.attachment_id),
        ref(ownerTableOf(r.owner_type), r.owner_id),
      ]);
    // 0.11.1: подсистема публикаций. Обложка (`cover_attachment_id`) — не
    // ссылка замыкания: как и `thoughts.icon_attachment_id`, пойнтер
    // обнуляется при удалении вложения, а не отвергает слияние.
    case 'publication_order':
      return compact([ref('publications', r.publication_id)]);
    case 'publication_exclusions':
      // Исключение адресует мысль, которой может уже не быть (висячее
      // исключение безвредно) — замыкается только на публикацию.
      return compact([ref('publications', r.publication_id)]);
    case 'shelf_items':
      return compact([ref('shelves', r.shelf_id), ref('publications', r.publication_id)]);
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

/** publication_order content fields that must match for a row to count as
 * position-only (0.11.1, требование e7487d77 п.2: массовые правки только
 * `position` в `publication_order` сворачиваются в одну позицию отчёта —
 * расширение таблично-управляемого механизма свёртки по прецеденту
 * `links.position`). */
const PUBLICATION_ORDER_CONTENT_FIELDS = ['publication_id', 'node_key'] as const;

/**
 * Whether an update-path row differs from its winner by `position` only, and
 * the collapse-group key if so (иначе `null`). Группировка — по «владельцу»
 * порядка: `links` → `source_id` (мысль, у которой переставили детей),
 * `publication_order` → `publication_id`.
 */
function positionOnlyGroup(table: BranchableTable, row: AnyRow, winner: AnyRow): string | null {
  if (row.position === winner.position) return null;
  const fields =
    table === 'links'
      ? LINK_CONTENT_FIELDS
      : table === 'publication_order'
        ? PUBLICATION_ORDER_CONTENT_FIELDS
        : null;
  if (fields === null) return null;
  for (const field of fields) {
    if (row[field] !== winner[field]) return null;
  }
  return table === 'links' ? (row.source_id as string) : (row.publication_id as string);
}

/** Copy a physical row verbatim into another layer (reserve layer, §8.2). */
function copyRowToLayer(
  ndb: NetworkDb,
  table: BranchableTable,
  rowid: number,
  layerId: string,
): void {
  const { copyCols, hasVersion } = layoutOf(ndb, table);
  const cols = [
    'id',
    'layer_id',
    'deleted',
    'base_version',
    ...(hasVersion ? ['version'] : []),
    ...copyCols,
  ];
  const select = [
    'id',
    '?',
    'deleted',
    'base_version',
    ...(hasVersion ? ['version'] : []),
    ...copyCols,
  ];
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
  const { layer, target, targetIsBase } = loadMergeTarget(ndb, layerId);

  setupMergeChain(ndb, target.id);
  const merged = collectMergedRows(ndb, layerId, selection);

  // --- Phase A (read-only): conflict detection (§8.1) --------------------
  const conflicts = detectVersionConflicts(ndb, merged);
  if (conflicts.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `предок изменён после создания слоя: ${conflicts.length} расхождений. Слияние отклонено целиком.`,
      // `how_to` — hint-навигатор уровня 2 (ADR b2eebf8b, задача 940a499d):
      // имя процедурного промпта, объясняющего ошибку. Агент узнаёт об
      // инструкции в момент, когда она нужна.
      { conflicts, how_to: 'etn.how_to_merge_partial' },
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
          skipped.push({
            table: 'links',
            id: entry.row.id as string,
            reason: 'endpoint_missing',
            missing: role,
          });
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
      // Hint-навигатор уровня 2 (ADR b2eebf8b) — см. конфликтную ветку выше.
      { missing_closure: missingClosure, how_to: 'etn.how_to_merge_partial' },
    );
  }
  const skippedLinkIds = new Set(skipped.map((s) => s.id));
  const isSkipped = (table: BranchableTable, id: string): boolean =>
    table === 'links' && skippedLinkIds.has(id);

  // --- Phase C: reserve layer (§8.2) --------------------------------------
  // Affected = rows that overwrite or delete something in P (a winner
  // exists). Pure inserts have nothing to back up, so an insert-only merge
  // creates no reserve (report carries null).
  const affected = merged.filter(
    (m) => m.winner !== undefined && !isSkipped(m.table, m.row.id as string),
  );
  let reserveLayerId: string | null = null;
  if (affected.length > 0) {
    reserveLayerId = randomUUID();
    const nowMs = Date.now();
    const now = nowSeconds();
    ndb
      .prepare(
        `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                             depth, created_by, updated_by, created_at,
                             last_activity_at, created_at_ms, updated_at_ms, version)
         VALUES (?, ?, ?, ?, NULL, 1, 0,
                 (SELECT depth FROM layers WHERE id = ?) + 1, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        reserveLayerId,
        target.id,
        `резерв: слияние «${layer.title}» → «${target.title}»`.slice(0, 200),
        `резерв: слияние «${layer.title}» → «${target.title}», ${now}`,
        target.id,
        actorUserId,
        actorUserId,
        now,
        now,
        nowMs,
        nowMs,
      );
    for (const { table, winner } of affected) {
      copyRowToLayer(ndb, table, winner!.rowid, reserveLayerId);
    }
  }

  // --- Phase D: replay (tombstones → updates → inserts, §8.1) -------------
  const applied: Record<string, number> = {};
  const reorderGroups = new Map<string, number>();
  const publicationReorderGroups = new Map<string, number>();
  // Вложения, затронутые слиянием: строки владений (их attachment_id) и
  // надгробия самих строк вложений. После реплея по этому набору проверяется,
  // не потеряло ли вложение последнее живое владение (0.12.1, ADR 9f90b010).
  const touchedAttachmentIds = new Set<string>();

  /** Tombstone replay: the deletion lands in P (§8.1, реализация — only P's
   * row; other layers' shadows survive and conflict-detect at their own
   * merges). */
  const deleteInTarget = (entry: MergedRow): void => {
    const { table, row, winner } = entry;
    if (winner === undefined) return; // nothing to delete — no-op drop
    if (table === 'attachments') touchedAttachmentIds.add(row.id as string);
    if (targetIsBase) {
      ndb.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(winner.rowid);
      return;
    }
    if (winner.layer_id === target.id) {
      const hasVersion = layoutOf(ndb, table).hasVersion;
      ndb
        .prepare(
          `UPDATE ${table} SET deleted = 1${hasVersion ? ', version = ?' : ''} WHERE rowid = ?`,
        )
        .run(...(hasVersion ? [row.version as number, winner.rowid] : [winner.rowid]));
      return;
    }
    // The winner lives above P: deleting in P materialises a tombstone row of
    // P (§5.2 semantics), copied from the winner row.
    const { copyCols, hasVersion } = layoutOf(ndb, table);
    const cols = [
      'id',
      'layer_id',
      'deleted',
      'base_version',
      ...(hasVersion ? ['version'] : []),
      ...copyCols,
    ];
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
      const cols = [
        'id',
        'layer_id',
        'deleted',
        'base_version',
        ...(hasVersion ? ['version'] : []),
        ...copyCols,
      ];
      const select = ['id', '?', 'deleted', '?', ...(hasVersion ? ['version'] : []), ...copyCols];
      ndb
        .prepare(
          `INSERT INTO ${table} (${cols.join(', ')})
           SELECT ${select.join(', ')} FROM ${table} WHERE rowid = ?`,
        )
        .run(target.id, winner.version as number, row.rowid);
    }
    // §6.5: position-only updates collapse into one report entry; 0.11.1 —
    // тем же механизмом и для порядка публикаций (e7487d77 п.2).
    const group = positionOnlyGroup(table, row, winner);
    if (group !== null) {
      const map = table === 'links' ? reorderGroups : publicationReorderGroups;
      map.set(group, (map.get(group) ?? 0) + 1);
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
    const cols = [
      'id',
      'layer_id',
      'deleted',
      'base_version',
      ...(hasVersion ? ['version'] : []),
      ...copyCols,
    ];
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
    // Затронутые слиянием владения (0.12.1): по их вложениям после реплея
    // проверяется, не исчезло ли вложение (последнее живое владение).
    if (entry.table === 'attachment_owners') {
      touchedAttachmentIds.add(entry.row.attachment_id as string);
    }
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
        .prepare(
          `DELETE FROM ${table} WHERE layer_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .run(layerId, ...chunk);
    }
  }
  if (merged.length > 0) {
    const now = new Date().toISOString();
    ndb
      .prepare('UPDATE layers SET last_activity_at = ? WHERE id IN (?, ?)')
      .run(now, layerId, target.id);
  }

  // --- Phase E2: исчезновение вложений (0.12.1, ADR 9f90b010) -------------
  // Вложение живёт, пока в ЛЮБОМ рабочем слое остаётся живое владение. Слияние
  // сводит слои — здесь и проверяется «последний владелец»: для вложений,
  // затронутых слиянием (надгробия владений отреплеены, строки слоя уже
  // убраны в Phase E), без живого владения строка вложения убирается из цели, а
  // висячие указатели иконки мысли / обложки публикации обнуляются (как и в
  // физическом каскаде — пойнтер не ссылка замыкания).
  //
  // Физический файл здесь НЕ трогается: носитель один на все слои, его судьбу
  // по исчезновению последнего живого владельца решает owner-cleanup (задача
  // da59a4cf), а не слияние.
  for (const attachmentId of touchedAttachmentIds) {
    if (hasLiveOwnershipAnywhere(ndb, attachmentId)) continue;
    const winner = resolveRow(ndb, 'attachments', attachmentId);
    if (winner !== undefined && winner.deleted === 0) {
      deleteInTarget({ table: 'attachments', row: winner, winner });
    }
    ndb
      .prepare(
        'UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ? AND layer_id = ?',
      )
      .run(attachmentId, target.id);
    // 0.11.1: обложка публикации, как и иконка мысли, — не ссылка замыкания;
    // при исчезновении вложения пойнтер обнуляется.
    ndb
      .prepare(
        'UPDATE publications SET cover_attachment_id = NULL WHERE cover_attachment_id = ? AND layer_id = ?',
      )
      .run(attachmentId, target.id);
  }

  for (const entry of merged) {
    if (isSkipped(entry.table, entry.row.id as string)) continue;
    applied[entry.table] = (applied[entry.table] ?? 0) + 1;
  }
  const reorder_collapsed: LayerMergeReorderCollapsed[] = [...reorderGroups.entries()].map(
    ([thought_id, count]) => ({ thought_id, count }),
  );
  const publication_reorder_collapsed: LayerMergePublicationReorderCollapsed[] = [
    ...publicationReorderGroups.entries(),
  ].map(([publication_id, count]) => ({ publication_id, count }));

  // --- Phase F: trash auto-purge (§8.4, same call as layer deletion) ------
  // Исход очистки (события/журнал) здесь не раздаётся — события раздаёт
  // фасад по `deleted_*_ids` отчёта.
  const purge = purgeTrash(ndb).result;

  // --- Phase G: авто-свёртка событий журнала для слоя (задача 6bcccd2b,
  // требование 1f7f789b «авто-свёртка при слиянии слоя»). Детальные
  // события слоя уже не нужны — по каждой затронутой сущности в основе
  // появляется ровно одна итоговая запись (`autoRollupLayerActivity`
  // выполняется в той же транзакции, что и merge — откатывается вместе). ---
  const activityRollup = autoRollupLayerActivity(ndb, ndb.networkId, layerId);

  return {
    applied,
    skipped,
    reorder_collapsed,
    publication_reorder_collapsed,
    reserve_layer_id: reserveLayerId,
    purged: purge.purged,
    deleted_thought_ids: purge.deleted_thought_ids,
    deleted_link_ids: purge.deleted_link_ids,
    merged_layer: { id: layer.id, title: layer.title },
    target_layer: { id: target.id, title: target.title },
    activity_rollup: activityRollup,
  };
}

// ---------------------------------------------------------------------------
// Разрешение изменений ОДНОЙ мысли (задача f5c363a3, «Слияние отдельных мыслей
// в основу из GUI с разрешением конфликтов»).
//
// Три варианта из GUI отображаются на серверные операции так:
//   * «Отказаться от изменений»  → discardLayerThought (строки мысли удаляются
//     из слоя, мысль возвращается к состоянию основы);
//   * «Полностью переписать…»    → mergeLayerThought режим `overwrite`;
//   * «Объединить изменения»     → mergeLayerThought режим `combine`
//     (единственное отступление от «посрочного реплея без слияния
//     содержимого» — постоянный комментарий объединяется; ADR-мысль задачи).
// ---------------------------------------------------------------------------

/**
 * Все физические строки слоя, принадлежащие одной мысли, как замкнутое
 * подмножество для слияния/отказа (требование 406f432e).
 *
 * В набор входит сама мысль, её зависимые строки (синонимы, значения свойств,
 * комментарии с их целями, вложения) и её рёбра (связи, у которых мысль —
 * любой конец) вместе с зависимыми строками этих рёбер. Типы/справочники
 * свойств НЕ добавляются: они либо уже есть в основе, либо дадут честный
 * `missing_closure` — сервер, как и раньше, набор не расширяет.
 */
export function collectThoughtLayerRows(
  ndb: NetworkDb,
  layerId: string,
  thoughtId: string,
): MergeSelection {
  const selection: MergeSelection = {};
  const push = (table: BranchableTable, ids: string[]): void => {
    if (ids.length === 0) return;
    (selection[table] ??= []).push(...ids);
  };

  push('thoughts', layerIds(ndb, 'thoughts', layerId, 'id = ?', thoughtId));
  push('thought_synonyms', layerIds(ndb, 'thought_synonyms', layerId, 'thought_id = ?', thoughtId));
  push(
    'property_values',
    layerIds(ndb, 'property_values', layerId, "owner_type = 'thought' AND owner_id = ?", thoughtId),
  );
  // Вложения мысли — ОБА источника, переходный период (ADR 9f90b010; снимется
  // задачей домена 7678876a): строки владений `attachment_owners` (целевая
  // модель) и вложения по owner-колонкам `attachments` (пока домен пишет их —
  // именно этот путь создаёт вложение иконки/вложения в слое сегодня). Дубли
  // схлопывает дедупликация на выходе.
  pushOwnedAttachments(ndb, layerId, 'thought', [thoughtId], selection);
  push(
    'attachments',
    layerIds(ndb, 'attachments', layerId, "owner_type = 'thought' AND owner_id = ?", thoughtId),
  );
  const commentIds = layerIds(
    ndb,
    'comments',
    layerId,
    "owner_type = 'thought' AND owner_id = ?",
    thoughtId,
  );
  push('comments', commentIds);
  push('comment_targets', commentTargetRows(ndb, layerId, commentIds));

  const linkIds = layerIds(
    ndb,
    'links',
    layerId,
    '(source_id = ? OR target_id = ?)',
    thoughtId,
    thoughtId,
  );
  push('links', linkIds);
  if (linkIds.length > 0) {
    const placeholders = linkIds.map(() => '?').join(', ');
    push(
      'property_values',
      layerIds(
        ndb,
        'property_values',
        layerId,
        `owner_type = 'link' AND owner_id IN (${placeholders})`,
        ...linkIds,
      ),
    );
    // Вложения связей — тем же двойным чтением (переходный период, 7678876a):
    // строки владений + owner-колонки `attachments`.
    pushOwnedAttachments(ndb, layerId, 'link', linkIds, selection);
    push(
      'attachments',
      layerIds(
        ndb,
        'attachments',
        layerId,
        `owner_type = 'link' AND owner_id IN (${placeholders})`,
        ...linkIds,
      ),
    );
    const linkCommentIds = layerIds(
      ndb,
      'comments',
      layerId,
      `owner_type = 'link' AND owner_id IN (${placeholders})`,
      ...linkIds,
    );
    push('comments', linkCommentIds);
    push('comment_targets', commentTargetRows(ndb, layerId, linkCommentIds));
  }

  for (const table of Object.keys(selection) as BranchableTable[]) {
    selection[table] = [...new Set(selection[table])];
  }
  return selection;
}

/** Ids of the layer's own rows of `table` matching `where` (§4.2 intentional
 * physical read). */
function layerIds(
  ndb: NetworkDb,
  table: BranchableTable,
  layerId: string,
  where: string,
  ...args: unknown[]
): string[] {
  return (
    ndb
      .prepare(`SELECT id FROM ${table} WHERE layer_id = ? AND ${where} -- layers:physical-read`)
      .all(layerId, ...args) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Добавить в набор строки владений (`attachment_owners`) перечисленных объектов
 * и строки вложений, созданных в СЛОЕ (0.12.1, ADR 9f90b010): владелец вложения
 * определяется строками владений, а не owner-колонками `attachments`. Вложение,
 * живущее только в основе, в набор не попадает — его разрешит замыкание по
 * цепочке (`resolveLiveRow`), как и раньше.
 */
function pushOwnedAttachments(
  ndb: NetworkDb,
  layerId: string,
  ownerType: 'thought' | 'link',
  ownerIds: string[],
  selection: MergeSelection,
): void {
  if (ownerIds.length === 0) return;
  const ownerPlaceholders = ownerIds.map(() => '?').join(', ');
  const ownerships = ndb
    .prepare(
      `SELECT id, attachment_id FROM attachment_owners -- layers:physical-read
       WHERE layer_id = ? AND owner_type = ? AND owner_id IN (${ownerPlaceholders})`,
    )
    .all(layerId, ownerType, ...ownerIds) as Array<{ id: string; attachment_id: string }>;
  if (ownerships.length === 0) return;
  (selection.attachment_owners ??= []).push(...ownerships.map((o) => o.id));
  const attachmentIds = [...new Set(ownerships.map((o) => o.attachment_id))];
  const attachmentPlaceholders = attachmentIds.map(() => '?').join(', ');
  const attachments = ndb
    .prepare(
      `SELECT id FROM attachments -- layers:physical-read
       WHERE layer_id = ? AND id IN (${attachmentPlaceholders})`,
    )
    .all(layerId, ...attachmentIds) as Array<{ id: string }>;
  if (attachments.length > 0) {
    (selection.attachments ??= []).push(...attachments.map((a) => a.id));
  }
}

/** Layer `comment_targets` rows attached to any of `commentIds`. */
function commentTargetRows(ndb: NetworkDb, layerId: string, commentIds: string[]): string[] {
  if (commentIds.length === 0) return [];
  const placeholders = commentIds.map(() => '?').join(', ');
  return layerIds(ndb, 'comment_targets', layerId, `comment_id IN (${placeholders})`, ...commentIds);
}

// ---------------------------------------------------------------------------
// Объединение постоянного комментария (режим combine)
// ---------------------------------------------------------------------------

/** Маркеры конфликтов git-стиля для объединённого комментария. */
export const COMMENT_MERGE_MARKER_LAYER = '<<<<<<< слой';
export const COMMENT_MERGE_MARKER_SEPARATOR = '=======';
export const COMMENT_MERGE_MARKER_TARGET = '>>>>>>> основа';

/** Верхняя граница таблицы LCS (строки²): выше — конфликт всем текстом, чтобы
 * не съесть память на гигантском комментарии. */
const COMMENT_MERGE_LCS_MAX_CELLS = 4_000_000;

/** Разбить текст на строки; пустой текст — пустой список (без `['']`). */
function splitCommentLines(body: string): string[] {
  return body.length === 0 ? [] : body.split('\n');
}

/** Результат построчного объединения постоянного комментария. */
export interface CommentMergeResult {
  body: string;
  /** Число вставленных конфликтных блоков. */
  conflicts: number;
}

/** Целый текст как один конфликтный блок (крупные тексты и спорные случаи). */
function wholeTextConflict(layerBody: string, targetBody: string): CommentMergeResult {
  const block = [
    COMMENT_MERGE_MARKER_LAYER,
    layerBody,
    COMMENT_MERGE_MARKER_SEPARATOR,
    targetBody,
    COMMENT_MERGE_MARKER_TARGET,
  ].join('\n');
  return { body: block, conflicts: 1 };
}

/**
 * Объединение двух доступных версий постоянного комментария (слоя и основы)
 * построчно, с маркерами конфликтов git-стиля.
 *
 * Общего предка система не хранит (в `comments` — только текущее содержимое и
 * `version`), поэтому настоящий трёхсторонний дифф невозможен. Алгоритм: LCS по
 * строкам даёт общие строки; в промежутках строки, которые есть только в одной
 * версии, приписываются ей (непересекающиеся правки объединяются без
 * конфликта), а промежуток, где у обеих версий есть свои строки, помечается
 * конфликтом и сохраняет ОБА варианта — ни один текст не теряется.
 */
export function mergeCommentText(layerBody: string, targetBody: string): CommentMergeResult {
  if (layerBody === targetBody) return { body: layerBody, conflicts: 0 };
  const ours = splitCommentLines(layerBody);
  const theirs = splitCommentLines(targetBody);
  if ((ours.length + 1) * (theirs.length + 1) > COMMENT_MERGE_LCS_MAX_CELLS) {
    return wholeTextConflict(layerBody, targetBody);
  }

  // LCS по строкам: dp[i][j] — длина LCS(ours[i:], theirs[j:]).
  const width = theirs.length + 1;
  const dp = new Uint32Array((ours.length + 1) * width);
  for (let i = ours.length - 1; i >= 0; i -= 1) {
    for (let j = theirs.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        ours[i] === theirs[j]
          ? (dp[(i + 1) * width + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }

  // Пары совпавших строк (обратный ход), в прямом порядке.
  const matches: Array<[number, number]> = [];
  let i = ours.length;
  let j = theirs.length;
  while (i > 0 && j > 0) {
    if (ours[i - 1] === theirs[j - 1]) {
      matches.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if ((dp[(i - 1) * width + j] as number) >= (dp[i * width + j - 1] as number)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  matches.reverse();

  const out: string[] = [];
  let conflicts = 0;
  let oi = 0;
  let tj = 0;
  const flushHunk = (oiEnd: number, tjEnd: number): void => {
    const layerSeg = ours.slice(oi, oiEnd);
    const targetSeg = theirs.slice(tj, tjEnd);
    if (layerSeg.length === 0 && targetSeg.length === 0) return;
    if (targetSeg.length === 0) {
      out.push(...layerSeg);
      return;
    }
    if (layerSeg.length === 0) {
      out.push(...targetSeg);
      return;
    }
    out.push(
      COMMENT_MERGE_MARKER_LAYER,
      ...layerSeg,
      COMMENT_MERGE_MARKER_SEPARATOR,
      ...targetSeg,
      COMMENT_MERGE_MARKER_TARGET,
    );
    conflicts += 1;
  };
  for (const [mo, mt] of matches) {
    flushHunk(mo, mt);
    out.push(ours[mo] as string);
    oi = mo + 1;
    tj = mt + 1;
  }
  flushHunk(ours.length, theirs.length);
  return { body: out.join('\n'), conflicts };
}

/** Постоянный комментарий мысли, как его видит цепочка слияния (предок). */
function resolveTargetPermanentComment(
  ndb: NetworkDb,
  thoughtId: string,
): { id: string; body_md: string; version: number } | undefined {
  return ndb
    .prepare(
      `SELECT c.id AS id, c.body_md AS body_md, c.version AS version FROM main.comments c
       JOIN temp.merge_chain mc ON mc.layer_id = c.layer_id
       WHERE c.owner_type = 'thought' AND c.owner_id = ? AND c.kind = 'permanent'
         AND NOT EXISTS (
           SELECT 1 FROM main.comments c2
           JOIN temp.merge_chain mc2 ON mc2.layer_id = c2.layer_id
           WHERE c2.owner_type = 'thought' AND c2.owner_id = c.owner_id
             AND c2.kind = 'permanent' AND mc2.depth < mc.depth
         )
       LIMIT 1`,
    )
    .get(thoughtId) as { id: string; body_md: string; version: number } | undefined;
}

/**
 * Режим `combine`: постоянный комментарий мысли в слое переписывается
 * объединением с текущей версией основы (маркеры конфликтов). Хроно-записи и
 * остальные строки сюда не входят — их переносит обычный реплей (версия слоя).
 *
 * Объединение выполняется только при настоящем конфликте (`base_version` тени
 * отстал от версии основы): если основа комментарий не меняла, побеждает версия
 * слоя без маркеров.
 */
function combineThoughtComment(
  ndb: NetworkDb,
  layerId: string,
  thoughtId: string,
): LayerThoughtMergeResult {
  const result: LayerThoughtMergeResult = {
    thought_id: thoughtId,
    mode: 'combine',
    comment_merged: false,
    comment_conflicts: 0,
  };
  const layerRow = ndb
    .prepare(
      `SELECT id, body_md, base_version FROM comments WHERE layer_id = ? AND owner_type = 'thought' AND owner_id = ? AND kind = 'permanent' -- layers:physical-read`,
    )
    .get(layerId, thoughtId) as { id: string; body_md: string; base_version: number } | undefined;
  if (layerRow === undefined) return result; // слой комментарий не менял
  const target = resolveTargetPermanentComment(ndb, thoughtId);
  // Основа не меняла комментарий с момента материализации тени — версия слоя
  // побеждает целиком, объединять нечего.
  if (target === undefined || layerRow.base_version === target.version) return result;
  const merged = mergeCommentText(layerRow.body_md, target.body_md);
  if (merged.body !== layerRow.body_md) {
    ndb
      .prepare(
        `UPDATE comments SET body_md = ?, body_html = ?, version = version + 1, updated_at = ?
          WHERE id = ? -- layers:physical-read`,
      )
      .run(merged.body, renderMarkdown(merged.body), new Date().toISOString(), layerRow.id);
    result.comment_merged = true;
    result.comment_conflicts = merged.conflicts;
  }
  return result;
}

/** Итог слияния одной мысли: обычный отчёт + режим разрешения. */
export interface LayerThoughtMergeOutcome extends LayerMergeOutcome {
  thought_merge: LayerThoughtMergeResult;
}

/**
 * Разрешить изменения ОДНОЙ мысли слоя слиянием в родителя (задача f5c363a3).
 *
 * Набор строк собирается сервером как замкнутое подмножество мысли
 * ({@link collectThoughtLayerRows}); `base_version`-расхождения по этим строкам
 * снимаются — выбранный вариант «версия слоя побеждает» (варианты 2–3 из GUI).
 * Режим `combine` дополнительно объединяет постоянный комментарий.
 */
export function mergeLayerThought(
  ndb: NetworkDb,
  layerId: string,
  thoughtId: string,
  mode: LayerThoughtMergeMode,
  actorUserId: string,
): LayerThoughtMergeOutcome {
  try {
    return ndb.transaction(() => {
      const selection = collectThoughtLayerRows(ndb, layerId, thoughtId);
      if (Object.keys(selection).length === 0) {
        throw new EtnError('VALIDATION_ERROR', 'в слое нет изменений этой мысли — сливать нечего.', {
          field: 'thought_id',
          thought_id: thoughtId,
        });
      }
      // Варианты 2–3: версия слоя побеждает целиком — расхождение base_version
      // по строкам мысли снимается до реплея (иначе слияние откажет 422).
      // Порядок важен: объединение комментария читает `base_version` тени, пока
      // он ещё показывает расхождение, поэтому выполняется ДО сброса.
      const { target } = loadMergeTarget(ndb, layerId);
      setupMergeChain(ndb, target.id);
      const thoughtMerge: LayerThoughtMergeResult =
        mode === 'combine'
          ? combineThoughtComment(ndb, layerId, thoughtId)
          : { thought_id: thoughtId, mode, comment_merged: false, comment_conflicts: 0 };
      resetLayerOverride(ndb, layerId, selection);
      const outcome = mergeLayerInner(ndb, layerId, selection, actorUserId);
      return { ...outcome, thought_merge: thoughtMerge };
    });
  } catch (err) {
    if (err instanceof EtnError) throw err;
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

/**
 * «Отказаться от изменений»: физически удалить из слоя все строки, принадлежащие
 * мысли (замкнутое подмножество {@link collectThoughtLayerRows}). Основа не
 * затрагивается: мысль возвращается к своему состоянию в основе, а созданная
 * только в слое — исчезает. Деструктивно по смыслу (правки слоя теряются),
 * поэтому GUI спрашивает подтверждение.
 */
export function discardLayerThought(
  ndb: NetworkDb,
  layerId: string,
  thoughtId: string,
): LayerDiscardReport {
  return ndb.transaction(() => {
    const { layer, target } = loadMergeTarget(ndb, layerId);
    const selection = collectThoughtLayerRows(ndb, layerId, thoughtId);
    const discarded: Record<string, number> = {};
    let total = 0;
    for (const table of BRANCHABLE_TABLES) {
      const ids = selection[table];
      if (ids === undefined || ids.length === 0) continue;
      let removed = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const res = ndb
          .prepare(
            `DELETE FROM ${table} WHERE layer_id = ? AND id IN (${chunk.map(() => '?').join(', ')})
             -- layers:physical-read`,
          )
          .run(layerId, ...chunk);
        removed += Number(res.changes);
      }
      if (removed > 0) discarded[table] = removed;
      total += removed;
    }
    if (total > 0) {
      ndb
        .prepare('UPDATE layers SET last_activity_at = ? WHERE id = ?')
        .run(new Date().toISOString(), layerId);
    }
    return {
      layer: { id: layer.id, title: layer.title },
      target_layer: { id: target.id, title: target.title },
      thought_id: thoughtId,
      discarded,
      total,
    };
  });
}
