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
 * Элемент списка значений: литерал или токен. Список с токенами нужен
 * оператору «между» — каждая граница может быть токеном (требование 84b52caa:
 * `[ { "token": "$weekStart-1d" }, { "token": "$today" } ]`).
 */
export type FilterAstListItem = FilterAstScalar | FilterAstTokenValue;

/**
 * Под-выборка как значение: `{ "query": <узел>, "operator": "in" | "not_in" | "all_in" }`.
 * `query` — полноценное под-дерево AST (глубина вложенности не ограничена).
 */
export interface FilterAstSubqueryValue {
  query: FilterAstNode;
  operator: 'in' | 'not_in' | 'all_in';
}

/**
 * Значение условия-листа: литерал | список (литералы и/или токены) | токен |
 * под-выборка. Список с токенами — для «между», где каждая граница может быть
 * токеном (требование 84b52caa).
 */
export type FilterAstValue =
  | FilterAstScalar
  | FilterAstListItem[]
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
  /**
   * Карта подписей значений-ссылок по id (`{ [id]: имя }`) — показ имён вместо
   * id при НЕСКОЛЬКИХ выбранных значениях (ошибка 4258e694 п.12б). Одиночное
   * значение дополнительно несёт {@link value} (совместимость с уже
   * сохранёнными отборами и сообщениями диагностики).
   */
  values?: Record<string, string>;
}

/**
 * Полный словарь видов операндов AST (`FilterAstEntity['kind']`). Отдельный
 * const-набор нужен реестру профилей контекста и сторожу паритета: состав
 * операндов профиля задаётся подмножеством этого набора. Держи в синхроне с
 * объединением {@link FilterAstEntity} (проверяется тестом-сторожем).
 */
export const FILTER_AST_ENTITY_KINDS = [
  'id',
  'type',
  'property',
  'link_type',
  'parents',
  'children',
  'attachments',
  'chronology',
  'comment',
  'targets',
  'active',
  'trashed',
  'keywords',
  'author',
  'editor',
  'created_at',
  'updated_at',
  'properties',
  'record_time',
  'record_title',
  'record_body',
  'record_author',
  'record_editor',
  // --- Профиль «События»: характеристики записи журнала активности (требование 1765e659) ---
  'occurred_at',
  'action',
  'entity_type',
  'entity_id',
  'user',
  // --- Профиль «Вложения»: видимые характеристики вложения (требование f67c85c1) ---
  'name',
  'kind',
  'mime_type',
  'owner',
  'size',
] as const;
/** Вид операнда AST (элемент {@link FILTER_AST_ENTITY_KINDS}). */
export type FilterAstEntityKind = (typeof FILTER_AST_ENTITY_KINDS)[number];

/**
 * Левый операнд условия. Дискриминант — `kind`. Состав операндов зависит от
 * профиля контекста точки применения (проектируется профилями контекста);
 * здесь — общий словарь операндов отбора мыслей.
 */
export type FilterAstEntity =
  /**
   * Мысль: явный набор id (операторы `eq`/`ne`/`in`/`not_in`) либо она и её
   * потомки по структурным связям (`in_hierarchy`/`not_in_hierarchy`, режим
   * связей неприменим — только структурные потомки; задача a577875b).
   */
  | { kind: 'id' }
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
  | { kind: 'properties' }
  // --- Профиль «Хроника»: характеристики ЗАПИСИ дневника (требование 62475a6e) ---
  /** «Время записи» (`valid_from`/`valid_to`) — пересечение интервала записи. */
  | { kind: 'record_time' }
  /** «Заголовок записи» (`title`). */
  | { kind: 'record_title' }
  /** «Тело записи» (`body_md`) — «Есть слова». */
  | { kind: 'record_body' }
  /** Автор записи (`created_by`). */
  | { kind: 'record_author' }
  /** Редактор записи (`updated_by`). */
  | { kind: 'record_editor' }
  // --- Профиль «События»: характеристики записи журнала активности (требование 1765e659) ---
  /** «Время события» (`occurred_at_ms`) — сравнение, «между», токены времени. */
  | { kind: 'occurred_at' }
  /** «Тип действия» (`action`) — создано/изменено/удалено/… */
  | { kind: 'action' }
  /** «Вид сущности» (`entity_type`). */
  | { kind: 'entity_type' }
  /** «Сущность» (`entity_id`) — равно или под-выборка по мыслям. */
  | { kind: 'entity_id' }
  /** «Автор события» (`user_id`). */
  | { kind: 'user' }
  // --- Профиль «Вложения»: видимые характеристики вложения (требование f67c85c1) ---
  /**
   * «Имя/заголовок» вложения (`title`) — равно/содержит/в списке/«Есть слова».
   * Семантический id (`name`), колонка — `title` (конвенция реестра профилей).
   */
  | { kind: 'name' }
  /** «Тип» вложения (`kind` = `file`/`url`) — равно/в списке. */
  | { kind: 'kind' }
  /** «MIME-подтип» (`mime_type`) — равно/содержит/в списке. */
  | { kind: 'mime_type' }
  /**
   * «Владельцы» (`attachment_owners`): заполнено/не заполнено; в списке по ТИПУ
   * владельца; под-выборка по мыслям-владельцам (`in`/`not_in`/`all_of`);
   * «в иерархии» по мыслям-владельцам; количество (сравнения).
   */
  | { kind: 'owner' }
  /** «Размер» (`file_size`, байты) — сравнения, «между», заполнено/не заполнено. */
  | { kind: 'size' };

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

/**
 * Уровень серьёзности диагностики отбора (требования 44d61c8a «красная»,
 * 325efc13 «жёлтая»). `error` — красное: применение отбора запрещено;
 * `warning` — жёлтое: отбор исполняется, предупреждение не блокирует.
 */
export type FilterDiagnosticSeverity = 'error' | 'warning';

/**
 * Машиночитаемый код диагностики отбора:
 *
 *   * `entity_deleted` — сущность условия удалена из сети (свойство реестра,
 *     тип/тип связи, значение-мысль): красная диагностика, запрет применения;
 *   * `property_detached` — свойство существует, но больше не входит в
 *     эффективный набор свойств типа отбора: жёлтая диагностика, исполнение по
 *     фактическим значениям вне типа (требование 325efc13).
 */
export type FilterDiagnosticCode = 'entity_deleted' | 'property_detached';

/**
 * Диагностика узла отбора (требования 44d61c8a/325efc13). Возвращается
 * сервером как данные для UI: `path` находит проблемную строку редактора,
 * `label` — снапшот человекочитаемого имени из `labels` AST (сущности уже
 * нет — имя взять больше негде), `deleted_at` — дата удаления, если известна.
 */
export interface FilterDiagnostic {
  severity: FilterDiagnosticSeverity;
  code: FilterDiagnosticCode;
  /** Путь к узлу AST, напр. `filter.children[0]` (для перехода «исправить»). */
  path: string;
  /** Снапшот имени сущности из `labels` AST; `null`, если снапшота нет. */
  label: string | null;
  /** Снапшот значения из `labels` AST (для значения-мысли); иначе — `null`. */
  value_label?: string | null;
  /**
   * ISO-8601 дата, когда сущность была удалена/отвязана; `null`/отсутствует,
   * когда сеть такую метку не хранит.
   */
  deleted_at?: string | null;
  /** Человекочитаемая причина (для сообщения пользователю/агенту). */
  message: string;
}
