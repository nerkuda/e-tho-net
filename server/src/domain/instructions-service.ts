/**
 * Витрина инструкций сети — единая доменная реализация (ADR 8c93f03a, веха 7
 * версии 0.8.2; ADR 717f04df, спека 14b0cc4f). Раньше весь query-сервис
 * (~280 строк с сырым SQL) жил внутри MCP-фасада и не имел REST-аналога.
 * Теперь три режима выборки реализованы здесь, а фасады — `etn.instructions`
 * и `GET /networks/:networkId/instructions` — только разбирают вход и
 * добавляют `network_id` в ответ.
 *
 * Режимы:
 *   * `{ instruction_id }` — полный текст одной инструкции (постоянный
 *     комментарий целиком, без обрезки);
 *   * `{ keywords }` — фильтр по title+synonyms мини-синтаксом
 *     (`whitespace-AND`, `-word` исключение);
 *   * без обоих — все актуальные инструкции (пейджинг `limit`/`offset`).
 *
 * Если роль `instructions` не задана — `{ has_instructions: false,
 * instructions: [] }` без ошибки. Только актуальные мысли; помеченные на
 * удаление исключаются; учитываются подтипы роли (L21-иерархия типов).
 * Читается из переданного `ndb` — фасад решает, какой контекст слоя открыть.
 */

import { EtnError, buildLikePattern, parseFilterKeywords } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getPermanentFull, getPermanentPreview } from './comment-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';

/** Превью постоянного комментария (как в `meta.permanent` выборок). */
type InstructionsPreview = NonNullable<ReturnType<typeof getPermanentPreview>>;

/** Строка списка инструкций. */
export interface InstructionsListItem {
  id: string;
  title: string;
  synonyms: string[];
  preview: InstructionsPreview | null;
  type_id: string | null;
}

/** Результат: роль не задана. */
export interface NoInstructionsResult {
  has_instructions: false;
  instructions: [];
}

/** Результат: одна инструкция целиком. */
export interface SingleInstructionResult {
  has_instructions: true;
  instruction_id: string;
  title: string;
  type_id: string | null;
  body_md: string | null;
}

/** Результат: страница списка. */
export interface InstructionsListResult {
  has_instructions: true;
  instructions: InstructionsListItem[];
  meta: { total: number; matched?: number };
}

export type NetworkInstructionsResult =
  | NoInstructionsResult
  | SingleInstructionResult
  | InstructionsListResult;

/** Параметры выборки (режим выбирается по фактически переданным полям). */
export interface NetworkInstructionsQuery {
  instructionId?: string;
  keywords?: string;
  limit?: number;
  offset?: number;
}

/** Ключевое слово: название или синоним, регистронезависимо, LIKE-паттерном. */
function keywordClauseFor(keywords: string | undefined): {
  sql: string;
  params: unknown[];
} {
  if (keywords === undefined || keywords.trim() === '') {
    return { sql: '', params: [] };
  }
  const parsed = parseFilterKeywords(keywords);
  const clauses: string[] = [];
  const params: unknown[] = [];
  // AND всех include-слов; `-word` исключения отрицают.
  for (const word of parsed.include) {
    const pattern = buildLikePattern(word.toLowerCase());
    clauses.push(
      "(t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts" +
        " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))",
    );
    params.push(pattern, pattern);
  }
  for (const word of parsed.exclude) {
    const pattern = buildLikePattern(word.toLowerCase());
    clauses.push(
      "NOT (t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts" +
        " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))",
    );
    params.push(pattern, pattern);
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * Страница инструкций: тип + фильтр по ключевым словам, вторичная
 * сортировка по названию. Синонимы подгружаются одним дополнительным
 * запросом на страницу.
 */
function fetchInstructionsList(
  ndb: NetworkDb,
  instructionsTypeIds: string[],
  keywords: string | undefined,
  limit: number,
  offset: number,
): InstructionsListItem[] {
  if (instructionsTypeIds.length === 0) return [];
  const placeholders = instructionsTypeIds.map(() => '?').join(',');
  const keyword = keywordClauseFor(keywords);

  const rows = ndb
    .prepare(
      `SELECT t.id AS id, t.title AS title, t.type_id AS type_id
         FROM thoughts_v t
        WHERE t.type_id IN (${placeholders})
          AND t.active = 1
          AND t.marked_for_deletion = 0${keyword.sql}
        ORDER BY t.title COLLATE NOCASE ASC, t.created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...instructionsTypeIds, ...keyword.params, limit, offset) as Array<{
    id: string;
    title: string;
    type_id: string | null;
  }>;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const idPlaceholders = ids.map(() => '?').join(',');
  const synRows = ndb
    .prepare(
      `SELECT thought_id, synonym FROM thought_synonyms_v
        WHERE thought_id IN (${idPlaceholders})
        ORDER BY thought_id, synonym`,
    )
    .all(...ids) as Array<{ thought_id: string; synonym: string }>;
  const synonymsById = new Map<string, string[]>();
  for (const row of synRows) {
    const list = synonymsById.get(row.thought_id);
    if (list === undefined) {
      synonymsById.set(row.thought_id, [row.synonym]);
    } else {
      list.push(row.synonym);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    synonyms: synonymsById.get(row.id) ?? [],
    // Превью — короткая подстрока постоянного комментария (200 символов);
    // полный текст — через `etn.comments.get`.
    preview: getPermanentPreview(ndb, 'thought', row.id),
    type_id: row.type_id,
  }));
}

/**
 * Прочитать инструкции сети. `roleTypeId` — значение
 * `network.type_roles.instructions`; `networkId` — для `details` ошибок.
 */
export function getNetworkInstructions(
  ndb: NetworkDb,
  roleTypeId: string | null | undefined,
  networkId: string,
  query: NetworkInstructionsQuery,
): NetworkInstructionsResult {
  // --- Одна инструкция целиком -------------------------------------------
  if (query.instructionId !== undefined) {
    if (typeof roleTypeId !== 'string') {
      return { has_instructions: false, instructions: [] };
    }
    const instructionsTypeIds = expandTypeIdsToSubtree(ndb, 'thought_types', [roleTypeId]);
    if (instructionsTypeIds.length === 0) {
      throw new EtnError(
        'NOT_FOUND',
        `Инструкция ${query.instructionId} не найдена — роль «instructions» не покрывает ни одного типа.`,
        { instruction_id: query.instructionId, network_id: networkId },
      );
    }
    const placeholders = instructionsTypeIds.map(() => '?').join(',');
    const row = ndb
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.type_id AS type_id, t.active AS active,
                t.marked_for_deletion AS marked_for_deletion
           FROM thoughts_v t
          WHERE t.id = ? AND t.type_id IN (${placeholders})
          LIMIT 1`,
      )
      .get(query.instructionId, ...instructionsTypeIds) as
      | {
          id: string;
          title: string;
          type_id: string | null;
          active: number;
          marked_for_deletion: number;
        }
      | undefined;
    if (row === undefined) {
      throw new EtnError(
        'NOT_FOUND',
        `Инструкция ${query.instructionId} не найдена среди активных мыслей роли «instructions».`,
        { instruction_id: query.instructionId, network_id: networkId },
      );
    }
    if (row.active !== 1 || row.marked_for_deletion !== 0) {
      throw new EtnError(
        'NOT_FOUND',
        `Инструкция ${query.instructionId} неактуальна или помечена на удаление.`,
        { instruction_id: query.instructionId, network_id: networkId },
      );
    }
    // Полное тело (без обрезки) — спека 14b0cc4f.
    const permanent = getPermanentFull(ndb, 'thought', row.id);
    return {
      has_instructions: true,
      instruction_id: row.id,
      title: row.title,
      type_id: row.type_id,
      body_md: permanent === null ? null : permanent.body_md,
    };
  }

  // --- Список (с ключевыми словами или без) ------------------------------
  if (typeof roleTypeId !== 'string') {
    return { has_instructions: false, instructions: [] };
  }
  const instructionsTypeIds = expandTypeIdsToSubtree(ndb, 'thought_types', [roleTypeId]);
  if (instructionsTypeIds.length === 0) {
    return { has_instructions: true, instructions: [], meta: { total: 0 } };
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const keywords = query.keywords;

  const keyword = keywordClauseFor(keywords);
  const placeholders = instructionsTypeIds.map(() => '?').join(',');
  const totalRow = ndb
    .prepare(
      `SELECT COUNT(*) AS c
         FROM thoughts_v t
        WHERE t.type_id IN (${placeholders})
          AND t.active = 1
          AND t.marked_for_deletion = 0${keyword.sql}`,
    )
    .get(...instructionsTypeIds, ...keyword.params) as { c: number };
  const instructions = fetchInstructionsList(
    ndb,
    instructionsTypeIds,
    keywords,
    limit,
    offset,
  );
  return {
    has_instructions: true,
    instructions,
    meta: { total: totalRow.c, matched: keywords !== undefined ? totalRow.c : undefined },
  };
}
