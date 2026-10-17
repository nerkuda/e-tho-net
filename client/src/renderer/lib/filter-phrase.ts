/**
 * Композер фразы-превью отбора (задача 3cb50258 ТП 11b2509a «Редактор: базовый
 * компонент»; элемент интерфейса ca905fbc «Футер редактора отбора»; сценарий
 * 2a7648d8; требования ca905fbc/9ecf405b; ADR 30ff83bb, ADR 23fab347).
 *
 * Задача модуля — одна: из дерева условий единой модели (`FilterCriteriaState`)
 * собрать человекочитаемую строку. Потребители (текст фразы, тултипы):
 *   • футер редактора — `preview` по умолчанию (`lib/filter-footer.ts`),
 *     показывает ≤3 строки, полный текст и ошибки — в тултипе;
 *   • полоса отборов типов и места внедрения — тултипы кнопок отбора.
 *
 * Модуль — ЧИСТАЯ функция: ни DOM, ни состояния, ни обращений к сети; результат
 * зависит только от входа (дерево + ключи сортировки + данные подписей). Вид
 * собирается из словарей, у которых один источник: подписи операнда —
 * `filterOperandLabel` (`lib/filter-builder.ts`), подписи оператора —
 * `AST_OPERATOR_LABELS`, подписи сортировки — `filterSortAstKeys`, композиция
 * токенов-дат — словарь `lib/period-editor.ts` (канон camelCase, легаси читается).
 *
 * Формат фразы (правка заказчика 2026-10-14, ошибка 4258e694 п.12а/12б):
 *   • лист — `<операнд> <оператор> <значение>` («Город равно Москва»,
 *     «Период записи между начало месяца и конец месяца», «Есть вложения
 *     заполнено»); значение не требуется — только операнд и оператор;
 *   • коннекция группы — операторы «И»/«ИЛИ»/«НЕ» В ВЕРХНЕМ РЕГИСТРЕ между
 *     условиями («A И B», «A ИЛИ B», «НЕ A»); служебных префиксов «все
 *     условия»/«любое условие» больше нет; одиночная группа (один ребёнок) —
 *     без оператора; вложенная группа с другой коннекцией — в скобках
 *     («A И (B ИЛИ C)»);
 *   • значение-ссылка (мысль/тип/связь/свойство) — СОКРАЩЁННЫМ ИМЕНЕМ, а не id:
 *     имя берётся из карты снапшотов `labels.values[id]` (любое число значений,
 *     ошибка 4258e694 п.12б), для одиночного — ещё из `labels.value`, иначе из
 *     каталогов контекста (типы мыслей/связей, реестр свойств) или из резолвера
 *     имён мыслей `ctx.thoughtName` (ошибка d17a8bfd); резолвер есть, а имени
 *     нет — нейтральный плейсхолдер без ID (требование 9d5e3c4e); резолвера нет
 *     (вызов вне редактора/в тестах) — как было (id);
 *   • имя значения обрезается по {@link FILTER_PHRASE_NAME_LIMIT} с «…»;
 *   • под-выборка сворачивается: «Цели в выборке (2 условия)»;
 *   • хвост сортировки: «; сортировка: по названию (убыв.)»;
 *   • длинная фраза обрезается по пределу с «…» (полный текст — в тултипе).
 *
 * Разметка раскраски (правка заказчика 2026-10-14, п.12в; задача 58f77990):
 * фраза собирается ОДИН раз токенами {@link FilterPhraseToken}, а текст и DOM —
 * её проекции (`filterPhraseTokens` — токены, `composeFilterPhrase` — строка).
 * Токены-операторы несут коннекцию И/ИЛИ/НЕ, токены-скобки — уровень
 * вложенности группы; пользовательские данные всегда текстовый токен, поэтому
 * разметку из имени мысли собрать нельзя. Обрезка идёт ДО раскраски — по
 * текстовым позициям (`clipFilterPhraseTokens`), готовый HTML не режется.
 * CSS-классы и цвета — дело представления (`lib/filter-footer.ts`,
 * `styles/filter-editor.css`), модуль о них не знает.
 */

import {
  astOperatorLabel,
  filterAstSortKeyLabel,
  filterOperandLabel,
  parseFilterDefinition,
  type FilterLabelData,
  type FilterTreeGroup,
  type FilterTreeLeaf,
} from './filter-builder.js';
import {
  STRUCTURE_KEYWORD_SCOPES,
  type FilterAstEntityKind,
  type FilterAstGroupOp,
  type FilterAstSortKey,
  type NetworkProperty,
  type StructureKeywordScope,
  type ThoughtType,
} from '@etn/shared';
import { canonicalGlobalToken, isGlobalDateToken, panelAnchorLabel, PERIOD_TOKEN_PRESETS } from './period-editor.js';
// Перечень пользовательских операндов — из каталога природы значения
// (`lib/filter-tokens.ts`), а не вторым словарём (ошибка 23c7d3e9 п. A1).
import { FILTER_USER_OPERAND_KINDS } from './filter-tokens.js';

/** Предел длины фразы по умолчанию; полный текст в тултипе не обрезается. */
export const FILTER_PHRASE_LIMIT = 300;

/**
 * Предел длины ИМЕНИ значения во фразе (правка заказчика 2026-10-14, ошибка
 * 4258e694 п.12б): имена длиннее — с многоточием «…». Применяется к имени
 * ссылочного значения (мысль/тип/связь/свойство), не к свободному тексту.
 */
export const FILTER_PHRASE_NAME_LIMIT = 32;

/**
 * Плейсхолдер вместо имени НЕРАЗРЕШИМОЙ ссылки на мысль (требование 9d5e3c4e):
 * пока имя не догружено (или мысль недоступна), фраза не показывает сырой или
 * обрезанный UUID — только нейтральный текст. Как только кэш имён наполнится
 * (`lib/thought-names.ts`), подписка перерисует фразу с настоящим именем.
 */
export const FILTER_PHRASE_UNKNOWN_THOUGHT = 'без названия';

/** Тот же плейсхолдер для неизвестного участника (`ctx.userName` не нашёл имя). */
export const FILTER_PHRASE_UNKNOWN_USER = 'без имени';

/** Состояние отбора, нужное композеру (часть единой модели `FilterCriteriaState`). */
export interface FilterPhraseState {
  /** Дерево условий; `null` — условий нет. */
  tree?: FilterTreeGroup | FilterTreeLeaf | null;
  /** Хвост сортировки (ключи AST с порядком). */
  sortKeys?: readonly FilterAstSortKey[];
}

/** Контекст композера: данные подписей и предел длины. */
export interface FilterPhraseContext extends FilterLabelData {
  /** Типы мыслей сети — имена значений-типов во фразе (ошибка 4258e694 п.12б). */
  thoughtTypes?: readonly ThoughtType[];
  /**
   * Имя пользователя по id (ошибка 23c7d3e9 п. A1): значение пользовательских
   * операндов («Автор»/«Редактор»/«Автор записи»/«Автор события») — UUID
   * участника, и во фразе-превью показывается ИМЯ, а не id. Источник — кэш
   * пользователей клиента (`lib/users.ts`); не задан или имя неизвестно —
   * значение остаётся как есть (id). Функция передаётся данными, поэтому
   * модуль остаётся чистым и тестируемым без сети.
   */
  userName?: (id: string) => string | null;
  /**
   * Название МЫСЛИ по id (ошибка d17a8bfd): значения ссылочных операндов
   * («Мысль», «Родители», «Потомки», «Цели записи», «Сущность», «Владельцы»)
   * и значения свойств-ссылок (`value_type: link|thought_ref`) — id мысли, и во
   * фразе-превью показывается её ИМЯ, а не UUID. Источник — кэш имён клиента
   * (`lib/thought-names.ts`); функцию передают данными, поэтому модуль остаётся
   * чистым (догрузка имён — ВНЕ композера). Резолвер задан, а имени нет
   * (мысль ещё не догружена/удалена) — {@link FILTER_PHRASE_UNKNOWN_THOUGHT};
   * резолвер не задан — значение остаётся как есть (прежняя деградация для
   * вызовов без кэша, например в юнит-тестах композера).
   */
  thoughtName?: (id: string) => string | null;
  /** Предел длины фразы; по умолчанию {@link FILTER_PHRASE_LIMIT}. */
  limit?: number;
}

/** Подписи областей поиска «Найти слова» — по КОДУ shared-словаря
 *  (`STRUCTURE_KEYWORD_SCOPES`, §6.10 keywords). Запись
 *  `Record<StructureKeywordScope, string>` требует подпись для КАЖДОГО кода:
 *  новый код области, добавленный в shared, ломает сборку, пока подпись не
 *  заведена (ошибка 2bc251de). Словарь ОДИН на клиент — он же рисует чекбоксы
 *  ячейки (`lib/filter-value.ts`), поэтому фраза-превью и ячейка не расходятся. */
const KEYWORD_SCOPE_LABELS: Readonly<Record<StructureKeywordScope, string>> = {
  title: 'в именах',
  synonyms: 'в именах',
  comment: 'в комментарии',
  diary: 'в дневниках',
};

/** Области поиска «Найти слова» в порядке словаря: код → подпись во фразе. */
export const FILTER_PHRASE_KEYWORD_SCOPES: readonly {
  value: StructureKeywordScope;
  label: string;
}[] = STRUCTURE_KEYWORD_SCOPES.map((value) => ({ value, label: KEYWORD_SCOPE_LABELS[value] }));

/** Подпись области из словаря: ячейка значения и фраза берут её отсюда —
 *  подписи в одном месте (элемент интерфейса 9ecf405b). */
export function filterKeywordScopeLabel(value: StructureKeywordScope): string {
  return KEYWORD_SCOPE_LABELS[value];
}

/** Подписи оператора под-выборки (wire `FilterAstSubqueryValue['operator']`). */
const SUBQUERY_OPERATOR_LABELS: Readonly<Record<string, string>> = {
  in: 'в выборке',
  not_in: 'не в выборке',
  all_in: 'все в выборке',
};

/** Коннекция группы во фразе — оператор В ВЕРХНЕМ РЕГИСТРЕ между условиями
 *  (правка заказчика 2026-10-14, ошибка 4258e694 п.12а): служебные префиксы
 *  «все условия»/«любое условие» убраны. `НЕ` — префикс к единственному ребёнку. */
const GROUP_SEPARATOR: Readonly<Record<string, string>> = {
  and: ' И ',
  or: ' ИЛИ ',
  not: 'НЕ ',
};

/**
 * Вид токена фразы (правка заказчика 2026-10-14, п.12в; задача 58f77990):
 * `text` — обычный текст (экранируется/рисуется текстом), `operator` — оператор
 * коннекции И/ИЛИ/НЕ, `paren` — скобка уровня вложенности. Модель раскраски
 * живёт ЗДЕСЬ, а не в разметке потребителя: фраза собирается один раз, а
 * представление (текст, DOM) — проекции одного набора токенов, поэтому они не
 * могут разойтись. Модуль остаётся чистым: CSS-классов и DOM он не знает.
 */
export type FilterPhraseTokenKind = 'text' | 'operator' | 'paren';

/** Оператор коннекции, несущий раскраску: `И`/`ИЛИ`/`НЕ` — словарь shared
 *  (`FILTER_AST_GROUP_OPS`), второго перечня не заводим. */
export type FilterPhraseOperator = FilterAstGroupOp;

/** Токен фразы: неделимый кусок текста с признаком раскраски. */
export interface FilterPhraseToken {
  kind: FilterPhraseTokenKind;
  /** Текст токена (уже обрезанный по пределу фразы). */
  text: string;
  /** Коннекция — у токена-оператора. */
  operator?: FilterPhraseOperator;
  /**
   * Уровень вложенности группы — у токена-скобки (корневая группа 0, вложенная
   * группа уровня N отдаёт скобки с глубиной N). Тон скобки считает
   * представление по циклу тонов вложенности (`filterTreeToneIndex`,
   * `lib/filter-tree.ts`) — источник тонов ОДИН на дерево и фразу.
   */
  depth?: number;
}

/** Токен-оператор коннекции. */
function phraseOperatorToken(op: FilterPhraseOperator): FilterPhraseToken {
  return { kind: 'operator', text: GROUP_SEPARATOR[op] ?? `${op} `, operator: op };
}


/** Русское число с согласованием: `1 условие` / `2 условия` / `5 условий`. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Человекочитаемая композиция границы-токена; неизвестное — как есть. */
export function filterPhraseToken(token: string): string {
  const canon = canonicalGlobalToken(token);
  const preset = PERIOD_TOKEN_PRESETS.find((p) => p.text === canon);
  if (preset !== undefined) {
    const parts = preset.label.split('—');
    return (parts[1] ?? preset.label).trim();
  }
  const m = /^(\$[A-Za-z.]+?)([+-]\d+)(d|w|mo|y|h|mi)$/.exec(canon);
  if (m !== null) return `${panelAnchorLabel(m[1]!)} ${filterPhraseShift(m[2]!, m[3]!)}`;
  if (isGlobalDateToken(canon)) return panelAnchorLabel(canon);
  return token;
}

/** Подпись сдвига: `-1`, `mo` → «− 1 мес.» (типографский минус). */
export function filterPhraseShift(signed: string, unit: string): string {
  const sign = signed.startsWith('-') ? '−' : '+';
  return `${sign} ${Number(signed.replace(/^[+-]/, ''))} ${filterPhraseUnit(unit)}`;
}

/** Длинное имя единицы сдвига. */
export function filterPhraseUnit(unit: string): string {
  switch (unit) {
    case 'd':
      return 'дн.';
    case 'w':
      return 'нед.';
    case 'mo':
      return 'мес.';
    case 'y':
      return 'г.';
    case 'h':
      return 'ч.';
    case 'mi':
      return 'мин.';
    default:
      return unit;
  }
}

/** Подпись областей поиска «Найти слова» (пусто — «области не выбраны»). */
export function filterPhraseKeywordScopes(scope: readonly string[] | undefined): string {
  const active = FILTER_PHRASE_KEYWORD_SCOPES.filter((s) => (scope ?? []).includes(s.value));
  if (active.length === 0) return 'области не выбраны';
  // «В именах» — имена И синонимы вместе: во фразе не дублируется.
  const labels = [...new Set(active.map((s) => s.label))];
  return labels.join(', ');
}

/** Число условий в узле под-выборки (листья дерева, глубоко). */
export function filterPhraseLeafCount(node: FilterTreeGroup | FilterTreeLeaf | null | undefined): number {
  if (node === null || node === undefined) return 0;
  if (node.kind === 'leaf') return 1;
  return node.children.reduce((sum, child) => sum + filterPhraseLeafCount(child), 0);
}

/** Значение листа фразой ('' — значение не требуется/не задано). */
export function filterPhraseValue(leaf: FilterTreeLeaf, ctx: FilterPhraseContext): string {
  const value = leaf.value;
  switch (value.kind) {
    case 'none':
      return '';
    case 'scalar':
      return filterPhraseScalar(value.value, leaf, ctx, true);
    case 'token':
      return filterPhraseToken(value.token);
    case 'list': {
      const single = value.items.length === 1;
      const items = value.items.map((item) =>
        typeof item === 'object'
          ? filterPhraseToken(item.token)
          : filterPhraseScalar(item, leaf, ctx, single),
      );
      if (items.length === 0) return '';
      // Пара границ «между» читается через «и», набор — через запятую; длинный
      // набор сворачивается с остатком.
      const separator = leaf.operator === 'between' || leaf.operator === 'not_between' ? ' и ' : ', ';
      if (items.length > 3) {
        return `${items.slice(0, 3).join(separator)} и ещё ${items.length - 3}`;
      }
      return items.join(separator);
    }
    case 'subquery': {
      const count = filterPhraseLeafCount(value.node);
      const label = SUBQUERY_OPERATOR_LABELS[value.operator] ?? value.operator;
      return `${label} (${count} ${pluralRu(count, 'условие', 'условия', 'условий')})`;
    }
    default:
      return '';
  }
}

/**
 * Скаляр значением фразы: булево — «да»/«нет», число — как есть, строка —
 * именем (см. {@link filterPhraseNamedValue}). `allowSnapshot` разрешает взять
 * снапшот `labels.value` целиком — для одиночного значения, а не каждого
 * элемента списка (иначе одна подпись повторилась бы на всех).
 */
function filterPhraseScalar(
  value: string | number | boolean,
  leaf: FilterTreeLeaf,
  ctx: FilterPhraseContext,
  allowSnapshot: boolean,
): string {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value !== 'string') return String(value);
  return filterPhraseNamedValue(leaf, value, ctx, allowSnapshot);
}

/**
 * Строка-значение фразой (правка заказчика 2026-10-14, ошибка 4258e694 п.12б):
 * для ссылочного операнда (мысль/тип/связь/свойство) вместо id показывается
 * СОКРАЩЁННОЕ ИМЯ. Источники имени по старшинству:
 *   1. карта снапшотов `labels.values[id]` — по имени на КАЖДОЕ значение набора
 *      (мысли набираются в чип-поле без каталога имён);
 *   2. снапшот `labels.value` (одиночное значение, при `allowSnapshot`) —
 *      совместимость с уже сохранёнными отборами;
 *   3. имя МЫСЛИ из резолвера `ctx.thoughtName` — для операндов-ссылок на мысль
 *      и значений свойств-ссылок (ошибка d17a8bfd); резолвер задан, имени нет —
 *      {@link FILTER_PHRASE_UNKNOWN_THOUGHT} (без ID, требование 9d5e3c4e);
 *   4. каталог контекста (тип мысли, тип связи, реестр свойств);
 *   5. имя ПОЛЬЗОВАТЕЛЯ из `ctx.userName`; кэш задан, имени нет —
 *      {@link FILTER_PHRASE_UNKNOWN_USER};
 *   6. как было — само значение (id), тоже обрезанное (нет резолвера).
 */
function filterPhraseNamedValue(
  leaf: FilterTreeLeaf,
  raw: string,
  ctx: FilterPhraseContext,
  allowSnapshot: boolean,
): string {
  const fromMap = leaf.labels?.values?.[raw];
  if (fromMap !== undefined && fromMap !== '') return truncateFilterName(fromMap);
  if (allowSnapshot) {
    const snapshot = leaf.labels?.value;
    if (snapshot !== undefined && snapshot !== '') return truncateFilterName(snapshot);
  }
  // Ссылка на МЫСЛЬ: имя из кэша имён; кэш есть, а имени нет — плейсхолдер без
  // ID (резолвера нет — пропускаем ветку, деградация прежняя — значение как есть).
  if (filterPhraseValueIsThoughtRef(leaf, ctx.registry)) {
    const name = ctx.thoughtName?.(raw) ?? null;
    if (name !== null && name !== '') return truncateFilterName(name);
    if (ctx.thoughtName !== undefined) return FILTER_PHRASE_UNKNOWN_THOUGHT;
  }
  const catalogue = filterPhraseCatalogueValue(leaf.entity.kind, raw, ctx);
  if (catalogue !== null && catalogue !== '') return truncateFilterName(catalogue);
  // Пользователь: имя из кэша участников (`lib/users.ts`); кэш есть, имени нет —
  // плейсхолдер без ID. Токен `$user` сюда не попадает: он читается токеном.
  if (FILTER_USER_OPERAND_KINDS.has(leaf.entity.kind)) {
    const name = ctx.userName?.(raw) ?? null;
    if (name !== null && name !== '') return truncateFilterName(name);
    if (ctx.userName !== undefined) return FILTER_PHRASE_UNKNOWN_USER;
  }
  return truncateFilterName(raw);
}

/**
 * Операнды, значение которых — id МЫСЛИ (во фразе показывается её имя, не UUID):
 * «Мысль» (`id`), «Родители», «Потомки», «Цели записи», «Сущность» (`entity_id`),
 * «Владельцы» (`owner`). Тип/связь/свойство резолвятся каталогами контекста —
 * их здесь нет (ошибка d17a8bfd).
 */
const THOUGHT_REF_OPERAND_KINDS: ReadonlySet<FilterAstEntityKind> = new Set([
  'id',
  'parents',
  'children',
  'targets',
  'entity_id',
  'owner',
]);

/** `value_type` операнда-свойства по реестру; `null` — не свойство/не найдено. */
function filterPhrasePropertyValueType(
  leaf: FilterTreeLeaf,
  registry?: ReadonlyMap<string, NetworkProperty>,
): string | null {
  if (leaf.entity.kind !== 'property') return null;
  const ref = leaf.entity.property_id ?? leaf.entity.property ?? '';
  return registry?.get(ref)?.value_type ?? null;
}

/**
 * Значение листа — ссылка на МЫСЛЬ (id): либо операнд-ссылка
 * ({@link THOUGHT_REF_OPERAND_KINDS}), либо значение свойства с
 * `value_type: link|thought_ref` (`lib/filter-tokens.ts` — природа `thought-id`).
 */
function filterPhraseValueIsThoughtRef(
  leaf: FilterTreeLeaf,
  registry?: ReadonlyMap<string, NetworkProperty>,
): boolean {
  if (THOUGHT_REF_OPERAND_KINDS.has(leaf.entity.kind)) return true;
  const valueType = filterPhrasePropertyValueType(leaf, registry);
  return valueType === 'link' || valueType === 'thought_ref';
}

/** Имя значения-ссылки из каталогов контекста; `null` — вид без каталога/не нашли. */
function filterPhraseCatalogueValue(
  kind: FilterAstEntityKind,
  id: string,
  ctx: FilterPhraseContext,
): string | null {
  switch (kind) {
    case 'type': {
      const type = ctx.thoughtTypes?.find((row) => row.id === id);
      return type?.name ?? null;
    }
    case 'link_type': {
      const link = ctx.linkTypes?.find((row) => row.id === id);
      return link?.name_forward ?? null;
    }
    case 'properties':
    case 'property': {
      return ctx.registry.get(id)?.name ?? null;
    }
    default:
      return null;
  }
}

/**
 * Обрезка имени значения до {@link FILTER_PHRASE_NAME_LIMIT} с «…»: по границе
 * слова, если она не отсекает больше половины предела, иначе жёстко. Итог не
 * длиннее предела.
 */
export function truncateFilterName(text: string, limit: number = FILTER_PHRASE_NAME_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(1, limit - 1));
  const space = cut.lastIndexOf(' ');
  const stem = space >= Math.floor(limit / 2) ? cut.slice(0, space) : cut;
  return `${stem.trimEnd()}…`;
}

/** Лист фразой: `<операнд> <оператор> <значение>` + режим обхода/области. */
export function filterPhraseLeaf(leaf: FilterTreeLeaf, ctx: FilterPhraseContext): string {
  const operand = filterOperandLabel(leaf, ctx);
  const operator = astOperatorLabel(leaf.operator);
  const value = filterPhraseValue(leaf, ctx);
  // У «Найти слова» и под-выборки подпись оператора лишняя: смысл несёт сам
  // операнд («Найти слова расход») либо подпись оператора под-выборки
  // («Родители в выборке (2 условия)») — «в списке в выборке» не читается.
  const skipOperator = leaf.entity.kind === 'keywords' || leaf.value.kind === 'subquery';
  // П.9 (ошибка заказчика 2026-10-14): у предиката БЕЗ значения оператор
  // «равно»/«не равно» не печатается — сравнение без значения не читается
  // («Есть вложения», а не «Есть вложения равно»). Операторы со смыслом в себе
  // («заполнено», «не заполнено», «имеет свойство») остаются как есть.
  const comparisonWithoutValue =
    value === '' && (leaf.operator === 'eq' || leaf.operator === 'ne');
  let phrase: string;
  if (skipOperator) phrase = value === '' ? operand : `${operand} ${value}`;
  else if (value === '') phrase = comparisonWithoutValue ? operand : `${operand} ${operator}`;
  else phrase = `${operand} ${operator} ${value}`;
  // Режим обхода «по всем связям» — отличие от структурного (по умолчанию).
  if (leaf.mode === 'all_links') phrase += ' (по всем связям)';
  // «Найти слова»: чем ограничен поиск — видно во фразе (требование 0882f8d5).
  if (leaf.entity.kind === 'keywords') {
    phrase += ` (${filterPhraseKeywordScopes(leaf.entity.scope)})`;
  }
  return phrase;
}

/**
 * Узел дерева фразой. Коннекция — оператор «И»/«ИЛИ»/«НЕ» в верхнем регистре
 * (правка заказчика 2026-10-14, ошибка 4258e694 п.12а); одиночный ребёнок
 * оператора не получает. Вложенная группа с ДРУГОЙ коннекцией берётся в скобки —
 * «A И (B ИЛИ C)» читается однозначно; верхний уровень (parentOp === undefined)
 * и та же коннекция скобок не получают.
 */
export function filterPhraseNode(
  node: FilterTreeGroup | FilterTreeLeaf,
  ctx: FilterPhraseContext,
  parentOp?: string,
): string {
  return filterPhraseNodeTokens(node, ctx, parentOp).map((token) => token.text).join('');
}

/**
 * Узел дерева токенами раскраски (задача 58f77990, п.12в): текстовая фраза —
 * конкатенация тех же токенов, поэтому представления не расходятся. Коннекции
 * «И»/«ИЛИ»/«НЕ» — токены-операторы, скобки вложенных групп — токены-скобки с
 * уровнем вложенности (`depth`); всё остальное — текст. Глубина считается от
 * корня дерева: вложенная группа уровня N отдаёт скобки с `depth: N`.
 */
export function filterPhraseNodeTokens(
  node: FilterTreeGroup | FilterTreeLeaf,
  ctx: FilterPhraseContext,
  parentOp?: string,
  depth = 0,
): FilterPhraseToken[] {
  if (node.kind === 'leaf') {
    const text = filterPhraseLeaf(node, ctx);
    return text === '' ? [] : [{ kind: 'text', text }];
  }
  const groups = node.children
    .map((child) => filterPhraseNodeTokens(child, ctx, node.op, depth + 1))
    .filter((tokens) => tokens.length > 0);
  if (groups.length === 0) return [];
  const separator = GROUP_SEPARATOR[node.op];
  /** Разделитель группы: известная коннекция — токен-оператор, иначе — текст. */
  const separatorToken = (): FilterPhraseToken =>
    separator === undefined ? { kind: 'text', text: `${node.op} ` } : phraseOperatorToken(node.op);
  const body: FilterPhraseToken[] = [];
  if (node.op === 'not') {
    // «НЕ» — префикс к своему (единственному) ребёнку; дети соединяются запятой.
    body.push(separatorToken());
    groups.forEach((tokens, index) => {
      if (index > 0) body.push({ kind: 'text', text: ', ' });
      body.push(...tokens);
    });
  } else {
    // «И»/«ИЛИ» — разделитель между детьми.
    groups.forEach((tokens, index) => {
      if (index > 0) body.push(separatorToken());
      body.push(...tokens);
    });
  }
  const needParens = parentOp !== undefined && parentOp !== node.op;
  if (!needParens) return body;
  return [
    { kind: 'paren', text: '(', depth },
    ...body,
    { kind: 'paren', text: ')', depth },
  ];
}

/**
 * Подпись ключа сортировки во фразе: движковый словарь (`filterAstSortKeyLabel`),
 * затем — имя свойства реестра по id ключа (ошибка 50d9bf4e п. A7: прямой ключ
 * свойства-сети — его UUID, и во фразе показывался id вместо названия), иначе
 * ключ как есть (обратная сторона связи — уже имя).
 */
export function filterPhraseSortKeyLabel(
  key: string,
  registry?: ReadonlyMap<string, NetworkProperty>,
): string {
  const known = filterAstSortKeyLabel(key);
  if (known !== key) return known;
  const name = registry?.get(key)?.name;
  return name !== undefined && name !== '' ? name : key;
}

/** Хвост сортировки: «сортировка: по названию (убыв.)» ('' — сортировки нет). */
export function filterPhraseSort(
  sortKeys: readonly FilterAstSortKey[] | undefined,
  registry?: ReadonlyMap<string, NetworkProperty>,
): string {
  const keys = sortKeys ?? [];
  if (keys.length === 0) return '';
  const parts = keys.map((sort) => {
    const label = filterPhraseSortKeyLabel(sort.key, registry);
    return sort.order === 'desc' ? `${label} (убыв.)` : label;
  });
  return `сортировка: ${parts.join(', ')}`;
}

/** Обрезка фразы по пределу: режем по последнему пробелу и помечаем «…». */
export function truncateFilterPhrase(text: string, limit: number = FILTER_PHRASE_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(1, limit - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Обрезка ТОКЕНОВ фразы до предела (задача 58f77990, требование о разметке):
 * режем ДО раскраски — по текстовым позициям, а не по готовой разметке, иначе
 * обрезка разрезала бы тег/спан. Текст токенов повторяет
 * {@link truncateFilterPhrase} символ-в-символ (та же граница слова), а
 * «…» становится отдельным текстовым токеном. Оператор или скобка, попавшие на
 * границу, усекаются как текст — разметка от этого не рвётся.
 */
export function clipFilterPhraseTokens(
  tokens: readonly FilterPhraseToken[],
  limit: number = FILTER_PHRASE_LIMIT,
): FilterPhraseToken[] {
  const plain = tokens.map((token) => token.text).join('');
  if (plain.length <= limit) return [...tokens];
  const clipped = truncateFilterPhrase(plain, limit);
  const keep = clipped.slice(0, -1).trimEnd().length;
  const out: FilterPhraseToken[] = [];
  let used = 0;
  for (const token of tokens) {
    if (used >= keep) break;
    const room = keep - used;
    const text = token.text.length <= room ? token.text : token.text.slice(0, room);
    if (text === '') break;
    out.push({ ...token, text });
    used += text.length;
  }
  out.push({ kind: 'text', text: '…' });
  return out;
}

/**
 * Фраза-превью отбора ТОКЕНАМИ раскраски: дерево + хвост сортировки, обрезка по
 * пределу. Пустой список — условий и сортировки нет (потребитель превью не
 * рисует). Единственный источник фразы: текстовая фраза и разметка — проекции
 * ЭТИХ токенов (задача 58f77990).
 */
export function filterPhraseTokens(
  state: FilterPhraseState,
  ctx: FilterPhraseContext,
): FilterPhraseToken[] {
  const tokens: FilterPhraseToken[] = [];
  if (state.tree !== null && state.tree !== undefined) {
    tokens.push(...filterPhraseNodeTokens(state.tree, ctx));
  }
  const sort = filterPhraseSort(state.sortKeys, ctx.registry);
  if (sort !== '') {
    if (tokens.length > 0) tokens.push({ kind: 'text', text: '; ' });
    tokens.push({ kind: 'text', text: sort });
  }
  return clipFilterPhraseTokens(tokens, ctx.limit ?? FILTER_PHRASE_LIMIT);
}

/**
 * Фраза-превью отбора из единой модели: дерево + хвост сортировки, обрезка по
 * пределу. Пустая строка — условий и сортировки нет (потребитель превью не рисует).
 */
export function composeFilterPhrase(state: FilterPhraseState, ctx: FilterPhraseContext): string {
  return filterPhraseTokens(state, ctx)
    .map((token) => token.text)
    .join('');
}

/**
 * Id МЫСЛЕЙ, которые композер покажет ИМЕНЕМ, — для догрузки имён ВНЕ композера
 * (`lib/thought-names.ts`): модуль остаётся чистым, а редактор просит кэш
 * наполнить ровно те id, что попадут во фразу. Собираются строковые значения
 * операндов-ссылок ({@link THOUGHT_REF_OPERAND_KINDS}) и значений свойств-ссылок
 * (`value_type: link|thought_ref`) — скаляры и элементы списков, включая
 * вложенные под-выборки. Контекстные токены (`$…`) и пустые значения
 * пропускаются; дубли схлопываются.
 */
export function filterPhraseThoughtIds(
  state: FilterPhraseState,
  registry?: ReadonlyMap<string, NetworkProperty>,
): string[] {
  const out = new Set<string>();
  const collectValue = (leaf: FilterTreeLeaf): void => {
    if (!filterPhraseValueIsThoughtRef(leaf, registry)) return;
    const value = leaf.value;
    if (value.kind === 'scalar' && typeof value.value === 'string') {
      if (value.value !== '' && !value.value.startsWith('$')) out.add(value.value);
    } else if (value.kind === 'list') {
      for (const item of value.items) {
        if (typeof item === 'string' && item !== '' && !item.startsWith('$')) out.add(item);
      }
    }
  };
  const walk = (node: FilterTreeGroup | FilterTreeLeaf | null | undefined): void => {
    if (node === null || node === undefined) return;
    if (node.kind === 'leaf') {
      collectValue(node);
      if (node.value.kind === 'subquery') walk(node.value.node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(state.tree);
  return [...out];
}

/**
 * Фраза для сохранённого определения отбора (полоса отборов, тултипы кнопок):
 * то же дерево, прочитанное из wire-определения единым конвертером
 * (`parseFilterDefinition`). Условий в определении нет — пустая строка.
 */
export function composeFilterPhraseFromDefinition(
  definition: unknown,
  ctx: FilterPhraseContext,
): string {
  return filterPhraseTokensFromDefinition(definition, ctx)
    .map((token) => token.text)
    .join('');
}

/**
 * Токены раскраски сохранённого определения отбора (задача 58f77990): сохранённые
 * отборы получают ту же разметку, что и живая фраза редактора. Пустой список —
 * условий в определении нет.
 */
export function filterPhraseTokensFromDefinition(
  definition: unknown,
  ctx: FilterPhraseContext,
): FilterPhraseToken[] {
  if (definition === null || definition === undefined) return [];
  const parsed = parseFilterDefinition(definition);
  return filterPhraseTokens({ tree: parsed.tree ?? null, sortKeys: parsed.sortKeys ?? [] }, ctx);
}
