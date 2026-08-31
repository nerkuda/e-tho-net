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
 * в висячую ссылку.
 *
 * Контекст текущего слоя соединения (S11, «проверка из рабочего слоя»):
 * теневая строка **самого** текущего слоя — это и есть проверяемая строка,
 * поэтому она из удержаний исключается (иначе мысль, созданная в слое,
 * блокировала бы сама себя); а живая строка **основы** удерживает — «удалить
 * совсем» в слое можно только то, чего в основе нет, иначе удаление не
 * физическое (надгробие), а эффект «пропало из основы» появится лишь после
 * слияния — для пользователя это обман. Такая проверка возвращает основу
 * элементом списка `{ id: BASE_LAYER_ID, title: 'Основа' }`.
 */

import { BASE_LAYER_ID, type HoldingLayerRef } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { existsInBaseLayer, isBaseContext } from '../db/layer-write.js';

/** Заголовок основы фиксирован спецификацией (13-layers.md §2.2). */
const BASE_LAYER_TITLE = 'Основа';

/**
 * Живые теневые строки-удержания во всех не-основных слоях, кроме текущего
 * слоя соединения (его собственная тень — и есть проверяемая строка).
 */
function otherHoldingLayers(
  ndb: NetworkDb,
  holdersQuery: string,
  params: unknown[],
): HoldingLayerRef[] {
  return ndb
    .prepare(
      `SELECT l.id, l.title
       FROM layers l
       WHERE l.is_base = 0 AND l.id <> ? AND l.id IN (
       ${holdersQuery}
       )
       ORDER BY l.created_at, l.id`,
    )
    .all(ndb.layerId, ...params) as HoldingLayerRef[];
}

/**
 * Layers holding a **thought** back from physical deletion: every non-base
 * layer other than the connection's own with a live (`deleted = 0`) shadow row
 * of the thought itself or of a link where the thought is an endpoint, plus —
 * in a working-layer context — the base layer when the thought still has a live
 * row there (the deletion would be a tombstone, not a real delete). Ordered by
 * layer creation time so the caller's list is stable; the base entry goes first.
 */
export function listThoughtHoldingLayers(ndb: NetworkDb, thoughtId: string): HoldingLayerRef[] {
  const holding = otherHoldingLayers(
    ndb,
    `SELECT layer_id FROM thoughts WHERE id = ? AND deleted = 0 -- layers:physical-read
     UNION
     SELECT layer_id FROM links WHERE (source_id = ? OR target_id = ?) AND deleted = 0 -- layers:physical-read`,
    [thoughtId, thoughtId, thoughtId],
  );
  if (!isBaseContext(ndb) && existsInBaseLayer(ndb, 'thoughts', thoughtId)) {
    holding.unshift({ id: BASE_LAYER_ID, title: BASE_LAYER_TITLE });
  }
  return holding;
}

/**
 * Layers holding a **link** back from physical deletion: every non-base layer
 * other than the connection's own with a live (`deleted = 0`) shadow row of the
 * link itself, plus — in a working-layer context — the base layer when the link
 * still has a live row there. (Для связей «использование в свойствах» не бывает
 * — 02-data-model.md §3.1.2.)
 */
export function listLinkHoldingLayers(ndb: NetworkDb, linkId: string): HoldingLayerRef[] {
  const holding = otherHoldingLayers(
    ndb,
    `SELECT layer_id FROM links WHERE id = ? AND deleted = 0 -- layers:physical-read`,
    [linkId],
  );
  if (!isBaseContext(ndb) && existsInBaseLayer(ndb, 'links', linkId)) {
    holding.unshift({ id: BASE_LAYER_ID, title: BASE_LAYER_TITLE });
  }
  return holding;
}

