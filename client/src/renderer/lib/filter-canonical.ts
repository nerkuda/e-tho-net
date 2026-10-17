/**
 * Каноничная форма условий отбора — сопоставление определений «ПО УСЛОВИЯМ»
 * (задача 347b307e «Предопределённые наборы отборов», арбитраж оркестратора
 * 2026-10-14).
 *
 * Задача панелей «Структур» и «Дневника» — при открытии списка сохранённых
 * отборов добавлять отсутствующие предопределённые наборы, сопоставляя их с уже
 * сохранёнными ПО НОРМАЛИЗОВАННОМУ AST условий, а не по имени. Имя отбора
 * пользователь может переименовать — это не повод заводить дубль.
 *
 * Модуль даёт единственное представление «эквивалентности условий» — строку
 * (JSON) нормализованного дерева. Нормализация:
 *
 *   • корень — ГРУППА (`И`): одиночный лист оборачивается, как в редакторе
 *     (`normalizeFilterTreeRoot`);
 *   • порядок детей `И`/`ИЛИ` не значим (операторы коммутативны) — дети
 *     сортируются; у `НЕ` ребёнок один и порядок не трогается;
 *   • служебные отличия формы приводятся к канону: отсутствующий режим обхода
 *     «в иерархии» = структурный (`mode: 'structural'`), области поиска «Есть
 *     слова» сортируются и дедуплицируются, пустой набор областей = отсутствие
 *     (условие отключено);
 *   • токены приводятся к каноничной форме головы: точечные
 *     `$week.start`/`$week.end` (`$month.*`/`$year.*`) эквивалентны camelCase
 *     `$weekStart`/`$weekEnd` — обе формы читаются и встречаются в дикой природе
 *     (`lib/period-editor.ts` пишет канон, читает обе); арифметика хвоста
 *     сохраняется как есть;
 *   • снапшоты подписей (`labels`) в сравнение НЕ входят: это презентационные
 *     данные на момент сохранения, а не условие.
 *
 * Пустое дерево (нет ни одного условия) канонизируется в ПУСТУЮ строку —
 * сопоставлять нечего; вызывающий её игнорирует. Дерево — модель редактора
 * (`FilterTreeNode`); определение отбора к дереву приводит РИДЕР ПАНЕЛИ
 * (`readFilterDefinition` соответствующего экрана), поэтому легаси-плоское
 * определение (`definition v1`) сравнивается наравне с AST.
 */

import type { FilterTreeNode, FilterTreeOperand, FilterTreeValue } from './filter-builder.js';

/**
 * Алиасы головы токена: точечные формы эквивалентны camelCase. Хвост
 * (арифметика `±Nd`/`±Nw`/`±Nmo`) сохраняется без изменений.
 */
const TOKEN_HEAD_ALIASES: Readonly<Record<string, string>> = {
  '$week.start': '$weekStart',
  '$week.end': '$weekEnd',
  '$month.start': '$monthStart',
  '$month.end': '$monthEnd',
  '$year.start': '$yearStart',
  '$year.end': '$yearEnd',
};

/**
 * Каноничная форма одной строки-токена: точечная голова → camelCase, пробелы по
 * краям срезаются. Арифметический хвост и регистр сохраняются.
 */
export function normalizeFilterToken(text: string): string {
  const trimmed = text.trim();
  for (const [dotted, camel] of Object.entries(TOKEN_HEAD_ALIASES)) {
    if (trimmed.startsWith(dotted)) return `${camel}${trimmed.slice(dotted.length)}`;
  }
  return trimmed;
}

/** Каноничный вид операнда листа (без служебных отличий формы). */
function canonicalEntity(entity: FilterTreeOperand): unknown {
  switch (entity.kind) {
    case 'property':
      return {
        k: 'property',
        id: entity.property_id ?? '',
        name: entity.property ?? '',
        dir: entity.direction ?? '',
      };
    case 'keywords': {
      const scopes = [...new Set(entity.scope ?? [])].sort();
      return { k: 'keywords', scope: scopes.length === 0 ? null : scopes };
    }
    default:
      return { k: entity.kind };
  }
}

/** Каноничный вид значения листа (литералы, токены, списки, под-выборки). */
function canonicalValue(value: FilterTreeValue): unknown {
  switch (value.kind) {
    case 'none':
      return null;
    case 'scalar':
      return { s: typeof value.value, v: value.value };
    case 'token':
      return { t: normalizeFilterToken(value.token) };
    case 'list':
      // Порядок списка значим («между» — границы С/По) — сохраняем как есть.
      return value.items.map((item) =>
        typeof item === 'object' ? { t: normalizeFilterToken(item.token) } : { s: typeof item, v: item },
      );
    case 'subquery':
      return { q: value.operator, n: canonicalNode(value.node) };
  }
}

/** Каноничный узел дерева: группа (дети `И`/`ИЛИ` отсортированы) либо лист. */
function canonicalNode(node: FilterTreeNode): unknown {
  if (node.kind === 'group') {
    const children = node.children.map((child) => JSON.stringify(canonicalNode(child)));
    if (node.op === 'not') return { g: 'not', c: children };
    return { g: node.op, c: [...children].sort() };
  }
  return {
    e: canonicalEntity(node.entity),
    o: node.operator,
    v: canonicalValue(node.value),
    m: node.mode ?? 'structural',
  };
}

/** Есть ли в дереве хотя бы одно условие-лист. */
export function canonicalTreeHasConditions(node: FilterTreeNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.kind === 'leaf') return true;
  return node.children.some(canonicalTreeHasConditions);
}

/**
 * Каноничная строка условий дерева. Пустое дерево (нет ни одного условия) —
 * пустая строка: сопоставлять нечего, вызывающий её игнорирует.
 */
export function canonicalFilterTree(tree: FilterTreeNode | null | undefined): string {
  if (tree === null || tree === undefined || !canonicalTreeHasConditions(tree)) return '';
  const root: FilterTreeNode =
    tree.kind === 'group' ? tree : { kind: 'group', op: 'and', children: [tree] };
  return JSON.stringify(canonicalNode(root));
}
