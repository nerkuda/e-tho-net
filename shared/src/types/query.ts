/**
 * Structured thought query (`etn.thoughts.query`, task N1, docs/05-mcp-server.md
 * §4.1). A criteria-based list — unlike `SearchRequest` there is no mandatory
 * text query: filters combine with AND, and the result carries the subtree
 * depth of every hit.
 */

import type { LinkTypeFilterInput } from './link.js';

/** Актуальность мысли в выборке: `'true'` — только активные, `'false'` —
 * только неактивные, `'any'` — без фильтра. */
export type ThoughtQueryActive = 'true' | 'false' | 'any';

/** Пометка на удаление в выборке (S13): `'true'` — только помеченные,
 * `'false'` (default) — только непомеченные, `'any'` — без фильтра. */
export type ThoughtQueryTrashed = 'true' | 'false' | 'any';

/**
 * Оператор условия по значению свойства.
 *
 * `any_of`/`all_of`/`none_of` (задача 20effcbd, 0.8.1) — операторы для
 * наборов значений: свойство-связь (`value_type: 'link'`, набор целей рёбер)
 * и обычные множественные свойства (`config.multiple` — `thought_ref`/`url`).
 * `value` для них — непустой массив id/строк (см. {@link PropertyQueryCondition.value}):
 *   * `any_of` — набор пересекается с перечисленными значениями (хотя бы одно);
 *   * `all_of` — набор содержит все перечисленные значения;
 *   * `none_of` — набор не содержит ни одного из перечисленных.
 */
export type PropertyQueryOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'any_of'
  | 'all_of'
  | 'none_of';

/** Одно условие по значению свойства мысли (AND-группа). */
export interface PropertyQueryCondition {
  /** Registry `property_id` (0.6.5 — справочник `properties`). Один и тот же
   *  id адресует свойство на любых типах владельца, у которых оно подключено.
   *  Взаимоисключающе с `property` (задача d5ab1630 — именованная адресация
   *  в фильтрах MCP). */
  property_id?: string;
  /** Имя свойства из реестра (0.6.5). MCP-фасад резолвит в `property_id` —
   *  `NOT_FOUND` если такого имени нет, `VALIDATION_ERROR` с
   *  `details.candidates` при неоднозначности (теоретически невозможно — ключ
   *  уникален в пределах сети). Взаимоисключающе с `property_id`. */
  property?: string;
  operator: PropertyQueryOperator;
  /**
   * Значение для сравнения. Колонка хранения (`value_text` / `value_date` /
   * `value_number` / `value_bool` / `value_thought_ref`) выбирается по
   * `value_type` адресуемого свойства, а не по runtime-типу значения —
   * подробности см. в `query-service.ts`.
   *
   * Для свойства-связи (`value_type: 'link'`, задача 20effcbd): `eq`/`ne` со
   * строкой — id конкретной цели («связь с конкретной целью»); `eq`/`ne` с
   * boolean — наличие/отсутствие живого ребра этого типа независимо от цели
   * («связь такого типа есть либо отсутствует»). Для `any_of`/`all_of`/`none_of`
   * (свойство-связь и `config.multiple` `thought_ref`/`url`) — непустой массив
   * id/строк.
   */
  value: string | number | boolean | string[];
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
  /** Фильтр по типам мыслей — registry `type_id`. Взаимоисключающе с `type`
   *  (задача d5ab1630 — именованная адресация в фильтрах MCP). */
  type_id?: string[];
  /** Фильтр по типам мыслей — имена типов. MCP-фасад резолвит каждый элемент
   *  в `type_id` через реестр (case-insensitive, `name_key`); `NOT_FOUND`,
   *  `VALIDATION_ERROR` с `details.candidates` при неоднозначности. Семанически
   *  эквивалентно `type_id` (запрос по-прежнему захватывает поддерево
   *  адресованного типа через L21). Взаимоисключающе с `type_id`. */
  type?: string[];
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
  /**
   * Автор мысли — id пользователя, создавшего строку (`created_by`;
   * задача 59119797 «Фильтры Автор/Редактор»). Отсутствует/пустая строка —
   * фильтр не применяется.
   */
  author_id?: string;
  /**
   * Последний редактор мысли — id пользователя (`updated_by`).
   * Отсутствует/пустая строка — фильтр не применяется.
   */
  editor_id?: string;
  /**
   * Фильтр обхода по типам связей (задача c965ad03, 0.8.1): ограничивает
   * рёбра, по которым `in_subtree_of` спускается вниз. Задан — типы
   * раскрываются с потомками, нетипизированные связи участвуют только при
   * `include_structural: true`; не задан — обход по всем рёбрам, как раньше.
   */
  link_filter?: LinkTypeFilterInput;
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
