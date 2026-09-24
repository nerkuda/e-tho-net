/**
 * Живая тройка связи `(source, target, type_id)`: поиск и восстановление из
 * корзины.
 *
 * Общий низкоуровневый примитив для создания связи (`link-service.createLink`)
 * и для записи значений свойства-связи (`property-service`). Эти модули лежат
 * по разные стороны зависимости `link-service → property-service` (цикл
 * импортов намеренно не допускается — см. комментарий к `insertLinkRow`),
 * поэтому примитив вынесен в нейтральный модуль без собственных зависимостей
 * от них.
 *
 * Норма (требование 4591f837, обновлено 2026-09-24 задачей 3f35d354): тройка
 * уникальна среди **живых** рёбер, а не среди всех строк. Ребро, помеченное на
 * удаление, живую тройку не занимает: повторное создание связи обязано снять
 * пометку и вернуть то же ребро, а не упасть на UNIQUE-индексе миграции 029
 * (который освобождает тройку лишь для надгробия слоя `deleted = 1`) и не
 * выдать сырую ошибку SQLite. Восстановление сохраняет постоянный комментарий
 * ребра («зачем эта ссылка») — как и операция корзины `etn.links.restore`.
 */

import type { NetworkDb } from '../db/network-db.js';
import { materializeShadow } from '../db/layer-write.js';

/** Строка ребра тройки в разрешённом слое: логический id + признак корзины. */
export interface LinkTripleRow {
  id: string;
  marked_for_deletion: boolean;
}

/**
 * Найти ребро указанной тройки в разрешённом слое (`links_v`) — живое или
 * помеченное на удаление. Нетипизированные рёбра (`type_id IS NULL`) ищутся
 * отдельной веткой: в SQLite `NULL` не сравнивается сам с собой.
 */
export function findLinkTripleRow(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
): LinkTripleRow | null {
  const typeClause = typeId === null ? 'type_id IS NULL' : 'type_id = ?';
  const params = typeId === null ? [sourceId, targetId] : [sourceId, targetId, typeId];
  const row = ndb
    .prepare(
      `SELECT id, marked_for_deletion FROM links_v
        WHERE source_id = ? AND target_id = ? AND ${typeClause} LIMIT 1`,
    )
    .get(...params) as { id: string; marked_for_deletion: number } | undefined;
  if (row === undefined) return null;
  return { id: row.id, marked_for_deletion: row.marked_for_deletion === 1 };
}

/**
 * Снять пометку на удаление (зеркало `markLinkForDeletion` в
 * `property-service`): постоянный комментарий ребра сохраняется. Слой-осознанно:
 * в рабочем слое сначала материализуется тень, затем правится строка слоя.
 */
export function restoreLinkRow(ndb: NetworkDb, linkId: string, actorUserId: string): void {
  materializeShadow(ndb, 'links', linkId);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  ndb
    .prepare(
      `UPDATE links
          SET marked_for_deletion = 0, marked_for_deletion_at = NULL,
              marked_for_deletion_by = NULL,
              updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
        WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, linkId, ndb.layerId);
}
