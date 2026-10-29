/**
 * Единая точка удаления типа мысли вместе с его отборами (0.14.1, ошибка
 * 1242f78d).
 *
 * До фикса каскад существовал только в MCP-ветке (`ontology-delete-service`),
 * REST `DELETE /thought-types/{id}` оставлял строки `thought_type_views`
 * сиротами, а MCP снимал список отборов ПОСЛЕ удаления типа — события
 * `thought-type-view.deleted` фактически не уходили.
 *
 * Здесь каскад и удаление выполняются одной транзакцией в правильном порядке:
 * снять снапшоты отборов → удалить отборы → удалить тип. Снапшоты возвращаются
 * транспорту, который эмитит `thought-type-view.deleted` на каждый отбор
 * (полная карточка, ошибка 69aa355c) и `thought-type.deleted` на тип.
 *
 * Циклического импорта нет: модуль зависит от `thought-type-service` и
 * `thought-type-views-service`, а те друг от друга — нет (views-service уже
 * читает type-service, поэтому каскад не мог жить внутри type-service).
 */

import type { EffectiveThoughtTypeView, ThoughtType } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  deleteThoughtType,
  getThoughtType,
  type DeleteThoughtTypeOptions,
} from './thought-type-service.js';
import {
  deleteThoughtTypeView,
  listOwnEffectiveTypeViews,
} from './thought-type-views-service.js';

/** Итог удаления типа: карточка типа и снапшоты каскадно удалённых отборов. */
export interface DeleteThoughtTypeWithViewsResult {
  /** Карточка типа ДО удаления (`null`, если строки не было — тогда бросит). */
  type: ThoughtType | null;
  /** Собственные отборы типа, удалённые каскадом (снапшоты ДО удаления). */
  views: EffectiveThoughtTypeView[];
}

/**
 * Удалить тип мысли и каскадно — все его собственные отборы (REST и MCP идут
 * этим путём, ошибка 1242f78d).
 *
 * Отборы удаляются ПЕРВЫМИ, пока тип ещё жив: `deleteThoughtTypeView` адресует
 * строку через `thought_type_views_v`, а после удаления типа её владелец уже
 * не разрешается. Наследуемые от предков отборы не трогаются — они принадлежат
 * другому типу (`thought_type_id` строки).
 *
 * Семантика ошибок — как у {@link deleteThoughtType}: `NOT_FOUND`,
 * `VERSION_CONFLICT`, `VALIDATION_ERROR` для корневого типа/подчинённых/force.
 */
export function deleteThoughtTypeWithViews(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
  opts: DeleteThoughtTypeOptions = {},
): DeleteThoughtTypeWithViewsResult {
  return ndb.transaction(() => {
    // Снапшоты и каскад — только для существующего типа: `deleteThoughtType`
    // ниже отдаст канонический NOT_FOUND, если строки нет.
    const type = getThoughtType(ndb, id);
    const views = type === null ? [] : listOwnEffectiveTypeViews(ndb, id);
    for (const view of views) {
      deleteThoughtTypeView(ndb, view.id);
    }
    deleteThoughtType(ndb, id, expectedVersion, opts);
    return { type, views };
  });
}
