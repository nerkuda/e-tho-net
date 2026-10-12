/**
 * Валидация AST отбора по профилю контекста точки применения (требование
 * 0095daad «Профили контекста всех точек применения отбора описаны», ADR
 * 0c02ab4f; задача 7a798b17). Профиль — из реестра `@etn/shared`
 * (`filter-profiles.ts`); здесь — проверка «операнд, невидимый в точке
 * применения, отвергается VALIDATION_ERROR» и «оператор — из набора профиля».
 *
 * Профили, отбирающие ИНЫЕ сущности (хроника, события, вложения), несут
 * семантические операнды: их AST появится отдельными задачами под-проекта, до
 * тех пор AST-валидация по операндам к ним не применяется
 * ({@link filterProfileAstOperands} возвращает `null`).
 */

import {
  EtnError,
  filterProfileAstOperands,
  getFilterProfile,
  type FilterAst,
  type FilterAstEntityKind,
  type FilterAstNode,
  type FilterProfileId,
} from '@etn/shared';

import { parseFilterAst } from './filter-ast.js';

/** Нарушение видимости: узел AST с операндом/оператором вне профиля. */
interface ProfileViolation {
  /** Путь к листу-условию, напр. `filter.children[0]`. */
  path: string;
  kind: 'operand' | 'operator';
  value: string;
}

function collectViolations(
  node: FilterAstNode,
  path: string,
  allowed: ReadonlySet<FilterAstEntityKind>,
  operators: ReadonlySet<string>,
  out: ProfileViolation[],
): void {
  if ('op' in node) {
    node.children.forEach((child, i) =>
      collectViolations(child, `${path}.children[${i}]`, allowed, operators, out),
    );
    return;
  }
  if (!allowed.has(node.entity.kind)) {
    out.push({ path: `${path}.entity`, kind: 'operand', value: node.entity.kind });
  }
  if (!operators.has(node.operator)) {
    out.push({ path: `${path}.operator`, kind: 'operator', value: node.operator });
  }
  // Значение-подвыборка несёт собственное под-дерево — проверяем и его.
  const value = node.value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value) {
    collectViolations(value.query, `${path}.value.query`, allowed, operators, out);
  }
}

/**
 * Проверить AST на видимость операндов/операторов в профиле точки применения.
 * Бросает `VALIDATION_ERROR` со списком `details.violations`. Профиль иной
 * целевой сущности (AST пока не применим) — no-op.
 */
export function assertFilterAstInProfile(
  ast: FilterAst,
  profileId: FilterProfileId,
  requestId?: string,
): void {
  const allowed = filterProfileAstOperands(profileId);
  if (allowed === null) return;
  const profile = getFilterProfile(profileId);
  const operators = new Set<string>(profile.operators);
  const violations: ProfileViolation[] = [];
  collectViolations(ast.filter, 'filter', allowed, operators, violations);
  if (violations.length === 0) return;
  const first = violations[0]!;
  const reason =
    first.kind === 'operand'
      ? `операнд «${first.value}» не виден в точке применения`
      : `оператор «${first.value}» недопустим в точке применения`;
  throw new EtnError(
    'VALIDATION_ERROR',
    `Отбор не соответствует профилю «${profile.title}»: ${reason}.`,
    {
      field: first.path,
      profile: profileId,
      violations,
      allowed_operands: [...allowed],
      allowed_operators: [...operators],
    },
    requestId,
  );
}

/**
 * Проверить сохранённое определение отбора (AST-формы) на соответствие профилю.
 * Определения старой плоской формы (без поля `version`) пропускаются — их
 * миграция в AST отдельная задача.
 */
export function assertFilterDefinitionInProfile(
  definition: Record<string, unknown>,
  profileId: FilterProfileId,
  requestId?: string,
): void {
  if (definition['version'] === undefined) return;
  assertFilterAstInProfile(parseFilterAst(definition, requestId), profileId, requestId);
}
