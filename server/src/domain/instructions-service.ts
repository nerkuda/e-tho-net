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
 *   * `{ instruction_ids }` — карточки перечня для указанных id в порядке
 *     запроса (задача 649c55e2);
 *   * `{ keywords }` — фильтр по title+synonyms мини-синтаксом
 *     (`whitespace-AND`, `-word` исключение);
 *   * без них — актуальные инструкции (пейджинг `limit`/`offset`): по
 *     умолчанию (`scope: "roots"`) только корневые, `scope: "all"` — все
 *     активные, включая подчинённые. Под-инструкции (родитель — тоже
 *     инструкция) в корневой перечень не попадают — их находит `keywords`
 *     из текста корневой инструкции.
 *
 * Если роль `instructions` не задана — `{ has_instructions: false,
 * instructions: [] }` без ошибки. Только актуальные мысли; помеченные на
 * удаление исключаются; учитываются подтипы роли (L21-иерархия типов).
 * Читается из переданного `ndb` — фасад решает, какой контекст слоя открыть.
 */

import { EtnError, INSTRUCTIONS_PREVIEW_CHARS, buildLikePattern, parseFilterKeywords } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getPermanentFull, getPermanentPreview } from './comment-service.js';
import type { BodyExpander } from './transclusion-service.js';
import { projectThoughtRows } from './response-projection.js';
import { resolveThoughtId } from './thought-id.js';
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

/** Результат: карточки по указанным id (режим `instruction_ids`). */
export interface InstructionsSelectionResult {
  has_instructions: true;
  instructions: InstructionsListItem[];
  /** Запрошенные id, не найденные среди активных инструкций роли. */
  missing: string[];
  meta: { total: number };
}

export type NetworkInstructionsResult =
  | NoInstructionsResult
  | SingleInstructionResult
  | InstructionsListResult
  | InstructionsSelectionResult;

/** Параметры выборки (режим выбирается по фактически переданным полям). */
export interface NetworkInstructionsQuery {
  instructionId?: string;
  /**
   * Режим «указанные» (задача 649c55e2): карточки в форме перечня для
   * перечисленных id — в порядке запроса, дубликаты схлопываются. Полный
   * текст — по-прежнему режимом `instructionId` по одной инструкции.
   */
  instructionIds?: string[];
  keywords?: string;
  limit?: number;
  offset?: number;
  /**
   * Режим перечня без `keywords` (задача 649c55e2): `roots` (по умолчанию) —
   * только корневые инструкции (мысль типа «инструкция», у которой среди
   * родителей нет другой инструкции по нетипизированному ребру) — модель
   * скиллов витрины (требование «Перечень etn.instructions отдаёт только
   * корневые инструкции»); `all` — все активные инструкции, включая
   * подчинённые. Режим `keywords` фильтр не применяет — он ищет по всем
   * инструкциям, включая подчинённые.
   */
  scope?: 'roots' | 'all';
  /**
   * Предел превью постоянного комментария в перечне (символы). По умолчанию
   * {@link INSTRUCTIONS_PREVIEW_CHARS} — агенту в перечне хватает блока
   * «Когда применять», полный текст читается режимом `instruction_id`/
   * `etn.comments.get`. Общая норма обоих фасадов (задача 65cf6074).
   */
  previewChars?: number;
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
 * SQL-условие «корневая инструкция»: среди родителей мысли нет другой
 * инструкции (мысли того же поддерева типов роли `instructions`). Родительские
 * рёбра — структурные (нетипизированные): только отсутствие типа (`type_id
 * IS NULL`) делает мысль подчинённой, типизированная связь («см. также»)
 * иерархию не образует (требование 825800fc, ошибка fa7df2c3). Живые родители:
 * активные и не в корзине. `placeholders` — заполнители под
 * `instructionsTypeIds`; условие использует их повторно, поэтому при связывании
 * параметров набор типов передаётся второй раз.
 */
function rootInstructionClause(placeholders: string): string {
  return (
    ' AND NOT EXISTS (' +
    'SELECT 1 FROM links_v l JOIN thoughts_v p ON p.id = l.source_id' +
    ' WHERE l.target_id = t.id AND l.active = 1 AND l.marked_for_deletion = 0' +
    ' AND l.type_id IS NULL' +
    ` AND p.type_id IN (${placeholders})` +
    ' AND p.active = 1 AND p.marked_for_deletion = 0)'
  );
}

/**
 * Страница инструкций: тип + фильтр по ключевым словам, вторичная
 * сортировка по названию. Синонимы подгружаются одним дополнительным
 * запросом на страницу.
 *
 * `rootsOnly` — режим без ключевых слов: отдаются только корневые инструкции
 * (модель скиллов); в режиме `keywords` фильтр не применяется — ищем по всем
 * инструкциям, включая подчинённые.
 */
function fetchInstructionsList(
  ndb: NetworkDb,
  instructionsTypeIds: string[],
  keywords: string | undefined,
  limit: number,
  offset: number,
  rootsOnly: boolean,
  previewChars: number,
  bodyTransform?: BodyExpander,
): InstructionsListItem[] {
  if (instructionsTypeIds.length === 0) return [];
  const placeholders = instructionsTypeIds.map(() => '?').join(',');
  const keyword = keywordClauseFor(keywords);
  const rootClause = rootsOnly ? rootInstructionClause(placeholders) : '';
  const rootParams = rootsOnly ? instructionsTypeIds : [];

  const rows = ndb
    .prepare(
      `SELECT t.id AS id, t.title AS title, t.type_id AS type_id
         FROM thoughts_v t
        WHERE t.type_id IN (${placeholders})
          AND t.active = 1
          AND t.marked_for_deletion = 0${keyword.sql}${rootClause}
        ORDER BY t.title COLLATE NOCASE ASC, t.created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(
      ...instructionsTypeIds,
      ...keyword.params,
      ...rootParams,
      limit,
      offset,
    ) as Array<{
    id: string;
    title: string;
    type_id: string | null;
  }>;
  return buildListItems(ndb, rows, previewChars, bodyTransform);
}

/**
 * Собрать карточки перечня из строк (id/title/type_id): загрузить синонимы
 * одним запросом на страницу и приложить превью постоянного комментария
 * (задача 649c55e2 — общий сборщик режимов «перечень» и «указанные»).
 */
function buildListItems(
  ndb: NetworkDb,
  rows: ReadonlyArray<{ id: string; title: string; type_id: string | null }>,
  previewChars: number,
  bodyTransform?: BodyExpander,
): InstructionsListItem[] {
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
    // Превью — короткая подстрока постоянного комментария (по умолчанию
    // 300 символов, блок «Когда применять»); полный текст — по `instruction_id`
    // либо через `etn.comments.get`. Предел — общая норма обоих фасадов
    // (задача 65cf6074).
    preview: getPermanentPreview(ndb, 'thought', row.id, previewChars, bodyTransform),
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
  bodyTransform?: BodyExpander,
): NetworkInstructionsResult {
  // --- Одна инструкция целиком -------------------------------------------
  if (query.instructionId !== undefined) {
    if (typeof roleTypeId !== 'string') {
      return { has_instructions: false, instructions: [] };
    }
    // Короткая форма id (hex-префикс UUID) резолвится в полный id — как в
    // `etn.thoughts.get` (ошибка 8ca8f4cc). Неоднозначный префикс даёт
    // VALIDATION_ERROR со списком кандидатов; ненайденный — NOT_FOUND ниже.
    // Резолв ровно одной мысли — заодно гарантия, что выдача относится ИМЕННО
    // к запрошенной инструкции, а не к «похожей» (ошибка 50098756).
    const resolvedId = resolveThoughtId(ndb, query.instructionId);
    if (resolvedId === null) {
      throw new EtnError(
        'NOT_FOUND',
        `Инструкция ${query.instructionId} не найдена среди активных мыслей роли «instructions». ` +
          'Принимается полный UUID или однозначный hex-префикс id (не короче 4 символов).',
        { instruction_id: query.instructionId, network_id: networkId },
      );
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
      .get(resolvedId, ...instructionsTypeIds) as
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
    // Полное тело (без обрезки) — спека 14b0cc4f. MCP-выдача разворачивает
    // трансклюзии (ТП2, задача bcfc7eb7); REST фасад передаёт `bodyTransform`
    // не заданным и получает исходный текст.
    const permanent = getPermanentFull(ndb, 'thought', row.id, bodyTransform);
    return {
      has_instructions: true,
      instruction_id: row.id,
      title: row.title,
      type_id: row.type_id,
      body_md: permanent === null ? null : permanent.body_md,
    };
  }

  // --- Общий резолв роли для перечневых режимов --------------------------
  if (typeof roleTypeId !== 'string') {
    return { has_instructions: false, instructions: [] };
  }
  const instructionsTypeIds = expandTypeIdsToSubtree(ndb, 'thought_types', [roleTypeId]);
  const previewChars = query.previewChars ?? INSTRUCTIONS_PREVIEW_CHARS;

  // --- Режим «указанные» (instruction_ids) --------------------------------
  if (query.instructionIds !== undefined && query.instructionIds.length > 0) {
    if (instructionsTypeIds.length === 0) {
      return {
        has_instructions: true,
        instructions: [],
        missing: [...new Set(query.instructionIds)],
        meta: { total: 0 },
      };
    }
    // Порядок запроса, дубликаты схлопываются (задача 649c55e2). Каждый
    // запрошенный id резолвится из короткой формы в полную — как в
    // `etn.thoughts.get` (ошибка 8ca8f4cc): ненайденный префикс уходит в
    // `missing`, неоднозначный даёт VALIDATION_ERROR со списком кандидатов
    // (ложный ответ недопустим — ошибка 50098756).
    const requested: string[] = [];
    const missing: string[] = [];
    const seenIds = new Set<string>();
    for (const raw of query.instructionIds) {
      const resolved = resolveThoughtId(ndb, raw);
      if (resolved === null) {
        if (!missing.includes(raw)) missing.push(raw);
        continue;
      }
      if (!seenIds.has(resolved)) {
        seenIds.add(resolved);
        requested.push(resolved);
      }
    }
    if (requested.length === 0) {
      return {
        has_instructions: true,
        instructions: [],
        missing,
        meta: { total: 0 },
      };
    }
    const idPlaceholders = requested.map(() => '?').join(',');
    const placeholders = instructionsTypeIds.map(() => '?').join(',');
    const rows = ndb
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.type_id AS type_id
           FROM thoughts_v t
          WHERE t.id IN (${idPlaceholders})
            AND t.type_id IN (${placeholders})
            AND t.active = 1
            AND t.marked_for_deletion = 0`,
      )
      .all(...requested, ...instructionsTypeIds) as Array<{
      id: string;
      title: string;
      type_id: string | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const foundRows = requested.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    for (const id of requested) {
      if (!byId.has(id)) missing.push(id);
    }
    const items = buildListItems(ndb, foundRows, previewChars, bodyTransform);
    return {
      has_instructions: true,
      instructions: projectThoughtRows(items),
      missing,
      meta: { total: items.length },
    };
  }

  // --- Список (с ключевыми словами или без) ------------------------------
  if (instructionsTypeIds.length === 0) {
    return { has_instructions: true, instructions: [], meta: { total: 0 } };
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const keywords = query.keywords;
  // Режим без ключевых слов: `scope: "roots"` (по умолчанию) — только корневые
  // инструкции (модель скиллов, требование «Перечень etn.instructions отдаёт
  // только корневые инструкции»); `scope: "all"` — все активные, включая
  // подчинённые. `keywords` ищет по всем и scope не применяет (задача 649c55e2).
  const rootsOnly = (query.scope ?? 'roots') === 'roots' && keywords === undefined;

  const keyword = keywordClauseFor(keywords);
  const placeholders = instructionsTypeIds.map(() => '?').join(',');
  const rootClause = rootsOnly ? rootInstructionClause(placeholders) : '';
  const rootParams = rootsOnly ? instructionsTypeIds : [];
  const totalRow = ndb
    .prepare(
      `SELECT COUNT(*) AS c
         FROM thoughts_v t
        WHERE t.type_id IN (${placeholders})
          AND t.active = 1
          AND t.marked_for_deletion = 0${keyword.sql}${rootClause}`,
    )
    .get(...instructionsTypeIds, ...keyword.params, ...rootParams) as { c: number };
  const instructions = fetchInstructionsList(
    ndb,
    instructionsTypeIds,
    keywords,
    limit,
    offset,
    rootsOnly,
    previewChars,
    bodyTransform,
  );
  return {
    has_instructions: true,
    // Записи перечня проходят через общий сериализатор домена
    // (response-projection.ts): пустые контейнеры (например, `synonyms: []`)
    // не пишутся, визуальные/сервисные поля снимаются. Одна точка и для MCP,
    // и для REST (задача 65cf6074).
    instructions: projectThoughtRows(instructions),
    meta: { total: totalRow.c, matched: keywords !== undefined ? totalRow.c : undefined },
  };
}
