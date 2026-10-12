/**
 * Диагностика отбора — серверный классификатор неисполнимых/подозрительных
 * условий (требования 44d61c8a «красная», 325efc13 «жёлтая»; тех.проект «Ядро
 * AST и операторы» f93afcd4). Отдельный проход по дереву AST ДО исполнения:
 *
 *   * **красное** (`severity: 'error'`) — сущность условия удалена из сети
 *     (свойство реестра, тип/тип связи, значение-мысль). Применение отбора
 *     запрещено — исполнение заведомо неисполнимого отбора не запускается;
 *   * **жёлтое** (`severity: 'warning'`) — свойство существует, но больше не
 *     входит в эффективный набор свойств типа отбора: отбор исполняется по
 *     фактическим значениям вне типа, предупреждение не блокирует.
 *
 * Человекочитаемое имя исчезнувшей сущности берётся из снапшота `labels` AST
 * (сущности уже нет — восстановить имя негде; сущность «Модель отбора (AST) и
 * её wire-формат» 489c394f).
 *
 * Валидация формы дерева — {@link parseFilterAst} (filter-ast.ts); этот модуль
 * формы не проверяет, он разбирает уже провалидированное дерево.
 */

import {
  EtnError,
  type FilterAst,
  type FilterAstLeaf,
  type FilterAstNode,
  type FilterAstValue,
  type FilterDiagnostic,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getNetworkProperty, listEffectiveTypeProperties, resolveConditionPropertyRef } from './property-service.js';

/** Похоже ли строковое значение на id сущности (UUID). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Опции прохода диагностики. */
export interface DiagnoseFilterOptions {
  /**
   * Тип мысли отбора (для жёлтой диагностики «свойство отвязано от типа»).
   * Отсутствует у произвольной выборки без типа-контекста — тогда жёлтых
   * диагностик нет (отвязка определена только относительно типа).
   */
  thoughtTypeId?: string;
  requestId?: string;
}

/** Итог диагностики: красные (error) и жёлтые (warning) записи. */
export interface FilterDiagnosticsResult {
  errors: FilterDiagnostic[];
  warnings: FilterDiagnostic[];
}

/**
 * Разобрать дерево отбора и вернуть диагностику. Побочных эффектов нет;
 * `resolveConditionPropertyRef` может бросить `VALIDATION_ERROR` на неоднозначное
 * имя свойства — это ожидаемая ошибка ввода, не диагностика.
 */
export function diagnoseFilterAst(
  ndb: NetworkDb,
  ast: FilterAst,
  opts: DiagnoseFilterOptions = {},
): FilterDiagnosticsResult {
  const errors: FilterDiagnostic[] = [];
  const warnings: FilterDiagnostic[] = [];
  const effective =
    opts.thoughtTypeId === undefined
      ? null
      : new Set(listEffectiveTypeProperties(ndb, 'thought_type', opts.thoughtTypeId).map((p) => p.property_id));
  walk(ndb, ast.filter, 'filter', effective, opts.requestId, errors, warnings);
  return { errors, warnings };
}

/**
 * Явная ошибка «отбор нельзя применить» по красной диагностике (требование
 * 44d61c8a). `details.diagnostics` несёт структурированный список — UI берёт из
 * него строку и причину со снапшотом имени.
 */
export function filterDiagnosticsError(
  errors: readonly FilterDiagnostic[],
  requestId?: string,
): EtnError {
  const first = errors[0];
  return new EtnError(
    'VALIDATION_ERROR',
    first?.message ?? 'Отбор нельзя применить: сущность условия удалена из сети.',
    { reason: 'filter_entity_deleted', diagnostics: errors },
    requestId,
  );
}

/** Concat обход дерева: группы — по детям, листья — в диагностику. */
function walk(
  ndb: NetworkDb,
  node: FilterAstNode,
  path: string,
  effective: Set<string> | null,
  requestId: string | undefined,
  errors: FilterDiagnostic[],
  warnings: FilterDiagnostic[],
): void {
  if ('op' in node) {
    node.children.forEach((child, i) =>
      walk(ndb, child, `${path}.children[${i}]`, effective, requestId, errors, warnings),
    );
    return;
  }
  diagnoseLeaf(ndb, node, path, effective, requestId, errors, warnings);
}

function diagnoseLeaf(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  path: string,
  effective: Set<string> | null,
  requestId: string | undefined,
  errors: FilterDiagnostic[],
  warnings: FilterDiagnostic[],
): void {
  // Значение-подвыборка несёт собственное под-дерево — диагностируем и его.
  if (isSubqueryValue(leaf.value)) {
    walk(ndb, leaf.value.query, `${path}.value.query`, effective, requestId, errors, warnings);
  }
  const entity = leaf.entity;
  switch (entity.kind) {
    case 'property': {
      const ref = entity.property_id ?? entity.property;
      if (ref === undefined) return;
      const resolved = resolveConditionPropertyRef(ndb, ref, requestId);
      const label = leaf.labels?.entity ?? entity.property ?? null;
      if (resolved === null) {
        errors.push({
          severity: 'error',
          code: 'entity_deleted',
          path: `${path}.entity`,
          label,
          message: `Свойство${label ? ` «${label}»` : ''} удалено из реестра сети — отбор нельзя применить.`,
        });
        return;
      }
      const def = getNetworkProperty(ndb, resolved.propertyId);
      if (def !== null && effective !== null && !effective.has(resolved.propertyId)) {
        const name = leaf.labels?.entity ?? def.name;
        warnings.push({
          severity: 'warning',
          code: 'property_detached',
          path: `${path}.entity`,
          label: name,
          message: `Свойство «${name}» больше не входит в набор свойств этого типа — отбор исполнится по фактическим значениям вне типа.`,
        });
      }
      // Значение-мысль: у ссылочных свойств строковые значения — id целей.
      // Id, невидимый в сети вовсе, означает удалённую мысль (красное).
      if (def !== null && (def.value_type === 'link' || def.value_type === 'thought_ref')) {
        for (const id of stringValues(leaf.value)) {
          if (!isUuid(id)) continue;
          if (!thoughtVisible(ndb, id)) {
            errors.push({
              severity: 'error',
              code: 'entity_deleted',
              path: `${path}.value`,
              label: leaf.labels?.entity ?? def.name,
              value_label: leaf.labels?.value ?? id,
              message: `Значение «${leaf.labels?.value ?? id}» ссылается на удалённую мысль — отбор нельзя применить.`,
            });
          }
        }
      }
      return;
    }
    case 'type': {
      // «Имеет свойство»/«не имеет» для типа: значение — id/имена СВОЙСТВ, не
      // типов (требование bd0348b3) — отдельная диагностика свойств.
      if (leaf.operator === 'has' || leaf.operator === 'not_has') {
        diagnosePropertyIdList(ndb, leaf, path, requestId, errors);
        return;
      }
      for (const id of stringValues(leaf.value)) {
        if (!isUuid(id) || typeExists(ndb, 'thought_types', id)) continue;
        errors.push({
          severity: 'error',
          code: 'entity_deleted',
          path: `${path}.value`,
          label: leaf.labels?.entity ?? 'Тип',
          value_label: leaf.labels?.value ?? id,
          message: `Тип «${leaf.labels?.value ?? id}» удалён из сети — отбор нельзя применить.`,
        });
      }
      return;
    }
    case 'link_type': {
      for (const id of stringValues(leaf.value)) {
        if (!isUuid(id) || typeExists(ndb, 'link_types', id)) continue;
        errors.push({
          severity: 'error',
          code: 'entity_deleted',
          path: `${path}.value`,
          label: leaf.labels?.entity ?? 'Тип связи',
          value_label: leaf.labels?.value ?? id,
          message: `Тип связи «${leaf.labels?.value ?? id}» удалён из сети — отбор нельзя применить.`,
        });
      }
      return;
    }
    case 'properties': {
      diagnosePropertyIdList(ndb, leaf, path, requestId, errors);
      return;
    }
    default:
      return;
  }
}

/**
 * Операнд «Имеет свойство»/«свойство» со списком свойств: каждое имя/id обязано
 * резолвиться в реестр, иначе — красное (свойство удалено).
 */
function diagnosePropertyIdList(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  path: string,
  requestId: string | undefined,
  errors: FilterDiagnostic[],
): void {
  const label = leaf.labels?.value ?? null;
  for (const ref of stringValues(leaf.value)) {
    if (resolveConditionPropertyRef(ndb, ref, requestId) === null) {
      errors.push({
        severity: 'error',
        code: 'entity_deleted',
        path: `${path}.value`,
        label: leaf.labels?.entity ?? null,
        value_label: label,
        message: `Свойство «${label ?? ref}» удалено из реестра сети — отбор нельзя применить.`,
      });
    }
  }
}

/** Строковые значения листа (скаляр/список); токены и подвыборки пропускаются. */
function stringValues(value: FilterAstValue | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function isSubqueryValue(
  value: FilterAstValue | undefined,
): value is { query: FilterAstNode; operator: 'in' | 'not_in' | 'all_in' } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value;
}

/** Жива ли мысль в видимости текущего слоя (удалённая навсегда — нет). */
function thoughtVisible(ndb: NetworkDb, id: string): boolean {
  return ndb.prepare('SELECT 1 AS x FROM thoughts_v WHERE id = ?').get(id) !== undefined;
}

/** Существует ли узел каталога типов (`thought_types`/`link_types`). */
function typeExists(ndb: NetworkDb, table: 'thought_types' | 'link_types', id: string): boolean {
  return ndb.prepare(`SELECT 1 AS x FROM ${table}_v WHERE id = ?`).get(id) !== undefined;
}
