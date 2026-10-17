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
 * **Состав операторов по операнду (требование c088f9e1, задача 6ae062a9).** Все
 * шесть профилей объявляют наборы операторов по операнду
 * ({@link FilterProfile.operand_operators}), а отбор мыслей — ещё и по природе
 * свойства для полиморфного операнда «Свойство»
 * ({@link FilterProfile.operand_operators_by_value_type}). Благодаря этому
 * редактор не предлагает оператор, который исполнитель отвергнет: «в (выборке)»
 * и наборные операторы стоят только на релевантных операндах, предикаты несут
 * триаду, булево — «равно»/«не равно».
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
import { type PropertyValueType } from './enums.js';

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
   * Наборы операторов ПО ПРИРОДЕ свойства для полиморфного операнда «Свойство»
   * (требование 9bdddad6 «правила применимости операторов по типу операнда»):
   * `property` адресует свойства ВСЕХ видов, поэтому его состав уточняется по
   * `value_type` свойства реестра, а не по виду операнда. Ключ — значение
   * {@link PropertyValueType}. Читается клиентским конструктором, когда редактор
   * знает природу свойства; серверный гейт профиля проверяет объединённый набор
   * {@link FilterProfile.operand_operators} (семантику природы проверяет
   * исполнитель).
   */
  operand_operators_by_value_type?: Readonly<Record<string, readonly FilterAstOperator[]>>;
  /**
   * Операторы, которые исполнитель ПРИНИМАЕТ (входят в
   * {@link FilterProfile.operand_operators}), но редактор НЕ показывает в списке
   * операторов операнда (ошибка 609deba0 п.5). Пример: `matches` у текстовых
   * операндов записи («Заголовок записи»/«Текст записи») — условие «Найти слова»
   * строит живая строка поиска панели «Дневника» (`buildChronicleKeywordGroup`),
   * а в строке условия пользователю достаточно «содержит»/«не содержит». На
   * серверный гейт профиля не влияет (тот читает `operand_operators`).
   */
  hidden_menu_operators?: Readonly<Record<string, readonly FilterAstOperator[]>>;
  /**
   * Объединение допустимых операторов профиля (для AST-профилей — словарь
   * {@link FILTER_AST_OPERATORS}). Для семантических профилей обязан совпадать с
   * объединением значений {@link FilterProfile.operand_operators} (паритет
   * стережётся тестом). Профили с наборами по операнду (в том числе отбор
   * мыслей) соблюдают тот же инвариант: составы по операндам покрывают словарь
   * без остатка — иначе оператор ядра оказался бы невыразим редактором.
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
function unionOperators(lists: Iterable<readonly FilterAstOperator[]>): FilterAstOperator[] {
  const out: FilterAstOperator[] = [];
  for (const list of lists) {
    for (const op of list) if (!out.includes(op)) out.push(op);
  }
  return out;
}

/** Операторы по операнду профиля «вложения» (требование f67c85c1). */
const ATTACHMENT_OPERATOR_SETS: Record<string, readonly FilterAstOperator[]> = {
  // «Имя/заголовок»: равно/не равно/содержит/не содержит/в списке/Найти слова.
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
  // «Время записи» — датовый операнд: сравнения, «между» и равно/не равно
  // (равенство «голой даты» = пересечение интервала записи с её СУТКАМИ,
  // паритет с датами создания/изменения — ошибка 03db4cb0, аналог e219112e).
  record_time: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  // «Цели записи» (ошибка 609deba0 п.1): значение — под-выборка мыслей ИЛИ
  // список мыслей; «в иерархии»/«не в иерархии» — выбранные цели и их
  // структурные потомки (зеркало операнда «Мысль» профиля мыслей).
  targets: ['in', 'not_in', 'all_of', 'in_hierarchy', 'not_in_hierarchy', 'is_empty', 'not_empty'],
  // «Заголовок записи»: равно/не равно/содержит/не содержит + `matches`
  // (условие «Найти слова» строит живая строка поиска панели — путь Б
  // `buildChronicleKeywordGroup`); в списке операторов редактора `matches` не
  // предлагается (`hidden_menu_operators`, ошибка 609deba0 п.5).
  record_title: ['eq', 'ne', 'contains', 'not_contains', 'matches'],
  // «Текст записи» — те же операторы, что у заголовка (ошибка 609deba0 п.5):
  // раньше было только `matches`, из-за чего текст записи нельзя было отобрать
  // по подстроке. `matches` сохранён для пути Б ключевых слов (панель).
  record_body: ['eq', 'ne', 'contains', 'not_contains', 'matches'],
  record_author: ['eq', 'ne', 'in', 'not_in'],
  record_editor: ['eq', 'ne', 'in', 'not_in'],
};

/** Операторы по операнду профиля «события» (требование 1765e659). */
const EVENT_OPERATOR_SETS: Record<string, readonly FilterAstOperator[]> = {
  // «Время события» — датовый операнд: сравнения, «между» и равно/не равно
  // (равенство «голой даты» = СУТКИ события, паритет с датами
  // создания/изменения — ошибка 03db4cb0, аналог e219112e).
  occurred_at: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  // «Тип действия» и «Вид сущности» — МНОЖЕСТВЕННЫЕ перечисления: вид значения у
  // них всегда список кодов, поэтому допустимы ТОЛЬКО «в»/«не в» (ошибка 50d9bf4e
  // п. C1 — прежние `eq`/`ne`/`contains` вводили в заблуждение одним и тем же
  // видом ячейки).
  action: ['in', 'not_in'],
  entity_type: ['in', 'not_in'],
  // «Заголовок сущности» (задача b2aa2444, решение пользователя — вариант 1):
  // текстовый операнд — снимок заголовка сущности на момент события (`activity_log.
  // entity_title`). Операторы — «содержит»/«не содержит» (LIKE по слову), как у
  // прочих текстовых операндов.
  entity_title: ['contains', 'not_contains'],
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
 * Операторы операнда «Свойство» ПО ПРИРОДЕ свойства (требования 9bdddad6
 * «правила применимости операторов по типу операнда», c088f9e1). Левый операнд
 * `property` полиморфен: состав зависит от `value_type` свойства реестра, а не
 * от вида операнда, поэтому объявляется здесь и читается конструктором, когда
 * природа свойства известна.
 *
 * Наборы отражают исполнимую единым движком (`server/src/domain/query-service.ts`)
 * семантику:
 *   * скаляры (текст/url) — подстрока, сравнения, «между», списки и наборы;
 *   * булево — только `eq`/`ne` (требование 9bdddad6: триада «да/нет/не важно»,
 *     без сравнений и без «между»);
 *   * ссылочные (связь, legacy `thought_ref`) — списки и наборы
 *     (`any_of`/`all_of`/`none_of`), «количество» (`gt/gte/lt/lte/between`),
 *     «в иерархии» — только у свойства-связи (требование aa7a2aea);
 *   * кросс-сетевая ссылка и публикация — только точное совпадение и наборы
 *     (адрес либо совпал, либо нет).
 *
 * Серверный гейт плоской формы `OPS_BY_VALUE_TYPE` — подмножество этих наборов:
 * AST-эра добавила `not_contains`, сравнения/«между» скаляров и «в иерархии»
 * свойства-связи (паритет «гейт ⊆ наборы, лишнее — только эти операторы»
 * стережётся тестом `server/tests/filter-profiles.test.ts`).
 */
export const PROPERTY_OPERATOR_SETS: Readonly<
  Record<PropertyValueType, readonly FilterAstOperator[]>
> = {
  text: [
    'contains',
    'not_contains',
    'eq',
    'ne',
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
  ],
  url: [
    'contains',
    'not_contains',
    'eq',
    'ne',
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
  ],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between', 'is_empty', 'not_empty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between', 'is_empty', 'not_empty'],
  // Булево свойство: только «равно»/«не равно» — триада «да/нет/не важно»
  // выражается значением, сравнения и «заполнено» избыточны (9bdddad6).
  bool: ['eq', 'ne'],
  link: [
    'eq',
    'ne',
    'in',
    'not_in',
    'any_of',
    'all_of',
    'none_of',
    'in_hierarchy',
    'not_in_hierarchy',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'not_between',
    'is_empty',
    'not_empty',
  ],
  thought_ref: ['eq', 'ne', 'in', 'not_in', 'any_of', 'all_of', 'none_of', 'is_empty', 'not_empty'],
  cross_network_ref: ['eq', 'ne', 'any_of', 'all_of', 'none_of'],
  publication: ['eq', 'ne', 'any_of', 'all_of', 'none_of'],
};

/**
 * Краткие описания НАЗНАЧЕНИЯ операторов ядра — тултипы списка операторов
 * редактора отбора (требование заказчика 2026-10-14, ошибка 4258e694, п.7в).
 *
 * Один словарь на клиент и сервер: описание читает конструктор дерева
 * (`client/src/renderer/lib/filter-tree.ts`), второй копии нет — паритет
 * «покрытие всех операторов словаря» стережёт сторож `guard-filter-builder`.
 */
export const AST_OPERATOR_DESCRIPTIONS: Readonly<Record<FilterAstOperator, string>> = {
  eq: 'проверяет точное соответствие заданному значению',
  ne: 'проверяет, что значение отличается от заданного',
  contains: 'ищет заданную подстроку в значении',
  not_contains: 'проверяет, что подстроки в значении нет',
  gt: 'значение больше заданного',
  gte: 'значение больше заданного или равно ему',
  lt: 'значение меньше заданного',
  lte: 'значение меньше заданного или равно ему',
  between: 'значение попадает в заданный диапазон',
  not_between: 'значение вне заданного диапазона',
  in: 'значение совпадает с любым из перечисленных',
  not_in: 'значение не совпадает ни с одним из перечисленных',
  any_of: 'значение совпадает хотя бы с одним из выборки',
  all_of: 'значение совпадает со всеми из выборки',
  none_of: 'значение не совпадает ни с одним из выборки',
  is_empty: 'значение не заполнено',
  not_empty: 'значение заполнено',
  matches: 'ищет слова в выбранных областях мысли',
  in_hierarchy: 'совпадает с выбранной мыслью или её потомком',
  not_in_hierarchy: 'не совпадает с выбранной мыслью и её потомками',
  has: 'у мыслей должно быть выбранное свойство',
  not_has: 'у мыслей не должно быть выбранного свойства',
};

/**
 * Операторы ПО ОПЕРАНДУ профиля «мысли» (требование c088f9e1 «состав операторов
 * по типу операнда», ADR 30ff83bb; задача 6ae062a9, доработка).
 *
 * Раньше профиль отдавал объединённый словарь ядра, и редактор предлагал
 * «в (выборке)»/наборные операторы на предикатах и скалярах, где исполнитель их
 * отвергает. Теперь состав объявлен: под-выборочные наборные операторы
 * (`any_of`/`all_of`/`none_of`) стоят только на релевантных операндах
 * (свойства-ссылки, «Родители»/«Потомки», «Тип»), предикаты-триады несут
 * `eq`/`ne`, «Найти слова» — только `matches`, коллекции — наличие и «количество»,
 * «Автор»/«Редактор» — списки и заполненность.
 */
const THOUGHT_OPERATOR_SETS: Readonly<Record<string, readonly FilterAstOperator[]>> = {
  // «Мысль» (`id`): тождественность явным набором и «в иерархии» — выбранные
  // мысли и все их потомки по СТРУКТУРНЫМ связям (режим связей неприменим;
  // задача a577875b).
  id: ['eq', 'ne', 'in', 'not_in', 'in_hierarchy', 'not_in_hierarchy'],
  type: [
    'eq',
    'ne',
    'in',
    'not_in',
    'in_hierarchy',
    'not_in_hierarchy',
    // «Имеет свойство»/«не имеет» на операнде «Тип» (требование bd0348b3).
    'has',
    'not_has',
    // «Тип» — одиночный операнд: «все в выборке» неприменимо (исполнитель
    // отвергает `all_in` на типе), «любой»/«ни один» — применимы.
    'any_of',
    'none_of',
  ],
  property: unionOperators(Object.values(PROPERTY_OPERATOR_SETS)),
  link_type: [
    'eq',
    'ne',
    'in',
    'not_in',
    'in_hierarchy',
    'not_in_hierarchy',
    'is_empty',
    'not_empty',
  ],
  parents: [
    'eq',
    'ne',
    'in',
    'not_in',
    'is_empty',
    'not_empty',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'not_between',
    'in_hierarchy',
    'not_in_hierarchy',
    'any_of',
    'all_of',
    'none_of',
  ],
  children: [
    'eq',
    'ne',
    'in',
    'not_in',
    'is_empty',
    'not_empty',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'not_between',
    'in_hierarchy',
    'not_in_hierarchy',
    'any_of',
    'all_of',
    'none_of',
  ],
  attachments: ['eq', 'ne', 'is_empty', 'not_empty', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  chronology: ['eq', 'ne', 'is_empty', 'not_empty', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  comment: ['eq', 'ne', 'is_empty', 'not_empty'],
  active: ['eq', 'ne'],
  trashed: ['eq', 'ne'],
  keywords: ['matches'],
  author: ['eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty'],
  editor: ['eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty'],
  created_at: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  updated_at: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'not_between'],
  properties: ['has', 'not_has', 'is_empty', 'not_empty'],
};

/**
 * Операнды профиля «карта»: тот же набор, что у «мыслей» (оператор `link_type`
 * доступен обоим профилям, задача f7da04d6). Отдельный профиль сохранён как
 * точка расширения карты.
 */
const MAP_OPERANDS: readonly FilterAstEntityKind[] = [...THOUGHT_OPERANDS];

/**
 * Реестр профилей контекста. Ключ — {@link FilterProfileId}. Профили точек,
 * отбирающих мысли, несут ПОЛНЫЙ словарь ядра (`operators`) и составы по
 * операндам ({@link FilterProfile.operand_operators}); профили иных сущностей —
 * подмножество по видимым характеристикам (требования 62475a6e/1765e659/f67c85c1).
 */
export const FILTER_PROFILES: Readonly<Record<FilterProfileId, FilterProfile>> = {
  thoughts: {
    id: 'thoughts',
    title: 'Мысли (панель поиска, выборки типа, сохранённые отборы)',
    target: 'thought',
    operands: THOUGHT_OPERANDS,
    operand_operators: THOUGHT_OPERATOR_SETS,
    operand_operators_by_value_type: PROPERTY_OPERATOR_SETS,
    operators: FILTER_AST_OPERATORS,
    tokens: ['calendar'],
    withTime: false,
  },
  map: {
    id: 'map',
    title: 'Карта (фильтр мыслей и типов связей)',
    target: 'thought',
    operands: MAP_OPERANDS,
    operand_operators: THOUGHT_OPERATOR_SETS,
    operand_operators_by_value_type: PROPERTY_OPERATOR_SETS,
    operators: FILTER_AST_OPERATORS,
    tokens: ['calendar'],
    withTime: false,
  },
  publications: {
    id: 'publications',
    title: 'Публикации (рецепт заголовков)',
    target: 'thought',
    operands: THOUGHT_OPERANDS,
    operand_operators: THOUGHT_OPERATOR_SETS,
    operand_operators_by_value_type: PROPERTY_OPERATOR_SETS,
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
    // «Найти слова» у текстовых операндов записи — только для внутреннего
    // условия живой строки поиска, пользователю в строке не предлагается
    // (ошибка 609deba0 п.5).
    hidden_menu_operators: {
      record_title: ['matches'],
      record_body: ['matches'],
    },
    operators: unionOperators(Object.values(CHRONICLE_OPERATOR_SETS)),
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  events: {
    id: 'events',
    title: 'События (журнал активности)',
    target: 'activity',
    operands: ['occurred_at', 'action', 'entity_type', 'entity_title', 'entity_id', 'user'],
    operand_operators: EVENT_OPERATOR_SETS,
    operators: unionOperators(Object.values(EVENT_OPERATOR_SETS)),
    tokens: ['calendar', 'time'],
    withTime: true,
  },
  attachments: {
    id: 'attachments',
    title: 'Вложения',
    target: 'attachment',
    operands: ['name', 'kind', 'mime_type', 'owner', 'size'],
    operand_operators: ATTACHMENT_OPERATOR_SETS,
    operators: unionOperators(Object.values(ATTACHMENT_OPERATOR_SETS)),
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
 * Операторы одного операнда профиля — состав, доступный редактору и проверяемый
 * сервером (требование c088f9e1 «состав операторов по типу операнда»).
 *
 * Для полиморфного операнда «Свойство» состав уточняется по природе свойства:
 * `propertyValueType` — `value_type` адресуемого свойства реестра (требование
 * 9bdddad6). Природа неизвестна — отдаётся объединённый набор операнда.
 *
 * Профиль без составов по операндам отдаёт объединённый словарь
 * ({@link FilterProfile.operators}).
 */
export function filterProfileOperandOperators(
  id: FilterProfileId,
  kind: FilterAstEntityKind,
  propertyValueType?: PropertyValueType,
): readonly FilterAstOperator[] {
  const profile = FILTER_PROFILES[id];
  const byValueType = profile.operand_operators_by_value_type;
  if (kind === 'property' && byValueType !== undefined && propertyValueType !== undefined) {
    const scoped = byValueType[propertyValueType];
    if (scoped !== undefined) return scoped;
  }
  const perOperand = profile.operand_operators;
  if (perOperand !== undefined) return perOperand[kind] ?? [];
  return profile.operators;
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
