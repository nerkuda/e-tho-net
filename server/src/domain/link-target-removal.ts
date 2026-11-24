/**
 * Умное удаление ребра при удалении цели свойства-связи (0.14.1, задача
 * 58b598d5; ADR a967d865, требование ebb070c2).
 *
 * Единая процедура для ВСЕХ путей удаления ребра (крестик чипа в GUI, set-запись
 * без цели в REST `PUT` и MCP write-wrapper, `properties.remove`, «Удалить»
 * внетипового свойства, MCP `links.delete` — 0.16.1, ошибка 7df2b3d1):
 *
 *   * **основа** — физическое удаление живого ребра вместе с зависимостями,
 *     без корзины (событие `link.deleted`);
 *   * **слой, ребро существует в основе/слоях-предках** (видимая строка имеет
 *     `layer_id` предка либо материализованную тень с `base_version > 0`) —
 *     корзина `marked_for_deletion` (событие `link.updated`);
 *   * **слой, ребро создано в текущем слое** (`layer_id` текущий,
 *     `base_version = 0`) — физическое удаление строки слоя (событие
 *     `link.deleted`), но только если ребро не держит живая тень ни в одном
 *     другом слое: иначе 422 `VALIDATION_ERROR` с `details.blocking.layers`
 *     (та же проверка `listLinkHoldingLayers`, что у основы; ошибка 97b64a69 —
 *     физическое удаление осиротило бы тень, и её слияние вернуло бы ребро);
 *   * **дубль тройки** (живые строки одной тройки в разных слоях, ошибка
 *     374c9776) — снимается ВЕСЬ дубль: своя свежая строка слоя удаляется
 *     физически, строка основы/предка уходит в корзину слоя. Снять только одну
 *     строку нельзя: вторая осталась бы видимой, а тень поверх живой строки
 *     слоя упирается в уникальный индекс тройки (миграция 029) — сырой
 *     `UNIQUE constraint failed`. Корзинные строки живыми не считаются: уже
 *     снятое значение не участвует в разборе дубля и не помечается повторно.
 *     Неразрешимый дубль (две живые строки выше текущего слоя: две живые тени
 *     одной тройки в слой не помещаются) — 422 `VALIDATION_ERROR` с перечнем
 *     строк;
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
import { findTripleSlotRow, throwTripleSlotTaken } from './link-live-triple.js';
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
 * 422, если ребро держит живая тень другого слоя (основа — рабочие слои,
 * рабочий слой — дочерние/соседние слои и основа). Физическое удаление
 * вырвало бы землю из-под держателя: тень осиротела бы, а её слияние вернуло
 * бы ребро в предка.
 */
function throwIfLinkHeld(ndb: NetworkDb, linkId: string): void {
  const holdingLayers = listLinkHoldingLayers(ndb, linkId);
  if (holdingLayers.length === 0) return;
  throw new EtnError('VALIDATION_ERROR', 'link is held by a layer and cannot be deleted', {
    entity: 'link',
    id: linkId,
    blocking: { layers: holdingLayers },
  });
}

/**
 * ЖИВЫЕ строки одной тройки `source -> target` одного типа, видимые в текущем
 * контексте слоя. Больше одной строки — дубль тройки в разных слоях (ошибка
 * 374c9776): `links_v` схлопывает строки по логическому `id`, а не по тройке, а
 * уникальность тройки держится ВНУТРИ слоя (029).
 *
 * Корзинные строки (`marked_for_deletion = 1`) в список НЕ входят: это уже
 * снятые значения, и в разборе живого дубля они не участвуют (доработка
 * верификации 374c9776: корзинная строка выше давала ложный 422 и помечалась
 * повторно). Слот тройки в слое корзинная строка при этом занимает — см.
 * {@link findTripleSlotRow}.
 */
function listTripleRows(ndb: NetworkDb, row: VisibleLinkRow): VisibleLinkRow[] {
  const typeClause = row.type_id === null ? 'type_id IS NULL' : 'type_id = ?';
  const params = [row.source_id, row.target_id, ...(row.type_id === null ? [] : [row.type_id])];
  return ndb
    .prepare(
      `SELECT * FROM links_v
        WHERE source_id = ? AND target_id = ? AND ${typeClause}
          AND marked_for_deletion = 0
        ORDER BY id`,
    )
    .all(...params) as VisibleLinkRow[];
}

/**
 * 422 на неразрешимый дубль тройки: двум ЖИВЫМ строкам основы/предков нужны две
 * живые тени одной тройки, а слой держит не больше одной (уникальный индекс
 * миграции 029). Чинится слиянием или отбрасыванием лишнего слоя; сырой сбой
 * SQLite здесь недопустим (ошибка 374c9776).
 */
function throwDuplicateTriple(rows: readonly VisibleLinkRow[]): never {
  throw new EtnError(
    'VALIDATION_ERROR',
    'duplicate edges: the link triple is alive in several layers - merge or discard the layer duplicating it',
    {
      entity: 'link',
      id: rows[0]?.id ?? null,
      source_id: rows[0]?.source_id ?? null,
      target_id: rows[0]?.target_id ?? null,
      type_id: rows[0]?.type_id ?? null,
      links: rows.map((r) => ({ id: r.id, layer_id: r.layer_id })),
    },
  );
}

/**
 * Удалить ребро по правилам ADR a967d865 и вернуть фактическое действие по
 * КАЖДОЙ снятой строке (запрошенная идёт первой). Пустой список — ребра уже
 * нет или оно уже помечено (no-op без события). Вызывающий публикует событие
 * по `action` каждой строки: `deleted` → `link.deleted`, `trashed` →
 * `link.updated` с `marked_for_deletion: true`.
 *
 * Процедура рассчитана на вызов внутри транзакции записи (`runWrite`):
 * физическое удаление и материализация пометки должны быть атомарны с
 * остальной записью свойства.
 */
export function removeLinkTargets(
  ndb: NetworkDb,
  linkId: string,
  actorUserId: string,
): LinkRemoval[] {
  const row = ndb
    .prepare('SELECT * FROM links_v WHERE id = ?')
    .get(linkId) as VisibleLinkRow | undefined;
  if (row === undefined) return [];
  // Уже в корзине — повторная пометка не создаётся, событие не эмитится
  // (уточнение аудита цикла 1).
  if (row.marked_for_deletion === 1) return [];

  if (isBaseContext(ndb)) {
    // S13: физическое удаление в основе запрещено, пока ребро держит живая
    // тень в рабочем слое (docs/13-layers.md §6.5a) — та же защита, что у
    // `DELETE /links/{id}`.
    throwIfLinkHeld(ndb, linkId);
    purgeOwnerDependants(ndb, 'link', [linkId]);
    // Физическое удаление логической строки во всех слоях — поведение основы
    // до S4 (`deleteLink`); держащих слоёв здесь уже нет. Дубля тройки в
    // основе быть не может: уникальность держится внутри слоя (029).
    ndb.prepare('DELETE FROM links WHERE id = ?').run(linkId); // layers:physical-write — физическое удаление в основе: держащих слоёв уже нет
    return [{ link_id: linkId, action: 'deleted', link: rowToLink(row) }];
  }

  // Слой. Живая тройка `source -> target` может быть видна несколькими
  // строками — своя свежая строка слоя и строка основы/предка (ошибка
  // 374c9776): уникальность тройки держится внутри слоя, а `links_v` выбирает
  // строку по логическому `id`, а не по тройке. Корзинные строки сюда не
  // попадают — они уже сняты и в разборе дубля не участвуют.
  const liveRows = listTripleRows(ndb, row);
  const ownRow = liveRows.find((r) => r.layer_id === ndb.layerId);
  // Своя строка слоя, созданная здесь и нигде выше, — её можно снести физически.
  const ownIsFresh = ownRow !== undefined && ownRow.base_version === 0;
  // Строки основы/предков: каждая требует своей живой тени в текущем слое.
  const aboveRows = liveRows.filter((r) => r.layer_id !== ndb.layerId);

  // Две живые тени одной тройки в слой не помещаются (029): дубль в двух слоях
  // выше текущего неразрешим — 422 вместо сырого сбоя SQLite.
  if (aboveRows.length > 1) throwDuplicateTriple(liveRows);

  const removals: LinkRemoval[] = [];
  // Ребро создано в текущем слое и выше его нет — физически удаляем строку
  // слоя. Зависимости (комментарии/вложения/значения) принадлежат этому же
  // слою: ребра выше не существует. Но живая тень ребра в дочернем слое
  // удержит его (ошибка 97b64a69): после физического удаления она осиротеет,
  // а её слияние вернёт ребро в этот слой.
  if (ownRow !== undefined && ownIsFresh) {
    throwIfLinkHeld(ndb, ownRow.id);
    purgeOwnerDependants(ndb, 'link', [ownRow.id]);
    ndb.prepare('DELETE FROM links WHERE id = ? AND layer_id = ?').run(ownRow.id, ndb.layerId);
    removals.push({ link_id: ownRow.id, action: 'deleted', link: rowToLink(ownRow) });
  }

  // Строка предка (или её материализованная тень) означает, что ребро
  // существует выше: его можно только спрятать корзиной, физическое удаление
  // сделало бы невозможным восстановление и потеряло бы знание основы.
  const toTrash: VisibleLinkRow[] =
    aboveRows.length === 1
      ? aboveRows
      : aboveRows.length === 0 && !ownIsFresh && ownRow !== undefined
        ? [ownRow]
        : [];
  // Живую тень можно вставить, только если слот тройки в текущем слое свободен:
  // его держит своя живая строка слоя (живой дубль) или корзинная строка (029).
  if (toTrash.length > 0) {
    const slotRow = findTripleSlotRow(ndb, row.source_id, row.target_id, row.type_id, ndb.layerId);
    if (slotRow !== null && slotRow.id !== toTrash[0]?.id) {
      throwTripleSlotTaken(row, slotRow);
    }
  }
  for (const anc of toTrash) {
    materializeShadow(ndb, 'links', anc.id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    ndb
      .prepare(
        `UPDATE links SET marked_for_deletion = 1, marked_for_deletion_at = ?,
                          marked_for_deletion_by = ?, updated_at = ?, updated_by = ?,
                          updated_at_ms = ?, version = version + 1
          WHERE id = ? AND layer_id = ?`,
      )
      .run(now, actorUserId, now, actorUserId, nowMs, anc.id, ndb.layerId);
    removals.push({ link_id: anc.id, action: 'trashed', link: rowToLink(anc) });
  }
  // Запрошенная строка — первой: ответ и события читаются по ней.
  const requested = removals.findIndex((r) => r.link_id === linkId);
  if (requested > 0) removals.unshift(...removals.splice(requested, 1));
  return removals;
}
