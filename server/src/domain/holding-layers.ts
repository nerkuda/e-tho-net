/**
 * «Удерживающие слои» для проверки физического удаления (S2,
 * docs/02-data-model.md §3.1.2 п.2–3, docs/13-layers.md §6.3).
 *
 * После снятия SQL-FK между сущностями (логический `id` больше не уникален)
 * физическое удаление мысли/связи из корзины обязано смотреть в теневые
 * строки **всех** слоёв сети: надгробие (`deleted = 1`) в слое означает
 * «слой тоже хочет удалить» и не удерживает, а живая (`deleted = 0`) теневая
 * строка — удерживает: физическое удаление вырвало бы землю из-под неё.
 *
 * Для мысли удерживающими являются и теневые строки **связей**, у которых она
 * — конец (13-layers.md §6.3): связь, перекрытая в слое, не должна превращаться
 * в висячую ссылку. До S7 никаких слоёв, кроме основы, не существует, поэтому
 * на практике эти списки пусты — но контракт `deletion-check` работает уже
 * сейчас (shared `HoldingLayerRef`).
 */

import type { HoldingLayerRef } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Row shape of the `layers` projection used by the queries below. */
type LayerRefRow = HoldingLayerRef;

/**
 * Layers holding a **thought** back from physical deletion: every non-base
 * layer with a live (`deleted = 0`) shadow row of the thought itself or of a
 * link where the thought is an endpoint. Ordered by layer creation time so the
 * caller's list is stable.
 */
export function listThoughtHoldingLayers(ndb: NetworkDb, thoughtId: string): HoldingLayerRef[] {
  // layers:physical-read — аудит теней ВСЕХ слоёв сети, а не разрешение цепочки.
  return (
    ndb
      .prepare(
        `SELECT l.id, l.title
         FROM layers l
         WHERE l.is_base = 0 AND l.id IN (
           SELECT layer_id FROM thoughts WHERE id = ? AND deleted = 0 -- layers:physical-read
           UNION
           SELECT layer_id FROM links WHERE (source_id = ? OR target_id = ?) AND deleted = 0 -- layers:physical-read
         )
         ORDER BY l.created_at, l.id`,
      )
      .all(thoughtId, thoughtId, thoughtId) as LayerRefRow[]
  );
}

/**
 * Layers holding a **link** back from physical deletion: every non-base layer
 * with a live (`deleted = 0`) shadow row of the link itself. (Для связей
 * «использование в свойствах» не бывает — 02-data-model.md §3.1.2.)
 */
export function listLinkHoldingLayers(ndb: NetworkDb, linkId: string): HoldingLayerRef[] {
  // layers:physical-read — аудит теней ВСЕХ слоёв сети, а не разрешение цепочки.
  return (
    ndb
      .prepare(
        `SELECT l.id, l.title
         FROM layers l
         WHERE l.is_base = 0 AND l.id IN (
           SELECT layer_id FROM links WHERE id = ? AND deleted = 0 -- layers:physical-read
         )
         ORDER BY l.created_at, l.id`,
      )
      .all(linkId) as LayerRefRow[]
  );
}
