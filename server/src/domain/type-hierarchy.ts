/**
 * Shared helpers for the type hierarchy (L21, docs/02-data-model.md §3.3/§3.7).
 *
 * `thought_types` and `link_types` are trees with a single undeletable root
 * («основной тип», `is_root = 1`). Both tables expose the same `parent_id`
 * column, so every helper below is table-parameterised. The trees are tiny,
 * so plain per-row parent walks are fine — no recursive CTEs needed.
 *
 * Reads go through the layer-resolving views (`${table}_v`,
 * docs/13-layers.md §13): the inheritance chain is computed over the rows the
 * connection's layer resolves, not over raw physical rows of every layer.
 */

import { BASE_LAYER_ID, EtnError, isLinkTypeFilterActive, type LinkTypeFilterInput } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Which of the two type tables a hierarchy helper operates on. */
export type TypeTable = 'thought_types' | 'link_types';

/** Maximum tree depth including the root (docs/08-ui-spec.md §8.1). */
export const MAX_TYPE_DEPTH = 4;

/** Minimal `id, parent_id, is_root, name` projection shared by both tables. */
export interface TypeNodeRow {
  id: string;
  parent_id: string | null;
  is_root: number;
}

/** Read the id/parent_id/is_root projection of every row of a type table. */
export function listTypeNodes(ndb: NetworkDb, table: TypeTable): TypeNodeRow[] {
  return ndb.prepare(`SELECT id, parent_id, is_root FROM ${table}_v`).all() as TypeNodeRow[];
}

/** The single root type of a table, or `null` (only possible mid-migration). */
export function getRootTypeId(ndb: NetworkDb, table: TypeTable): string | null {
  const row = ndb
    .prepare(`SELECT id FROM ${table}_v WHERE is_root = 1`)
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The chain of a type's ancestor ids, from the type itself up to (and
 * including) the root. Unknown ids yield an empty chain.
 */
export function typeAncestors(ndb: NetworkDb, table: TypeTable, typeId: string): string[] {
  const byId = new Map(listTypeNodes(ndb, table).map((n) => [n.id, n]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(typeId);
  while (current) {
    if (seen.has(current.id)) break; // corrupt cycle — stop defensively
    seen.add(current.id);
    chain.push(current.id);
    if (current.parent_id === null) break;
    current = byId.get(current.parent_id);
  }
  return chain;
}

/** Depth of a type in the tree: the root is 1, its children 2, and so on. */
export function typeDepth(ndb: NetworkDb, table: TypeTable, typeId: string): number {
  return typeAncestors(ndb, table, typeId).length;
}

/** Height of the subtree rooted at a type: a leaf is 1. Unknown id → 0. */
export function subtreeHeight(ndb: NetworkDb, table: TypeTable, typeId: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const node of listTypeNodes(ndb, table)) {
    if (node.parent_id === null) continue;
    const list = childrenOf.get(node.parent_id);
    if (list) list.push(node.id);
    else childrenOf.set(node.parent_id, [node.id]);
  }
  const height = (id: string): number => {
    const kids = childrenOf.get(id) ?? [];
    let best = 0;
    for (const kid of kids) best = Math.max(best, height(kid));
    return 1 + best;
  };
  return height(typeId);
}

/**
 * Every type id in the subtree rooted at `typeId`, including itself. Used to
 * expand `type_ids` filters: matching a parent type matches its descendants
 * with OR semantics (docs/03-server-api.md §6.10/§20).
 */
export function subtreeIds(ndb: NetworkDb, table: TypeTable, typeId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const node of listTypeNodes(ndb, table)) {
    if (node.parent_id === null) continue;
    const list = childrenOf.get(node.parent_id);
    if (list) list.push(node.id);
    else childrenOf.set(node.parent_id, [node.id]);
  }
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const kid of childrenOf.get(id) ?? []) walk(kid);
  };
  walk(typeId);
  return out;
}

/**
 * Expand a list of type ids to itself plus all descendants (deduplicated).
 * An empty list stays empty (= no filter). Unknown ids are kept verbatim —
 * they match nothing (type columns only store existing ids), which preserves
 * the «deleted type in a saved filter filters everything out» behaviour.
 */
export function expandTypeIdsToSubtree(
  ndb: NetworkDb,
  table: TypeTable,
  ids: readonly string[],
): string[] {
  if (ids.length === 0) return [];
  const known = new Set(listTypeNodes(ndb, table).map((n) => n.id));
  const expanded = new Set<string>();
  for (const id of ids) {
    if (!known.has(id)) {
      expanded.add(id);
      continue;
    }
    for (const sub of subtreeIds(ndb, table, id)) expanded.add(sub);
  }
  return [...expanded];
}

/**
 * SQL clause of the traversal link-type filter (задача c965ad03, требование
 * bed23c25 «Фильтр обхода по типам связей»).
 *
 * `alias` is the SQL alias of a `links_v` reference (`'l'`, `'lp'`, …) whose
 * `type_id` column the clause constrains. Returns `null` when the filter is
 * absent/empty — the caller must then keep the historical "walk every edge"
 * behaviour. The typed ids are expanded to their `link_types` subtrees here,
 * so every caller shares the same descendant semantics; unknown ids are kept
 * verbatim (they match nothing — same preservation rule as the thought-type
 * filters). A filter that selects no types and no structural links yields the
 * guaranteed-false `0` fragment.
 */
export function linkTypeFilterClause(
  ndb: NetworkDb,
  filter: LinkTypeFilterInput | undefined,
  alias: string,
): { sql: string; params: unknown[] } | null {
  if (!isLinkTypeFilterActive(filter)) return null;
  const expanded = expandTypeIdsToSubtree(ndb, 'link_types', filter?.type_ids ?? []);
  const structural = filter?.include_structural === true;
  if (expanded.length === 0) {
    return structural
      ? { sql: `${alias}.type_id IS NULL`, params: [] }
      : { sql: '0', params: [] };
  }
  const placeholders = expanded.map(() => '?').join(',');
  return {
    sql: structural
      ? `(${alias}.type_id IN (${placeholders}) OR ${alias}.type_id IS NULL)`
      : `${alias}.type_id IN (${placeholders})`,
    params: expanded,
  };
}

/**
 * Validate a parent assignment for a type (create or reparent).
 *
 * Throws `NOT_FOUND` when the parent does not exist and `VALIDATION_ERROR`
 * when the parent is the type itself, one of its descendants (would create a
 * cycle), or when the resulting tree would exceed {@link MAX_TYPE_DEPTH}
 * levels.
 */
export function assertParentValid(
  ndb: NetworkDb,
  table: TypeTable,
  typeId: string | null,
  parentId: string | null,
): void {
  // null parent means «directly under the root» — nothing to validate.
  if (parentId === null) return;
  const parent = ndb.prepare(`SELECT id FROM ${table}_v WHERE id = ?`).get(parentId) as
    | { id: string }
    | undefined;
  if (!parent) {
    throw new EtnError('NOT_FOUND', `parent type ${parentId} not found`, {
      entity: 'type',
      id: parentId,
    });
  }
  if (typeId !== null) {
    if (parentId === typeId) {
      throw new EtnError('VALIDATION_ERROR', 'тип не может быть родителем самого себя', {
        entity: 'type',
        id: typeId,
      });
    }
    if (subtreeIds(ndb, table, typeId).includes(parentId)) {
      throw new EtnError('VALIDATION_ERROR', 'родительский тип не может быть подчинённым этого типа', {
        entity: 'type',
        id: typeId,
        parent_id: parentId,
      });
    }
  }
  // Depth check: the parent's own depth + the height of the type's subtree
  // must fit into MAX_TYPE_DEPTH levels.
  const parentDepth = typeDepth(ndb, table, parentId);
  const subtree = typeId === null ? 1 : subtreeHeight(ndb, table, typeId);
  if (parentDepth + subtree > MAX_TYPE_DEPTH) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `вложенность типов ограничена ${MAX_TYPE_DEPTH} уровнями, включая корневой тип`,
      { entity: 'type', id: typeId, parent_id: parentId },
    );
  }
}

// ===========================================================================
// Reparent-impact helper (задача 8ea1ab6a, версия 0.8.2)
//
// Снят безусловный запрет «тип используется в N записях — смена родителя
// невозможна» (link-type-service.ts:331-356, thought-type-service.ts:309-336
// в предыдущей версии). Новая логика:
//
//   1. Запрет по живым слоям: если в любом не-базовом слое сети есть мысли
//      (для типов мыслей) или связи (для типов связей) с типом из множества
//      {изменяемый тип + все его потомки + текущий родитель + новый родитель},
//      смена родителя отвергается 422 с перечнем затронутых слоёв.
//   2. Иначе для типов мыслей: 422 с details { kind: 'reparent_impact', … }
//      и интерактивным подтверждением (повторный PATCH с `confirmed=true`).
//   3. Для типов связей: смена выполняется сразу (у свойств связей нет
//      UI-редактора — предупреждать не о чем).
//
// Запрос идёт по физическим таблицам `thoughts` / `links`, а не по `*_v`:
// «живая» строка слоя — это материализованная тень или строка, созданная в
// этом слое. Слой без тени записи не учитывается — наследование типов он всё
// равно прочтёт через `*_v` без собственного мнения.
//
// Только слои `is_base = 0`. Слитый/удалённый слой физически отсутствует
// в `layers` (ON DELETE CASCADE на поддереве), и его строки выкошены тем же
// каскадом (13-layers.md §2.4).
// ===========================================================================

/**
 * Сводный перечень слоёв с теневыми строками записей, ссылающихся на тип из
 * `affectedTypeIds`. Возвращаемые слои — не базовые (живые рабочие); для
 * каждого — id, заголовок и число затронутых строк.
 */
export interface ReparentImpactLayer {
  layer_id: string;
  layer_title: string;
  count: number;
}

/** Сводный итог перепланирования parent_id: счётчики + перечень слоёв. */
export interface ReparentImpact {
  /** Число затронутых строк по всему множеству слоёв и типов. */
  total_count: number;
  /** Число живых (не базовых) слоёв, где есть затронутые строки. */
  layers_open_count: number;
  /** Слои с числом затронутых строк в каждом. */
  layers: ReparentImpactLayer[];
  /** Ид типов, вошедших в проверку (включая сам тип + потомки + старый/новый родители). */
  affected_type_ids: string[];
}

/**
 * Подсчитать затронутые записи при планируемой смене `parent_id` для `typeId`
 * (таблица `thought_types` или `link_types`). Множество проверяемых типов —
 * сам тип, все его потомки, текущий родитель и новый родитель.
 *
 * Возвращает `null`, когда смена родителя — no-op (тип не имеет ни старого,
 * ни нового родителя, или оба совпадают).
 */
export function computeReparentImpact(
  ndb: NetworkDb,
  table: TypeTable,
  typeId: string,
  currentParentId: string | null,
  newParentId: string | null,
): ReparentImpact | null {
  if (currentParentId === newParentId) return null;

  // Множество проверяемых id: сам тип, потомки, оба родителя (если заданы).
  const ids = new Set<string>([typeId, ...subtreeIds(ndb, table, typeId)]);
  if (currentParentId !== null) ids.add(currentParentId);
  if (newParentId !== null) ids.add(newParentId);
  const idList = [...ids];

  // Физический запрос: слои `is_base = 0` (живые рабочие), запись
  // не удалена (`deleted = 0`), `type_id` входит в проверяемое множество.
  // Таблица записей зависит от переданной таблицы типов.
  const recordTable: 'thoughts' | 'links' = table === 'thought_types' ? 'thoughts' : 'links';
  const placeholders = idList.map(() => '?').join(',');
  const sql =
    `SELECT t.layer_id AS layer_id, l.title AS layer_title, COUNT(*) AS count ` +
    `FROM ${recordTable} t ` +
    `JOIN layers l ON l.id = t.layer_id AND l.is_base = 0 ` +
    `WHERE t.type_id IN (${placeholders}) AND t.deleted = 0 ` +
    `GROUP BY t.layer_id, l.title ` +
    `ORDER BY count DESC, t.layer_id`;

  const rows = ndb.prepare(sql).all(...idList) as Array<{
    layer_id: string;
    layer_title: string;
    count: number;
  }>;

  const total = rows.reduce((s, r) => s + r.count, 0);
  return {
    total_count: total,
    layers_open_count: rows.length,
    layers: rows.map((r) => ({
      layer_id: r.layer_id,
      layer_title: r.layer_title,
      count: r.count,
    })),
    affected_type_ids: idList,
  };
}

/**
 * Истина, когда в сетевой БД ровно один слой — базовый. В такой сети живой
 * слой невозможен; перепланирование parent_id по живым слоям всегда
 * «разрешает» (базовые записи в подсчёт не идут — они переоценятся
 * через `*_v` независимо).
 */
export function hasOnlyBaseLayer(ndb: NetworkDb): boolean {
  // BASE_LAYER_ID — фиксированный id основы (13-layers.md §2.1).
  const row = ndb.prepare('SELECT COUNT(*) AS c FROM layers WHERE id <> ?').get(BASE_LAYER_ID) as {
    c: number;
  };
  return row.c === 0;
}
