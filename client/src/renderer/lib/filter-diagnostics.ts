/**
 * Диагностика строк редактора отбора (задача c74f17a0 ТП 11b2509a «Редактор:
 * базовый компонент»; элемент интерфейса 4e634c9a «Диагностика строк»;
 * требования 44d61c8a «красная», 325efc13 «жёлтая», cf8fdd4d «проверки
 * конструктора и поведение при ошибках сборки», 3e47f52a «сортировка»).
 *
 * Модуль сводит в ОДИН список всё, что редактор обязан показать у строк:
 *
 *   • диагностику ядра — красную (`VALIDATION_ERROR` → `details.diagnostics`)
 *     и жёлтую (`meta.warnings`) — ровно в той форме, какую отдаёт сервер
 *     (`FilterDiagnostic` реестра `@etn/shared`), включая диагностику ключей
 *     сортировки (`path: sort[i]`);
 *   • неразрешимые токены (`unresolved`) — путь против строки редактора;
 *   • строковые предупреждения сборки/рецепта;
 *   • собственные проверки конструктора: пустая группа, условие без значения,
 *     противоречие в пределах одного поля.
 *
 * Шкала одна и та же у ядра и у редактора ({@link FilterIssueSeverity} совпадает
 * с `FilterDiagnosticSeverity`): `error` — красное, применение запрещено
 * ({@link hasBlockingIssues}); `warning` — жёлтое, отбор исполняется.
 *
 * Адрес строки — та же схема, что у `FilterTreeIssue.path`
 * (`filter.children[0]…`, {@link filterIssueNodePath}); у ключа сортировки —
 * `sort[i]`, как у серверной диагностики. Диагностика без адреса (`path: ''`) в
 * строку не локализуется и уходит в тултип фразы-превью футера (требование
 * cf8fdd4d).
 *
 * Модуль чистый: DOM не трогает, модель отбора не ведёт и не копирует (второй
 * модели состояния отбора в клиенте нет — ADR 30ff83bb, сторож
 * `guard-filter-builder`).
 */

import {
  EtnError,
  type FilterAstEntity,
  type FilterAstOperator,
  type FilterDiagnostic,
  type FilterDiagnosticCode,
  type FilterDiagnosticSeverity,
} from '@etn/shared';

import type { FilterTreeGroup, FilterTreeLeaf, FilterTreeNode } from './filter-builder.js';

// ---------------------------------------------------------------------------
// Вид записи диагностики
// ---------------------------------------------------------------------------

/** Серьёзность — та же шкала, что у ядра (`error` красное / `warning` жёлтое). */
export type FilterIssueSeverity = FilterDiagnosticSeverity;

/** Источник записи: диагностика ядра или собственная проверка конструктора. */
export type FilterIssueSource = 'server' | 'constructor';

/** Код собственной проверки конструктора (требование cf8fdd4d). */
export type FilterConstructorIssueCode =
  /** Группа без единого условия. */
  | 'empty_group'
  /** Условие, оператор которого требует значение, а значения нет. */
  | 'condition_without_value'
  /** Взаимоисключающие условия по одному полю. */
  | 'contradiction';

/** Код записи: код ядра (`entity_deleted`/`property_detached`) или свой. */
export type FilterIssueCode = FilterDiagnosticCode | FilterConstructorIssueCode | 'token_unresolved' | 'build_warning';

/**
 * Одна запись диагностики строки. `path` — адрес строки редактора
 * (`filter.children[0]`, `sort[0]`) либо `''` — «локализовать нельзя».
 */
export interface FilterIssue {
  severity: FilterIssueSeverity;
  source: FilterIssueSource;
  code: FilterIssueCode;
  path: string;
  message: string;
  /** Снапшот имени исчезнувшей сущности (`labels` AST); иначе — нет. */
  label?: string | null;
  /** Снапшот значения-мысли (`labels` AST); иначе — нет. */
  valueLabel?: string | null;
  /** Дата удаления/отвязки (ISO-8601), если сеть её знает. */
  deletedAt?: string | null;
}

/** Неразрешимый токен выборки (`unresolved`): путь против строки редактора. */
export interface FilterUnresolvedToken {
  path?: string;
  token: string;
  reason: string;
  message: string;
}

/** Что отдаёт выборка/ошибка сервера — вход {@link filterIssuesFromPayload}. */
export interface FilterDiagnosticsPayload {
  /** `VALIDATION_ERROR` → `details.diagnostics` (красное ядро). */
  diagnostics?: readonly FilterDiagnostic[];
  /** `meta.warnings` выборки (жёлтое и красное ядро). */
  warnings?: readonly FilterDiagnostic[];
  /** `unresolved` — нераскрытые токены (`ids` пуст). */
  unresolved?: readonly FilterUnresolvedToken[];
  /** Строковые предупреждения сборки/рецепта (адреса у них нет). */
  messages?: readonly string[];
}

// ---------------------------------------------------------------------------
// Операторы, которым значение не нужно
// ---------------------------------------------------------------------------

/**
 * Операторы ядра, у которых значения нет вовсе: «заполнено» / «не заполнено» и
 * «имеет свойство» / «не имеет свойство». Такой лист законно кодируется без
 * значения (wire: поле `value` отсутствует), поэтому «условие без значения» для
 * них — не ошибка сборки. Список — не второй словарь операторов (он один в
 * `@etn/shared`), а признак «оператор не принимает значение».
 */
const FILTER_OPERATORS_WITHOUT_VALUE: ReadonlySet<FilterAstOperator> = new Set([
  'is_empty',
  'not_empty',
  'has',
  'not_has',
]);

/** Нужно ли оператору значение (для проверки «условие без значения»). */
export function filterOperatorNeedsValue(operator: FilterAstOperator): boolean {
  return !FILTER_OPERATORS_WITHOUT_VALUE.has(operator);
}

// ---------------------------------------------------------------------------
// Адреса строк
// ---------------------------------------------------------------------------

/** Путь узла модели → путь AST (`[]` → `filter`, `[0,1]` → `filter.children[0].children[1]`). */
export function filterIssueNodePath(path: readonly number[]): string {
  return path.reduce((acc, index) => `${acc}.children[${index}]`, 'filter');
}

/** Адрес ключа сортировки — как у серверной диагностики (требование 3e47f52a). */
export function filterIssueSortPath(index: number): string {
  return `sort[${index}]`;
}

/** Ключ операнда листа для поиска противоречий по одному полю. */
export function filterEntityKey(entity: FilterAstEntity): string {
  if (entity.kind === 'property') {
    return `property:${entity.property_id ?? entity.property ?? ''}:${entity.direction ?? 'out'}`;
  }
  return entity.kind;
}

// ---------------------------------------------------------------------------
// Проверки конструктора (требование cf8fdd4d)
// ---------------------------------------------------------------------------

function emptyGroupIssue(path: string): FilterIssue {
  return {
    severity: 'error',
    source: 'constructor',
    code: 'empty_group',
    path,
    message: 'группа пуста — добавьте условие или группу',
  };
}

function withoutValueIssue(path: string): FilterIssue {
  return {
    severity: 'error',
    source: 'constructor',
    code: 'condition_without_value',
    path,
    message: 'условие без значения — задайте значение условия',
  };
}

function contradictionIssue(path: string, message: string): FilterIssue {
  return {
    severity: 'warning',
    source: 'constructor',
    code: 'contradiction',
    path,
    message,
  };
}

/** Скалярное значение-литерал листа (иначе — `null`: токен/список/подвыборка). */
function scalarOf(leaf: FilterTreeLeaf): string | number | boolean | null {
  return leaf.value.kind === 'scalar' ? leaf.value.value : null;
}

/** Сравнимы ли два значения (оба числа или обе строки — ISO-даты сравнимы лексикой). */
function comparable(a: unknown, b: unknown): a is string | number {
  return (
    (typeof a === 'number' && typeof b === 'number') ||
    (typeof a === 'string' && typeof b === 'string')
  );
}

/** Листья, соединённые конъюнкцией внутри поддерева (через группы `И`), с адресами. */
function andConnectedLeaves(
  group: FilterTreeGroup,
  groupPath: readonly number[],
): Array<{ leaf: FilterTreeLeaf; path: string }> {
  const out: Array<{ leaf: FilterTreeLeaf; path: string }> = [];
  const walk = (node: FilterTreeNode, path: readonly number[]): void => {
    if (node.kind === 'leaf') {
      out.push({ leaf: node, path: filterIssueNodePath(path) });
      return;
    }
    // Группы ИЛИ/НЕ меняют логику — их листья к конъюнкции не относятся.
    if (node.op === 'and') node.children.forEach((child, index) => walk(child, [...path, index]));
  };
  walk(group, groupPath);
  return out;
}

/**
 * Противоречия в пределах одного поля у листьев одной конъюнкции
 * (требование cf8fdd4d): «заполнено» вместе с «не заполнено» и перевёрнутые
 * границы диапазона. Возвращает записи с путём ВТОРОГО листа — «исправить»
 * ведёт в строку, которую пользователь правит.
 */
function contradictionIssues(group: FilterTreeGroup, groupPath: readonly number[]): FilterIssue[] {
  const leaves = andConnectedLeaves(group, groupPath);
  const out: FilterIssue[] = [];
  for (let i = 0; i < leaves.length; i += 1) {
    for (let j = i + 1; j < leaves.length; j += 1) {
      const a = leaves[i]!;
      const b = leaves[j]!;
      if (filterEntityKey(a.leaf.entity) !== filterEntityKey(b.leaf.entity)) continue;
      const ops = new Set<FilterAstOperator>([a.leaf.operator, b.leaf.operator]);
      // Противоречие достижимо только для пары на одном поле: сравнение «между»
      // (список значений) и подвыборки проверяются ядром, редактор их не судит.
      if (ops.has('is_empty') && ops.has('not_empty')) {
        out.push(
          contradictionIssue(
            b.path,
            'условия требуют одновременного «заполнено» и «не заполнено» — ни одна мысль не подойдёт',
          ),
        );
        continue;
      }
      const lower = boundsOf(a.leaf, b.leaf, 'lower');
      const upper = boundsOf(a.leaf, b.leaf, 'upper');
      if (lower === null || upper === null) continue;
      if (!comparable(lower.value, upper.value)) continue;
      const inclusive = lower.inclusive && upper.inclusive;
      const impossible = inclusive ? lower.value > upper.value : lower.value >= upper.value;
      if (impossible) {
        out.push(
          contradictionIssue(
            b.path,
            'нижняя граница диапазона не меньше верхней — ни одна мысль не подойдёт',
          ),
        );
      }
    }
  }
  return out;
}

/** Граница диапазона у одного из двух листьев (`null` — лист не граница). */
function boundsOf(
  a: FilterTreeLeaf,
  b: FilterTreeLeaf,
  kind: 'lower' | 'upper',
): { value: string | number; inclusive: boolean } | null {
  const ops = kind === 'lower' ? ['gt', 'gte'] : ['lt', 'lte'];
  for (const leaf of kind === 'lower' ? [a, b] : [b, a]) {
    const operator: string = leaf.operator;
    if (!ops.includes(operator)) continue;
    const value = scalarOf(leaf);
    // Границы диапазона сравнимы только числом или строкой (ISO-дата — лексикой).
    if (value === null || typeof value === 'boolean') continue;
    return { value, inclusive: operator.endsWith('e') };
  }
  return null;
}

/**
 * Собственные проверки конструктора по дереву модели (требование cf8fdd4d):
 * пустая группа, условие без значения, противоречие в одном поле. Пустой корень
 * «отбора без условий» ошибкой не считается — это законная модель пустого
 * отбора (`buildFilterAst`: «корень пустого дерева — валидная пустая группа И»).
 */
export function constructorFilterIssues(tree: FilterTreeNode | null | undefined): FilterIssue[] {
  if (tree === null || tree === undefined) return [];
  const issues: FilterIssue[] = [];
  walkConstructor(tree, [], issues);
  return issues;
}

function walkConstructor(
  node: FilterTreeNode,
  path: readonly number[],
  out: FilterIssue[],
): void {
  if (node.kind === 'leaf') {
    if (filterOperatorNeedsValue(node.operator) && node.value.kind === 'none') {
      out.push(withoutValueIssue(filterIssueNodePath(path)));
    }
    return;
  }
  const nodePath = filterIssueNodePath(path);
  if (node.children.length === 0 && path.length > 0) out.push(emptyGroupIssue(nodePath));
  if (node.op === 'and') out.push(...contradictionIssues(node, path));
  node.children.forEach((child, index) => walkConstructor(child, [...path, index], out));
}

// ---------------------------------------------------------------------------
// Диагностика ядра
// ---------------------------------------------------------------------------

/** Диагностика ядра (`FilterDiagnostic`) → запись редактора. */
function issueFromDiagnostic(diagnostic: FilterDiagnostic): FilterIssue {
  return {
    severity: diagnostic.severity,
    source: 'server',
    code: diagnostic.code,
    path: typeof diagnostic.path === 'string' ? diagnostic.path : '',
    message: diagnostic.message,
    label: diagnostic.label ?? null,
    valueLabel: diagnostic.value_label ?? null,
    deletedAt: diagnostic.deleted_at ?? null,
  };
}

/** Свести серверные данные выборки/ошибки в список записей редактора. */
export function filterIssuesFromPayload(payload: FilterDiagnosticsPayload): FilterIssue[] {
  const out: FilterIssue[] = [];
  for (const diagnostic of payload.diagnostics ?? []) out.push(issueFromDiagnostic(diagnostic));
  for (const diagnostic of payload.warnings ?? []) out.push(issueFromDiagnostic(diagnostic));
  for (const token of payload.unresolved ?? []) {
    out.push({
      severity: 'error',
      source: 'server',
      code: 'token_unresolved',
      path: typeof token.path === 'string' ? token.path : '',
      message: token.message,
    });
  }
  for (const message of payload.messages ?? []) {
    out.push({
      severity: 'warning',
      source: 'server',
      code: 'build_warning',
      path: '',
      message,
    });
  }
  return dedupeIssues(out);
}

/**
 * Записи из ошибки `EtnError`: красная диагностика ядра приходит
 * `VALIDATION_ERROR` со структурированным `details.diagnostics` (требование
 * 44d61c8a) — редактор берёт из неё строку и причину со снапшотом имени.
 */
export function filterIssuesFromError(err: unknown): FilterIssue[] {
  if (!(err instanceof EtnError)) return [];
  const details = err.details;
  if (details === null || typeof details !== 'object') return [];
  const diagnostics = (details as Record<string, unknown>)['diagnostics'];
  if (!Array.isArray(diagnostics)) return [];
  return filterIssuesFromPayload({ diagnostics: diagnostics as FilterDiagnostic[] });
}

/** Слить списки записей, убрав дубли (по коду, адресу и тексту). */
export function mergeFilterIssues(...lists: ReadonlyArray<readonly FilterIssue[]>): FilterIssue[] {
  return dedupeIssues(lists.flat());
}

/**
 * Жёлтые записи диагностики для условий, ОТБРОШЕННЫХ при чтении сохранённого
 * определения отбора (`readFilterDefinitionDetailed.lost`): сохранённый отбор
 * не перезаписывается молча, потеря видна пользователю. Адреса строки у таких
 * записей нет — они показываются в тултипе фразы-превью футера, пока пользователь
 * не тронул отбор (образец — диагностика потери миграции ленты «События»).
 * Текст диагностики — из модуля каркаса, а не из места применения: строки
 * интерфейса мест берутся из словаря `t()` (требование 0e5ff1c6).
 */
export function lostConditionIssues(lost: readonly string[]): FilterIssue[] {
  return lost.map((condition) => ({
    severity: 'warning' as const,
    source: 'constructor' as const,
    code: 'build_warning' as const,
    path: '',
    message: `${condition}. Правка заменит сохранённое определение.`,
  }));
}

function dedupeIssues(issues: readonly FilterIssue[]): FilterIssue[] {
  const seen = new Set<string>();
  const out: FilterIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Сводки
// ---------------------------------------------------------------------------

/** Записи по адресам строк: одна запись на путь, при конфликте — более строгая. */
export function filterIssuesByPath(issues: readonly FilterIssue[]): Map<string, FilterIssue> {
  const out = new Map<string, FilterIssue>();
  for (const issue of issues) {
    if (issue.path === '') continue;
    const current = out.get(issue.path);
    if (current === undefined || (current.severity === 'warning' && issue.severity === 'error')) {
      out.set(issue.path, issue);
    }
  }
  return out;
}

/**
 * Запись, адресующая УЗЕЛ дерева, а не его соседа: сервер адресует поле листа
 * (`filter.children[0].entity`, `.operator`, `.value.query`), а редактор ищет
 * диагностику по строке. Подходит и точный путь узла, и путь его ПОЛЯ (продолжение
 * не начинается с `children` — иначе это уже путь другого узла: предок не должен
 * забирать диагностику потомка). При нескольких записях побеждает красная.
 */
export function filterIssueForNode(
  issues: readonly FilterIssue[],
  nodePath: string,
): FilterIssue | null {
  let best: FilterIssue | null = null;
  for (const issue of issues) {
    if (issue.path === '') continue;
    const rest = issue.path === nodePath ? '' : issue.path.startsWith(`${nodePath}.`)
      ? issue.path.slice(nodePath.length + 1)
      : null;
    if (rest === null || rest.startsWith('children')) continue;
    if (best === null || (best.severity === 'warning' && issue.severity === 'error')) best = issue;
  }
  return best;
}

/** Записи без адреса строки — их показывает тултип фразы-превью футера. */
export function unlocalizedFilterIssues(issues: readonly FilterIssue[]): FilterIssue[] {
  return issues.filter((issue) => issue.path === '');
}

/** Есть ли красное (запрет применения) — требование 44d61c8a. */
export function hasBlockingIssues(issues: readonly FilterIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/**
 * Первая красная запись С адресом строки — цель перехода «исправить» из
 * сообщения о запрете применения (требования 0fd1dc5d, 44d61c8a). Записи без
 * адреса (`path: ''`, например конструкторское предупреждение миграции) для
 * перехода не годятся: локализовать строку нельзя. `null` — переходить некуда.
 */
export function firstLocalizedErrorIssue(issues: readonly FilterIssue[]): FilterIssue | null {
  for (const issue of issues) {
    if (issue.severity === 'error' && issue.path !== '') return issue;
  }
  return null;
}

/** Худшая серьёзность списка (`null` — записей нет) — для окраски футера. */
export function worstFilterIssueSeverity(
  issues: readonly FilterIssue[],
): FilterIssueSeverity | null {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length > 0) return 'warning';
  return null;
}

/**
 * Человекочитаемая причина строки: текст ядра плюс снапшот имени (если ядро его
 * не вписало) и дата удаления — требование «точная причина со снапшотом имени и
 * датой».
 */
export function filterIssueReason(issue: FilterIssue): string {
  const parts = [issue.message];
  if (issue.label !== null && issue.label !== undefined && issue.label !== '' && !issue.message.includes(issue.label)) {
    parts.push(`«${issue.label}»`);
  }
  if (issue.valueLabel !== null && issue.valueLabel !== undefined && issue.valueLabel !== '') {
    parts.push(`значение «${issue.valueLabel}»`);
  }
  if (issue.deletedAt !== null && issue.deletedAt !== undefined && issue.deletedAt !== '') {
    parts.push(`удалено ${issue.deletedAt}`);
  }
  return parts.join(' · ');
}
