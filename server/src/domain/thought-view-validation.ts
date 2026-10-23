/**
 * Общая валидация определения отбора мысли — единая точка для отборов типа
 * (`thought-type-views-service.ts`, миграция 037) и внетиповых отборов мысли
 * (`thought-custom-views-service.ts`, миграция 052). 0.14.1, задача a28d444b:
 * валидаторы вынесены из сервиса отборов типа, чтобы второй владелец отбора
 * не дублировал правила.
 *
 * Правила одинаковы у обоих владельцев (операция 5e55b7bb):
 *   * имя — непустая строка до {@link THOUGHT_TYPE_VIEW_NAME_MAX} символов;
 *   * описание — необязательная строка до
 *     {@link THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов; пустая строка
 *     нормализуется в `null`;
 *   * `definition` — непустая JSON-строка с JSON-объектом; токены
 *     `$thought.*` проверяются по реестру сети; AST-определение, ссылающееся
 *     на удалённую сущность, не сохраняется; операнд вне профиля `thoughts`
 *     отвергается (требования 0095daad/44d61c8a, ADR 0c02ab4f).
 */

import {
  EtnError,
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { parseFilterAst } from './filter-ast.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import { assertFilterDefinitionInProfile } from './filter-profile-validation.js';
import {
  linkPropertySideFromConfig,
  listNetworkProperties,
  oppositeLinkPropertyDisplayName,
} from './property-service.js';
import {
  validateDefinitionForTokens,
  type PropertyMeta,
} from './thought-type-view-tokens.js';

/**
 * Нормализованная форма имени (`trim + lowercase`) — ключ дубля и перекрытия
 * (требования 141c2576/eaca1253/045f539a). Репозитории держат свою копию как
 * правило ХРАНЕНИЯ (значение колонки `name_key`), чтобы не тянуть доменные
 * зависимости в слой данных; сервисы пользуются этой функцией.
 */
export function viewNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Метаданные свойств РЕЕСТРА СЕТИ для валидатора токенов
 * (`thought-type-view-tokens`): имена, `multiple`, `value_type`.
 *
 * **Свойство резолвится по реестру сети независимо от привязки к типу отбора**
 * (ошибка 50d9bf4e, пункт A6): токен `$thought.[Имя]` принимается, если такое
 * свойство определено в сети, — даже если оно не подключено к типу этого отбора
 * (при исполнении отсутствие значения у мысли даёт пустое значение по семантике
 * отбора). Поэтому валидатору отдаётся ПОЛНЫЙ список свойств сети, а не
 * свойства цепочки типа.
 *
 * Свойство-связь адресуется обеими сторонами: к метаданным добавляется имя
 * противоположной стороны, чтобы токен `$thought.[<обратное имя>]` был принят
 * (единая точка интерпретации направления — `oppositeLinkPropertyDisplayName`).
 */
export function getNetworkPropertyMeta(ndb: NetworkDb): PropertyMeta[] {
  const out: PropertyMeta[] = [];
  for (const p of listNetworkProperties(ndb)) {
    out.push({
      key: p.name,
      multiple: p.config?.multiple === true,
      value_type: p.value_type,
    });
    if (p.value_type !== 'link') continue;
    const side = linkPropertySideFromConfig(p.value_type, p.config ?? null);
    const opposite = oppositeLinkPropertyDisplayName(ndb, p.config ?? null, side);
    if (opposite === null || opposite === p.name) continue;
    out.push({ key: opposite, multiple: p.config?.multiple === true, value_type: p.value_type });
  }
  return out;
}

/**
 * Валидация имени отбора: непустая строка, до {@link THOUGHT_TYPE_VIEW_NAME_MAX}
 * символов (после `trim`). Требование 141c2576.
 *
 * `requestId` пробрасывается в `EtnError` (REST/MCP его подставляют).
 */
export function validateViewName(name: unknown, requestId?: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Имя отбора должно быть непустой строкой.',
      { field: 'name' },
      requestId,
    );
  }
  const trimmed = name.trim();
  if ([...trimmed].length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Имя отбора должно быть не длиннее ${THOUGHT_TYPE_VIEW_NAME_MAX} символов.`,
      { field: 'name', limit: THOUGHT_TYPE_VIEW_NAME_MAX },
      requestId,
    );
  }
  return trimmed;
}

/**
 * Валидация описания: необязательная строка, до
 * {@link THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов. Пустая строка и `null`
 * нормализуются в `null` — описание либо есть осмысленное, либо отсутствует.
 */
export function validateViewDescription(
  description: unknown,
  requestId?: string,
): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Описание отбора должно быть строкой или null.',
      { field: 'description' },
      requestId,
    );
  }
  if (description.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Описание отбора должно быть не длиннее ${THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов.`,
      { field: 'description', limit: THOUGHT_TYPE_VIEW_DESCRIPTION_MAX },
      requestId,
    );
  }
  return description === '' ? null : description;
}

/**
 * Валидация `definition`: непустая строка, синтаксически валидный
 * JSON-объект. Семантика токенов — отдельным проходом
 * ({@link validateViewDefinitionInput}).
 */
export function validateViewDefinition(definition: unknown, requestId?: string): string {
  if (typeof definition !== 'string' || definition.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'definition должен быть непустой JSON-строкой.',
      { field: 'definition' },
      requestId,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch (err) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `definition не является валидным JSON: ${(err as Error).message}`,
      { field: 'definition' },
      requestId,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'definition должен быть JSON-объектом (не массивом и не null).',
      { field: 'definition' },
      requestId,
    );
  }
  return definition;
}

/** Валидация `position`: целое число ≥ 0, опционально. */
export function validateViewPosition(position: unknown, requestId?: string): number | undefined {
  if (position === undefined) return undefined;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'position должен быть неотрицательным целым числом.',
      { field: 'position' },
      requestId,
    );
  }
  return position;
}

/**
 * Красная диагностика на сохранении (требование 44d61c8a): AST-форма
 * определения, ссылающаяся на удалённую сущность (свойство реестра, тип/тип
 * связи, значение-мысль), не сохраняется — `VALIDATION_ERROR` со
 * структурированными `details.diagnostics`. Определения старой плоской формы
 * (`definition v1`, без поля `version`) пропускаются: их миграция в AST —
 * отдельная задача 4be62d42.
 */
export function assertAstDefinitionEntitiesResolvable(
  ndb: NetworkDb,
  parsedDefinition: Record<string, unknown>,
  thoughtTypeId: string | null | undefined,
  requestId?: string,
): void {
  if (parsedDefinition['version'] === undefined) return;
  const ast = parseFilterAst(parsedDefinition, requestId);
  const diag = diagnoseFilterAst(ndb, ast, {
    thoughtTypeId: thoughtTypeId ?? undefined,
    requestId,
  });
  if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors, requestId);
}

/**
 * Полная валидация определения отбора, общая для типового и внетипового
 * владельца: синтаксис JSON → токены по реестру сети → красная диагностика
 * AST → профиль точки применения `thoughts`.
 *
 * `thoughtTypeId` — якорь жёлтой диагностики (для внетипового отбора —
 * тип мысли-владельца; у мысли без типа диагностика идёт без якоря).
 *
 * Возвращает нормализованную строку и её разобранную форму — вызывающий код
 * не парсит JSON повторно.
 */
export function validateViewDefinitionInput(
  ndb: NetworkDb,
  definition: unknown,
  thoughtTypeId: string | null | undefined,
  requestId?: string,
): { definition: string; parsed: Record<string, unknown> } {
  const normalized = validateViewDefinition(definition, requestId);
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  validateDefinitionForTokens(
    parsed,
    { properties: getNetworkPropertyMeta(ndb) },
    requestId,
  );
  assertAstDefinitionEntitiesResolvable(ndb, parsed, thoughtTypeId, requestId);
  assertFilterDefinitionInProfile(parsed, 'thoughts', requestId);
  return { definition: normalized, parsed };
}
