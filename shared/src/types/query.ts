/**
 * Structured thought query (`etn.thoughts.query`, task N1, docs/05-mcp-server.md
 * §4.1). A criteria-based list — unlike `SearchRequest` there is no mandatory
 * text query: filters combine with AND, and the result carries the subtree
 * depth of every hit.
 */

/** Актуальность мысли в выборке: `'true'` — только активные, `'false'` —
 * только неактивные, `'any'` — без фильтра. */
export type ThoughtQueryActive = 'true' | 'false' | 'any';

/** Пометка на удаление в выборке (S13): `'true'` — только помеченные,
 * `'false'` (default) — только непомеченные, `'any'` — без фильтра. */
export type ThoughtQueryTrashed = 'true' | 'false' | 'any';

/** Оператор условия по значению свойства. */
export type PropertyQueryOperator = 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

/** Одно условие по значению свойства мысли (AND-группа). */
export interface PropertyQueryCondition {
  /** Ключ определения свойства (type_properties.key). */
  key: string;
  operator: PropertyQueryOperator;
  /**
   * Тип значения сам выбирает колонку: число → `value_number`,
   * булево → `value_bool`; строка с `contains` → `value_text`, с
   * `gt/gte/lt/lte` → `value_date` (ISO), с `eq/ne` → любая текстовая
   * колонка (`value_text`/`value_date`/`value_thought_ref`).
   */
  value: string | number | boolean;
}

/** Сортировка результата. */
export type ThoughtQuerySort = 'title' | 'created_at' | 'updated_at';

/** Направление сортировки. */
export type ThoughtQueryOrder = 'asc' | 'desc';

/** Параметры структурной выборки мыслей. */
export interface ThoughtQueryRequest {
  /** Ограничить выборку подчинёнными этой мысли (направленный обход вниз). */
  in_subtree_of?: string;
  /** Максимальная глубина обхода (по умолчанию TRAVERSAL_DEFAULTS.MAX_DEPTH). */
  max_depth?: number;
  /** Фильтр по типам мыслей. */
  type_id?: string[];
  /** Актуальность (по умолчанию `'true'` — только активные). */
  active?: ThoughtQueryActive;
  /**
   * Пометка на удаление (S13): `'true'` — только помеченные, `'false'`
   * (default) — только непомеченные, `'any'` — без фильтра. Независим от `active`.
   */
  trashed?: ThoughtQueryTrashed;
  /** Необязательный текстовый фильтр по названию и синонимам (LIKE). */
  keywords?: string;
  /** Условия по значениям свойств (AND). */
  properties?: PropertyQueryCondition[];
  /** ISO-8601: только мысли, созданные не раньше этого момента. */
  created_after?: string;
  /** ISO-8601: только мысли, созданные не позже этого момента. */
  created_before?: string;
  /** ISO-8601: только мысли, изменённые не раньше этого момента. */
  updated_after?: string;
  /** ISO-8601: только мысли, изменённые не позже этого момента. */
  updated_before?: string;
  /** Сортировка (по умолчанию `title`). */
  sort?: ThoughtQuerySort;
  /** Направление (по умолчанию `asc`). */
  order?: ThoughtQueryOrder;
  /** Лимит (по умолчанию 50, максимум 200). */
  limit?: number;
  /** Смещение (по умолчанию 0). */
  offset?: number;
}

/** Одна мысль в результате выборки. */
export interface ThoughtQueryHit {
  id: string;
  title: string;
  type_id: string | null;
  active: boolean;
  /** Глубина от `in_subtree_of` (0 — сам корень); `null` без поддерева. */
  depth: number | null;
}

/** Ответ структурной выборки. */
export interface ThoughtQueryResponse {
  total: number;
  hits: ThoughtQueryHit[];
  /** True, когда обход поддерева остановился по лимиту узлов. */
  truncated: boolean;
  /** Причина обрезки: только превышение лимита узлов (`max_nodes`). */
  reason: 'max_nodes' | null;
}
