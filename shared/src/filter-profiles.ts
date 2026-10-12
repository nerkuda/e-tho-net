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
 *
 * **Подключение к точкам.** Профили `thoughts`/`publications` подключены к своим
 * точкам и участвуют в валидации AST (задача 7a798b17); профиль `map` описан
 * заранее. Профили `events` и `attachments` описаны, но к точкам ПОКА не
 * подключены — их AST-точки появляются задачами 2b230e8e и 5a007bed (осознанно;
 * до тех пор AST-валидация по операндам к семантическим профилям неприменима).
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
   *
   * **Конвенция семантических id** (решение оркестратора 2026-10-12): id операнда
   * НЕ обязан совпадать с SQL-колонкой (`name` — это `title`, `user` — `user_id`).
   * Id — стабильное имя характеристики для реестра и клиентского конструктора;
   * привязка к колонке — забота будущего исполнителя AST соответствующей точки.
   */
  operands: readonly string[];
  /**
   * Операторы, допустимые для КАЖДОГО операнда семантического профиля (точки,
   * отбирающие не-мысли). Для AST-профилей отсутствует: набор операторов по
   * операнду задаёт доменный исполнитель (`query-service.ts`).
   */
  operand_operators?: Readonly<Record<string, readonly FilterAstOperator[]>>;
  /**
   * Объединение допустимых операторов профиля (для AST-профилей — словарь
   * {@link FILTER_AST_OPERATORS}). Для семантических профилей обязан совпадать с
   * объединением значений {@link FilterProfile.operand_operators} (паритет
   * стережётся тестом).
   */
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

/** Уникальное объединение наборов операторов (порядок — появления). */
function unionOperators(
  map: Readonly<Record<string, readonly FilterAstOperator[]>>,
): FilterAstOperator[] {
  const out: FilterAstOperator[] = [];
  for (const list of Object.values(map)) {
    for (const op of list) if (!out.includes(op)) out.push(op);
  }
  return out;
}

/** Операторы по операнду профиля «вложения» (требование f67c85c1). */
const ATTACHMENT_OPERATOR_SETS: Record<string, readonly FilterAstOperator[]> = {
  // «Имя/заголовок»: равно/не равно/содержит/не содержит/в списке/Есть слова.
  name: ['eq', 'ne', 'contains', 'not_contains', 'in', 'not_in', 'matches'],
  // «Вид вложения» (file/url): равно/в списке.
  kind: ['eq', 'ne', 'in', 'not_in'],
  // «MIME-подтип»: равно/содержит/в списке.
  mime_type: ['eq', 'ne', 'contains', 'not_contains', 'in', 'not_in'],
  // «Владельцы»: в списке/в иерархии/в выборке (значение-подзапрос с in/not_in/
  // all_of)/количество (сравнения) + заполнено.
  owner: ['in', 'not_in', 'all_of', 'in_hierarchy', 'not_in_hierarchy', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  // «Размер»: сравнения/между/заполнено.
  size: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between', 'is_empty', 'not_empty'],
};

/** Операторы по операнду профиля «хроника» (требование 62475a6e). */
const CHRONICLE_OPERATOR_SETS: Record<string, readonly FilterAstOperator[]> = {
  record_time: ['gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  targets: ['in', 'not_in', 'all_of', 'is_empty', 'not_empty'],
  record_title: ['eq', 'ne', 'contains', 'not_contains', 'matches'],
  record_body: ['matches'],
  record_author: ['eq', 'ne', 'in', 'not_in'],
  record_editor: ['eq', 'ne', 'in', 'not_in'],
};

/** Операторы по операнду профиля «события» (требование 1765e659). */
const EVENT_OPERATOR_SETS: Record<string, readonly FilterAstOperator[]> = {
  occurred_at: ['gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  action: ['eq', 'ne', 'contains', 'not_contains', 'in', 'not_in'],
  entity_type: ['in', 'not_in'],
  entity_id: ['eq', 'ne'],
  user: ['eq', 'ne', 'in', 'not_in'],
};

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
    operand_operators: CHRONICLE_OPERATOR_SETS,
    operators: unionOperators(CHRONICLE_OPERATOR_SETS),
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  events: {
    id: 'events',
    title: 'События (журнал активности)',
    target: 'activity',
    operands: ['occurred_at', 'action', 'entity_type', 'entity_id', 'user'],
    operand_operators: EVENT_OPERATOR_SETS,
    operators: unionOperators(EVENT_OPERATOR_SETS),
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  attachments: {
    id: 'attachments',
    title: 'Вложения',
    target: 'attachment',
    operands: ['name', 'kind', 'mime_type', 'owner', 'size'],
    operand_operators: ATTACHMENT_OPERATOR_SETS,
    operators: unionOperators(ATTACHMENT_OPERATOR_SETS),
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
