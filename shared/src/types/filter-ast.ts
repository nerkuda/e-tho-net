/**
 * Модель отбора (AST) и её wire-формат (тех.проект «Ядро AST и операторы», задача
 * 9c156b8c; сущность спецификации «Модель отбора (AST) и её wire-формат»
 * 489c394f). Единая модель условий отбора для всех контуров (UI, REST, MCP),
 * пришедшая на смену плоским критериям `definition v1`.
 *
 * Узел дерева — группа (`and`/`or`/`not`) либо условие-лист
 * `[операнд][оператор][значение]`. Значение — литерал, список, токен
 * (календарный/контекстный) или под-выборка (под-дерево AST). Сортировка —
 * отдельное поле отбора (не узел): многоуровневый список ключей `{ key, order }`.
 *
 * Дерево целиком (корень отбора) несёт признак версии формы — поле `version`.
 * Wire распознаётся по версии; поле расширяемо под будущее (ссылка под-выборки
 * на именованный сохранённый отбор) — задел, не входит в текущий ТП.
 *
 * Только типы и константы — исполнение и валидация формы живут в доменном слое
 * сервера (`server/src/domain/filter-ast.ts`, `query-service.ts`). Клиентская
 * модель состояния редактора — `FilterCriteriaState` (`client/src/renderer/lib/filter-builder.ts`),
 * он же единственный конвертер в эту wire-форму (ADR «условия отбора строит один
 * конструктор с одной моделью состояния»).
 */

import type { StructureKeywordScope } from '../enums.js';

/** Версия формы корня отбора (поле `version` wire-формата). */
export const FILTER_AST_VERSION = 1;

/** Операторы группы. У `not` — ровно один ребёнок; у `and`/`or` — один и более. */
export const FILTER_AST_GROUP_OPS = ['and', 'or', 'not'] as const;
export type FilterAstGroupOp = (typeof FILTER_AST_GROUP_OPS)[number];

/**
 * Коды операторов-листьев. Полный словарь модели (набор зависит от типа левого
 * операнда; семантику по операндам задаёт доменный исполнитель). Введён здесь,
 * чтобы форма листа валидировалась по единому словарю на всех контурах.
 *
 * Соответствие русским названиям спецификации:
 *   * `eq`/`ne` — «равно»/«не равно» (строгое сравнение);
 *   * `contains`/`not_contains` — «содержит»/«не содержит»;
 *   * `in`/`not_in` — «в списке»/«не в списке»;
 *   * `gt`/`gte`/`lt`/`lte` — «больше/больше или равно/меньше/меньше или равно»;
 *   * `between`/`not_between` — «между»/«не между» (границы включительны);
 *   * `any_of`/`all_of`/`none_of` — наборные («хотя бы один»/«все»/«ни один»);
 *   * `is_empty`/`not_empty` — «заполнено»/«не заполнено»;
 *   * `matches` — «Есть слова» (области поиска — в операнде `keywords`);
 *   * `in_hierarchy`/`not_in_hierarchy` — «в иерархии»/«не в иерархии» (два режима);
 *   * `has`/`not_has` — «имеет свойство»/«не имеет свойство» (набор свойств).
 *
 * Режим обхода «в иерархии» — параметр листа {@link FilterAstLeaf.mode}
 * (требование aa7a2aea, ADR df23db45/588be3f3): по структурным связям либо по
 * всем типам связей. Значение по умолчанию — структурный режим.
 */
export const FILTER_AST_OPERATORS = [
  'eq',
  'ne',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'not_between',
  'in',
  'not_in',
  'any_of',
  'all_of',
  'none_of',
  'is_empty',
  'not_empty',
  'matches',
  'in_hierarchy',
  'not_in_hierarchy',
  'has',
  'not_has',
] as const;
export type FilterAstOperator = (typeof FILTER_AST_OPERATORS)[number];

/**
 * Режимы оператора «в иерархии»/«не в иерархии» (требование aa7a2aea, ADR
 * df23db45): `structural` — обход по живым нетипизированным (структурным)
 * рёбрам; `all_links` — любая живая связь считается родительской. Оба режима
 * ограничены глубиной 20 и дедупликацией посещённых (циклы графа).
 */
export const FILTER_AST_HIERARCHY_MODES = ['structural', 'all_links'] as const;
export type FilterAstHierarchyMode = (typeof FILTER_AST_HIERARCHY_MODES)[number];

/** Скалярное значение-литерал. */
export type FilterAstScalar = string | number | boolean;

/** Токен: `{ "token": "$today" }`, `$thought.[Свойство]`, арифметика ±N. */
export interface FilterAstTokenValue {
  token: string;
}

/**
 * Под-выборка как значение: `{ "query": <узел>, "operator": "in" | "not_in" | "all_in" }`.
 * `query` — полноценное под-дерево AST (глубина вложенности не ограничена).
 */
export interface FilterAstSubqueryValue {
  query: FilterAstNode;
  operator: 'in' | 'not_in' | 'all_in';
}

/** Значение условия-листа: литерал | список литералов | токен | под-выборка. */
export type FilterAstValue =
  | FilterAstScalar
  | FilterAstScalar[]
  | FilterAstTokenValue
  | FilterAstSubqueryValue;

/**
 * Снапшоты человекочитаемых подписей сущности и значения на момент сохранения
 * отбора. Нужны для сообщений диагностики (красная строка при удалённой
 * сущности) — сервер не восстанавливает подпись удалённого элемента.
 */
export interface FilterAstLabels {
  /** Подпись левого операнда (имя типа/свойства/…). */
  entity?: string;
  /** Подпись значения (имя мысли/типа или человекочитаемое значение). */
  value?: string;
}

/**
 * Левый операнд условия. Дискриминант — `kind`. Состав операндов зависит от
 * профиля контекста точки применения (проектируется профилями контекста);
 * здесь — общий словарь операндов отбора мыслей.
 */
export type FilterAstEntity =
  /** Тип мысли. */
  | { kind: 'type' }
  /**
   * Свойство мысли. Адресация — registry `property_id` (предпочтительно) или
   * именем `property` (прямое/обратное имя свойства-связи разрешает домен).
   * `direction` переопределяет сторону свойства-связи, когда условие адресовано
   * обратным именем.
   */
  | { kind: 'property'; property_id?: string; property?: string; direction?: 'out' | 'in' }
  /** Тип связи (формально; операнд ссылок). */
  | { kind: 'link_type' }
  /** Структурные «Родители». */
  | { kind: 'parents' }
  /** Структурные «Потомки». */
  | { kind: 'children' }
  /** «Вложения» мысли. */
  | { kind: 'attachments' }
  /** «Дневниковые записи» (хронологические комментарии) мысли. */
  | { kind: 'chronology' }
  /** Постоянный комментарий мысли. */
  | { kind: 'comment' }
  /** «Цели» записей дневника (операнд контекста хроники). */
  | { kind: 'targets' }
  /** Актуальность мысли (служебный предикат). */
  | { kind: 'active' }
  /** Пометка на удаление (служебный предикат). */
  | { kind: 'trashed' }
  /** «Есть слова»: области поиска — чекбоксы; пустой/отсутствующий `scope` — условие отключено. */
  | { kind: 'keywords'; scope?: StructureKeywordScope[] }
  /** Автор мысли (`created_by`). */
  | { kind: 'author' }
  /** Последний редактор мысли (`updated_by`). */
  | { kind: 'editor' }
  /** Дата создания мысли. */
  | { kind: 'created_at' }
  /** Дата изменения мысли. */
  | { kind: 'updated_at' }
  /** «Имеет свойство»: набор адресуемых свойств (значения — в `value`). */
  | { kind: 'properties' };

/** Условие-лист: `[операнд][оператор][значение]` (+ снапшоты подписей). */
export interface FilterAstLeaf {
  entity: FilterAstEntity;
  operator: FilterAstOperator;
  value?: FilterAstValue;
  labels?: FilterAstLabels;
  /**
   * Режим обхода «в иерархии» (только для `in_hierarchy`/`not_in_hierarchy`);
   * отсутствие — структурный режим (`structural`). Для операнда «Тип» режим
   * неприменим (у типов собственная иерархия подтипов) и игнорируется.
   */
  mode?: FilterAstHierarchyMode;
}

/** Группа: `and`/`or` — один и более детей; `not` — ровно один. Глубина не ограничена. */
export interface FilterAstGroup {
  op: FilterAstGroupOp;
  children: FilterAstNode[];
}

/** Узел дерева отбора: группа или условие-лист. */
export type FilterAstNode = FilterAstGroup | FilterAstLeaf;

/**
 * Ключ сортировки: код ключа и направление. Сортировка — отдельное поле отбора,
 * порядок дополняется уникальным `id` (совместимо с keyset-пагинацией).
 */
export interface FilterAstSortKey {
  /** Код ключа сортировки (`title`/`created_at`/`updated_at`, позже — свойства). */
  key: string;
  order: 'asc' | 'desc';
}

/**
 * Корень wire-формата отбора: версия формы + дерево условий + необязательная
 * сортировка. Именно эту форму хранят `thought_type_views.definition` и
 * `saved_filters.definition` после одноразовой миграции `definition v1 → AST`.
 */
export interface FilterAst {
  version: number;
  filter: FilterAstNode;
  sort?: FilterAstSortKey[];
}
