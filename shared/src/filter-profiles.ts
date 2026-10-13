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
 * заранее. Профиль `chronicle` подключён точкой `POST /chronicle/query`
 * (задача 4752b065), профиль `events` — точкой `GET /activity` /
 * `etn.activity.list` (задача 2b230e8e), профиль `attachments` — точкой
 * `GET /networks/:id/attachments` / `etn.attachments.search` (задача 5a007bed):
 * их операнды — виды AST (`record_*` / `occurred_at`, `action`, `entity_type`,
 * `entity_id`, `user` / `name`, `kind`, `mime_type`, `owner`, `size`), AST
 * исполняется единым исполнителем соответствующей точки.
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
 * `operands` — допустимые операнды точки. У всех подключённых точек это виды
 * операндов AST ({@link FilterAstEntityKind}) — тогда по профилю валидируется
 * AST: мысли (`thoughts`/`publications`/`map`), записи дневника (`record_*`,
 * `targets`, требование 62475a6e), события (`occurred_at`…`user`, требование
 * 1765e659), вложения (`name`…`size`, требование f67c85c1). Каждый такой профиль
 * исполняется единым AST-движком своей точки.
 */
export interface FilterProfile {
  id: FilterProfileId;
  /** Человекочитаемое имя точки применения (для интерфейса/диагностики). */
  title: string;
  /** Целевая сущность отбора. */
  target: FilterProfileTarget;
  /**
   * Допустимые операнды — виды AST ({@link FilterAstEntityKind}).
   *
   * **Конвенция семантических id** (решение оркестратора 2026-10-12): id операнда
   * НЕ обязан совпадать с SQL-колонкой (`name` — это `title`, `user` — `user_id`).
   * Id — стабильное имя характеристики для реестра и клиентского конструктора;
   * привязка к колонке — забота исполнителя AST соответствующей точки.
   */
  operands: readonly FilterAstEntityKind[];
  /**
   * Операторы, допустимые для КАЖДОГО операнда профиля. Несёт подмножество по
   * видимым характеристикам (точки, отбирающие не-мысли: хроника, события,
   * вложения). Отсутствует у профилей, где набор операторов по операнду задаёт
   * доменный исполнитель (`query-service.ts`, отбор мыслей) — там действует
   * объединённый словарь {@link FilterProfile.operators}.
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
  entity_type: ['eq', 'ne', 'in', 'not_in'],
  // «По конкретной сущности — равно ИЛИ под-выборка по мыслям» (требование
  // 1765e659): `eq`/`ne` — литеральный id; `in`/`not_in`/`all_of` — значение-
  // под-выборка мыслей (операторы совместимы со значением-под-выборкой,
  // AST_SUBQUERY_LEAF_OPS; `all_of` ↔ `value.operator = "all_in"`).
  entity_id: ['eq', 'ne', 'in', 'not_in', 'all_of'],
  user: ['eq', 'ne', 'in', 'not_in'],
};

/**
 * Операнды профиля «мысли»: полный словарь AST без операндов чужих точек.
 *
 * `link_type` входит и в профиль «мысли» (задача f7da04d6): канонический
 * AST-лист фильтра типов связей (`linkFilterToAst`) допустим в теле отбора
 * мыслей наравне с плоским фасадным `link_filter`. Семантика в контексте мысли —
 * «у мысли есть инцидентная связь указанного типа»; `is_empty`/`not_empty` —
 * «нет/есть типизированных инцидентных связей» (executor `query-service`).
 */
const THOUGHT_OPERANDS: readonly FilterAstEntityKind[] = [
  'id',
  'type',
  'link_type',
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

/**
 * Операнды профиля «карта»: тот же набор, что у «мыслей» (оператор `link_type`
 * доступен обоим профилям, задача f7da04d6). Отдельный профиль сохранён как
 * точка расширения карты.
 */
const MAP_OPERANDS: readonly FilterAstEntityKind[] = [...THOUGHT_OPERANDS];

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
 * применения. После подключения вложений (задача 5a007bed) все шесть профилей
 * AST-профили, поэтому `null` практически недостижим; он сохранён контрактом
 * (`null` — семантические операнды иной сущности, AST-валидация по операндам
 * неприменима) на случай профиля, чьи операнды ещё не сведены к видам AST.
 */
export function filterProfileAstOperands(
  id: FilterProfileId,
): ReadonlySet<FilterAstEntityKind> | null {
  const known = new Set<string>(FILTER_AST_ENTITY_KINDS);
  const operands = FILTER_PROFILES[id].operands;
  if (operands.length === 0 || !operands.every((o) => known.has(o))) return null;
  return new Set(operands);
}
