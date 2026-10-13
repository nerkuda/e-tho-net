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
 * Формат фразы:
 *   • лист — `<операнд> <оператор> <значение>` («Город равно Москва»,
 *     «Время записи между начало месяца и конец месяца», «Есть вложения
 *     заполнено»); значение не требуется — только операнд и оператор;
 *   • группа `И` — «все условия: A и B», `ИЛИ` — «любое условие: A или B»,
 *     `НЕ` — «кроме A»; вложенная группа с другой коннекцией — в скобках;
 *   • под-выборка сворачивается: «Цели в выборке (2 условия)»;
 *   • хвост сортировки: «; сортировка: по названию (убыв.)»;
 *   • длинная фраза обрезается по пределу с «…» (полный текст — в тултипе).
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
import type { FilterAstSortKey } from '@etn/shared';
import { canonicalGlobalToken, isGlobalDateToken, panelAnchorLabel, PERIOD_TOKEN_PRESETS } from './period-editor.js';

/** Предел длины фразы по умолчанию; полный текст в тултипе не обрезается. */
export const FILTER_PHRASE_LIMIT = 300;

/** Состояние отбора, нужное композеру (часть единой модели `FilterCriteriaState`). */
export interface FilterPhraseState {
  /** Дерево условий; `null` — условий нет. */
  tree?: FilterTreeGroup | FilterTreeLeaf | null;
  /** Хвост сортировки (ключи AST с порядком). */
  sortKeys?: readonly FilterAstSortKey[];
}

/** Контекст композера: данные подписей и предел длины. */
export interface FilterPhraseContext extends FilterLabelData {
  /** Предел длины фразы; по умолчанию {@link FILTER_PHRASE_LIMIT}. */
  limit?: number;
}

/** Области поиска «Есть слова»: код словаря → подпись во фразе. */
export const FILTER_PHRASE_KEYWORD_SCOPES: readonly {
  value: 'title' | 'synonyms' | 'comment';
  label: string;
}[] = [
  { value: 'title', label: 'в имени' },
  { value: 'synonyms', label: 'в синонимах' },
  { value: 'comment', label: 'в комментарии' },
];

/** Подписи оператора под-выборки (wire `FilterAstSubqueryValue['operator']`). */
const SUBQUERY_OPERATOR_LABELS: Readonly<Record<string, string>> = {
  in: 'в выборке',
  not_in: 'не в выборке',
  all_in: 'все в выборке',
};

/** Подписи коннекции группы во фразе. */
const GROUP_OP_LABELS: Readonly<Record<string, string>> = {
  and: 'все условия',
  or: 'любое условие',
  not: 'кроме',
};

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

/** Подпись областей поиска «Есть слова» (пусто — «области не выбраны»). */
export function filterPhraseKeywordScopes(scope: readonly string[] | undefined): string {
  const active = FILTER_PHRASE_KEYWORD_SCOPES.filter((s) => (scope ?? []).includes(s.value));
  if (active.length === 0) return 'области не выбраны';
  return active.map((s) => s.label).join(', ');
}

/** Число условий в узле под-выборки (листья дерева, глубоко). */
export function filterPhraseLeafCount(node: FilterTreeGroup | FilterTreeLeaf | null | undefined): number {
  if (node === null || node === undefined) return 0;
  if (node.kind === 'leaf') return 1;
  return node.children.reduce((sum, child) => sum + filterPhraseLeafCount(child), 0);
}

/** Значение листа фразой ('' — значение не требуется/не задано). */
export function filterPhraseValue(leaf: FilterTreeLeaf): string {
  const value = leaf.value;
  switch (value.kind) {
    case 'none':
      return '';
    case 'scalar':
      return filterPhraseScalar(value.value);
    case 'token':
      return filterPhraseToken(value.token);
    case 'list': {
      const items = value.items.map((item) =>
        typeof item === 'object' ? filterPhraseToken(item.token) : filterPhraseScalar(item),
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

/** Скаляр значением фразы: булево — «да»/«нет», остальное — как есть. */
function filterPhraseScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

/** Лист фразой: `<операнд> <оператор> <значение>` + режим обхода/области. */
export function filterPhraseLeaf(leaf: FilterTreeLeaf, ctx: FilterPhraseContext): string {
  const operand = filterOperandLabel(leaf, ctx);
  const operator = astOperatorLabel(leaf.operator);
  const value = filterPhraseValue(leaf);
  // У «Есть слова» и под-выборки подпись оператора лишняя: смысл несёт сам
  // операнд («Есть слова расход») либо подпись оператора под-выборки
  // («Родители в выборке (2 условия)») — «в списке в выборке» не читается.
  const skipOperator = leaf.entity.kind === 'keywords' || leaf.value.kind === 'subquery';
  let phrase: string;
  if (skipOperator) phrase = value === '' ? operand : `${operand} ${value}`;
  else phrase = value === '' ? `${operand} ${operator}` : `${operand} ${operator} ${value}`;
  // Режим обхода «по всем связям» — отличие от структурного (по умолчанию).
  if (leaf.mode === 'all_links') phrase += ' (по всем связям)';
  // «Есть слова»: чем ограничен поиск — видно во фразе (требование 0882f8d5).
  if (leaf.entity.kind === 'keywords') {
    phrase += ` (${filterPhraseKeywordScopes(leaf.entity.scope)})`;
  }
  return phrase;
}

/**
 * Узел дерева фразой. Вложенная группа с другой коннекцией берётся в скобки —
 * «(A или B) и C» читается однозначно; верхний уровень (parentOp === undefined)
 * скобок не получает.
 */
export function filterPhraseNode(
  node: FilterTreeGroup | FilterTreeLeaf,
  ctx: FilterPhraseContext,
  parentOp?: string,
): string {
  if (node.kind === 'leaf') return filterPhraseLeaf(node, ctx);
  const children = node.children
    .map((child) => filterPhraseNode(child, ctx, node.op))
    .filter((part) => part !== '');
  if (children.length === 0) return '';
  const separator = node.op === 'and' ? ' и ' : node.op === 'or' ? ' или ' : ', ';
  const label = GROUP_OP_LABELS[node.op] ?? node.op;
  const body = children.join(separator);
  const phrase = node.op === 'not' ? `${label} ${body}` : `${label}: ${body}`;
  const needParens = parentOp !== undefined && parentOp !== node.op;
  return needParens ? `(${phrase})` : phrase;
}

/** Хвост сортировки: «сортировка: по названию (убыв.)» ('' — сортировки нет). */
export function filterPhraseSort(sortKeys: readonly FilterAstSortKey[] | undefined): string {
  const keys = sortKeys ?? [];
  if (keys.length === 0) return '';
  const parts = keys.map((sort) => {
    const label = filterAstSortKeyLabel(sort.key);
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
 * Фраза-превью отбора из единой модели: дерево + хвост сортировки, обрезка по
 * пределу. Пустая строка — условий и сортировки нет (потребитель превью не рисует).
 */
export function composeFilterPhrase(state: FilterPhraseState, ctx: FilterPhraseContext): string {
  const parts: string[] = [];
  if (state.tree !== null && state.tree !== undefined) {
    const phrase = filterPhraseNode(state.tree, ctx);
    if (phrase !== '') parts.push(phrase);
  }
  const sort = filterPhraseSort(state.sortKeys);
  if (sort !== '') parts.push(sort);
  return truncateFilterPhrase(parts.join('; '), ctx.limit ?? FILTER_PHRASE_LIMIT);
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
  if (definition === null || definition === undefined) return '';
  const parsed = parseFilterDefinition(definition);
  return composeFilterPhrase({ tree: parsed.tree ?? null, sortKeys: parsed.sortKeys ?? [] }, ctx);
}
