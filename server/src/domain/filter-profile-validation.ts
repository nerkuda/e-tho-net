/**
 * Валидация AST отбора по профилю контекста точки применения (требование
 * 0095daad «Профили контекста всех точек применения отбора описаны», ADR
 * 0c02ab4f; задача 7a798b17). Профиль — из реестра `@etn/shared`
 * (`filter-profiles.ts`); здесь — проверка «операнд, невидимый в точке
 * применения, отвергается VALIDATION_ERROR» и «оператор — из набора профиля».
 *
 * Профили, отбирающие ИНЫЕ сущности (хроника, события, вложения), несут
 * собственные виды операндов AST, и их AST исполняется единым исполнителем
 * соответствующей точки (задачи 4752b065/2b230e8e/5a007bed); видимость операндов
 * и операторов в них проверяется этим же модулем.
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

/** Свёртка правил видимости одного профиля (для рекурсии в под-выборку). */
interface ProfileScope {
  allowed: ReadonlySet<FilterAstEntityKind>;
  operators: ReadonlySet<string>;
  perOperand: Readonly<Record<string, readonly string[]>> | undefined;
}

function collectViolations(
  node: FilterAstNode,
  path: string,
  scope: ProfileScope,
  thoughtsScope: ProfileScope,
  out: ProfileViolation[],
): void {
  if ('op' in node) {
    node.children.forEach((child, i) =>
      collectViolations(child, `${path}.children[${i}]`, scope, thoughtsScope, out),
    );
    return;
  }
  const kind = node.entity.kind;
  if (!scope.allowed.has(kind)) {
    out.push({ path: `${path}.entity`, kind: 'operand', value: kind });
  }
  // Оператор: у профилей с наборами по операнду — набор СВОЕГО операнда
  // (требование 62475a6e), иначе — объединённый словарь профиля.
  const allowedOps = scope.perOperand?.[kind];
  const opOk = allowedOps !== undefined ? allowedOps.includes(node.operator) : scope.operators.has(node.operator);
  if (!opOk) {
    out.push({ path: `${path}.operator`, kind: 'operator', value: node.operator });
  }
  // Значение-подвыборка несёт собственное под-дерево — проверяем и его.
  // Под-выборки, адресующие МЫСЛИ, проверяются профилем «мысли»: «Цели»
  // хроники (`targets`), «Сущность» событий (`entity_id` — «по конкретной
  // сущности равно ИЛИ под-выборка по мыслям») и «Владельцы» вложений (`owner`
  // — под-выборка по мыслям-владельцам). Иначе операнды мысли в них были бы
  // невидимы.
  const value = node.value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value) {
    const nested =
      kind === 'targets' || kind === 'entity_id' || kind === 'owner' ? thoughtsScope : scope;
    collectViolations(value.query, `${path}.value.query`, nested, thoughtsScope, out);
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
  const scope: ProfileScope = {
    allowed,
    operators: new Set<string>(profile.operators),
    perOperand: profile.operand_operators as Readonly<Record<string, readonly string[]>> | undefined,
  };
  // Профиль мыслей для подзапросов «Цели» (адресуют мысли). Составы по операндам
  // берём у того же профиля — иначе вложенная под-выборка проверялась бы мягче
  // внешнего отбора и расходилась бы с редактором (задача 6ae062a9).
  const thoughtsProfile = getFilterProfile('thoughts');
  const thoughtsScope: ProfileScope = {
    allowed: filterProfileAstOperands('thoughts') ?? allowed,
    operators: new Set<string>(thoughtsProfile.operators),
    perOperand: thoughtsProfile.operand_operators as
      | Readonly<Record<string, readonly string[]>>
      | undefined,
  };
  const violations: ProfileViolation[] = [];
  collectViolations(ast.filter, 'filter', scope, thoughtsScope, violations);
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
      allowed_operators: [...scope.operators],
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
