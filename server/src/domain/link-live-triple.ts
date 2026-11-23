/**
 * Живая тройка связи `(source, target, type_id)`: поиск, восстановление из
 * корзины и материализация живой тени.
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
 *
 * Живой дубль тройки в разных слоях (ошибка 374c9776) — законное состояние
 * видимости слоя, но не запись: слот тройки ВНУТРИ слоя держит одна строка
 * (уникальный индекс 029, включая корзинные). Поэтому материализация живой
 * тени строки-предка поверх живой строки того же слоя отвергается внятной 422
 * {@link throwTripleSlotTaken}, а не сырым сбоем SQLite (ошибка a9615f9b).
 */

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { materializeShadow } from '../db/layer-write.js';

/** Строка ребра тройки в разрешённом слое: логический id + признак корзины. */
export interface LinkTripleRow {
  id: string;
  marked_for_deletion: boolean;
}

/** Строка, занимающая слот тройки в слое: живая или корзинная (029 держит и её). */
export interface LinkTripleSlotRow {
  id: string;
  layer_id: string;
  marked_for_deletion: boolean;
}

/** Адрес запрошенной строки для деталей отказа «тройка занята». */
export interface LinkTripleRequest {
  id: string;
  layer_id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
}

/**
 * Найти ребро указанной тройки в разрешённом слое (`links_v`) — живое или
 * помеченное на удаление. Нетипизированные рёбра (`type_id IS NULL`) ищутся
 * отдельной веткой: в SQLite `NULL` не сравнивается сам с собой. Живая строка
 * предпочтительнее корзинной: при живом дубле тройки вызов обязан увидеть
 * живое ребро (DUPLICATE/восстановление), а не корзинную строку той же тройки.
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
        WHERE source_id = ? AND target_id = ? AND ${typeClause}
        ORDER BY marked_for_deletion ASC LIMIT 1`,
    )
    .get(...params) as { id: string; marked_for_deletion: number } | undefined;
  if (row === undefined) return null;
  return { id: row.id, marked_for_deletion: row.marked_for_deletion === 1 };
}

/**
 * Снять пометку на удаление (обратная операция к умному удалению цели в
 * `link-target-removal`/`property-service`): постоянный комментарий ребра
 * сохраняется. Слой-осознанно: в рабочем слое сначала материализуется тень,
 * затем правится строка слоя.
 */
export function restoreLinkRow(ndb: NetworkDb, linkId: string, actorUserId: string): void {
  materializeLiveLinkShadow(ndb, linkId);
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

/**
 * Строка, занимающая слот тройки в конкретном слое: любая видимая — живая или
 * корзинная (уникальный индекс 029 держит тройку и за помеченными строками).
 * Нужна перед материализацией живой тени: если слот занят, тень не вставить.
 */
export function findTripleSlotRow(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  layerId: string,
): LinkTripleSlotRow | null {
  const typeClause = typeId === null ? 'type_id IS NULL' : 'type_id = ?';
  const params: unknown[] = [sourceId, targetId];
  if (typeId !== null) params.push(typeId);
  params.push(layerId);
  const row = ndb
    .prepare(
      `SELECT id, layer_id, marked_for_deletion FROM links_v
        WHERE source_id = ? AND target_id = ? AND ${typeClause} AND layer_id = ?
        LIMIT 1`,
    )
    .get(...params) as { id: string; layer_id: string; marked_for_deletion: number } | undefined;
  if (row === undefined) return null;
  return { id: row.id, layer_id: row.layer_id, marked_for_deletion: row.marked_for_deletion === 1 };
}

/**
 * 422 «тройка занята в текущем слое». Держателем слота может быть живая строка
 * самого слоя (живой дубль тройки, 374c9776) или корзинная строка — совет
 * разный: дубль снимают целиком удалением ребра либо слиянием/отбрасыванием
 * лишнего слоя, корзину — очисткой корзины слоя.
 */
export function throwTripleSlotTaken(request: LinkTripleRequest, slot: LinkTripleSlotRow): never {
  const holder = slot.marked_for_deletion
    ? 'by a basket row - empty the basket of this layer first'
    : 'by a live row of this layer - delete the duplicate wholly (links.delete) or merge/discard the layer';
  throw new EtnError(
    'VALIDATION_ERROR',
    `duplicate edges: the triple is already taken in the current layer ${holder}`,
    {
      entity: 'link',
      id: request.id,
      source_id: request.source_id,
      target_id: request.target_id,
      type_id: request.type_id,
      links: [
        { id: request.id, layer_id: request.layer_id },
        { id: slot.id, layer_id: slot.layer_id },
      ],
    },
  );
}

/**
 * Материализовать ЖИВУЮ тень ребра в текущем слое. Но-оп, когда строка этого
 * логического `id` в слое уже есть (в том числе надгробие: view её не покажет,
 * а вставка упёрлась бы в `UNIQUE (id, layer_id)`).
 *
 * Если слот тройки в текущем слое занят ДРУГОЙ строкой — живым дублем тройки
 * или корзинной строкой, — запись отвергается 422 {@link throwTripleSlotTaken}:
 * вставка тени упала бы сырым `UNIQUE constraint failed: links.source_id,
 * links.target_id, links.type_id, links.layer_id` (ошибка a9615f9b). Правило
 * действует для ТИПИЗИРОВАННЫХ троек: нетипизированную тройку индекс 029 не
 * держит (`NULL` не равен сам себе), её вставка не падает.
 */
export function materializeLiveLinkShadow(ndb: NetworkDb, linkId: string): boolean {
  const own = ndb
    .prepare('SELECT 1 FROM links WHERE id = ? AND layer_id = ? LIMIT 1') // layers:physical-read — своя строка слоя, view её скрывает надгробием
    .get(linkId, ndb.layerId);
  if (own !== undefined) return true;
  const winner = ndb
    .prepare('SELECT id, layer_id, source_id, target_id, type_id FROM links_v WHERE id = ? LIMIT 1')
    .get(linkId) as LinkTripleRequest | undefined;
  if (winner === undefined) return materializeShadow(ndb, 'links', linkId);
  if (winner.type_id !== null) {
    const slot = findTripleSlotRow(
      ndb,
      winner.source_id,
      winner.target_id,
      winner.type_id,
      ndb.layerId,
    );
    if (slot !== null) throwTripleSlotTaken(winner, slot);
  }
  return materializeShadow(ndb, 'links', linkId);
}
