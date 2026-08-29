/**
 * Материализация теневых строк — семантика записи слоёв (фаза S, задача S4,
 * docs/13-layers.md §5).
 *
 * До S4 весь доменный слой писал в физические таблицы, а `DEFAULT layer_id`
 * уводил каждую запись в основу. Здесь живёт механизм, который делает запись
 * слой-осознанной:
 *
 *   * {@link materializeShadow} — первая правка логического `id` в слое
 *     копирует разрешённую (§4.1) строку предка в текущий слой: `version`
 *     копируется без инкремента (инкремент делает сама правка — UPDATE),
 *     `base_version` фиксируется равным версии предка и больше не меняется;
 *   * {@link materializeTombstone} — удаление в слое (§5.2): та же
 *     материализация, но со `deleted = 1` и инкрементом версии (удаление —
 *     тоже правка, поэтому `version = V + 1`). Надгробие в слое, где строка
 *     уже есть, — обычный UPDATE `deleted = 1`; повторное удаление — no-op;
 *   * {@link deleteRowLayered} — единая точка для прикладных «удалить строку
 *     X»: в основе — физический `DELETE` (как до S4), в слое — надгробие.
 *
 * Чтения при этом по-прежнему идут через представления `*_v` (§4.2), так что
 * материализованная тень немедленно перекрывает строку предка, а надгробие
 * прячет сущность из всех чтений текущего слоя. Копия строки делается из
 * физической строки-победителя (по `rowid`, который экспонирует представление)
 * — это гарантирует, что тень несёт все столбцы предка, а не только те, что
 * знает конкретный сервис.
 *
 * Таблицы с колонкой `version` (thoughts, links, comments, thought_types,
 * link_types) участвуют в `expected_version`/If-Match; остальные ветвимые
 * таблицы версий не имеют — для них `base_version` материализации равен 0.
 */

import { BASE_LAYER_ID } from '@etn/shared';

import type { NetworkDb } from './network-db.js';
import { BRANCHABLE_TABLES, layerViewName } from './layer-chain.js';

/** Имя ветвимой таблицы (закрытый список, docs/13-layers.md §3). */
export type BranchableTable = (typeof BRANCHABLE_TABLES)[number];

/** Столбцы копии: всё, кроме суррогатного pk и слой-колонок (§3.0.1). */
const COPY_COLUMNS = new Map<BranchableTable, { cols: string[]; hasVersion: boolean }>();

/** Cache PRAGMA table_info per table (schema is fixed after migrations). */
function copyColumns(ndb: NetworkDb, table: BranchableTable): { cols: string[]; hasVersion: boolean } {
  const cached = COPY_COLUMNS.get(table);
  if (cached) return cached;
  const info = ndb.pragma(`table_info(${table})`) as Array<{ name: string }>;
  const skip = new Set(['pk', 'layer_id', 'deleted', 'base_version', 'version']);
  const cols = info.map((c) => c.name).filter((name) => !skip.has(name));
  const hasVersion = info.some((c) => c.name === 'version');
  const result = { cols, hasVersion };
  COPY_COLUMNS.set(table, result);
  return result;
}

/** True when the connection's layer context is the base layer. */
export function isBaseContext(ndb: NetworkDb): boolean {
  return ndb.layerId === BASE_LAYER_ID;
}

/** Touch `layers.last_activity_at` of the current layer (docs/13-layers.md §2.2). */
function touchLayerActivity(ndb: NetworkDb): void {
  ndb
    .prepare('UPDATE layers SET last_activity_at = ? WHERE id = ?')
    .run(new Date().toISOString(), ndb.layerId);
}

/**
 * Первая правка строки в слое: копия разрешённой строки предка в текущий слой
 * (`deleted = 0`, `version` — копия, `base_version` — версия предка). No-op,
 * когда строка в текущем слое уже есть. Возвращает `false`, только если
 * логического `id` вообще не видно (вышестоящий сервис уже отвергнул бы это
 * как `NOT_FOUND` — защита от гонки внутри транзакции).
 */
export function materializeShadow(ndb: NetworkDb, table: BranchableTable, id: string): boolean {
  const exists = ndb
    .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND layer_id = ? LIMIT 1`)
    .get(id, ndb.layerId);
  if (exists) return true;
  const winner = ndb
    .prepare(`SELECT rowid FROM ${layerViewName(table)} WHERE id = ? LIMIT 1`)
    .get(id) as { rowid: number } | undefined;
  if (!winner) return false;
  insertShadowCopy(ndb, table, winner.rowid, false);
  return true;
}

/**
 * Надгробие в текущем слое (§5.2): скрыть логическую строку, не трогая предка.
 * Строка слоя есть → `UPDATE deleted = 1` с инкрементом версии; нет → копия
 * предка сразу надгробием (`version = V + 1`, `base_version = V`). Повторный
 * вызов — no-op. Возвращает `false`, когда прятать нечего (строка не видна).
 */
export function materializeTombstone(ndb: NetworkDb, table: BranchableTable, id: string): boolean {
  const own = ndb
    .prepare(`SELECT deleted FROM ${table} WHERE id = ? AND layer_id = ? LIMIT 1`)
    .get(id, ndb.layerId) as { deleted: number } | undefined;
  if (own) {
    if (own.deleted === 0) {
      const { hasVersion } = copyColumns(ndb, table);
      ndb
        .prepare(
          `UPDATE ${table} SET deleted = 1${hasVersion ? ', version = version + 1' : ''}
           WHERE id = ? AND layer_id = ?`,
        )
        .run(id, ndb.layerId);
      touchLayerActivity(ndb);
    }
    return true;
  }
  const winner = ndb
    .prepare(`SELECT rowid FROM ${layerViewName(table)} WHERE id = ? LIMIT 1`)
    .get(id) as { rowid: number } | undefined;
  if (!winner) return false;
  insertShadowCopy(ndb, table, winner.rowid, true);
  return true;
}

/**
 * Удаление строки как прикладная операция: в основе — физический `DELETE`
 * (выметает строки всех слоёв — поведение до S4), в слое — надгробие
 * ({@link materializeTombstone}). Возвращает число физически удалённых строк
 * (в слоёном контексте — 1 при успехе надгробия, 0, если прятать нечего).
 */
export function deleteRowLayered(ndb: NetworkDb, table: BranchableTable, id: string): number {
  if (isBaseContext(ndb)) {
    return ndb.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes;
  }
  return materializeTombstone(ndb, table, id) ? 1 : 0;
}

/**
 * Копия физической строки-победителя (`rowid` из представления `*_v`) в текущий
 * слой. `tombstone = true` — сразу надгробие с инкрементом версии (§5.2);
 * `false` — живая тень с копией версии (§5.1: инкремент сделает правка).
 */
function insertShadowCopy(ndb: NetworkDb, table: BranchableTable, winnerRowid: number, tombstone: boolean): void {
  const { cols, hasVersion } = copyColumns(ndb, table);
  const colList = ['id', 'layer_id', 'deleted', 'base_version', ...(hasVersion ? ['version'] : []), ...cols];
  // base_version — всегда версия предка (§5.1: фиксируется на момент
  // материализации и не меняется); безверсионные таблицы пишут 0 — конфликтов
  // слияния по ним не детектируют, S8 разберётся отдельно. Инкремент версии —
  // только у version надгробия (удаление — тоже правка, §5.2).
  const selectList = [
    'id',
    '?',
    tombstone ? '1' : '0',
    hasVersion ? 'COALESCE(version, 0)' : '0',
    ...(hasVersion ? [tombstone ? 'version + 1' : 'version'] : []),
    ...cols,
  ];
  ndb
    .prepare(
      `INSERT INTO ${table} (${colList.join(', ')})
       SELECT ${selectList.join(', ')} FROM ${table} WHERE rowid = ?`,
    )
    .run(ndb.layerId, winnerRowid);
  touchLayerActivity(ndb);
}
