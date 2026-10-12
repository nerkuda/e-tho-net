/**
 * Реестр профилей контекста отбора — состав доступных операндов, операторов и
 * токенов для каждой точки применения отбора (требование 0095daad «Профили
 * контекста всех точек применения отбора описаны», требование aed27eb8
 * «Профиль контекста: состав операндов по видимым характеристикам сущности»,
 * ADR 0c02ab4f; задача 7a798b17, под-проект «Отборы всех сущностей и мест»).
 *
 * **Принцип состава (ADR 0c02ab4f).** В профиль входят характеристики
 * сущности, которые пользователь видит или может увидеть на экране в текущем
 * представлении. Это принцип, а не перечень на каждый экран: профили
 * расширяемы, состав выводится из видимых характеристик.
 *
 * **Токены.** Календарные (`$today`, `$weekStart/$weekEnd`, `$monthStart/$monthEnd`,
 * `$yearStart/$yearEnd`, `±N d/w/mo/y`) доступны во ВСЕХ профилях. Токены и
 * единицы времени (`$now`, `$hourStart/$hourEnd`, `±N h/mi`) — только в
 * профилях, несущих время (хроника, события): `withTime === true`.
 *
 * **Единый источник для клиента и сервера.** Реестр живёт в `@etn/shared`:
 * сервер по нему валидирует AST в точке применения, клиентский конструктор — по
 * нему строит доступный набор операндов (задача e5dd10ab). Рассинхрон ловит
 * `tsc` и сторож паритета.
 */

import {
  FILTER_AST_ENTITY_KINDS,
  FILTER_AST_OPERATORS,
  type FilterAstEntityKind,
  type FilterAstOperator,
} from './types/filter-ast.js';

/** Идентификатор профиля контекста — точка применения отбора. */
export const FILTER_PROFILE_IDS = [
  'thoughts',
  'chronicle',
  'events',
  'attachments',
  'map',
  'publications',
] as const;
export type FilterProfileId = (typeof FILTER_PROFILE_IDS)[number];

/** Целевая сущность отбора точки применения. */
export const FILTER_PROFILE_TARGETS = [
  'thought',
  'chronicle_record',
  'activity',
  'attachment',
  'link',
  'publication',
] as const;
export type FilterProfileTarget = (typeof FILTER_PROFILE_TARGETS)[number];

/**
 * Семейство токенов, допустимое в профиле:
 *   * `calendar` — календарные токены и арифметика дней/недель/месяцев/лет
 *     (доступны везде);
 *   * `time` — токены и единицы времени (`$now`, `$hourStart/$hourEnd`, `h`/`mi`).
 */
export type FilterTokenFamily = 'calendar' | 'time';

/**
 * Профиль контекста точки применения.
 *
 * `operands` — допустимые операнды. Для точек, отбирающих МЫСЛИ, это виды
 * операндов AST ({@link FilterAstEntityKind}) — тогда по профилю валидируется
 * AST. Для точек с иной целевой сущностью (хроника, события, вложения) это
 * семантические идентификаторы характеристик: их AST появится в отдельных
 * задачах под-проекта, до тех пор профиль описывает состав декларативно.
 */
export interface FilterProfile {
  id: FilterProfileId;
  /** Человекочитаемое имя точки применения (для интерфейса/диагностики). */
  title: string;
  /** Целевая сущность отбора. */
  target: FilterProfileTarget;
  /**
   * Допустимые операнды: виды AST (для точек на мысли) либо семантические
   * идентификаторы характеристик целевой сущности.
   */
  operands: readonly string[];
  /** Допустимые операторы-листья (семантику по операнду задаёт движок). */
  operators: readonly FilterAstOperator[];
  /** Семейства токенов профиля (состав надмножества полного словаря токенов). */
  tokens: readonly FilterTokenFamily[];
  /**
   * Гранулярность времени профиля: `true` — токены и единицы времени доступны
   * (`$now`/`$hour*`/`h`/`mi`); `false` — только календарные. Отражает
   * присутствие `'time'` в {@link FilterProfile.tokens} (инвариант стережётся
   * тестом) и прокидывается в `AstTokenContext.withTime`.
   */
  withTime: boolean;
}

/** Операнды профиля «мысли»: полный словарь AST без операндов чужих точек. */
const THOUGHT_OPERANDS: readonly FilterAstEntityKind[] = [
  'type',
  'property',
  'parents',
  'children',
  'attachments',
  'chronology',
  'comment',
  'active',
  'trashed',
  'keywords',
  'author',
  'editor',
  'created_at',
  'updated_at',
  'properties',
];

/** Операнды профиля «карта»: мысли + формально тип связи (задача f7da04d6). */
const MAP_OPERANDS: readonly FilterAstEntityKind[] = [...THOUGHT_OPERANDS, 'link_type'];

/**
 * Реестр профилей контекста. Ключ — {@link FilterProfileId}. Полный AST-словарь
 * операторов доступен на точках, отбирающих мысли; профили иных сущностей несут
 * подмножество по видимым характеристикам (требования 62475a6e/1765e659/f67c85c1).
 */
export const FILTER_PROFILES: Readonly<Record<FilterProfileId, FilterProfile>> = {
  thoughts: {
    id: 'thoughts',
    title: 'Мысли (панель поиска, выборки типа, сохранённые отборы)',
    target: 'thought',
    operands: THOUGHT_OPERANDS,
    operators: FILTER_AST_OPERATORS,
    tokens: ['calendar'],
    withTime: false,
  },
  map: {
    id: 'map',
    title: 'Карта (фильтр мыслей и типов связей)',
    target: 'thought',
    operands: MAP_OPERANDS,
    operators: FILTER_AST_OPERATORS,
    tokens: ['calendar'],
    withTime: false,
  },
  publications: {
    id: 'publications',
    title: 'Публикации (рецепт заголовков)',
    target: 'thought',
    operands: THOUGHT_OPERANDS,
    operators: FILTER_AST_OPERATORS,
    tokens: ['calendar'],
    withTime: false,
  },
  chronicle: {
    id: 'chronicle',
    title: 'Хроника (записи дневника)',
    target: 'chronicle_record',
    operands: [
      'record_time',
      'targets',
      'record_title',
      'record_body',
      'record_author',
      'record_editor',
    ],
    operators: ['eq', 'ne', 'contains', 'not_contains', 'in', 'not_in', 'between', 'not_between', 'matches'],
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  events: {
    id: 'events',
    title: 'События (журнал активности)',
    target: 'activity',
    operands: ['occurred_at', 'action', 'entity_type', 'entity_id', 'user'],
    operators: ['eq', 'ne', 'contains', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  attachments: {
    id: 'attachments',
    title: 'Вложения',
    target: 'attachment',
    operands: ['name', 'mime_type', 'owner', 'size', 'created_at', 'updated_at'],
    operators: ['eq', 'ne', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between', 'is_empty', 'not_empty'],
    tokens: ['calendar'],
    withTime: false,
  },
};

/** Профиль по id. */
export function getFilterProfile(id: FilterProfileId): FilterProfile {
  return FILTER_PROFILES[id];
}

/** Несёт ли профиль время (токены/единицы `$now`/`$hour*`/`h`/`mi`). */
export function filterProfileHasTime(id: FilterProfileId): boolean {
  return FILTER_PROFILES[id].withTime;
}

/**
 * AST-операнды профиля — множество видов операндов AST, допустимых в этой точке
 * применения. `null`, когда операнды профиля — семантические идентификаторы
 * иной целевой сущности (AST в такой точке появится отдельной задачей);
 * тогда AST-валидация по операндам к профилю неприменима.
 */
export function filterProfileAstOperands(
  id: FilterProfileId,
): ReadonlySet<FilterAstEntityKind> | null {
  const known = new Set<string>(FILTER_AST_ENTITY_KINDS);
  const operands = FILTER_PROFILES[id].operands;
  if (operands.length === 0 || !operands.every((o) => known.has(o))) return null;
  return new Set(operands as readonly FilterAstEntityKind[]);
}
