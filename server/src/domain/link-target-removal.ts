/**
 * Умное удаление ребра при удалении цели свойства-связи (0.14.1, задача
 * 58b598d5; ADR a967d865, требование ebb070c2).
 *
 * Единая процедура для ВСЕХ путей удаления цели (крестик чипа в GUI, set-запись
 * без цели в REST `PUT` и MCP write-wrapper, `properties.remove`, «Удалить»
 * внетипового свойства):
 *
 *   * **основа** — физическое удаление живого ребра вместе с зависимостями,
 *     без корзины (событие `link.deleted`);
 *   * **слой, ребро существует в основе/слоях-предках** (видимая строка имеет
 *     `layer_id` предка либо материализованную тень с `base_version > 0`) —
 *     корзина `marked_for_deletion` (событие `link.updated`);
 *   * **слой, ребро создано в текущем слое** (`layer_id` текущий,
 *     `base_version = 0`) — физическое удаление строки слоя (событие
 *     `link.deleted`);
 *   * уже помеченное ребро — no-op без события.
 *
 * Мысль-цель не удаляется и не помечается. Слияние слоя не меняется: это
 * обычный посрочный реплей (требование 24ca954b), поэтому пометка слоя
 * переносится в основу как пометка — merge-service не трогается.
 */

import { EtnError, type Link } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { isBaseContext, materializeShadow } from '../db/layer-write.js';
import { listLinkHoldingLayers } from './holding-layers.js';
import { purgeOwnerDependants } from './owner-cleanup.js';

/** Что произошло с ребром при удалении цели свойства-связи. */
export type LinkRemovalAction = 'deleted' | 'trashed';

/** Результат удаления одного ребра: id, действие и снимок до удаления. */
export interface LinkRemoval {
  link_id: string;
  action: LinkRemovalAction;
  /** Снимок ребра ДО операции — для журнала `deleted` (после удаления его нет). */
  link: Link;
}

/** Видимая в цепочке слоя строка ребра. */
interface VisibleLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  color: string | null;
  style: string | null;
  width: number | null;
  active: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  layer_id: string;
  base_version: number;
}

/** Снимок видимой строки ребра в форму `Link` (для журнала активности). */
function rowToLink(row: VisibleLinkRow): Link {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    type_id: row.type_id,
    color: row.color,
    style: row.style as Link['style'],
    width: row.width,
    active: row.active === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    marked_for_deletion_at: row.marked_for_deletion_at,
    marked_for_deletion_by: row.marked_for_deletion_by,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/**
 * Удалить цель свойства-связи по правилу ADR a967d865. Возвращает `null`,
 * когда ребра уже нет или оно уже помечено (no-op без события). Вызывающий
 * публикует событие по `action`: `deleted` → `link.deleted`, `trashed` →
 * `link.updated` с `marked_for_deletion: true`.
 *
 * Процедура рассчитана на вызов внутри транзакции записи (`runWrite`):
 * физическое удаление и материализация пометки должны быть атомарны с
 * остальной записью свойства.
 */
export function removeLinkTarget(
  ndb: NetworkDb,
  linkId: string,
  actorUserId: string,
): LinkRemoval | null {
  const row = ndb
    .prepare('SELECT * FROM links_v WHERE id = ?')
    .get(linkId) as VisibleLinkRow | undefined;
  if (row === undefined) return null;
  // Уже в корзине — повторная пометка не создаётся, событие не эмитится
  // (уточнение аудита цикла 1).
  if (row.marked_for_deletion === 1) return null;
  const snapshot = rowToLink(row);

  if (isBaseContext(ndb)) {
    // S13: физическое удаление в основе запрещено, пока ребро держит живая
    // тень в рабочем слое (docs/13-layers.md §6.5a) — та же защита, что у
    // `DELETE /links/{id}`.
    const holdingLayers = listLinkHoldingLayers(ndb, linkId);
    if (holdingLayers.length > 0) {
      throw new EtnError('VALIDATION_ERROR', 'link is held by a layer and cannot be deleted', {
        entity: 'link',
        id: linkId,
        blocking: { layers: holdingLayers },
      });
    }
    purgeOwnerDependants(ndb, 'link', [linkId]);
    // Физическое удаление логической строки во всех слоях — поведение основы
    // до S4 (`deleteLink`); держащих слоёв здесь уже нет.
    ndb.prepare('DELETE FROM links WHERE id = ?').run(linkId);
    return { link_id: linkId, action: 'deleted', link: snapshot };
  }

  // Слой. Строка предка (или её материализованная тень) означает, что ребро
  // существует выше: его можно только спрятать корзиной, физическое удаление
  // сделало бы невозможным восстановление и потеряло бы знание основы.
  const existedAbove = row.layer_id !== ndb.layerId || row.base_version > 0;
  if (!existedAbove) {
    // Ребро создано в текущем слое и выше его нет — физически удаляем строку
    // слоя. Зависимости (комментарии/вложения/значения) принадлежат этому же
    // слою: ребра выше не существует.
    purgeOwnerDependants(ndb, 'link', [linkId]);
    ndb
      .prepare('DELETE FROM links WHERE id = ? AND layer_id = ?')
      .run(linkId, ndb.layerId);
    return { link_id: linkId, action: 'deleted', link: snapshot };
  }

  materializeShadow(ndb, 'links', linkId);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  ndb
    .prepare(
      `UPDATE links SET marked_for_deletion = 1, marked_for_deletion_at = ?,
                        marked_for_deletion_by = ?, updated_at = ?, updated_by = ?,
                        updated_at_ms = ?, version = version + 1
        WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, now, actorUserId, nowMs, linkId, ndb.layerId);
  return { link_id: linkId, action: 'trashed', link: snapshot };
}
