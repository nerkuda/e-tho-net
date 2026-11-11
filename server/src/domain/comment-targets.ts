/**
 * Резолвер привязок комментария («цели записи», m2m `comment_targets`) к
 * отображаемым формам `ChronicleTarget` — единый батч-механизм `comment_targets_v`
 * для «Дневника» (`chronicle-service`), полнотекстового поиска (`by_chrono`) и
 * backlinks/mentions (хроно-строки) — 0.15.4, ADR db88d819, задача 6af1be50.
 *
 * Модуль НЕЙТРАЛЬНЫЙ намеренно: `chronicle-service` и `query-service` уже
 * импортируют `search-service`, а тот сам пользуется этим резолвером —
 * размещение в них замкнуло бы граф импортов `search → chronicle/query →
 * search` (уточнение предполёта 2026-11-11). Зависимости модуля — только
 * `thought-service` (канон колонок {@link REF_COLUMNS} и {@link rowToThoughtRef}).
 *
 * Флаги видимости привязок (актуальность, корзина) резолвер НЕ фильтрует:
 * клиент рисует их по `ChronicleTargetLink.active`/`ThoughtRef.active`/
 * `ThoughtRef.marked_for_deletion` (требование 012b2dc6).
 */

import type { ChronicleTarget, ChronicleTargetLink, CommentTarget } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { REF_COLUMNS, rowToThoughtRef } from './thought-service.js';

/** Row shape accepted by {@link rowToThoughtRef}. */
type ThoughtRefRow = Parameters<typeof rowToThoughtRef>[0];

/**
 * Источник привязок: комментарий и его ПЕРВИЧНЫЙ владелец
 * (`comments.owner_type`/`owner_id` — он же первый в `targets`).
 */
export interface CommentTargetSource {
  id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
}

/** Сырая строка `comment_targets_v`. */
interface TargetRow {
  comment_id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
}

/** `?`-плейсхолдеры в количестве `n`. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Один батч-запрос строк привязок по `comment_id` (общий SQL-слой резолвера и
 * comments-API: третьей копии `SELECT … FROM comment_targets_v` не заводим).
 *
 * Владельца НЕ подставляет: у comments-API инвариант «at least one target»
 * держит фолбэк в `comment-service.loadTargets`, у хроники подстановки нет —
 * отсутствие строк даёт пустой набор.
 *
 * Порядок строк внутри `comment_id` — как в базе (`owner_type`, `owner_id`);
 * «первичная привязка первой» упорядочивает потребитель, знающий владельца.
 */
export function queryTargets(
  ndb: NetworkDb,
  commentIds: readonly string[],
): Map<string, CommentTarget[]> {
  const map = new Map<string, CommentTarget[]>();
  if (commentIds.length === 0) return map;
  const rows = ndb
    .prepare(
      `SELECT comment_id, owner_type, owner_id FROM comment_targets_v
       WHERE comment_id IN (${placeholders(commentIds.length)})
       ORDER BY owner_type ASC, owner_id ASC`,
    )
    .all(...commentIds) as TargetRow[];
  for (const row of rows) {
    const list = map.get(row.comment_id) ?? [];
    list.push({ owner_type: row.owner_type, owner_id: row.owner_id });
    map.set(row.comment_id, list);
  }
  return map;
}

/** Строка связи, пригодная к отображению (`ChronicleTargetLink`). */
interface LinkRow {
  id: string;
  type_id: string | null;
  active: number;
  source_id: string;
  target_id: string;
  name_forward: string | null;
  name_reverse: string | null;
}

/**
 * Разрешить привязки набора комментариев в `ChronicleTarget[]` — ОДИН раз на
 * страницу выдачи (паритет `POST /chronicle/query`).
 *
 * Батч-запросы: строки привязок ({@link queryTargets}) → связи страницы
 * (`links_v` + имена типов) → мысли-привязки и концы связей ({@link REF_COLUMNS}).
 * Внутри списка — «первичная привязка первой», остальные как в базе; порядок
 * устойчив (`Array.prototype.sort` стабилен).
 *
 * @returns `Map<comment_id, ChronicleTarget[]>`; комментарий без строк привязок
 *   получает пустой массив (ключа нет только у не переданных комментариев).
 */
export function resolveChronicleTargets(
  ndb: NetworkDb,
  rows: readonly CommentTargetSource[],
): Map<string, ChronicleTarget[]> {
  const resolved = new Map<string, ChronicleTarget[]>();
  const targetsByComment = queryTargets(
    ndb,
    rows.map((r) => r.id),
  );

  const thoughtIds = new Set<string>();
  const linkIds = new Set<string>();
  for (const list of targetsByComment.values()) {
    for (const t of list) {
      if (t.owner_type === 'thought') thoughtIds.add(t.owner_id);
      else linkIds.add(t.owner_id);
    }
  }

  const linkRows =
    linkIds.size > 0
      ? (ndb
          .prepare(
            `SELECT l.id, l.type_id, l.active, l.source_id, l.target_id,
                    lt.name_forward, lt.name_reverse
             FROM links_v l
             LEFT JOIN link_types_v lt ON lt.id = l.type_id
             WHERE l.id IN (${placeholders(linkIds.size)})`,
          )
          .all(...linkIds) as LinkRow[])
      : [];

  // Мысли-привязки и оба конца связей — одним запросом канона отображения.
  const refIds = new Set<string>(thoughtIds);
  for (const lr of linkRows) {
    refIds.add(lr.source_id);
    refIds.add(lr.target_id);
  }
  const refs = new Map<string, ThoughtRefRow>();
  if (refIds.size > 0) {
    const refRows = ndb
      .prepare(
        `SELECT ${REF_COLUMNS} FROM thoughts_v t WHERE t.id IN (${placeholders(refIds.size)})`,
      )
      .all(...refIds) as ThoughtRefRow[];
    for (const r of refRows) refs.set(r.id, r);
  }

  const linkTargets = new Map<string, ChronicleTargetLink>();
  for (const lr of linkRows) {
    const source = refs.get(lr.source_id);
    const target = refs.get(lr.target_id);
    if (source === undefined || target === undefined) continue;
    linkTargets.set(lr.id, {
      id: lr.id,
      type_id: lr.type_id,
      active: lr.active === 1,
      type_name_forward: lr.name_forward,
      type_name_reverse: lr.name_reverse,
      source: rowToThoughtRef(source),
      target: rowToThoughtRef(target),
    });
  }

  for (const row of rows) {
    const targets: ChronicleTarget[] = [];
    for (const t of targetsByComment.get(row.id) ?? []) {
      if (t.owner_type === 'thought') {
        const ref = refs.get(t.owner_id);
        if (ref !== undefined) targets.push({ kind: 'thought', thought: rowToThoughtRef(ref) });
      } else {
        const link = linkTargets.get(t.owner_id);
        if (link !== undefined) targets.push({ kind: 'link', link });
      }
    }
    // Первичная привязка первой (конвенция DTO).
    targets.sort((a, b) => {
      const aPrimary =
        a.kind === 'thought'
          ? row.owner_type === 'thought' && row.owner_id === a.thought.id
          : row.owner_type === 'link' && row.owner_id === a.link.id;
      const bPrimary =
        b.kind === 'thought'
          ? row.owner_type === 'thought' && row.owner_id === b.thought.id
          : row.owner_type === 'link' && row.owner_id === b.link.id;
      return aPrimary === bPrimary ? 0 : aPrimary ? -1 : 1;
    });
    resolved.set(row.id, targets);
  }
  return resolved;
}
